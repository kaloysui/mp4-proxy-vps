# Cloudflare Worker MP4 Proxy — Design Spec

## Goal
Replace the Node.js/VPS proxy with a Cloudflare Worker that proxies MP4 video requests from `1embed.cc` only, fixing intermittent upstream errors (502/403/404) seen by some users through retry-once logic and randomized browser User-Agent strings.

## Non-Goals
- Keep the VPS server running.
- Support HLS / `.m3u8` playlists or `.ts` segments.
- Support origins other than `1embed.cc`.
- Add authentication, analytics, or billing.

## Architecture
Single Worker entry point (`src/index.js`) mounted at `/mp4-proxy*`. The Worker validates the request origin/referer, proxies the target MP4 URL with randomized browser-like headers, retries once on 403/5xx, and streams responses back.

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
Only allow requests where `Origin` or `Referer` resolves to `1embed.cc` or a subdomain (`*.1embed.cc`). Return `Access-Control-Allow-Origin: https://1embed.cc` on all responses. Case-insensitive.

### Target URL
Read `?url=...`. Required; return `400 Missing url` if absent. Parse with `new URL()`; return `400 Invalid URL` on failure.

### Upstream Request Headers
- `User-Agent`: randomly chosen from a small list of realistic desktop/mobile browser strings.
- `Accept`: `*/*`.
- `Accept-Language`: `en-US,en;q=0.5`.
- `Referer`: `?ref=` parameter or `https://<target-hostname>/`.
- `Origin`: `?origin=` parameter or `https://<target-hostname>`.
- `Range`: forwarded from client if present.
- Do **not** set `Accept-Encoding`, `Connection`, or `Host` manually.

### Retry Logic
- If upstream responds with status `403` or `5xx`, perform **one retry** using a different random `User-Agent` and the same headers.
- If the retry still fails, return the final upstream status.
- `404` is **not** retried (the resource is missing/expired).

### Response Handling
- If upstream status is 200–299 or 206, stream body back with:
  - `Access-Control-Allow-Origin: https://1embed.cc`
  - `Access-Control-Expose-Headers: Content-Length, Content-Range, Accept-Ranges, Content-Type`
  - Forwarded: `Content-Type`, `Content-Length`, `Content-Range`, `Accept-Ranges`, `ETag`, `Last-Modified`, `Cache-Control`.
- If upstream status is 403/5xx and retry also fails, return the upstream status with plain-text body.
- On fetch exception, return `502 Proxy failed: <message>`.

### Error Responses
All error responses include:
- `Access-Control-Allow-Origin: https://1embed.cc`
- `Access-Control-Allow-Methods: GET, HEAD, OPTIONS`
- Plain-text body
- Correct HTTP status

## Deployment
- `wrangler.toml` configured with Worker name `mp4-proxy` and route pattern `mp4-proxy.example.com/mp4-proxy*` (domain to be updated during deployment).
- Scripts: `npm run dev`, `npm run deploy`.

## Testing
- `npm run dev` + `curl` smoke tests from allowed/forbidden origins.
- Verify 206 range request.
- Verify 403/502 retry behavior.
- Verify 403 from non-`1embed.cc` origin.
