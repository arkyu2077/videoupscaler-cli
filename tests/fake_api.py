"""A tiny in-process HTTP server that plays the VideoUpscaler API in tests."""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class FakeApi:
    """Scripted responses keyed by ``"METHOD /path"``; every request is recorded.

    ``script`` maps a key to a list of ``(status, body, headers)`` tuples consumed
    in order (the last one repeats). Unknown routes answer 404 not_found.
    """

    def __init__(self):
        self.script = {}
        self.requests = []
        self._lock = threading.Lock()
        fake = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *a):
                pass

            def _handle(self):
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length) if length else b""
                with fake._lock:
                    fake.requests.append(
                        {"method": self.command, "path": self.path, "headers": dict(self.headers), "body": body}
                    )
                    key = "%s %s" % (self.command, self.path.split("?")[0])
                    steps = fake.script.get(key)
                    if steps:
                        status, data, headers = steps.pop(0) if len(steps) > 1 else steps[0]
                    else:
                        status, data, headers = 404, {"error": {"code": "not_found", "message": "No route " + key}}, {}
                payload = data if isinstance(data, bytes) else json.dumps(data).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/octet-stream" if isinstance(data, bytes) else "application/json")
                self.send_header("Content-Length", str(len(payload)))
                for k, v in headers.items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(payload)

            do_GET = do_POST = do_PUT = _handle

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.server.shutdown()
        self.server.server_close()

    @property
    def url(self):
        return "http://127.0.0.1:%d" % self.server.server_address[1]

    def on(self, method, path, *responses):
        """Queue responses: each is ``status, body`` or ``status, body, headers``."""
        self.script["%s %s" % (method, path)] = [r if len(r) == 3 else (r[0], r[1], {}) for r in responses]
        return self

    def calls(self, method=None, path=None):
        return [
            r for r in self.requests
            if (method is None or r["method"] == method) and (path is None or r["path"].split("?")[0] == path)
        ]


def task(**overrides):
    base = {
        "id": "0b6f3c1e-8a52-5d1e-9c43-3f1d2e7a9b10",
        "status": "processing",
        "resolution": "4k",
        "video_url": "https://example.com/clip.mp4",
        "duration_seconds": 12.4,
        "processed_seconds": 12.4,
        "credits_charged": 39,
        "watermark": False,
        "output_url": None,
        "thumbnail_url": None,
        "error": None,
        "created_at": "2026-09-30T08:00:00.000Z",
        "updated_at": "2026-09-30T08:00:02.000Z",
    }
    base.update(overrides)
    return base
