export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. Handle CORS preflight requests (OPTIONS)
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // 2. Subtitle Conversion Endpoint (/vtt?url=...)
    if (url.pathname === "/vtt" || url.pathname === "/api/proxy/vtt") {
      const targetUrlStr = url.searchParams.get("url");
      if (!targetUrlStr) {
        return new Response("Missing target 'url' parameter", { status: 400 });
      }

      try {
        const subRes = await fetch(targetUrlStr, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          },
        });

        if (!subRes.ok) {
          return new Response("Failed to fetch subtitle", { status: subRes.status });
        }

        const rawText = await subRes.text();
        let text = rawText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
        text = text.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");

        if (!text.trim().startsWith("WEBVTT")) {
          text = "WEBVTT\n\n" + text.trim();
        }

        return new Response(text, {
          status: 200,
          headers: {
            "Content-Type": "text/vtt; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
          },
        });
      } catch (err) {
        return new Response("Error converting subtitle: " + err.message, { status: 500 });
      }
    }

    // 3. Media & File Proxy Endpoint (?url=...)
    const targetUrlStr = url.searchParams.get("url");

    if (!targetUrlStr) {
      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Media Stream & File Proxy Worker</title>
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --accent: #38bdf8;
      --accent-hover: #0284c7;
      --border: #334155;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 2rem 1rem;
    }
    .container {
      max-width: 800px;
      width: 100%;
    }
    header {
      margin-bottom: 2rem;
      text-align: center;
    }
    h1 {
      font-size: 1.875rem;
      font-weight: 700;
      color: var(--accent);
      margin-bottom: 0.5rem;
    }
    p.subtitle {
      color: var(--text-muted);
      font-size: 0.95rem;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 1.5rem;
      margin-bottom: 1.5rem;
    }
    .card h2 {
      font-size: 1.1rem;
      margin-bottom: 1rem;
      color: #e2e8f0;
    }
    .field {
      margin-bottom: 1rem;
    }
    label {
      display: block;
      font-size: 0.85rem;
      font-weight: 600;
      color: var(--text-muted);
      margin-bottom: 0.35rem;
    }
    input[type="text"] {
      width: 100%;
      padding: 0.65rem 0.85rem;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: #0f172a;
      color: var(--text);
      font-size: 0.9rem;
      outline: none;
    }
    input[type="text"]:focus {
      border-color: var(--accent);
    }
    .btn-group {
      display: flex;
      gap: 0.5rem;
    }
    button {
      background: var(--accent);
      color: #0f172a;
      font-weight: 600;
      padding: 0.65rem 1.25rem;
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: 0.9rem;
      transition: background 0.2s;
    }
    button:hover {
      background: var(--accent-hover);
      color: #ffffff;
    }
    .preview-container {
      margin-top: 1rem;
      background: #000;
      border-radius: 8px;
      overflow: hidden;
      display: none;
      text-align: center;
    }
    video, img {
      width: 100%;
      max-height: 450px;
      display: block;
      object-fit: contain;
    }
    .endpoint-info {
      font-size: 0.85rem;
      color: var(--text-muted);
      line-height: 1.6;
    }
    code {
      background: #0f172a;
      padding: 0.15rem 0.4rem;
      border-radius: 4px;
      font-family: monospace;
      color: var(--accent);
    }
    .badge {
      display: inline-block;
      padding: 0.2rem 0.5rem;
      border-radius: 4px;
      font-size: 0.75rem;
      font-weight: 600;
      background: #334155;
      color: #38bdf8;
      margin-right: 0.3rem;
    }
  </style>
  <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
</head>
<body>
  <div class="container">
    <header>
      <h1>Media Stream & File Proxy Worker</h1>
      <p class="subtitle">Supports MP4, HLS (.m3u8), MPEG-TS (.ts), Images (.jpg), and Subtitles (.vtt)</p>
    </header>

    <div class="card">
      <h2>Test Media Proxy</h2>
      <div class="field">
        <label for="mediaUrl">Target URL (MP4, M3U8, TS, JPG)</label>
        <input type="text" id="mediaUrl" placeholder="https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4" value="https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4">
      </div>
      <div class="btn-group">
        <button onclick="testProxy()">Proxy & Preview</button>
      </div>

      <div class="preview-container" id="previewWrapper">
        <video id="videoPlayer" controls style="display:none;"></video>
        <img id="imageViewer" style="display:none;" alt="Proxied Image" />
      </div>
    </div>

    <div class="card">
      <h2>Supported File Types & Endpoints</h2>
      <div class="endpoint-info">
        <p><strong>Supported Extensions:</strong> 
          <span class="badge">MP4</span>
          <span class="badge">M3U8 (HLS)</span>
          <span class="badge">TS</span>
          <span class="badge">JPG/JPEG</span>
          <span class="badge">VTT</span>
        </p>
        <br/>
        <p><strong>1. Proxy Endpoint:</strong> <code>/?url=&lt;encoded_target_url&gt;</code></p>
        <p><strong>2. Subtitle VTT Endpoint:</strong> <code>/vtt?url=&lt;subtitle_url&gt;</code></p>
        <p><strong>3. CORS Preflight:</strong> <code>OPTIONS</code> requests handled automatically with <code>*</code> wildcard origin.</p>
      </div>
    </div>
  </div>

  <script>
    let hlsInstance = null;
    function testProxy() {
      const targetUrl = document.getElementById('mediaUrl').value.trim();
      if (!targetUrl) {
        alert('Please enter a target URL');
        return;
      }
      const proxyUrl = '/?url=' + encodeURIComponent(targetUrl);
      const wrapper = document.getElementById('previewWrapper');
      const video = document.getElementById('videoPlayer');
      const img = document.getElementById('imageViewer');

      wrapper.style.display = 'block';
      if (hlsInstance) {
        hlsInstance.destroy();
        hlsInstance = null;
      }

      const lower = targetUrl.toLowerCase();
      if (lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.includes('image')) {
        video.style.display = 'none';
        video.pause();
        img.src = proxyUrl;
        img.style.display = 'block';
      } else {
        img.style.display = 'none';
        video.style.display = 'block';

        if (lower.includes('.m3u8') && Hls.isSupported()) {
          hlsInstance = new Hls();
          hlsInstance.loadSource(proxyUrl);
          hlsInstance.attachMedia(video);
          hlsInstance.on(Hls.Events.MANIFEST_PARSED, function() {
            video.play().catch(e => console.log('Autoplay blocked', e));
          });
        } else {
          video.src = proxyUrl;
          video.play().catch(e => console.log('Autoplay blocked', e));
        }
      }
    }
  </script>
</body>
</html>`;
      return new Response(html, {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8", "Access-Control-Allow-Origin": "*" }
      });
    }

    try {
      const reqHeaders = new Headers();
      reqHeaders.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
      reqHeaders.set("Accept", "*/*");

      // Pass Range headers for seeking/streaming video and ts segments
      const rangeHeader = request.headers.get("Range");
      if (rangeHeader) {
        reqHeaders.set("Range", rangeHeader);
      }

      const proxyRes = await fetch(targetUrlStr, {
        method: request.method,
        headers: reqHeaders,
        redirect: "follow",
      });

      const resHeaders = new Headers(proxyRes.headers);
      resHeaders.set("Access-Control-Allow-Origin", "*");
      resHeaders.set(
        "Access-Control-Expose-Headers",
        "Content-Length, Content-Range, Accept-Ranges, Content-Type, Content-Disposition"
      );

      const cleanUrlPath = targetUrlStr.split("?")[0].toLowerCase();
      let contentType = resHeaders.get("Content-Type") || "";

      // Content-Type resolution for m3u8, ts, jpg, mp4
      if (cleanUrlPath.endsWith(".m3u8") || contentType.includes("mpegurl")) {
        contentType = "application/vnd.apple.mpegurl";
      } else if (cleanUrlPath.endsWith(".ts") || contentType.includes("mp2t") || contentType.includes("video/ts")) {
        contentType = "video/mp2t";
      } else if (cleanUrlPath.endsWith(".jpg") || cleanUrlPath.endsWith(".jpeg") || contentType.includes("image/jpeg")) {
        contentType = "image/jpeg";
      } else if (cleanUrlPath.endsWith(".png") || contentType.includes("image/png")) {
        contentType = "image/png";
      } else if (cleanUrlPath.endsWith(".mp4") || contentType.includes("video/mp4") || !contentType || contentType === "application/octet-stream") {
        contentType = "video/mp4";
      }

      resHeaders.set("Content-Type", contentType);
      resHeaders.set("Content-Disposition", "inline");

      if (!resHeaders.get("Accept-Ranges")) {
        resHeaders.set("Accept-Ranges", "bytes");
      }

      // If it's an m3u8 playlist, rewrite URIs inside the playlist text to route through the proxy
      if (contentType === "application/vnd.apple.mpegurl") {
        const playlistText = await proxyRes.text();
        const proxyOrigin = url.origin;
        
        const rewrittenLines = playlistText.split("\n").map((line) => {
          const trimmed = line.trim();
          if (!trimmed) return line;

          if (trimmed.startsWith("#")) {
            return line.replace(/URI=["']([^"']+)["']/g, (match, p1) => {
              try {
                const absUri = new URL(p1, targetUrlStr).href;
                return `URI="${proxyOrigin}/?url=${encodeURIComponent(absUri)}"`;
              } catch (e) {
                return match;
              }
            });
          }

          try {
            const absUri = new URL(trimmed, targetUrlStr).href;
            return `${proxyOrigin}/?url=${encodeURIComponent(absUri)}`;
          } catch (e) {
            return line;
          }
        });

        return new Response(rewrittenLines.join("\n"), {
          status: proxyRes.status,
          statusText: proxyRes.statusText,
          headers: resHeaders,
        });
      }

      return new Response(proxyRes.body, {
        status: proxyRes.status,
        statusText: proxyRes.statusText,
        headers: resHeaders,
      });
    } catch (err) {
      return new Response("Stream Proxy Error: " + err.message, { status: 502 });
    }
  },
};
