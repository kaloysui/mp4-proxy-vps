const http = require('http');
const { parse: parseUrl } = require('url');
const { Readable } = require('stream');

const PORT = process.env.PORT || 3001;

http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Range, Content-Type, Origin, Referer',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }

  const parsedUrl = parseUrl(req.url, true);

  if (parsedUrl.pathname !== '/mp4-proxy') {
    res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
    return res.end('Not found');
  }

  const targetUrl = parsedUrl.query.url;
  if (!targetUrl) {
    res.writeHead(400, { 'Access-Control-Allow-Origin': '*' });
    return res.end('Missing url');
  }

  let targetParsed;
  try { targetParsed = new URL(targetUrl); } catch {
    res.writeHead(400, { 'Access-Control-Allow-Origin': '*' });
    return res.end('Invalid URL');
  }

  const customReferer = parsedUrl.query.ref;
  const customOrigin = parsedUrl.query.origin;
  const hostname = targetParsed.hostname;
  const clientRange = req.headers['range'] || '';
  const method = req.method === 'HEAD' ? 'HEAD' : 'GET';

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
      const responseHeaders = { 'Access-Control-Allow-Origin': '*' };
      const forward = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'cache-control'];
      responseHeaders['Cache-Control'] = 'public, max-age=3600';
      for (const h of forward) {
        const v = resp.headers.get(h);
        if (v) responseHeaders[h] = v;
      }
      res.writeHead(resp.status, responseHeaders);
      if (method === 'HEAD') return res.end();
      const body = resp.body;
      if (body) return Readable.fromWeb(body).pipe(res);
      return res.end();
    }

    res.writeHead(502, { 'Access-Control-Allow-Origin': '*' });
    res.end(`Upstream error: ${resp.status}`);
  } catch (err) {
    res.writeHead(502, { 'Access-Control-Allow-Origin': '*' });
    res.end(`Proxy failed: ${err.message}`);
  }
}).listen(PORT, () => {
  console.log(`MP4 proxy running on port ${PORT}`);
});
