// A scripted fetch() that plays the VideoUpscaler API in tests.
export function fakeFetch() {
  const script = new Map();
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method || 'GET';
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ method, url: String(url), path: u.pathname, search: u.search, headers, body: init.body });
    const steps = script.get(`${method} ${u.pathname}`);
    const [status, body, resHeaders] = steps ? (steps.length > 1 ? steps.shift() : steps[0]) : [404, { error: { code: 'not_found', message: `No route ${method} ${u.pathname}` } }, {}];
    const payload = body instanceof Uint8Array || typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(payload, { status, headers: { 'content-type': 'application/json', ...resHeaders } });
  };
  fetch.on = (method, path, ...responses) => {
    script.set(`${method} ${path}`, responses.map((r) => (r.length === 3 ? r : [r[0], r[1], {}])));
    return fetch;
  };
  fetch.calls = (method, path) => calls.filter((c) => (!method || c.method === method) && (!path || c.path === path));
  return fetch;
}

export function task(overrides = {}) {
  return {
    id: '0b6f3c1e-8a52-5d1e-9c43-3f1d2e7a9b10',
    status: 'processing',
    resolution: '4k',
    video_url: 'https://example.com/clip.mp4',
    duration_seconds: 12.4,
    processed_seconds: 12.4,
    credits_charged: 39,
    watermark: false,
    output_url: null,
    thumbnail_url: null,
    error: null,
    created_at: '2026-09-30T08:00:00.000Z',
    updated_at: '2026-09-30T08:00:02.000Z',
    ...overrides,
  };
}
