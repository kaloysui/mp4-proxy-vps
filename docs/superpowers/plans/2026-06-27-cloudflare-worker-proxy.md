# Cloudflare Worker MP4 Proxy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Node.js/VPS proxy with a restricted Cloudflare Worker (`1embed.cc` only) that fixes 404/502 errors by handling trailing-slash routes, forwarding correct headers, supporting range requests, and rewriting `.m3u8` playlists.

**Architecture:** Single Worker entry point (`src/index.js`) plus `wrangler.toml`. The Worker validates origin/referer, proxies the `?url=` target with browser-like headers, rewrites HLS playlists, and streams responses back.

**Tech Stack:** Cloudflare Workers (workerd runtime), Wrangler CLI, vanilla JavaScript.

---

## Task 1: Clean up VPS files and scaffold Worker project

**Files:**
- Delete: `server.js`, `ecosystem.config.js`
- Modify: `package.json`
- Create: `wrangler.toml`, `src/index.js` (initial), `.gitignore` updates

- [ ] **Step 1: Remove VPS-only files**

```bash
rm server.js ecosystem.config.js
```

- [ ] **Step 2: Update package.json**

Replace the contents of `package.json` with:

```json
{
  "name": "mp4-proxy-worker",
  "version": "2.0.0",
  "description": "Cloudflare Worker MP4/HLS proxy for 1embed.cc",
  "main": "src/index.js",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy",
    "tail": "wrangler tail"
  },
  "devDependencies": {
    "wrangler": "^3.0.0"
  },
  "engines": {
    "node": ">=18"
  }
}
```

- [ ] **Step 3: Create wrangler.toml**

Create `wrangler.toml`:

```toml
name = "mp4-proxy"
main = "src/index.js"
compatibility_date = "2024-06-27"

# Update the route to your own domain/subdomain before deploying.
# Example pattern: "mp4-proxy.yourdomain.com/mp4-proxy*"
# routes = [
#   { pattern = "mp4-proxy.example.com/mp4-proxy*", custom_domain = true }
# ]
```

- [ ] **Step 4: Create src directory and initial index.js**

```bash
mkdir -p src
```

Create `src/index.js` as an empty file first, to be filled in Task 2.

- [ ] **Step 5: Update .gitignore**

Append to `.gitignore`:

```
.wrangler/
node_modules/
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: replace VPS scaffold with Cloudflare Worker"
```

---

## Task 2: Implement the Worker proxy

**Files:**
- Create/Modify: `src/index.js`

- [ ] **Step 1: Write src/index.js**

Replace the contents of `src/index.js` with:

```javascript
const ALLOWED_DOMAIN = '1embed.cc';
const ALLOWED_ORIGIN = `https://${ALLOWED_DOMAIN}`;

function isAllowed(request) {
  const origin = request.headers.get('origin') || '';
  const referer = request.headers.get('referer') || '';
  return origin.includes(ALLOWED_DOMAIN) || referer.includes(ALLOWED_DOMAIN);
}

function isM3u8(response, targetUrl) {
  const ct = (response.headers.get('content-type') || '').toLowerCase();
  return ct.includes('mpegurl') || ct.includes('x-mpegurl') || targetUrl.toLowerCase().includes('.m3u8');
}

function rewriteM3u8(text, baseUrl, proxyBase, ref, origin) {
  const lines = text.split('\n');
  const out = [];
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('#') || line.trim() === '') {
      out.push(line);
    } else {
      const absolute = line.startsWith('http') ? line : new URL(line, baseUrl).href;
      const params = new URLSearchParams({ url: absolute });
      if (ref) params.set('ref', ref);
      if (origin) params.set('origin', origin);
      out.push(`${proxyBase}/mp4-proxy?${params.toString()}`);
    }
  }
  return out.join('\n');
}

function errorResponse(message, status) {
  return new Response(message, {
    status,
    headers: {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
          'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          'Access-Control-Allow-Headers': 'Range, Content-Type, Origin, Referer',
          'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // Only allow GET/HEAD/OPTIONS
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      return errorResponse('Method not allowed', 405);
    }

    // Domain restriction
    if (!isAllowed(request)) {
      return errorResponse('Forbidden', 403);
    }

    // Accept /mp4-proxy and /mp4-proxy/
    if (url.pathname !== '/mp4-proxy' && url.pathname !== '/mp4-proxy/') {
      return errorResponse('Not found', 404);
    }

    const targetUrl = url.searchParams.get('url');
    if (!targetUrl) {
      return errorResponse('Missing url', 400);
    }

    let targetParsed;
    try {
      targetParsed = new URL(targetUrl);
    } catch {
      return errorResponse('Invalid URL', 400);
    }

    const customReferer = url.searchParams.get('ref');
    const customOrigin = url.searchParams.get('origin');
    const hostname = targetParsed.hostname;
    const clientRange = request.headers.get('Range') || '';
    const method = request.method === 'HEAD' ? 'HEAD' : 'GET';
    const proxyBase = `${url.protocol}//${url.host}`;

    const upstreamHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.5',
      'Referer': customReferer || `https://${hostname}/`,
      'Origin': customOrigin || `https://${hostname}`,
    };
    if (clientRange) upstreamHeaders['Range'] = clientRange;

    try {
      const resp = await fetch(targetUrl, { method, headers: upstreamHeaders });

      if (!resp.ok && resp.status !== 206) {
        return errorResponse(`Upstream error: ${resp.status}`, 502);
      }

      const responseHeaders = {
        'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
        'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type',
      };

      for (const h of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag', 'Last-Modified', 'Cache-Control']) {
        const v = resp.headers.get(h);
        if (v) responseHeaders[h] = v;
      }

      // HLS playlist rewrite
      if (method === 'GET' && isM3u8(resp, targetUrl)) {
        const text = await resp.text();
        const rewritten = rewriteM3u8(text, targetUrl, proxyBase, customReferer, customOrigin);
        responseHeaders['Content-Length'] = new TextEncoder().encode(rewritten).length.toString();
        return new Response(rewritten, { status: resp.status, headers: responseHeaders });
      }

      return new Response(resp.body, { status: resp.status, headers: responseHeaders });
    } catch (err) {
      return errorResponse(`Proxy failed: ${err.message}`, 502);
    }
  },
};
```

- [ ] **Step 2: Commit**

```bash
git add src/index.js
git commit -m "feat: add Cloudflare Worker proxy with 1embed restriction and m3u8 rewrite"
```

---

## Task 3: Add README and verify project structure

**Files:**
- Create: `README.md`
- Verify: `package.json`, `wrangler.toml`, `src/index.js`

- [ ] **Step 1: Write README.md**

Create `README.md`:

```markdown
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
```

- [ ] **Step 2: Verify files exist**

```bash
ls -la src/index.js wrangler.toml package.json README.md
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add README for Cloudflare Worker deployment"
```

---

## Task 4: Local smoke tests

**Files:**
- None (verification only)

- [ ] **Step 1: Install dependencies**

```bash
npm install
```

- [ ] **Step 2: Verify Wrangler is available**

```bash
npx wrangler --version
```

Expected output: a version number like `3.x.x`.

- [ ] **Step 3: Type-check / lint via Wrangler**

```bash
npx wrangler deploy --dry-run
```

Expected: no errors (it validates `src/index.js` and `wrangler.toml`).

- [ ] **Step 4: Start local dev server and run curl tests**

```bash
npx wrangler dev --local --port 8787 &
sleep 5
```

Test forbidden origin:

```bash
curl -i -H "Origin: https://evil.com" http://localhost:8787/mp4-proxy
```

Expected: `HTTP/1.1 403 Forbidden`.

Test missing url:

```bash
curl -i -H "Origin: https://1embed.cc" http://localhost:8787/mp4-proxy
```

Expected: `HTTP/1.1 400 Missing url`.

Test not found:

```bash
curl -i -H "Origin: https://1embed.cc" http://localhost:8787/other
```

Expected: `HTTP/1.1 404 Not found`.

Test trailing slash accepted:

```bash
curl -i -H "Origin: https://1embed.cc" "http://localhost:8787/mp4-proxy/?url=https://example.com/video.mp4"
```

Expected: `HTTP/1.1 200 OK` or `404` from upstream, but not `404` from the Worker itself.

Kill the dev server:

```bash
pkill -f "wrangler dev"
```

- [ ] **Step 5: Commit any final fixes**

If changes were made:

```bash
git add -A
git commit -m "fix: address smoke-test findings"
```

---

## Spec Coverage Check

| Spec Requirement | Plan Task |
|------------------|-----------|
| Replace VPS with Worker | Task 1 |
| Restrict to `1embed.cc` | Task 2 (`isAllowed`) |
| Handle `/mp4-proxy` and `/mp4-proxy/` | Task 2 (pathname check) |
| Fix 502 with correct headers | Task 2 (header construction) |
| Support range requests | Task 2 (forward `Range`) |
| Rewrite `.m3u8` playlists | Task 2 (`rewriteM3u8`) |
| Deployment config | Task 1 (`wrangler.toml`) |
| README docs | Task 3 |
| Smoke tests | Task 4 |

## Placeholder Scan

No TBD/TODO/"implement later" placeholders. All code is provided explicitly.
