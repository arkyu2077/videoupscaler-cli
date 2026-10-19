import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { main } from '../lib/cli.js';
import { Client } from '../lib/client.js';
import { fakeFetch, task } from './fake.js';

const BASE = 'https://api.test/v1';
const TID = task().id;

function setup() {
  const fetch = fakeFetch();
  const run = async (...argv) => {
    let out = '';
    let err = '';
    const code = await main(argv, {
      clientFactory: () => new Client({ apiKey: 'vu_live_x', baseUrl: BASE, fetch, sleep: async () => {} }),
      stdout: (s) => (out += s),
      stderr: (s) => (err += s),
    });
    return { code, out, err };
  };
  return { fetch, run };
}

test('missing key is a usage error', async () => {
  delete process.env.VIDEOUPSCALER_API_KEY;
  let err = '';
  const code = await main(['account'], { stdout: () => {}, stderr: (s) => (err += s) });
  assert.equal(code, 2);
  assert.match(err, /VIDEOUPSCALER_API_KEY/);
});

test('help, version and unknown commands', async () => {
  const { run } = setup();
  assert.equal((await run('--help')).code, 0);
  assert.match((await run('--help')).out, /Usage: videoupscaler/);
  assert.equal((await run()).code, 2);
  assert.match((await run('--version')).out, /^videoupscaler 0\.1\.0\n$/);
  const r = await run('frobnicate');
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown command "frobnicate"/);
  assert.equal((await run('account', '--bogus')).code, 2);
});

test('account', async () => {
  const { fetch, run } = setup();
  fetch.on('GET', '/v1/account', [200, { credits: 1240, credits_per_second: { '1080p': 1, '2k': 2, '4k': 3 } }]);
  const r = await run('account');
  assert.equal(r.code, 0);
  assert.match(r.out, /Credits: 1240/);
  assert.match(r.out, /1080p=1  2k=2  4k=3/);
  assert.equal(JSON.parse((await run('account', '--json')).out).credits, 1240);
});

test('upscale a URL without waiting', async () => {
  const { fetch, run } = setup();
  fetch.on('POST', '/v1/upscale', [201, task()]);
  const r = await run('upscale', 'https://example.com/clip.mp4', '--resolution', '4k', '--idempotency-key', 'k1');
  assert.equal(r.code, 0);
  assert.match(r.err, /Idempotency-Key: k1/);
  assert.match(r.out, new RegExp(`videoupscaler task ${TID} --wait`));
  assert.equal(fetch.calls('POST', '/v1/upscale')[0].headers['idempotency-key'], 'k1');
});

test('upscale a file, wait and save', async () => {
  const { fetch, run } = setup();
  fetch.on('POST', '/v1/uploads', [201, {
    upload_url: 'https://worker.test/uploads/t', method: 'PUT', headers: { 'Content-Type': 'video/mp4' },
    video_url: 'https://storage.videoupscaler.co/videos/api/x.mp4', max_bytes: 3, expires_at: '2026-09-30T09:00:00.000Z',
  }]);
  fetch.on('PUT', '/uploads/t', [200, { video_url: 'https://storage.videoupscaler.co/videos/api/x.mp4' }]);
  fetch.on('POST', '/v1/upscale', [201, task({ video_url: 'https://storage.videoupscaler.co/videos/api/x.mp4' })]);
  fetch.on('GET', `/v1/tasks/${TID}`, [200, task({ status: 'processing' })], [200, task({ status: 'completed', output_url: 'https://cdn.test/out.mp4' })]);
  fetch.on('GET', '/out.mp4', [200, Buffer.from('RESULT'), { 'content-type': 'video/mp4' }]);
  const dir = await mkdtemp(join(tmpdir(), 'vu-'));
  const src = join(dir, 'clip.mp4');
  await writeFile(src, 'abc');
  const dest = join(dir, 'result.mp4');
  const r = await run('upscale', src, '-r', '1080p', '--out', dest);
  assert.equal(r.code, 0, r.err);
  assert.equal(String(await readFile(dest)), 'RESULT');
  assert.match(r.out, new RegExp(`Saved ${dest}`));
  assert.match(r.err, /Uploading/);
  assert.match(r.err, /status: processing/);
  assert.deepEqual(JSON.parse(fetch.calls('POST', '/v1/upscale')[0].body), { video_url: 'https://storage.videoupscaler.co/videos/api/x.mp4', resolution: '1080p' });
});

test('upscale --wait --json prints the final task only', async () => {
  const { fetch, run } = setup();
  fetch.on('POST', '/v1/upscale', [201, task()]);
  fetch.on('GET', `/v1/tasks/${TID}`, [200, task({ status: 'completed', output_url: 'https://cdn/out.mp4' })]);
  const r = await run('upscale', 'https://example.com/clip.mp4', '--wait', '--json');
  assert.equal(r.code, 0);
  const data = JSON.parse(r.out);
  assert.equal(data.status, 'completed');
  assert.equal(data.output_url, 'https://cdn/out.mp4');
  assert.equal(r.err, '');
});

test('a failed task exits 1', async () => {
  const { fetch, run } = setup();
  fetch.on('POST', '/v1/upscale', [201, task()]);
  fetch.on('GET', `/v1/tasks/${TID}`, [200, task({ status: 'failed', error: 'Unsupported codec' })]);
  const r = await run('upscale', 'https://example.com/clip.mp4', '--wait');
  assert.equal(r.code, 1);
  assert.match(r.err, /Failed: Unsupported codec/);
});

test('API errors exit 1 with the code; unauthorized adds a hint', async () => {
  const { fetch, run } = setup();
  fetch.on('POST', '/v1/upscale', [403, { error: { code: 'paid_plan_required', message: 'See https://videoupscaler.co/pricing' } }]);
  const r = await run('upscale', 'https://example.com/clip.mp4');
  assert.equal(r.code, 1);
  assert.match(r.err, /error paid_plan_required: See https:\/\/videoupscaler.co\/pricing/);
  fetch.on('GET', '/v1/account', [401, { error: { code: 'unauthorized', message: 'Missing or invalid API key.' } }]);
  const a = await run('account');
  assert.equal(a.code, 1);
  assert.match(a.err, /settings%2Fapikeys/);
});

test('a missing file is a usage error', async () => {
  const { run } = setup();
  const r = await run('upscale', '/no/such/clip.mp4');
  assert.equal(r.code, 2);
  assert.match(r.err, /not a file or an http\(s\) URL/);
});

test('task and tasks', async () => {
  const { fetch, run } = setup();
  fetch.on('GET', `/v1/tasks/${TID}`, [200, task({ status: 'completed', output_url: 'https://cdn/out.mp4' })]);
  const t = await run('task', TID);
  assert.deepEqual([t.code, t.out], [0, 'https://cdn/out.mp4\n']);
  fetch.on('GET', '/v1/tasks', [200, { data: [task({ status: 'completed', output_url: 'https://cdn/out.mp4' })], page: 1, limit: 20, total: 1, has_more: false }]);
  const l = await run('tasks');
  assert.equal(l.code, 0);
  assert.match(l.out, new RegExp(TID));
  assert.match(l.out, /completed/);
  assert.match(l.out, /page 1 of 1 tasks/);
  const j = await run('tasks', '--json', '--limit', '5');
  assert.equal(JSON.parse(j.out).total, 1);
  assert.equal(fetch.calls('GET', '/v1/tasks').at(-1).search, '?page=1&limit=5');
  assert.equal((await run('tasks', '--limit', 'x')).code, 2);
});
