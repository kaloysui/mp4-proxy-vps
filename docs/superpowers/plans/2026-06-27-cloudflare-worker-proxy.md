# Cloudflare Worker MP4 Proxy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Node.js/VPS proxy with a restricted Cloudflare Worker (`1embed.cc` only) that proxies **MP4 only** and fixes upstream 502/403 errors for some users via retry-once logic and randomized User-Agent strings.

**Architecture:** Single Worker entry point (`src/index.js`) plus `wrangler.toml`. Validates origin/referer, proxies `?url=` target with randomized browser headers, retries once on 403/5xx, and streams responses back.

**Tech Stack:** Cloudflare Workers, Wrangler CLI, vanilla JavaScript.

---

## Task 1: Update Worker implementation for MP4-only + retry + UA rotation

**Files:**
- Modify: `src/index.js`
- Update: `README.md` (remove m3u8 mentions)

- [ ] **Step 1: Rewrite src/index.js**

Replace the contents of `src/index.js` with:

```javascript
const ALLOWED_DOMAIN = '1embed.cc';
const ALLOWED_ORIGIN = `https://${ALLOWED_DOMAIN}`;

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36',
];

function randomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function isAllowedHost(value) {
  if (!value) return false;
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === ALLOWED_DOMAIN || host.endsWith(`.${ALLOWED_DOMAIN}`);
  } catch {
    return false;
  }
}

function isAllowed(request) {
  const origin = request.headers.get('origin') || '';
  const referer = request.headers.get('referer') || '';
  return isAllowedHost(origin) || isAllowedHost(referer);
}

function errorResponse(message, status) {
  return new Response(message, {
    status,
    headers: {
      'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}

function buildUpstreamHeaders(targetUrl, request, userAgent, customReferer, customOrigin) {
  const hostname = new URL(targetUrl).hostname;
  const headers = {
    'User-Agent': userAgent,
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.5',
    'Referer': customReferer || `https://${hostname}/`,
    'Origin': customOrigin || `https://${hostname}`,
  };
  const clientRange = request.headers.get('Range');
  if (clientRange) headers['Range'] = clientRange;
  return headers;
}

async function fetchUpstream(targetUrl, request, userAgent, customReferer, customOrigin) {
  const headers = buildUpstreamHeaders(targetUrl, request, userAgent, customReferer, customOrigin);
  return fetch(targetUrl, {
    method: request.method === 'HEAD' ? 'HEAD' : 'GET',
    headers,
  });
}

function shouldRetry(status) {
  return status === 403 || (status >= 500 && status <= 599);
}

function forwardResponseHeaders(resp) {
  const responseHeaders = {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type',
  };
  for (const h of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag', 'Last-Modified', 'Cache-Control']) {
    const v = resp.headers.get(h);
    if (v) responseHeaders[h] = v;
  }
  return responseHeaders;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

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

    if (!['GET', 'HEAD'].includes(request.method)) {
      return errorResponse('Method not allowed', 405);
    }

    if (!isAllowed(request)) {
      return errorResponse('Forbidden', 403);
    }

    if (url.pathname !== '/mp4-proxy' && url.pathname !== '/mp4-proxy/') {
      return errorResponse('Not found', 404);
    }

    const targetUrl = url.searchParams.get('url');
    if (!targetUrl) {
      return errorResponse('Missing url', 400);
    }

    try {
      new URL(targetUrl);
    } catch {
      return errorResponse('Invalid URL', 400);
    }

    const customReferer = url.searchParams.get('ref');
    const customOrigin = url.searchParams.get('origin');

    try {
      let resp = await fetchUpstream(targetUrl, request, randomUserAgent(), customReferer, customOrigin);

      if (shouldRetry(resp.status)) {
        resp = await fetchUpstream(targetUrl, request, randomUserAgent(), customReferer, customOrigin);
      }

      if (!resp.ok && resp.status !== 206) {
        return errorResponse(`Upstream error: ${resp.status}`, resp.status >= 500 ? 502 : resp.status);
      }

      return new Response(resp.body, {
        status: resp.status,
        headers: forwardResponseHeaders(resp),
      });
    } catch (err) {
      return errorResponse(`Proxy failed: ${err.message}`, 502);
    }
  },
};
```

- [ ] **Step 2: Update README.md**

Replace m3u8/HLS references with MP4-only language. The README should say the Worker proxies MP4 video files only and does not rewrite playlists.

- [ ] **Step 3: Run Wrangler dry-run**

```bash
npx wrangler deploy --dry-run
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/index.js README.md
npm run deploy --dry-run  # sanity check
```

If dry-run passes:

```bash
git commit -m "feat: switch Worker to MP4-only with retry and User-Agent rotation"
```

---

## Task 2: Smoke-test retry and UA rotation

**Files:**
- None (verification only)

- [ ] **Step 1: Start local dev server**

```bash
npx wrangler dev --local --port 8787 &
sleep 5
```

- [ ] **Step 2: Run smoke tests**

Forbidden origin:

```bash
curl -i -H "Origin: https://evil1embed.cc" http://localhost:8787/mp4-proxy
```

Expected: `403 Forbidden`.

Missing url:

```bash
curl -i -H "Origin: https://1embed.cc" http://localhost:8787/mp4-proxy
```

Expected: `400 Missing url`.

Trailing slash accepted (upstream may 502/404, but Worker route must not 404):

```bash
curl -i -H "Origin: https://1embed.cc" "http://localhost:8787/mp4-proxy/?url=https://example.com/video.mp4"
```

Expected: status is NOT `404` from the Worker itself.

Range request:

```bash
curl -i -H "Origin: https://1embed.cc" -H "Range: bytes=0-1023" "http://localhost:8787/mp4-proxy?url=https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4"
```

Expected: `206 Partial Content` (if upstream supports ranges).

- [ ] **Step 3: Verify random User-Agent**

There is no direct curl output for User-Agent, but verify via Wrangler logs or by checking that multiple requests to an upstream that blocks one UA can succeed. At minimum confirm the code uses `randomUserAgent()`.

- [ ] **Step 4: Stop dev server**

```bash
pkill -f "wrangler dev"
```

- [ ] **Step 5: Commit if any fixes**

If smoke tests required changes:

```bash
git add -A
git commit -m "fix: smoke-test corrections"
```

---

## Spec Coverage Check

| Spec Requirement | Plan Task |
|------------------|-----------|
| Replace VPS with Worker | Previous commits / Task 1 |
| Restrict to `1embed.cc` | Task 1 (`isAllowedHost`) |
| MP4 only (no m3u8) | Task 1 (remove rewrite logic) |
| Random User-Agent rotation | Task 1 (`USER_AGENTS`, `randomUserAgent`) |
| Retry once on 403/5xx | Task 1 (`shouldRetry`, second `fetchUpstream`) |
| Handle `/mp4-proxy` and `/mp4-proxy/` | Task 1 (pathname check) |
| Forward `Range` header | Task 1 (`buildUpstreamHeaders`) |
| Smoke tests | Task 2 |

## Placeholder Scan

No TBD/TODO placeholders. All code is provided explicitly.
