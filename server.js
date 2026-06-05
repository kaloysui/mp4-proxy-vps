const http = require('http');
const { parse: parseUrl } = require('url');
const { Readable } = require('stream');

const PORT = process.env.PORT || 3000;
const ALLOWED_DOMAIN = '1embed.cc';

// Check if request comes from the allowed domain
function isAllowed(req) {
  const origin = req.headers['origin'] || '';
  const referer = req.headers['referer'] || '';
  return origin.includes(ALLOWED_DOMAIN) || referer.includes(ALLOWED_DOMAIN);
}

function isM3u8(resp, targetUrl) {
  const ct = (resp.headers.get('content-type') || '').toLowerCase();
  return ct.includes('mpegurl') || ct.includes('x-mpegurl') || targetUrl.includes('.m3u8');
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

http.createServer(async (req, res) => {
  // CORS preflight — allow only 1embed.cc
  if (req.method === 'OPTIONS') {
    const allowedOrigin = isAllowed(req) ? 'https://1embed.cc' : 'https://1embed.cc';
    res.writeHead(204, {
      'Access-Control-Allow-Origin': 'https://1embed.cc',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Range, Content-Type, Origin, Referer',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }

  // Domain restriction — only 1embed.cc can use this proxy
  if (!isAllowed(req)) {
    res.writeHead(403, { 'Access-Control-Allow-Origin': 'https://1embed.cc' });
    return res.end('Forbidden');
  }

  const parsedUrl = parseUrl(req.url, true);
  if (parsedUrl.pathname !== '/mp4-proxy') {
    res.writeHead(404, { 'Access-Control-Allow-Origin': 'https://1embed.cc' });
    return res.end('Not found');
  }

  const targetUrl = parsedUrl.query.url;
  if (!targetUrl) {
    res.writeHead(400, { 'Access-Control-Allow-Origin': 'https://1embed.cc' });
    return res.end('Missing url');
  }

  let targetParsed;
  try { targetParsed = new URL(targetUrl); } catch {
    res.writeHead(400, { 'Access-Control-Allow-Origin': 'https://1embed.cc' });
    return res.end('Invalid URL');
  }

  const customReferer = parsedUrl.query.ref;
  const customOrigin = parsedUrl.query.origin;
  const hostname = targetParsed.hostname;
  const clientRange = req.headers['range'] || '';
  const method = req.method === 'HEAD' ? 'HEAD' : 'GET';
  const proxyBase = `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers.host}`;

  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': '*/*',
      'Accept-Language': 'en-US,en;q=0.5',
      'Referer': customReferer || `https://${hostname}/`,
      'Origin': customOrigin || `https://${hostname}`,
    };
    if (clientRange) headers['Range'] = clientRange;

    const resp = await fetch(targetUrl, { method, headers });

    if (resp.ok || resp.status === 206) {
      const responseHeaders = { 'Access-Control-Allow-Origin': 'https://1embed.cc' };
      const forward = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'cache-control'];
      responseHeaders['Cache-Control'] = 'public, max-age=3600';
      for (const h of forward) {
        const v = resp.headers.get(h);
        if (v) responseHeaders[h] = v;
      }

      if (method === 'HEAD') {
        res.writeHead(resp.status, responseHeaders);
        return res.end();
      }

      // M3U8 playlist rewrite — pass ref/origin so TS URLs keep the chain
      if (isM3u8(resp, targetUrl)) {
        const text = await resp.text();
        const rewritten = rewriteM3u8(text, targetUrl, proxyBase, customReferer, customOrigin);
        responseHeaders['Content-Length'] = Buffer.byteLength(rewritten).toString();
        res.writeHead(resp.status, responseHeaders);
        return res.end(rewritten);
      }

      // Binary stream (MP4, TS, etc.)
      res.writeHead(resp.status, responseHeaders);
      const body = resp.body;
      if (body) return Readable.fromWeb(body).pipe(res);
      return res.end();
    }

    res.writeHead(502, { 'Access-Control-Allow-Origin': 'https://1embed.cc' });
    res.end(`Upstream error: ${resp.status}`);
  } catch (err) {
    res.writeHead(502, { 'Access-Control-Allow-Origin': 'https://1embed.cc' });
    res.end(`Proxy failed: ${err.message}`);
  }
}).listen(PORT, () => {
  console.log(`MP4 proxy running on port ${PORT}`);
});
