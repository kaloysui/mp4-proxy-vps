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

// Dynamically return requesting Origin or '*' so all domains are allowed
function getCorsOrigin(request) {
  const origin = request.headers.get('origin');
  return origin ? origin : '*';
}

function errorResponse(message, status, request) {
  return new Response(message, {
    status,
    headers: {
      'Access-Control-Allow-Origin': request ? getCorsOrigin(request) : '*',
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

function forwardResponseHeaders(resp, request) {
  const responseHeaders = {
    'Access-Control-Allow-Origin': getCorsOrigin(request),
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

    // Handle Preflight OPTIONS requests for all origins
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': getCorsOrigin(request),
          'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
          'Access-Control-Allow-Headers': 'Range, Content-Type, Origin, Referer',
          'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    if (!['GET', 'HEAD'].includes(request.method)) {
      return errorResponse('Method not allowed', 405, request);
    }

    // Path validation
    if (url.pathname !== '/mp4-proxy' && url.pathname !== '/mp4-proxy/') {
      return errorResponse('Not found', 404, request);
    }

    const targetUrl = url.searchParams.get('url');
    if (!targetUrl) {
      return errorResponse('Missing url', 400, request);
    }

    try {
      new URL(targetUrl);
    } catch {
      return errorResponse('Invalid URL', 400, request);
    }

    const customReferer = url.searchParams.get('ref');
    const customOrigin = url.searchParams.get('origin');

    try {
      let resp = await fetchUpstream(targetUrl, request, randomUserAgent(), customReferer, customOrigin);

      if (shouldRetry(resp.status)) {
        resp = await fetchUpstream(targetUrl, request, randomUserAgent(), customReferer, customOrigin);
      }

      if (!resp.ok && resp.status !== 206) {
        return errorResponse(`Upstream error: ${resp.status}`, resp.status, request);
      }

      return new Response(resp.body, {
        status: resp.status,
        headers: forwardResponseHeaders(resp, request),
      });
    } catch (err) {
      return errorResponse(`Proxy failed: ${err.message}`, 502, request);
    }
  },
};
