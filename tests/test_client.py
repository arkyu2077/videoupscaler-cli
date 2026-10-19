import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(__file__))
from fake_api import FakeApi, task  # noqa: E402

from videoupscaler import ApiError, Client, UsageError, content_type_for  # noqa: E402

KEY = "vu_live_testkey"


class ClientTest(unittest.TestCase):
    def setUp(self):
        self.api = FakeApi().__enter__()
        self.addCleanup(self.api.__exit__, None, None, None)
        self.sleeps = []
        self.client = Client(api_key=KEY, base_url=self.api.url, sleep=self.sleeps.append)

    def test_requires_api_key(self):
        os.environ.pop("VIDEOUPSCALER_API_KEY", None)
        with self.assertRaises(UsageError) as cm:
            Client()
        self.assertIn("VIDEOUPSCALER_API_KEY", str(cm.exception))

    def test_account_sends_bearer_key(self):
        self.api.on("GET", "/account", (200, {"credits": 1240, "credits_per_second": {"1080p": 1, "2k": 2, "4k": 3}}))
        account = self.client.get_account()
        self.assertEqual(account["credits"], 1240)
        req = self.api.calls("GET", "/account")[0]
        self.assertEqual(req["headers"]["Authorization"], "Bearer " + KEY)

    def test_upscale_sends_idempotency_header_and_body(self):
        self.api.on("POST", "/upscale", (201, task()))
        result = self.client.upscale("https://example.com/clip.mp4", "4K", idempotency_key="order-1")
        req = self.api.calls("POST", "/upscale")[0]
        self.assertEqual(req["headers"]["Idempotency-Key"], "order-1")
        self.assertEqual(req["headers"]["Content-Type"], "application/json")
        self.assertEqual(json.loads(req["body"]), {"video_url": "https://example.com/clip.mp4", "resolution": "4k"})
        self.assertEqual(result["id"], task()["id"])
        self.assertEqual(result["idempotency_key"], "order-1")

    def test_upscale_generates_a_key_when_none_given(self):
        self.api.on("POST", "/upscale", (201, task()))
        result = self.client.upscale("https://example.com/clip.mp4", "1080p")
        self.assertTrue(result["idempotency_key"].startswith("cli-"))
        self.assertEqual(self.api.calls("POST", "/upscale")[0]["headers"]["Idempotency-Key"], result["idempotency_key"])

    def test_upscale_retries_500_with_the_same_key(self):
        self.api.on(
            "POST", "/upscale",
            (500, {"error": {"code": "internal_error", "message": "Something went wrong. Please retry with the same Idempotency-Key."}}),
            (200, task()),
        )
        result = self.client.upscale("https://example.com/clip.mp4", "2k")
        calls = self.api.calls("POST", "/upscale")
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0]["headers"]["Idempotency-Key"], calls[1]["headers"]["Idempotency-Key"])
        self.assertEqual(calls[1]["headers"]["Idempotency-Key"], result["idempotency_key"])
        self.assertEqual(self.sleeps, [2])

    def test_upscale_does_not_retry_502(self):
        self.api.on("POST", "/upscale", (502, {"error": {"code": "upstream_error", "message": "Failed to start processing. Your credits were refunded."}}))
        with self.assertRaises(ApiError) as cm:
            self.client.upscale("https://example.com/clip.mp4", "2k")
        self.assertEqual(cm.exception.status, 502)
        self.assertEqual(cm.exception.code, "upstream_error")
        self.assertEqual(len(self.api.calls("POST", "/upscale")), 1)

    def test_upscale_gives_up_after_retries(self):
        self.api.on("POST", "/upscale", (504, {"error": {"code": "upstream_timeout", "message": "slow"}}))
        with self.assertRaises(ApiError) as cm:
            self.client.upscale("https://example.com/clip.mp4", "2k")
        self.assertEqual(cm.exception.code, "upstream_timeout")
        self.assertEqual(len(self.api.calls("POST", "/upscale")), 4)
        self.assertEqual(self.sleeps, [2, 4, 6])

    def test_upscale_rejects_bad_resolution_locally(self):
        with self.assertRaises(UsageError):
            self.client.upscale("https://example.com/clip.mp4", "8k")
        self.assertEqual(self.api.requests, [])

    def test_error_mapping(self):
        self.api.on("POST", "/upscale", (402, {"error": {"code": "insufficient_credits", "message": "Not enough credits for this video. Buy credits to continue."}}))
        with self.assertRaises(ApiError) as cm:
            self.client.upscale("https://example.com/clip.mp4", "4k")
        e = cm.exception
        self.assertEqual((e.status, e.code), (402, "insufficient_credits"))
        self.assertEqual(str(e), "insufficient_credits: Not enough credits for this video. Buy credits to continue.")

    def test_non_json_error_body(self):
        self.api.on("GET", "/account", (503, b"<html>Service Unavailable</html>"))
        with self.assertRaises(ApiError) as cm:
            self.client.get_account()
        self.assertEqual(cm.exception.code, "http_503")
        self.assertIn("Service Unavailable", cm.exception.message)

    def test_rate_limit_waits_retry_after_once(self):
        self.api.on(
            "GET", "/account",
            (429, {"error": {"code": "rate_limited", "message": "Too many requests, slow down."}}, {"Retry-After": "7"}),
            (200, {"credits": 5, "credits_per_second": {}}),
        )
        self.assertEqual(self.client.get_account()["credits"], 5)
        self.assertEqual(self.sleeps, [7])

    def test_network_error_is_retried_then_reported(self):
        client = Client(api_key=KEY, base_url="http://127.0.0.1:9", sleep=self.sleeps.append)
        with self.assertRaises(ApiError) as cm:
            client.get_account()
        self.assertEqual(cm.exception.code, "network_error")
        self.assertEqual(len(self.sleeps), 3)

    def test_upload_file_puts_bytes_without_api_key(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "clip.mp4")
            with open(path, "wb") as f:
                f.write(b"\x00\x00\x00\x18ftypmp42" * 100)
            size = os.path.getsize(path)
            self.api.on("POST", "/uploads", (201, {
                "upload_url": self.api.url + "/put/token-1",
                "method": "PUT",
                "headers": {"Content-Type": "video/mp4"},
                "video_url": "https://storage.videoupscaler.co/videos/api/abc.mp4",
                "max_bytes": size,
                "expires_at": "2026-09-30T09:00:00.000Z",
            }))
            self.api.on("PUT", "/put/token-1", (200, {"video_url": "https://storage.videoupscaler.co/videos/api/abc.mp4"}))
            upload = self.client.upload_file(path)
        self.assertEqual(upload["video_url"], "https://storage.videoupscaler.co/videos/api/abc.mp4")
        post = self.api.calls("POST", "/uploads")[0]
        self.assertEqual(json.loads(post["body"]), {"content_type": "video/mp4", "size": size})
        put = self.api.calls("PUT", "/put/token-1")[0]
        self.assertEqual(put["headers"]["Content-Type"], "video/mp4")
        self.assertEqual(put["headers"]["Content-Length"], str(size))
        self.assertNotIn("Authorization", put["headers"])
        self.assertEqual(len(put["body"]), size)

    def test_upload_rejects_unsupported_and_oversized_files(self):
        with tempfile.TemporaryDirectory() as d:
            avi = os.path.join(d, "clip.avi")
            with open(avi, "wb") as f:
                f.write(b"x")
            with self.assertRaises(UsageError) as cm:
                self.client.upload_file(avi)
            self.assertIn("Unsupported file type", str(cm.exception))
            big = os.path.join(d, "big.mov")
            with open(big, "wb") as f:
                f.truncate(100 * 1024 * 1024 + 1)
            with self.assertRaises(UsageError) as cm:
                self.client.upload_file(big)
            self.assertIn("100MB", str(cm.exception))
        self.assertEqual(self.api.requests, [])
        self.assertEqual(content_type_for("a/b/CLIP.MOV"), "video/quicktime")
        self.assertEqual(content_type_for("clip.webm"), "video/webm")

    def test_wait_polls_until_terminal(self):
        tid = task()["id"]
        self.api.on("GET", "/tasks/" + tid,
                    (200, task(status="queued")), (200, task(status="processing")),
                    (200, task(status="completed", output_url="https://cdn/out.mp4")))
        seen = []
        final = self.client.wait(tid, on_status=lambda t: seen.append(t["status"]))
        self.assertEqual(final["output_url"], "https://cdn/out.mp4")
        self.assertEqual(seen, ["queued", "processing", "completed"])
        self.assertEqual(self.sleeps, [5, 5])
        self.assertEqual(len(self.api.calls("GET", "/tasks/" + tid)), 3)

    def test_wait_timeout(self):
        tid = task()["id"]
        self.api.on("GET", "/tasks/" + tid, (200, task(status="processing")))
        with self.assertRaises(ApiError) as cm:
            self.client.wait(tid, timeout=0)
        self.assertEqual(cm.exception.code, "timeout")

    def test_list_tasks_query(self):
        self.api.on("GET", "/tasks", (200, {"data": [task()], "page": 2, "limit": 5, "total": 7, "has_more": False}))
        result = self.client.list_tasks(page=2, limit=5)
        self.assertEqual(result["total"], 7)
        self.assertEqual(self.api.calls("GET", "/tasks")[0]["path"], "/tasks?page=2&limit=5")

    def test_task_not_found(self):
        self.api.on("GET", "/tasks/nope", (404, {"error": {"code": "not_found", "message": "Task not found"}}))
        with self.assertRaises(ApiError) as cm:
            self.client.get_task("nope")
        self.assertEqual(cm.exception.code, "not_found")

    def test_download_streams_without_api_key(self):
        self.api.on("GET", "/out.mp4", (200, b"video-bytes" * 1000))
        with tempfile.TemporaryDirectory() as d:
            dest = os.path.join(d, "result.mp4")
            self.client.download(self.api.url + "/out.mp4", dest)
            self.assertEqual(os.path.getsize(dest), 11 * 1000)
        self.assertNotIn("Authorization", self.api.calls("GET", "/out.mp4")[0]["headers"])


if __name__ == "__main__":
    unittest.main()
