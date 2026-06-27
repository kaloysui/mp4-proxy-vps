const ALLOWED_DOMAIN = '1embed.cc';
const ALLOWED_ORIGIN = `https://${ALLOWED_DOMAIN}`;

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

function isM3u8(response, targetUrl) {
  const ct = (response.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('mpegurl') || ct.includes('x-mpegurl')) return true;
  try {
    return new URL(targetUrl).pathname.toLowerCase().endsWith('.m3u8');
  } catch {
    return false;
  }
}

function rewriteM3u8(text, baseUrl, proxyBase, ref, origin) {
  const lines = text.split('\n');
  const out = [];
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('#') || line.trim() === '') {
      out.push(line);
    } else {
      const absolute = /^https?:\/\//i.test(line) ? line : new URL(line, baseUrl).href;
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
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
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
