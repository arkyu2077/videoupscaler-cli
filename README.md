# videoupscaler CLI

[![PyPI](https://img.shields.io/pypi/v/videoupscaler?label=PyPI)](https://pypi.org/project/videoupscaler/)
[![npm](https://img.shields.io/npm/v/videoupscaler?label=npm)](https://www.npmjs.com/package/videoupscaler)
[![GHCR](https://img.shields.io/badge/GHCR-ghcr.io%2Farkyu2077%2Fvideoupscaler-blue)](https://github.com/arkyu2077/videoupscaler-cli/pkgs/container/videoupscaler)
[![Docker](https://img.shields.io/docker/v/videoupscaler/cli?label=Docker%20Hub&sort=semver)](https://hub.docker.com/r/videoupscaler/cli)
[![CI](https://github.com/arkyu2077/videoupscaler-cli/actions/workflows/ci.yml/badge.svg)](https://github.com/arkyu2077/videoupscaler-cli/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://github.com/arkyu2077/videoupscaler-cli/blob/main/LICENSE)

Command-line client and SDK for the [VideoUpscaler](https://videoupscaler.co) API. Upscale a video file or URL to **1080p, 2K or 4K** with AI from your terminal, a script or a container, and download the result when it is done.

Whether you need a [4K video upscaler](https://videoupscaler.co/4k-video-upscaler) for production assets, a [batch video upscaler](https://videoupscaler.co/batch-video-upscaler) for multi-clip pipelines, or specialized AI tools to [denoise video](https://videoupscaler.co/denoise-video), run [AI frame interpolation](https://videoupscaler.co/frame-interpolation) (60fps/120fps), and [stabilize shaky video](https://videoupscaler.co/stabilize-video), `videoupscaler` brings studio-grade video enhancement to your CLI and CI/CD workflows.

The CLI wraps the public REST API documented at [videoupscaler.co/docs](https://videoupscaler.co/docs). It has no dependencies: the Python package uses only the standard library, the npm package only Node's built-in `fetch`.

## Install

Pick any one:

```bash
# Python 3.9+ (PyPI)
pip install videoupscaler

# Node.js 18+ (npm)
npm install -g videoupscaler        # or run once: npx videoupscaler account

# Docker (GitHub Container Registry or Docker Hub)
docker pull ghcr.io/arkyu2077/videoupscaler:latest
docker pull videoupscaler/cli
```

## API key

1. Sign in to [VideoUpscaler](https://videoupscaler.co) with an account that has bought credits or subscribed (the API is for paid accounts; see [pricing](https://videoupscaler.co/pricing)).
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

With Docker (GHCR or Docker Hub), pass the key through and mount the folder that holds your videos:

```bash
docker run --rm -e VIDEOUPSCALER_API_KEY -v "$PWD:/work" ghcr.io/arkyu2077/videoupscaler:latest \
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

## Ecosystem & Integrations

- **[VideoUpscaler](https://videoupscaler.co)**: The AI video enhancement platform behind this CLI.
- **Core AI Video Tools**:
  - [4K Video Upscaler](https://videoupscaler.co/4k-video-upscaler): Upscale SD/HD footage to crisp 4K UHD with AI super-resolution.
  - [Batch Video Upscaler](https://videoupscaler.co/batch-video-upscaler): Process multiple videos concurrently in automated pipelines.
  - [AI Video Denoiser](https://videoupscaler.co/denoise-video): Clean up low-light grain, compression artifacts, and sensor noise.
  - [AI Frame Interpolation](https://videoupscaler.co/frame-interpolation): Convert 24/30fps footage into smooth 60fps or 120fps slow-motion.
  - [AI Video Stabilizer](https://videoupscaler.co/stabilize-video): Remove camera shake from handheld, drone, or action footage.
- **Workflow & CI/CD Automation**:
  - [Workflow Integrations Hub](https://videoupscaler.co/integrations): Ready-to-import templates for n8n, Make, Zapier, and cloud storage pipelines.
  - [Workflow Automation Documentation](https://videoupscaler.co/docs/workflows): End-to-end guides on webhook polling, idempotency, and R2/S3 integration.
  - [`n8n-nodes-videoupscaler` on npm](https://www.npmjs.com/package/n8n-nodes-videoupscaler): Official n8n community node ([GitHub repository](https://github.com/arkyu2077/n8n-nodes-videoupscaler)).
  - [`videoupscaler-action` on GitHub](https://github.com/arkyu2077/videoupscaler-action): Official GitHub Action for automated 1080p/2K/4K video upscaling in CI/CD workflows.
  - [Video MCP Server](https://videoupscaler.co/docs/mcp): Model Context Protocol server for Claude Code, Cursor, and VS Code.
- **API & Guides**:
  - [API Documentation](https://videoupscaler.co/docs): [Create an upscale](https://videoupscaler.co/docs/upscale), [Tasks](https://videoupscaler.co/docs/tasks), [Uploads](https://videoupscaler.co/docs/uploads), [Errors and limits](https://videoupscaler.co/docs/errors), [Pricing and credits](https://videoupscaler.co/pricing).
  - Additional guides: [Enhance video quality](https://videoupscaler.co/enhance-video-quality), [Upscale video to 1080p](https://videoupscaler.co/upscale-video-to-1080p), [Video super resolution](https://videoupscaler.co/video-super-resolution).

## Development

```bash
PYTHONPATH=src python -m unittest discover -s tests   # Python tests (fake HTTP server, no network)
npm test                                               # Node tests (mocked fetch)
docker build -t videoupscaler-cli . && docker run --rm videoupscaler-cli --help
```

Tests never call the real API. Releases are published to PyPI, npm, GHCR and Docker Hub by the `Release` and `GHCR` workflows when a `v*` tag is pushed.

## License

[MIT](https://github.com/arkyu2077/videoupscaler-cli/blob/main/LICENSE)
