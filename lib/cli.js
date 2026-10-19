import { createRequire } from 'node:module';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { ApiError, Client, RESOLUTIONS, UsageError } from './client.js';

const { version } = createRequire(import.meta.url)('../package.json');

export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;

const USAGE = `Usage: videoupscaler <command> [options]

Upscale videos to 1080p, 2K or 4K with the VideoUpscaler API (https://videoupscaler.co/docs).

Commands:
  account                      show your credit balance and prices
  upscale <file-or-url>        upscale a .mp4/.mov/.webm file (up to 100MB) or a public URL (up to 500MB)
  task <id>                    show one task
  tasks                        list your tasks, newest first

Options for upscale / task:
  -r, --resolution <res>       1080p, 2k or 4k (default: 4k)
  -w, --wait                   poll until the task completes and print output_url
  -o, --out <file>             wait and save the result to <file>
      --idempotency-key <key>  reuse a key printed by an earlier run so a retry is never charged twice
      --timeout <seconds>      give up waiting after this long

Options for tasks:
      --limit <n>              tasks per page, 1-100 (default: 20)
      --page <n>               page number (default: 1)

Global:
      --json                   print the raw API response as JSON
  -h, --help                   show this help
  -V, --version                print the version

Set VIDEOUPSCALER_API_KEY to an API key from https://videoupscaler.co/sign-in?callbackUrl=%2Fsettings%2Fapikeys
`;

const OPTIONS = {
  json: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', short: 'V', default: false },
  resolution: { type: 'string', short: 'r', default: '4k' },
  wait: { type: 'boolean', short: 'w', default: false },
  out: { type: 'string', short: 'o' },
  'idempotency-key': { type: 'string' },
  timeout: { type: 'string' },
  limit: { type: 'string', default: '20' },
  page: { type: 'string', default: '1' },
};

const isUrl = (s) => /^https?:\/\//i.test(s);
const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);
const describe = (t) =>
  [t.resolution || '?', t.duration_seconds != null ? `${t.duration_seconds}s` : null, t.credits_charged != null ? `${t.credits_charged} credits` : null]
    .filter(Boolean)
    .join(', ');

function toInt(name, value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new UsageError(`--${name} must be a positive integer`);
  return n;
}

async function finish(client, task, opts, io) {
  const json = (d) => io.stdout(JSON.stringify(d, null, 2) + '\n');
  if (opts.wait || opts.out) {
    task = await client.wait(task.id, {
      timeout: opts.timeout == null ? undefined : Number(opts.timeout) * 1000,
      onStatus: opts.json ? undefined : (t) => io.stderr(`status: ${t.status}\n`),
    });
  }
  if (task.status === 'failed') {
    if (opts.json) json(task);
    else io.stderr(`Failed: ${task.error || 'processing failed'} (credits refunded)\n`);
    return EXIT_ERROR;
  }
  if (task.status === 'completed' && opts.out) {
    await client.download(task.output_url, opts.out);
    task.saved_to = resolve(opts.out);
  }
  if (opts.json) {
    json(task);
    return EXIT_OK;
  }
  if (task.status === 'completed') {
    io.stdout(opts.out ? `Saved ${task.saved_to}\n` : `${task.output_url}\n`);
  } else {
    io.stdout(`Task ${task.id}: ${task.status} (${describe(task)})\nCheck progress: videoupscaler task ${task.id} --wait\n`);
  }
  return EXIT_OK;
}

const commands = {
  async account(client, { opts }, io) {
    const account = await client.getAccount();
    if (opts.json) {
      io.stdout(JSON.stringify(account, null, 2) + '\n');
      return EXIT_OK;
    }
    const prices = account.credits_per_second || {};
    io.stdout(`Credits: ${account.credits}\n`);
    io.stdout('Per second: ' + RESOLUTIONS.filter((r) => r in prices).map((r) => `${r}=${prices[r]}`).join('  ') + '\n');
    return EXIT_OK;
  },

  async upscale(client, { opts, positionals }, io) {
    const source = positionals[0];
    if (!source) throw new UsageError('upscale needs a file or an http(s) URL');
    if (!RESOLUTIONS.includes(opts.resolution)) throw new UsageError(`--resolution must be one of ${RESOLUTIONS.join(', ')}`);
    let videoUrl = source;
    if (!isUrl(source)) {
      const info = await stat(source).catch(() => null);
      if (!info || !info.isFile()) throw new UsageError(`${source} is not a file or an http(s) URL`);
      if (!opts.json) io.stderr(`Uploading ${source} (${fmtSize(info.size)})...\n`);
      const upload = await client.uploadFile(source);
      videoUrl = upload.video_url;
      if (!opts.json) io.stderr(`Uploaded: ${videoUrl}\n`);
    }
    const task = await client.upscale(videoUrl, opts.resolution, { idempotencyKey: opts['idempotency-key'] });
    if (!opts.json) io.stderr(`Task ${task.id}: ${task.status} (${describe(task)})\nIdempotency-Key: ${task.idempotency_key}\n`);
    return finish(client, task, opts, io);
  },

  async task(client, { opts, positionals }, io) {
    if (!positionals[0]) throw new UsageError('task needs a task id');
    return finish(client, await client.getTask(positionals[0]), opts, io);
  },

  async tasks(client, { opts }, io) {
    const result = await client.listTasks({ page: toInt('page', opts.page), limit: toInt('limit', opts.limit) });
    if (opts.json) {
      io.stdout(JSON.stringify(result, null, 2) + '\n');
      return EXIT_OK;
    }
    const rows = result.data || [];
    if (!rows.length) {
      io.stdout('No tasks yet.\n');
      return EXIT_OK;
    }
    const line = (c) => `${c[0].padEnd(36)}  ${c[1].padEnd(10)}  ${c[2].padEnd(5)}  ${c[3].padStart(7)}  ${c[4].padStart(7)}  ${c[5].padEnd(20)}  ${c[6]}\n`;
    io.stdout(line(['ID', 'STATUS', 'RES', 'SECS', 'CREDITS', 'CREATED', 'OUTPUT']));
    for (const t of rows) {
      io.stdout(
        line([
          String(t.id ?? ''),
          String(t.status ?? ''),
          String(t.resolution ?? ''),
          t.duration_seconds != null ? String(t.duration_seconds) : '',
          t.credits_charged != null ? String(t.credits_charged) : '',
          String(t.created_at ?? '').slice(0, 19).replace('T', ' '),
          t.output_url || t.error || '',
        ])
      );
    }
    io.stdout(`page ${result.page} of ${result.total} tasks${result.has_more ? ' (more available)' : ''}\n`);
    return EXIT_OK;
  },
};

/**
 * Run the CLI. Returns the exit code; never throws.
 * @param {string[]} argv
 * @param {{clientFactory?: () => Client, stdout?: (s: string) => void, stderr?: (s: string) => void}} [deps]
 */
export async function main(argv, deps = {}) {
  const io = {
    stdout: deps.stdout || ((s) => process.stdout.write(s)),
    stderr: deps.stderr || ((s) => process.stderr.write(s)),
  };
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (e) {
    io.stderr(`error: ${e.message}\n${USAGE}`);
    return EXIT_USAGE;
  }
  const { values: opts, positionals } = parsed;
  if (opts.version) {
    io.stdout(`videoupscaler ${version}\n`);
    return EXIT_OK;
  }
  const [command, ...rest] = positionals;
  if (opts.help || !command) {
    io.stdout(USAGE);
    return command || opts.help ? EXIT_OK : EXIT_USAGE;
  }
  if (!commands[command]) {
    io.stderr(`error: unknown command "${command}"\n${USAGE}`);
    return EXIT_USAGE;
  }
  try {
    const client = (deps.clientFactory || (() => new Client()))();
    return await commands[command](client, { opts, positionals: rest }, io);
  } catch (e) {
    if (e instanceof UsageError) {
      io.stderr(`error: ${e.message}\n`);
      return EXIT_USAGE;
    }
    if (e instanceof ApiError) {
      io.stderr(e.status ? `error ${e.code}: ${e.message}\n` : `error: ${e.message}\n`);
      if (e.code === 'unauthorized') {
        io.stderr('Create a key at https://videoupscaler.co/sign-in?callbackUrl=%2Fsettings%2Fapikeys and export VIDEOUPSCALER_API_KEY.\n');
      }
      return EXIT_ERROR;
    }
    throw e;
  }
}
