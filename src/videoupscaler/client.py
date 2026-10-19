"""Stdlib-only client for the VideoUpscaler REST API.

Mirrors https://videoupscaler.co/docs: bearer API key, JSON bodies, the
``Idempotency-Key`` header on POST /upscale, and ``{"error": {"code", "message"}}``
on failure.
"""

import json
import os
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

DEFAULT_BASE_URL = "https://videoupscaler.co/api/v1"
RESOLUTIONS = ("1080p", "2k", "4k")
CONTENT_TYPES = {".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm"}
MAX_UPLOAD_BYTES = 100 * 1024 * 1024
TERMINAL_STATUSES = ("completed", "failed")

# POST /upscale downloads the video before answering: allow up to 5 minutes.
UPSCALE_TIMEOUT = 300
DEFAULT_TIMEOUT = 60
POLL_INTERVAL = 5
RETRIES = 3


class ApiError(Exception):
    """An error response from the API (or a transport failure, status 0)."""

    def __init__(self, status, code, message, retry_after=None):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.retry_after = retry_after

    def __str__(self):
        return "%s: %s" % (self.code, self.message)


class UsageError(Exception):
    """A problem with the local input (missing key, unsupported file, ...)."""


def content_type_for(path):
    """The content type the API expects for a local file, by extension."""
    ext = os.path.splitext(path)[1].lower()
    if ext not in CONTENT_TYPES:
        raise UsageError(
            "Unsupported file type %r: upload .mp4, .mov or .webm files, "
            "or host the video and pass its public URL." % ext
        )
    return CONTENT_TYPES[ext]


def new_idempotency_key():
    return "cli-" + uuid.uuid4().hex


def _parse_error(status, body, headers):
    try:
        error = json.loads(body)["error"]
        code, message = error["code"], error["message"]
    except (ValueError, KeyError, TypeError):
        code, message = "http_%d" % status, (body or "").strip()[:300] or "HTTP %d" % status
    retry_after = None
    if headers is not None and headers.get("Retry-After"):
        try:
            retry_after = int(headers.get("Retry-After"))
        except ValueError:
            retry_after = None
    return ApiError(status, code, message, retry_after)


class Client:
    """Thin wrapper over the six documented endpoints.

    ``opener`` is called with a ``urllib.request.Request`` and a timeout and
    must behave like ``urllib.request.urlopen``; tests inject their own.
    """

    def __init__(self, api_key=None, base_url=None, opener=None, sleep=time.sleep, user_agent=None):
        self.api_key = api_key or os.environ.get("VIDEOUPSCALER_API_KEY")
        if not self.api_key:
            raise UsageError(
                "VIDEOUPSCALER_API_KEY is not set. Create a key at "
                "https://videoupscaler.co/sign-in?callbackUrl=%2Fsettings%2Fapikeys "
                "and export it: export VIDEOUPSCALER_API_KEY=vu_live_..."
            )
        self.base_url = (base_url or os.environ.get("VIDEOUPSCALER_API_URL") or DEFAULT_BASE_URL).rstrip("/")
        self._open = opener or urllib.request.urlopen
        self._sleep = sleep
        self.user_agent = user_agent or "videoupscaler-cli-python"

    # -- transport -----------------------------------------------------------

    def _request(self, method, path, body=None, headers=None, timeout=DEFAULT_TIMEOUT, retries=0):
        """One API call. Retries connection errors, 500 and 504 ``retries`` times
        with the same request (and so the same Idempotency-Key); honours
        Retry-After on 429 once."""
        url = self.base_url + path
        data = json.dumps(body).encode() if body is not None else None
        req_headers = {"Authorization": "Bearer " + self.api_key, "Accept": "application/json", "User-Agent": self.user_agent}
        if data is not None:
            req_headers["Content-Type"] = "application/json"
        req_headers.update(headers or {})

        attempt = 0
        waited_429 = False
        while True:
            attempt += 1
            req = urllib.request.Request(url, data=data, headers=req_headers, method=method)
            try:
                with self._open(req, timeout=timeout) as res:
                    return json.loads(res.read().decode() or "null")
            except urllib.error.HTTPError as e:
                err = _parse_error(e.code, e.read().decode(errors="replace"), e.headers)
            except (urllib.error.URLError, socket.timeout, ConnectionError, TimeoutError) as e:
                reason = getattr(e, "reason", e)
                err = ApiError(0, "network_error", "Could not reach %s (%s)" % (url, reason))

            if err.status == 429 and not waited_429:
                waited_429 = True
                self._sleep(min(err.retry_after or 1, 60))
                continue
            if err.status in (0, 500, 504) and attempt <= retries:
                self._sleep(2 * attempt)
                continue
            raise err

    # -- endpoints -----------------------------------------------------------

    def get_account(self):
        """GET /account -> {"credits", "credits_per_second"}"""
        return self._request("GET", "/account", retries=RETRIES)

    def create_upload(self, content_type, size):
        """POST /uploads -> signed PUT target and the video_url to upscale."""
        return self._request("POST", "/uploads", {"content_type": content_type, "size": size}, retries=RETRIES)

    def upload_file(self, path):
        """Upload a local file: POST /uploads, then PUT the bytes to upload_url.
        Returns the upload record; pass its ``video_url`` to ``upscale``."""
        content_type = content_type_for(path)
        size = os.path.getsize(path)
        if size <= 0:
            raise UsageError("%s is empty" % path)
        if size > MAX_UPLOAD_BYTES:
            raise UsageError(
                "%s is %d bytes; uploads are limited to 100MB. Host the file and pass "
                "its public URL instead (up to 500MB)." % (path, size)
            )
        upload = self.create_upload(content_type, size)
        headers = dict(upload.get("headers") or {})
        headers["Content-Length"] = str(size)
        headers.setdefault("Content-Type", content_type)
        with open(path, "rb") as f:
            req = urllib.request.Request(upload["upload_url"], data=f, headers=headers, method=upload.get("method", "PUT"))
            try:
                with self._open(req, timeout=UPSCALE_TIMEOUT) as res:
                    res.read()
            except urllib.error.HTTPError as e:
                raise _parse_error(e.code, e.read().decode(errors="replace"), e.headers)
            except (urllib.error.URLError, socket.timeout, ConnectionError, TimeoutError) as e:
                raise ApiError(0, "network_error", "Upload failed (%s)" % getattr(e, "reason", e))
        return upload

    def upscale(self, video_url, resolution, idempotency_key=None):
        """POST /upscale. Charges credits and returns the task.

        The same ``idempotency_key`` is sent on every retry, so a timeout or
        a 500 never charges twice. The key used is stored on ``task["idempotency_key"]``.
        """
        resolution = str(resolution).lower()
        if resolution not in RESOLUTIONS:
            raise UsageError("resolution must be one of %s" % ", ".join(RESOLUTIONS))
        key = idempotency_key or new_idempotency_key()
        task = self._request(
            "POST",
            "/upscale",
            {"video_url": video_url, "resolution": resolution},
            headers={"Idempotency-Key": key},
            timeout=UPSCALE_TIMEOUT,
            retries=RETRIES,
        )
        task["idempotency_key"] = key
        return task

    def get_task(self, task_id):
        """GET /tasks/{id}"""
        return self._request("GET", "/tasks/" + urllib.parse.quote(str(task_id), safe=""), retries=RETRIES)

    def list_tasks(self, page=1, limit=20):
        """GET /tasks?page=&limit= (newest first)"""
        return self._request("GET", "/tasks?" + urllib.parse.urlencode({"page": page, "limit": limit}), retries=RETRIES)

    def wait(self, task_id, timeout=None, interval=POLL_INTERVAL, on_status=None):
        """Poll GET /tasks/{id} until the task is completed or failed.

        ``on_status(task)`` is called after every poll. Raises ApiError
        ``timeout`` when ``timeout`` seconds pass first.
        """
        deadline = None if timeout is None else time.monotonic() + timeout
        last = None
        while True:
            task = self.get_task(task_id)
            if on_status is not None and task.get("status") != last:
                on_status(task)
            last = task.get("status")
            if last in TERMINAL_STATUSES:
                return task
            if deadline is not None and time.monotonic() >= deadline:
                raise ApiError(0, "timeout", "Task %s is still %s after %ss" % (task_id, last, timeout))
            self._sleep(interval)

    def download(self, url, dest):
        """Save a result (``output_url``) to ``dest``. No API key is sent."""
        req = urllib.request.Request(url, headers={"User-Agent": self.user_agent})
        try:
            with self._open(req, timeout=UPSCALE_TIMEOUT) as res, open(dest, "wb") as out:
                while True:
                    chunk = res.read(1024 * 1024)
                    if not chunk:
                        break
                    out.write(chunk)
        except urllib.error.HTTPError as e:
            raise ApiError(e.code, "download_failed", "Could not download %s (HTTP %d)" % (url, e.code))
        except (urllib.error.URLError, socket.timeout, ConnectionError, TimeoutError) as e:
            raise ApiError(0, "network_error", "Download failed (%s)" % getattr(e, "reason", e))
        return dest
