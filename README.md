# videoupscaler CLI

[![PyPI](https://img.shields.io/pypi/v/videoupscaler?label=PyPI)](https://pypi.org/project/videoupscaler/)
[![npm](https://img.shields.io/npm/v/videoupscaler?label=npm)](https://www.npmjs.com/package/videoupscaler)
[![Docker](https://img.shields.io/docker/v/videoupscaler/cli?label=Docker%20Hub&sort=semver)](https://hub.docker.com/r/videoupscaler/cli)
[![CI](https://github.com/arkyu2077/videoupscaler-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/arkyu2077/videoupscaler-cli/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/arkyu2077/videoupscaler-cli/blob/main/LICENSE)

Command-line client for the [VideoUpscaler](https://videoupscaler.co) API. Upscale a video file or URL to **1080p, 2K or 4K** with AI from your terminal, a script or a container, and download the result when it is done.

The CLI wraps the public REST API documented at [videoupscaler.co/docs](https://videoupscaler.co/docs). It has no dependencies: the Python package uses only the standard library, the npm package only Node's built-in `fetch`.

## Install

Pick any one:

```bash
# Python 3.9+ (PyPI)
pip install videoupscaler

# Node.js 18+ (npm)
npm install -g videoupscaler        # or run once: npx videoupscaler account

# Docker
docker pull videoupscaler/cli
```

## API key

1. Sign in to VideoUpscaler with an account that has bought credits or subscribed (the API is for paid accounts; see [pricing](https://videoupscaler.co/pricing)).
2. Open [Settings → API Keys](https://videoupscaler.co/sign-in?callbackUrl=%2Fsettings%2Fapikeys) and create a key. It is shown once and looks like `vu_live_…`.
3. Export it:

```bash
export VIDEOUPSCALER_API_KEY=vu_live_...
```

That environment variable is the only configuration. Keys spend your credits, so keep them out of shell history and repositories.

## Quickstart

```bash
# Balance and price per second
videoupscaler account

# Upscale a local file to 4K, wait for it and save the result
videoupscaler upscale clip.mp4 --resolution 4k --wait --out result.mp4

# Or a public video URL (S3/R2 signed links work; share pages don't)
videoupscaler upscale https://example.com/clip.mp4 --resolution 2k --wait

# Your recent tasks, including ones started on the website
videoupscaler tasks
```

With Docker, pass the key through and mount the folder that holds your videos:

```bash
docker run --rm -e VIDEOUPSCALER_API_KEY -v "$PWD:/work" videoupscaler/cli \
  upscale clip.mp4 --resolution 4k --wait --out result.mp4
```

## Commands

| Command | What it does |
| --- | --- |
| `videoupscaler account` | Credit balance and credits per second for each resolution (`GET /account`). |
| `videoupscaler upscale <file-or-url>` | Starts an upscale and prints the task. A local `.mp4`, `.mov` or `.webm` file (up to 100MB) is uploaded first (`POST /uploads` + `PUT`); a public `http(s)` URL (up to 500MB) is sent as is (`POST /upscale`). |
| `videoupscaler task <id>` | One task's status and `output_url` (`GET /tasks/{id}`). |
| `videoupscaler tasks` | Your tasks, newest first (`GET /tasks`). |

Options for `upscale` and `task`:

| Option | Meaning |
| --- | --- |
| `-r, --resolution 1080p\|2k\|4k` | Target resolution (default `4k`). |
| `-w, --wait` | Poll every 5 seconds until the task is `completed` or `failed`, then print `output_url`. |
| `-o, --out FILE` | Wait and save the upscaled video to `FILE`. |
| `--idempotency-key KEY` | Reuse the key printed by an earlier run (see below). |
| `--timeout SECONDS` | Stop waiting after this long (the task keeps running). |
| `--json` | Print the raw API response, for scripts. |

`tasks` takes `--limit 1-100` and `--page N`.

Exit codes: `0` success, `1` API error or failed task, `2` usage error (bad arguments, missing key, unsupported file).

### Credits and billing

Credits are charged when the task starts, per second of video rounded up: **1 credit/s at 1080p, 2 at 2K, 3 at 4K**. A 12.4-second clip costs 13, 26 or 39 credits. If processing fails the credits are refunded automatically. Check the price list with `videoupscaler account` and top up on the [pricing page](https://videoupscaler.co/pricing).

### Retries never charge twice

Every `upscale` sends an `Idempotency-Key` header. The CLI generates one per run, prints it, and reuses it on its own retries (network errors, `500`, `504`), so a retried request returns the task that was already created instead of charging again. If a run is interrupted, rerun it with `--idempotency-key <the printed key>` and the same source and resolution to pick up the same task.

A `502 upstream_error` means the task was created, could not start and was refunded; retry that one with a new key.

### Errors

Errors print as `error <code>: <message>` and exit `1`. Common codes:

| Code | Meaning |
| --- | --- |
| `unauthorized` | Missing or invalid key. Create one in [Settings → API Keys](https://videoupscaler.co/sign-in?callbackUrl=%2Fsettings%2Fapikeys). |
| `paid_plan_required` | The account has never bought credits. Buy any pack on the [pricing page](https://videoupscaler.co/pricing). |
| `insufficient_credits` | The balance cannot cover the whole video. |
| `video_too_long` | Over 1200 s at 1080p, or 600 s at 2K and 4K. |
| `unsupported_video` | Not a readable MP4, MOV or WebM, or its duration is missing. |
| `rate_limited` | About 120 requests per minute per key. The CLI waits `Retry-After` once. |

The full list is in the [errors reference](https://videoupscaler.co/docs/errors).

## Use it as a library

Python:

```python
from videoupscaler import Client

client = Client()  # reads VIDEOUPSCALER_API_KEY
task = client.upscale("https://example.com/clip.mp4", "4k", idempotency_key="order-1234")
task = client.wait(task["id"])
print(task["output_url"])
```

Node.js:

```js
import { Client } from 'videoupscaler';

const client = new Client(); // reads VIDEOUPSCALER_API_KEY
let task = await client.upscale('https://example.com/clip.mp4', '4k', { idempotencyKey: 'order-1234' });
task = await client.wait(task.id);
console.log(task.output_url);
```

Both clients expose the same methods: `getAccount` / `get_account`, `uploadFile` / `upload_file`, `upscale`, `getTask` / `get_task`, `listTasks` / `list_tasks`, `wait` and `download`. Set `VIDEOUPSCALER_API_URL` to point them at another base URL (tests use this).

## Links

- [VideoUpscaler](https://videoupscaler.co): the AI video upscaler behind this CLI.
- [Pricing and credits](https://videoupscaler.co/pricing).
- [API documentation](https://videoupscaler.co/docs): [create an upscale](https://videoupscaler.co/docs/upscale), [tasks](https://videoupscaler.co/docs/tasks), [uploads](https://videoupscaler.co/docs/uploads), [errors and limits](https://videoupscaler.co/docs/errors).
- [Video MCP server](https://videoupscaler.co/docs/mcp): the same operations for Claude Code, Cursor and VS Code.
- Guides: [4K video upscaler](https://videoupscaler.co/4k-video-upscaler), [enhance video quality](https://videoupscaler.co/enhance-video-quality), [upscale video to 1080p](https://videoupscaler.co/upscale-video-to-1080p), [video super resolution](https://videoupscaler.co/video-super-resolution).

## Development

```bash
PYTHONPATH=src python -m unittest discover -s tests   # Python tests (fake HTTP server, no network)
npm test                                               # Node tests (mocked fetch)
docker build -t videoupscaler-cli . && docker run --rm videoupscaler-cli --help
```

Tests never call the real API. Releases are published to PyPI, npm and Docker Hub by the `Release` workflow when a `v*` tag is pushed.

## License

[MIT](https://github.com/arkyu2077/videoupscaler-cli/blob/main/LICENSE)
