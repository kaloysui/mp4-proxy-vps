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
