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

function errorResponse(message, status) {
  return new Response(message, {
    status,
    headers: {
      'Access-Control-Allow-Origin': '*', // Permissive CORS
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}

function buildUpstreamHeaders(targetUrl, request, userAgent, customReferer, customOrigin) {
  // Use passed customReferer/Origin, otherwise fallback to target host
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

function forwardResponseHeaders(resp) {
  const responseHeaders = {
    'Access-Control-Allow-Origin': '*', // Permissive CORS
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type, ETag, Last-Modified, Cache-Control',
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
          'Access-Control-Allow-Origin': '*',
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
      // Direct fetch without retry logic to reduce latency, assuming better header handling fixes the 403
      let resp = await fetchUpstream(targetUrl, request, randomUserAgent(), customReferer, customOrigin);

      // Return response regardless of status, let the client handle it, 
      // but ensure headers are passed for 200/206/etc.
      return new Response(resp.body, {
        status: resp.status,
        headers: forwardResponseHeaders(resp),
      });
    } catch (err) {
      return errorResponse(`Proxy failed: ${err.message}`, 502);
    }
  },
};
