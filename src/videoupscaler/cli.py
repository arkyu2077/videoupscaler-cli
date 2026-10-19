"""``videoupscaler`` command-line interface."""

import argparse
import json
import os
import sys

from videoupscaler import __version__
from videoupscaler.client import RESOLUTIONS, ApiError, Client, UsageError

EXIT_OK, EXIT_ERROR, EXIT_USAGE = 0, 1, 2


def _is_url(value):
    return value.lower().startswith(("http://", "https://"))


def _fmt_size(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return "%.1f %s" % (n, unit) if unit != "B" else "%d B" % n
        n /= 1024.0


def _print_json(data):
    print(json.dumps(data, indent=2, sort_keys=True))


def _describe(task):
    bits = [task.get("resolution") or "?"]
    if task.get("duration_seconds") is not None:
        bits.append("%ss" % task["duration_seconds"])
    if task.get("credits_charged") is not None:
        bits.append("%s credits" % task["credits_charged"])
    return ", ".join(bits)


def _status(task):
    print("status: %s" % task.get("status"), file=sys.stderr)


def _finish(client, task, args):
    """Wait (if asked), download (if asked) and print the final task. Returns the exit code."""
    if args.wait or args.out:
        task = client.wait(task["id"], timeout=args.timeout, on_status=None if args.json else _status)
    if task.get("status") == "failed":
        if args.json:
            _print_json(task)
        else:
            print("Failed: %s (credits refunded)" % (task.get("error") or "processing failed"), file=sys.stderr)
        return EXIT_ERROR
    if task.get("status") == "completed" and args.out:
        client.download(task["output_url"], args.out)
        task["saved_to"] = os.path.abspath(args.out)
    if args.json:
        _print_json(task)
        return EXIT_OK
    if task.get("status") == "completed":
        if args.out:
            print("Saved %s" % task["saved_to"])
        else:
            print(task["output_url"])
    else:
        print("Task %s: %s (%s)" % (task["id"], task.get("status"), _describe(task)))
        print("Check progress: videoupscaler task %s --wait" % task["id"])
    return EXIT_OK


def cmd_account(client, args):
    account = client.get_account()
    if args.json:
        _print_json(account)
        return EXIT_OK
    print("Credits: %s" % account.get("credits"))
    prices = account.get("credits_per_second") or {}
    print("Per second: " + "  ".join("%s=%s" % (r, prices.get(r)) for r in RESOLUTIONS if r in prices))
    return EXIT_OK


def cmd_upscale(client, args):
    source = args.source
    if _is_url(source):
        video_url = source
    else:
        if not os.path.isfile(source):
            raise UsageError("%s is not a file or an http(s) URL" % source)
        if not args.json:
            print("Uploading %s (%s)..." % (source, _fmt_size(os.path.getsize(source))), file=sys.stderr)
        upload = client.upload_file(source)
        video_url = upload["video_url"]
        if not args.json:
            print("Uploaded: %s" % video_url, file=sys.stderr)
    task = client.upscale(video_url, args.resolution, idempotency_key=args.idempotency_key)
    if not args.json:
        print("Task %s: %s (%s)" % (task["id"], task.get("status"), _describe(task)), file=sys.stderr)
        print("Idempotency-Key: %s" % task["idempotency_key"], file=sys.stderr)
    return _finish(client, task, args)


def cmd_task(client, args):
    task = client.get_task(args.id)
    return _finish(client, task, args)


def cmd_tasks(client, args):
    result = client.list_tasks(page=args.page, limit=args.limit)
    if args.json:
        _print_json(result)
        return EXIT_OK
    rows = result.get("data") or []
    if not rows:
        print("No tasks yet.")
        return EXIT_OK
    print("%-36s  %-10s  %-5s  %7s  %7s  %-20s  %s" % ("ID", "STATUS", "RES", "SECS", "CREDITS", "CREATED", "OUTPUT"))
    for t in rows:
        print(
            "%-36s  %-10s  %-5s  %7s  %7s  %-20s  %s"
            % (
                t.get("id"),
                t.get("status"),
                t.get("resolution") or "",
                t.get("duration_seconds") if t.get("duration_seconds") is not None else "",
                t.get("credits_charged") if t.get("credits_charged") is not None else "",
                (t.get("created_at") or "")[:19].replace("T", " "),
                t.get("output_url") or (t.get("error") or ""),
            )
        )
    print("page %s of %s tasks%s" % (result.get("page"), result.get("total"), " (more available)" if result.get("has_more") else ""))
    return EXIT_OK


def build_parser():
    parser = argparse.ArgumentParser(
        prog="videoupscaler",
        description="Upscale videos to 1080p, 2K or 4K with the VideoUpscaler API (https://videoupscaler.co/docs).",
        epilog="Set VIDEOUPSCALER_API_KEY to an API key from https://videoupscaler.co/sign-in?callbackUrl=%%2Fsettings%%2Fapikeys",
    )
    parser.add_argument("--version", action="version", version="videoupscaler " + __version__)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--json", action="store_true", help="print the raw API response as JSON")
    sub = parser.add_subparsers(dest="command", metavar="<command>")
    sub.required = True

    sub.add_parser("account", parents=[common], help="show your credit balance and prices").set_defaults(run=cmd_account)

    p = sub.add_parser("upscale", parents=[common], help="upscale a local file or a public video URL")
    p.add_argument("source", metavar="FILE_OR_URL", help="a .mp4/.mov/.webm file (up to 100MB) or a public http(s) URL (up to 500MB)")
    p.add_argument("--resolution", "-r", choices=RESOLUTIONS, default="4k", help="target resolution (default: 4k)")
    p.add_argument("--wait", "-w", action="store_true", help="poll until the task completes and print output_url")
    p.add_argument("--out", "-o", metavar="FILE", help="wait and save the result to FILE")
    p.add_argument("--idempotency-key", metavar="KEY", help="reuse a key printed by an earlier run so a retry is never charged twice")
    p.add_argument("--timeout", type=float, metavar="SECONDS", help="give up waiting after this long")
    p.set_defaults(run=cmd_upscale)

    p = sub.add_parser("task", parents=[common], help="show one task")
    p.add_argument("id")
    p.add_argument("--wait", "-w", action="store_true", help="poll until the task completes")
    p.add_argument("--out", "-o", metavar="FILE", help="wait and save the result to FILE")
    p.add_argument("--timeout", type=float, metavar="SECONDS", help="give up waiting after this long")
    p.set_defaults(run=cmd_task)

    p = sub.add_parser("tasks", parents=[common], help="list your tasks, newest first")
    p.add_argument("--limit", type=int, default=20, help="tasks per page, 1-100 (default: 20)")
    p.add_argument("--page", type=int, default=1, help="page number (default: 1)")
    p.set_defaults(run=cmd_tasks)
    return parser


def main(argv=None, client_factory=Client):
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        client = client_factory()
        return args.run(client, args)
    except UsageError as e:
        print("error: %s" % e, file=sys.stderr)
        return EXIT_USAGE
    except ApiError as e:
        print("error %s: %s" % (e.code, e.message) if e.status else "error: %s" % e.message, file=sys.stderr)
        if e.code == "unauthorized":
            print("Create a key at https://videoupscaler.co/sign-in?callbackUrl=%2Fsettings%2Fapikeys and export VIDEOUPSCALER_API_KEY.", file=sys.stderr)
        return EXIT_ERROR
    except KeyboardInterrupt:
        print("interrupted", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
