import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ApiError, Client, UsageError, contentTypeFor } from '../lib/client.js';
import { fakeFetch, task } from './fake.js';

const BASE = 'https://api.test/v1';
const KEY = 'vu_live_testkey';

function setup() {
  const fetch = fakeFetch();
  const sleeps = [];
  const client = new Client({ apiKey: KEY, baseUrl: BASE, fetch, sleep: async (ms) => sleeps.push(ms) });
  return { fetch, sleeps, client };
}

test('requires an API key', () => {
  delete process.env.VIDEOUPSCALER_API_KEY;
  assert.throws(() => new Client({ fetch: fakeFetch() }), (e) => e instanceof UsageError && /VIDEOUPSCALER_API_KEY/.test(e.message));
});

test('account sends the bearer key', async () => {
  const { fetch, client } = setup();
  fetch.on('GET', '/v1/account', [200, { credits: 1240, credits_per_second: { '1080p': 1, '2k': 2, '4k': 3 } }]);
  const account = await client.getAccount();
  assert.equal(account.credits, 1240);
  assert.equal(fetch.calls('GET', '/v1/account')[0].headers.authorization, `Bearer ${KEY}`);
});

test('upscale sends the Idempotency-Key header and JSON body', async () => {
  const { fetch, client } = setup();
  fetch.on('POST', '/v1/upscale', [201, task()]);
  const result = await client.upscale('https://example.com/clip.mp4', '4K', { idempotencyKey: 'order-1' });
  const req = fetch.calls('POST', '/v1/upscale')[0];
  assert.equal(req.headers['idempotency-key'], 'order-1');
  assert.equal(req.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(req.body), { video_url: 'https://example.com/clip.mp4', resolution: '4k' });
  assert.equal(result.id, task().id);
  assert.equal(result.idempotency_key, 'order-1');
});

test('upscale generates a key when none is given', async () => {
  const { fetch, client } = setup();
  fetch.on('POST', '/v1/upscale', [201, task()]);
  const result = await client.upscale('https://example.com/clip.mp4', '1080p');
  assert.match(result.idempotency_key, /^cli-[0-9a-f]{32}$/);
  assert.equal(fetch.calls('POST', '/v1/upscale')[0].headers['idempotency-key'], result.idempotency_key);
});

test('upscale retries a 500 with the same key', async () => {
  const { fetch, sleeps, client } = setup();
  fetch.on('POST', '/v1/upscale', [500, { error: { code: 'internal_error', message: 'retry' } }], [200, task()]);
  const result = await client.upscale('https://example.com/clip.mp4', '2k');
  const calls = fetch.calls('POST', '/v1/upscale');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers['idempotency-key'], calls[1].headers['idempotency-key']);
  assert.equal(calls[1].headers['idempotency-key'], result.idempotency_key);
  assert.deepEqual(sleeps, [2000]);
});

test('upscale does not retry a 502', async () => {
  const { fetch, client } = setup();
  fetch.on('POST', '/v1/upscale', [502, { error: { code: 'upstream_error', message: 'Failed to start processing. Your credits were refunded.' } }]);
  await assert.rejects(client.upscale('https://example.com/clip.mp4', '2k'), (e) => e instanceof ApiError && e.status === 502 && e.code === 'upstream_error');
  assert.equal(fetch.calls('POST', '/v1/upscale').length, 1);
});

test('upscale gives up after the retries', async () => {
  const { fetch, sleeps, client } = setup();
  fetch.on('POST', '/v1/upscale', [504, { error: { code: 'upstream_timeout', message: 'slow' } }]);
  await assert.rejects(client.upscale('https://example.com/clip.mp4', '2k'), (e) => e.code === 'upstream_timeout');
  assert.equal(fetch.calls('POST', '/v1/upscale').length, 4);
  assert.deepEqual(sleeps, [2000, 4000, 6000]);
});

test('upscale rejects a bad resolution locally', async () => {
  const { fetch, client } = setup();
  await assert.rejects(client.upscale('https://example.com/clip.mp4', '8k'), UsageError);
  assert.equal(fetch.calls().length, 0);
});

test('error responses map to ApiError', async () => {
  const { fetch, client } = setup();
  fetch.on('POST', '/v1/upscale', [402, { error: { code: 'insufficient_credits', message: 'Not enough credits for this video. Buy credits to continue.' } }]);
  await assert.rejects(client.upscale('https://example.com/clip.mp4', '4k'), (e) => {
    assert.equal(e.status, 402);
    assert.equal(e.code, 'insufficient_credits');
    assert.equal(e.message, 'Not enough credits for this video. Buy credits to continue.');
    return true;
  });
});

test('non-JSON error bodies still map', async () => {
  const { fetch, client } = setup();
  fetch.on('GET', '/v1/account', [503, '<html>Service Unavailable</html>', { 'content-type': 'text/html' }]);
  await assert.rejects(client.getAccount(), (e) => e.code === 'http_503' && /Service Unavailable/.test(e.message));
});

test('429 waits Retry-After once', async () => {
  const { fetch, sleeps, client } = setup();
  fetch.on('GET', '/v1/account', [429, { error: { code: 'rate_limited', message: 'slow down' } }, { 'retry-after': '7' }], [200, { credits: 5 }]);
  assert.equal((await client.getAccount()).credits, 5);
  assert.deepEqual(sleeps, [7000]);
});

test('network errors are retried then reported', async () => {
  const sleeps = [];
  const client = new Client({
    apiKey: KEY,
    baseUrl: BASE,
    fetch: async () => { throw new TypeError('fetch failed', { cause: new Error('ECONNREFUSED') }); },
    sleep: async (ms) => sleeps.push(ms),
  });
  await assert.rejects(client.getAccount(), (e) => e.code === 'network_error' && /ECONNREFUSED/.test(e.message));
  assert.equal(sleeps.length, 3);
});

test('uploadFile PUTs the bytes without the API key', async () => {
  const { fetch, client } = setup();
  const dir = await mkdtemp(join(tmpdir(), 'vu-'));
  const path = join(dir, 'clip.mp4');
  await writeFile(path, Buffer.from('\0\0\0\x18ftypmp42'.repeat(100)));
  const { size } = await stat(path);
  fetch.on('POST', '/v1/uploads', [201, {
    upload_url: 'https://worker.test/uploads/token-1', method: 'PUT', headers: { 'Content-Type': 'video/mp4' },
    video_url: 'https://storage.videoupscaler.co/videos/api/abc.mp4', max_bytes: size, expires_at: '2026-09-30T09:00:00.000Z',
  }]);
  fetch.on('PUT', '/uploads/token-1', [200, { video_url: 'https://storage.videoupscaler.co/videos/api/abc.mp4' }]);
  const upload = await client.uploadFile(path);
  assert.equal(upload.video_url, 'https://storage.videoupscaler.co/videos/api/abc.mp4');
  assert.deepEqual(JSON.parse(fetch.calls('POST', '/v1/uploads')[0].body), { content_type: 'video/mp4', size });
  const put = fetch.calls('PUT', '/uploads/token-1')[0];
  assert.equal(put.headers['content-type'], 'video/mp4');
  assert.equal(put.headers.authorization, undefined);
  assert.equal(put.body.length, size);
});

test('uploadFile rejects unsupported and oversized files', async () => {
  const { fetch, client } = setup();
  const dir = await mkdtemp(join(tmpdir(), 'vu-'));
  const avi = join(dir, 'clip.avi');
  await writeFile(avi, 'x');
  await assert.rejects(client.uploadFile(avi), (e) => e instanceof UsageError && /Unsupported file type/.test(e.message));
  const big = join(dir, 'big.mov');
  await writeFile(big, '');
  await truncate(big, 100 * 1024 * 1024 + 1);
  await assert.rejects(client.uploadFile(big), (e) => e instanceof UsageError && /100MB/.test(e.message));
  assert.equal(fetch.calls().length, 0);
  assert.equal(contentTypeFor('a/b/CLIP.MOV'), 'video/quicktime');
  assert.equal(contentTypeFor('clip.webm'), 'video/webm');
});

test('wait polls until a terminal status', async () => {
  const { fetch, sleeps, client } = setup();
  const id = task().id;
  fetch.on('GET', `/v1/tasks/${id}`, [200, task({ status: 'queued' })], [200, task({ status: 'processing' })], [200, task({ status: 'completed', output_url: 'https://cdn/out.mp4' })]);
  const seen = [];
  const final = await client.wait(id, { onStatus: (t) => seen.push(t.status) });
  assert.equal(final.output_url, 'https://cdn/out.mp4');
  assert.deepEqual(seen, ['queued', 'processing', 'completed']);
  assert.deepEqual(sleeps, [5000, 5000]);
  assert.equal(fetch.calls('GET', `/v1/tasks/${id}`).length, 3);
});

test('wait times out', async () => {
  const { fetch, client } = setup();
  fetch.on('GET', `/v1/tasks/${task().id}`, [200, task({ status: 'processing' })]);
  await assert.rejects(client.wait(task().id, { timeout: 0 }), (e) => e.code === 'timeout');
});

test('listTasks builds the query and getTask 404s map', async () => {
  const { fetch, client } = setup();
  fetch.on('GET', '/v1/tasks', [200, { data: [task()], page: 2, limit: 5, total: 7, has_more: false }]);
  assert.equal((await client.listTasks({ page: 2, limit: 5 })).total, 7);
  assert.equal(fetch.calls('GET', '/v1/tasks')[0].search, '?page=2&limit=5');
  fetch.on('GET', '/v1/tasks/nope', [404, { error: { code: 'not_found', message: 'Task not found' } }]);
  await assert.rejects(client.getTask('nope'), (e) => e.code === 'not_found');
});

test('download streams to a file without the API key', async () => {
  const { fetch, client } = setup();
  fetch.on('GET', '/out.mp4', [200, Buffer.from('video-bytes'.repeat(1000)), { 'content-type': 'video/mp4' }]);
  const dest = join(await mkdtemp(join(tmpdir(), 'vu-')), 'result.mp4');
  await client.download('https://cdn.test/out.mp4', dest);
  assert.equal((await readFile(dest)).length, 11 * 1000);
  assert.equal(fetch.calls('GET', '/out.mp4')[0].headers.authorization, undefined);
});
