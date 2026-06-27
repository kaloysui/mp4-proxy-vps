# Cloudflare Worker MP4 Proxy — Design Spec

## Goal
Replace the existing Node.js/VPS proxy with a Cloudflare Worker that proxies MP4/HLS requests from `1embed.cc` only, fixing intermittent 404/502 errors seen by some users.

## Non-Goals
- Keep the VPS server running (this is a replacement, not an add-on).
- Support origins other than `1embed.cc`.
- Add authentication, analytics, or billing.

## Architecture
Single Worker entry point (`src/index.js`) mounted at `/mp4-proxy*`. The Worker validates the request origin/referer, proxies the target URL with headers tailored for video/CDN origins, rewrites `.m3u8` playlist segments so they continue to flow through the proxy, and forwards range/response headers correctly.

## File Structure
```
mp4-proxy-vps/
├── wrangler.toml
├── package.json          (updated: wrangler scripts, dev dependency)
├── src/
│   └── index.js          (worker entry)
├── README.md             (deployment + usage notes)
└── .gitignore            (add .wrangler/)
```

## Behavior

### Route & Method Handling
- `OPTIONS` → CORS preflight, allowed methods `GET, HEAD, OPTIONS`.
- `GET` / `HEAD` on `/mp4-proxy` or `/mp4-proxy/` → proxy target.
- Any other pathname → `404 Not found`.
- Any non-allowed origin/referer → `403 Forbidden`.

### Domain Restriction
Only allow requests where `Origin` or `Referer` contains `1embed.cc`. Return `Access-Control-Allow-Origin: https://1embed.cc` on all responses.

### Target URL
Read `?url=...`. Required; return `400 Missing url` if absent. Parse with `new URL()`; return `400 Invalid URL` on failure.

### Upstream Request Headers
- `User-Agent`: realistic desktop browser string.
- `Accept`: `*/*`.
- `Accept-Language`: `en-US,en;q=0.5`.
- `Referer`: `?ref=` parameter or `https://<target-hostname>/`.
- `Origin`: `?origin=` parameter or `https://<target-hostname>`.
- `Range`: forwarded from client if present.
- Do **not** set `Accept-Encoding`, `Connection`, or `Host` manually.

### Response Handling
- If upstream status is 200–299 or 206, stream body back with:
  - `Access-Control-Allow-Origin: https://1embed.cc`
  - `Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges, Content-Type`
  - Forwarded: `Content-Type`, `Content-Length`, `Content-Range`, `Accept-Ranges`, `ETag`, `Last-Modified`, `Cache-Control`.
- If response is an HLS playlist (`.m3u8` or `content-type` contains `mpegurl`), rewrite absolute/relative segment URLs to pass through `/mp4-proxy` with original `ref`/`origin` params.
- If upstream status is not OK/206, return `502 Upstream error: <status>`.
- On fetch exception, return `502 Proxy failed: <message>`.

### Error Responses
All error responses include:
- `Access-Control-Allow-Origin: https://1embed.cc`
- Plain-text body
- Correct HTTP status

## Deployment
- `wrangler.toml` configured with Worker name `mp4-proxy` and route pattern `mp4-proxy.example.com/mp4-proxy*` (domain to be updated during deployment).
- Scripts: `npm run dev`, `npm run deploy`.

## Testing
- `npm run dev` + `curl` smoke tests from allowed/forbidden origins.
- Verify 206 range request.
- Verify `.m3u8` playlist rewriting.
- Verify 403 from non-`1embed.cc` origin.
