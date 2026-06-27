# MP4 Proxy Performance Optimization Design

## Goal
Make the proxy in `server.js` faster and reduce CPU load while preserving existing behavior (CORS, domain restriction, M3U8 rewriting, binary streaming).

## Current Bottlenecks
1. **Full M3U8 buffering** — `resp.text()` loads the entire playlist into memory before responding.
2. **No connection reuse** — built-in `fetch` creates new upstream connections per request.
3. **Synchronous string rewriting** — `split('\n')`, per-line `URL()` and `URLSearchParams` allocation is CPU-heavy.
4. **Stream wrapping overhead** — `Readable.fromWeb(body).pipe(res)` adds an extra layer.
5. **No compression** — M3U8 and other text responses are sent uncompressed.
6. **Single-core usage** — only one CPU core is used because there is no clustering.

## Selected Approach: Performance-first (Approach B)
Use `undici` for connection pooling, streaming M3U8 rewrite, `compression` middleware, and Node.js `cluster` module for multi-core usage.

## Architecture
- Keep `server.js` as the single entry point.
- Add a `cluster` wrapper at the top: the primary process forks one worker per CPU core.
- Workers run the HTTP server.
- Use `undici` `Dispatcher`/`Pool` for upstream HTTP requests with keep-alive and connection reuse.
- Use `compression` middleware to gzip/brotli text responses (M3U8, JSON, etc.).
- Rewrite M3U8 playlists using a `stream.Transform` so the response streams line-by-line instead of buffering the whole file.
- Stream binary responses (MP4, TS, etc.) directly from `undici` to the client.

## Dependencies
- `undici` — high-performance HTTP client with pooling and pipelining support.
- `compression` — Express/Connect-compatible compression middleware.

## Core Changes

### 1. Clustering
```js
const cluster = require('cluster');
const os = require('os');

if (cluster.isPrimary) {
  const numWorkers = process.env.WORKERS || os.availableParallelism();
  for (let i = 0; i < numWorkers; i++) cluster.fork();
  cluster.on('exit', (worker) => {
    console.error(`Worker ${worker.process.pid} died, restarting...`);
    cluster.fork();
  });
  return;
}
```

### 2. Upstream HTTP Client (undici)
Create one `undici.Pool` per upstream hostname or a single `Agent` with connection pooling:
```js
const { Agent, request } = require('undici');
const agent = new Agent({
  connect: { timeout: 30000 },
  bodyTimeout: 0,
  headersTimeout: 30000,
  keepAliveMaxTimeout: 600000,
});
```
Use `request(targetUrl, { method, headers, dispatcher: agent })` instead of `fetch`.

### 3. Streaming M3U8 Rewrite
Implement a `stream.Transform` that processes chunks line-by-line:
- Buffer partial lines between chunks.
- For each complete line:
  - If it starts with `#` or is empty, pass through.
  - Otherwise rewrite the URL into a proxied URL.
- Write the rewritten line to the output.

This avoids loading the whole playlist into memory and avoids `URLSearchParams` allocation per line by using string concatenation for the proxy URL.

### 4. Binary Streaming
Pipe the `undici` response body directly to `res` without `Readable.fromWeb()`.

### 5. Compression
Wrap the response handler with the `compression` middleware so M3U8 and other text responses are compressed.

### 6. Response Headers
Continue forwarding the same headers as before: `content-type`, `content-length`, `content-range`, `accept-ranges`, `etag`, `last-modified`, `cache-control`.
Set `Access-Control-Allow-Origin: https://1embed.cc` and handle OPTIONS preflight.

## Error Handling
- Invalid/missing `url` query → 400.
- Domain not allowed → 403.
- Unknown path → 404.
- Upstream timeout or connection error → 502.
- Worker crash → primary restarts the worker.

## Testing Plan
1. Functional tests:
   - OPTIONS preflight returns 204 with correct CORS headers.
   - Forbidden origin returns 403.
   - Missing/invalid `url` returns 400.
   - M3U8 proxy rewrites `.ts` and sub-playlist URLs.
   - Binary proxy (MP4/TS) streams with correct status and headers.
2. Load test (optional):
   - Use `autocannon` or `ab` to compare throughput before and after.

## PM2 Configuration
Update `ecosystem.config.js` to use all CPU cores:
```js
module.exports = {
  apps: [{
    name: 'mp4-proxy',
    script: 'server.js',
    env: { PORT: 8080 },
    instances: 'max',
    exec_mode: 'cluster',
    max_memory_restart: '128M',
  }],
};
```

## Risks / Trade-offs
- Adding `undici` and `compression` increases bundle size.
- Clustering adds process management complexity.
- Streaming rewrite must correctly handle lines split across chunk boundaries.
