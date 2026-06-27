# MP4 Proxy Worker

Cloudflare Worker that proxies MP4 video requests. Restricted to `1embed.cc` origin/referer.

## Endpoints

- `GET /mp4-proxy?url=<target>` — proxy an MP4 video.
- `HEAD /mp4-proxy?url=<target>` — proxy headers only.
- `OPTIONS /mp4-proxy` — CORS preflight.

## Query parameters

- `url` (required) — target MP4 URL to proxy.
- `ref` (optional) — custom `Referer` sent upstream.
- `origin` (optional) — custom `Origin` sent upstream.

## Local development

```bash
npm install
npm run dev
```

## Deploy

1. Update the route pattern in `wrangler.toml` to your domain.
2. Run:

```bash
npm run deploy
```

## Notes

- Only requests from `1embed.cc` are allowed.
- MP4 video files only — HLS / `.m3u8` playlists are not supported and are not rewritten.
- Upstream `User-Agent` is randomly rotated from a small list of realistic desktop and mobile browser strings on every request.
- On upstream `403` or `5xx` responses, the Worker retries once with a different random `User-Agent`. `404` responses are not retried.
