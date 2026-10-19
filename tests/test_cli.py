import contextlib
import io
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(__file__))
from fake_api import FakeApi, task  # noqa: E402

from videoupscaler import Client  # noqa: E402
from videoupscaler.cli import main  # noqa: E402

TID = task()["id"]


class CliTest(unittest.TestCase):
    def setUp(self):
        self.api = FakeApi().__enter__()
        self.addCleanup(self.api.__exit__, None, None, None)
        self.factory = lambda: Client(api_key="vu_live_x", base_url=self.api.url, sleep=lambda s: None)

    def run_cli(self, *argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = main(list(argv), client_factory=self.factory)
        return code, out.getvalue(), err.getvalue()

    def test_missing_key_is_a_usage_error(self):
        os.environ.pop("VIDEOUPSCALER_API_KEY", None)
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = main(["account"])
        self.assertEqual(code, 2)
        self.assertIn("VIDEOUPSCALER_API_KEY", err.getvalue())

    def test_account(self):
        self.api.on("GET", "/account", (200, {"credits": 1240, "credits_per_second": {"1080p": 1, "2k": 2, "4k": 3}}))
        code, out, _ = self.run_cli("account")
        self.assertEqual(code, 0)
        self.assertIn("Credits: 1240", out)
        self.assertIn("1080p=1  2k=2  4k=3", out)
        code, out, _ = self.run_cli("account", "--json")
        self.assertEqual(json.loads(out)["credits"], 1240)

    def test_upscale_url_without_wait(self):
        self.api.on("POST", "/upscale", (201, task()))
        code, out, err = self.run_cli("upscale", "https://example.com/clip.mp4", "--resolution", "4k", "--idempotency-key", "k1")
        self.assertEqual(code, 0)
        self.assertIn("Idempotency-Key: k1", err)
        self.assertIn("videoupscaler task %s --wait" % TID, out)
        self.assertEqual(self.api.calls("POST", "/upscale")[0]["headers"]["Idempotency-Key"], "k1")

    def test_upscale_file_wait_and_save(self):
        self.api.on("POST", "/uploads", (201, {
            "upload_url": self.api.url + "/put/t", "method": "PUT", "headers": {"Content-Type": "video/mp4"},
            "video_url": "https://storage.videoupscaler.co/videos/api/x.mp4", "max_bytes": 3, "expires_at": "2026-09-30T09:00:00.000Z"}))
        self.api.on("PUT", "/put/t", (200, {"video_url": "https://storage.videoupscaler.co/videos/api/x.mp4"}))
        self.api.on("POST", "/upscale", (201, task(video_url="https://storage.videoupscaler.co/videos/api/x.mp4")))
        self.api.on("GET", "/tasks/" + TID, (200, task(status="processing")),
                    (200, task(status="completed", output_url=self.api.url + "/out.mp4")))
        self.api.on("GET", "/out.mp4", (200, b"RESULT"))
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "clip.mp4")
            with open(src, "wb") as f:
                f.write(b"abc")
            dest = os.path.join(d, "result.mp4")
            code, out, err = self.run_cli("upscale", src, "-r", "1080p", "--out", dest)
            self.assertEqual(code, 0, err)
            with open(dest, "rb") as f:
                self.assertEqual(f.read(), b"RESULT")
            self.assertIn("Saved " + dest, out)
        self.assertIn("Uploading", err)
        self.assertIn("status: processing", err)
        body = json.loads(self.api.calls("POST", "/upscale")[0]["body"])
        self.assertEqual(body, {"video_url": "https://storage.videoupscaler.co/videos/api/x.mp4", "resolution": "1080p"})

    def test_upscale_wait_json_prints_final_task(self):
        self.api.on("POST", "/upscale", (201, task()))
        self.api.on("GET", "/tasks/" + TID, (200, task(status="completed", output_url="https://cdn/out.mp4")))
        code, out, err = self.run_cli("upscale", "https://example.com/clip.mp4", "--wait", "--json")
        self.assertEqual(code, 0)
        data = json.loads(out)
        self.assertEqual(data["status"], "completed")
        self.assertEqual(data["output_url"], "https://cdn/out.mp4")
        self.assertEqual(err, "")

    def test_failed_task_exits_1(self):
        self.api.on("POST", "/upscale", (201, task()))
        self.api.on("GET", "/tasks/" + TID, (200, task(status="failed", error="Unsupported codec")))
        code, out, err = self.run_cli("upscale", "https://example.com/clip.mp4", "--wait")
        self.assertEqual(code, 1)
        self.assertIn("Failed: Unsupported codec", err)

    def test_api_error_exits_1_with_code(self):
        self.api.on("POST", "/upscale", (403, {"error": {"code": "paid_plan_required", "message": "See https://videoupscaler.co/pricing"}}))
        code, _, err = self.run_cli("upscale", "https://example.com/clip.mp4")
        self.assertEqual(code, 1)
        self.assertIn("error paid_plan_required: See https://videoupscaler.co/pricing", err)

    def test_unauthorized_hint(self):
        self.api.on("GET", "/account", (401, {"error": {"code": "unauthorized", "message": "Missing or invalid API key."}}))
        code, _, err = self.run_cli("account")
        self.assertEqual(code, 1)
        self.assertIn("settings%2Fapikeys", err)

    def test_missing_file_is_usage_error(self):
        code, _, err = self.run_cli("upscale", "/no/such/clip.mp4")
        self.assertEqual(code, 2)
        self.assertIn("not a file or an http(s) URL", err)

    def test_task_and_tasks(self):
        self.api.on("GET", "/tasks/" + TID, (200, task(status="completed", output_url="https://cdn/out.mp4")))
        code, out, _ = self.run_cli("task", TID)
        self.assertEqual((code, out.strip()), (0, "https://cdn/out.mp4"))
        self.api.on("GET", "/tasks", (200, {"data": [task(status="completed", output_url="https://cdn/out.mp4")], "page": 1, "limit": 20, "total": 1, "has_more": False}))
        code, out, _ = self.run_cli("tasks")
        self.assertEqual(code, 0)
        self.assertIn(TID, out)
        self.assertIn("completed", out)
        self.assertIn("page 1 of 1 tasks", out)
        code, out, _ = self.run_cli("tasks", "--json", "--limit", "5")
        self.assertEqual(json.loads(out)["total"], 1)
        self.assertIn("limit=5", self.api.calls("GET", "/tasks")[-1]["path"])

    def test_version(self):
        with self.assertRaises(SystemExit) as cm:
            with contextlib.redirect_stdout(io.StringIO()):
                main(["--version"])
        self.assertEqual(cm.exception.code, 0)


if __name__ == "__main__":
    unittest.main()
