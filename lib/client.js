// Zero-dependency client for the VideoUpscaler REST API.
// Mirrors https://videoupscaler.co/docs: bearer API key, JSON bodies, the
// Idempotency-Key header on POST /upscale, and {"error": {"code", "message"}} on failure.

import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const DEFAULT_BASE_URL = 'https://videoupscaler.co/api/v1';
export const RESOLUTIONS = ['1080p', '2k', '4k'];
export const CONTENT_TYPES = { '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm' };
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const TERMINAL_STATUSES = ['completed', 'failed'];
// POST /upscale downloads the video before answering: allow up to 5 minutes.
const UPSCALE_TIMEOUT_MS = 300_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 5_000;
const RETRIES = 3;

export class ApiError extends Error {
  constructor(status, code, message, retryAfter = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

export function contentTypeFor(path) {
  const ext = extname(path).toLowerCase();
  if (!CONTENT_TYPES[ext]) {
    throw new UsageError(
      `Unsupported file type "${ext}": upload .mp4, .mov or .webm files, or host the video and pass its public URL.`
    );
  }
  return CONTENT_TYPES[ext];
}

export function newIdempotencyKey() {
  return 'cli-' + randomUUID().replaceAll('-', '');
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function parseError(res) {
  const text = await res.text().catch(() => '');
  let code = `http_${res.status}`;
  let message = text.trim().slice(0, 300) || `HTTP ${res.status}`;
  try {
    const { error } = JSON.parse(text);
    if (error && error.code && error.message) ({ code, message } = error);
  } catch {
    // not JSON
  }
  const header = res.headers.get('retry-after');
  const retryAfter = header && Number.isInteger(Number(header)) ? Number(header) : null;
  return new ApiError(res.status, code, message, retryAfter);
}

export class Client {
  /**
   * @param {object} [options]
   * @param {string} [options.apiKey]   defaults to $VIDEOUPSCALER_API_KEY
   * @param {string} [options.baseUrl]  defaults to $VIDEOUPSCALER_API_URL or the public API
   * @param {typeof fetch} [options.fetch]  injected in tests
   * @param {(ms: number) => Promise<void>} [options.sleep]
   */
  constructor({ apiKey, baseUrl, fetch: fetchImpl, sleep, userAgent } = {}) {
    this.apiKey = apiKey || process.env.VIDEOUPSCALER_API_KEY;
    if (!this.apiKey) {
      throw new UsageError(
        'VIDEOUPSCALER_API_KEY is not set. Create a key at ' +
          'https://videoupscaler.co/sign-in?callbackUrl=%2Fsettings%2Fapikeys ' +
          'and export it: export VIDEOUPSCALER_API_KEY=vu_live_...'
      );
    }
    this.baseUrl = (baseUrl || process.env.VIDEOUPSCALER_API_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetch = fetchImpl || globalThis.fetch;
    this.sleep = sleep || defaultSleep;
    this.userAgent = userAgent || 'videoupscaler-cli-node';
  }

  // One API call. Retries connection errors, 500 and 504 `retries` times with
  // the same request (and so the same Idempotency-Key); honours Retry-After on 429 once.
  async request(method, path, { body, headers, timeout = DEFAULT_TIMEOUT_MS, retries = 0 } = {}) {
    const url = this.baseUrl + path;
    const init = {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: 'application/json',
        'User-Agent': this.userAgent,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };
    let attempt = 0;
    let waited429 = false;
    for (;;) {
      attempt += 1;
      let err;
      try {
        const res = await this.fetch(url, { ...init, signal: AbortSignal.timeout(timeout) });
        if (res.ok) return res.status === 204 ? null : await res.json();
        err = await parseError(res);
      } catch (e) {
        err = new ApiError(0, 'network_error', `Could not reach ${url} (${e.cause?.message || e.message})`);
      }
      if (err.status === 429 && !waited429) {
        waited429 = true;
        await this.sleep(Math.min(err.retryAfter || 1, 60) * 1000);
        continue;
      }
      if ([0, 500, 504].includes(err.status) && attempt <= retries) {
        await this.sleep(2000 * attempt);
        continue;
      }
      throw err;
    }
  }

  /** GET /account -> {credits, credits_per_second} */
  getAccount() {
    return this.request('GET', '/account', { retries: RETRIES });
  }

  /** POST /uploads -> signed PUT target and the video_url to upscale */
  createUpload(contentType, size) {
    return this.request('POST', '/uploads', { body: { content_type: contentType, size }, retries: RETRIES });
  }

  /** Upload a local file: POST /uploads, then PUT the bytes. Returns the upload record. */
  async uploadFile(path) {
    const contentType = contentTypeFor(path);
    const { size } = await stat(path);
    if (size <= 0) throw new UsageError(`${path} is empty`);
    if (size > MAX_UPLOAD_BYTES) {
      throw new UsageError(
        `${path} is ${size} bytes; uploads are limited to 100MB. Host the file and pass its public URL instead (up to 500MB).`
      );
    }
    const upload = await this.createUpload(contentType, size);
    const data = await readFile(path);
    let res;
    try {
      res = await this.fetch(upload.upload_url, {
        method: upload.method || 'PUT',
        headers: { 'Content-Type': contentType, ...upload.headers },
        body: data,
        signal: AbortSignal.timeout(UPSCALE_TIMEOUT_MS),
      });
    } catch (e) {
      throw new ApiError(0, 'network_error', `Upload failed (${e.cause?.message || e.message})`);
    }
    if (!res.ok) throw await parseError(res);
    return upload;
  }

  /**
   * POST /upscale. Charges credits and returns the task. The same idempotency
   * key is sent on every retry, so a timeout or a 500 never charges twice; the
   * key used is returned as task.idempotency_key.
   */
  async upscale(videoUrl, resolution, { idempotencyKey } = {}) {
    resolution = String(resolution).toLowerCase();
    if (!RESOLUTIONS.includes(resolution)) throw new UsageError(`resolution must be one of ${RESOLUTIONS.join(', ')}`);
    const key = idempotencyKey || newIdempotencyKey();
    const task = await this.request('POST', '/upscale', {
      body: { video_url: videoUrl, resolution },
      headers: { 'Idempotency-Key': key },
      timeout: UPSCALE_TIMEOUT_MS,
      retries: RETRIES,
    });
    return { ...task, idempotency_key: key };
  }

  /** GET /tasks/{id} */
  getTask(id) {
    return this.request('GET', `/tasks/${encodeURIComponent(id)}`, { retries: RETRIES });
  }

  /** GET /tasks?page=&limit= (newest first) */
  listTasks({ page = 1, limit = 20 } = {}) {
    return this.request('GET', `/tasks?${new URLSearchParams({ page, limit })}`, { retries: RETRIES });
  }

  /** Poll GET /tasks/{id} until completed or failed. */
  async wait(id, { timeout, interval = POLL_INTERVAL_MS, onStatus } = {}) {
    const deadline = timeout == null ? null : Date.now() + timeout;
    let last;
    for (;;) {
      const task = await this.getTask(id);
      if (onStatus && task.status !== last) onStatus(task);
      last = task.status;
      if (TERMINAL_STATUSES.includes(last)) return task;
      if (deadline !== null && Date.now() >= deadline) {
        throw new ApiError(0, 'timeout', `Task ${id} is still ${last} after ${timeout / 1000}s`);
      }
      await this.sleep(interval);
    }
  }

  /** Save a result (output_url) to dest. No API key is sent. */
  async download(url, dest) {
    let res;
    try {
      res = await this.fetch(url, { headers: { 'User-Agent': this.userAgent } });
    } catch (e) {
      throw new ApiError(0, 'network_error', `Download failed (${e.cause?.message || e.message})`);
    }
    if (!res.ok) throw new ApiError(res.status, 'download_failed', `Could not download ${url} (HTTP ${res.status})`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
    return resolve(dest);
  }
}
