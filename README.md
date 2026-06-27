# MP4 Proxy Worker

Cloudflare Worker that proxies MP4/HLS video requests. Restricted to `1embed.cc` origin/referer.

## Endpoints

- `GET /mp4-proxy?url=<target>` — proxy a video or HLS playlist.
- `HEAD /mp4-proxy?url=<target>` — proxy headers only.
- `OPTIONS /mp4-proxy` — CORS preflight.

## Query parameters

- `url` (required) — target URL to proxy.
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
- `.m3u8` playlists are rewritten so segment URLs also pass through this proxy.
