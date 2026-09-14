export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Handle CORS Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
          "Access-Control-Allow-Headers": "*",
        },
      });
    }

    const targetUrl = url.searchParams.get("url");
    if (!targetUrl) {
      return new Response("Missing target url parameter", { status: 400 });
    }

    // 1. Parse custom headers from query parameter
    let customHeaders = {};
    const rawHeadersParam = url.searchParams.get("headers");
    if (rawHeadersParam) {
      try {
        customHeaders = JSON.parse(rawHeadersParam);
      } catch (e) {
        // fallback if not json
      }
    }

    // 2. Auto-detect Origin & Referer if targeting Atlantic / Peraspera
    const upstreamHeaders = new Headers();
    upstreamHeaders.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36");

    if (
      targetUrl.includes("atlantic") ||
      targetUrl.includes("peraspera") ||
      targetUrl.includes("workers.dev")
    ) {
      upstreamHeaders.set("Referer", "https://atlantic.st/");
      upstreamHeaders.set("Origin", "https://atlantic.st");
    } else if (targetUrl.includes("stellar") || targetUrl.includes("dryland")) {
      upstreamHeaders.set("Referer", "https://stellar.gdn/");
      upstreamHeaders.set("Origin", "https://stellar.gdn");
    }

    // Apply passed custom headers
    for (const [key, value] of Object.entries(customHeaders)) {
      upstreamHeaders.set(key, String(value));
    }

    // Pass Range header for seekable video playback
    const clientRange = request.headers.get("Range");
    if (clientRange) {
      upstreamHeaders.set("Range", clientRange);
    }

    // 3. Fetch from Upstream
    let upstreamRes;
    try {
      upstreamRes = await fetch(targetUrl, {
        method: request.method,
        headers: upstreamHeaders,
        redirect: "follow",
      });
    } catch (err) {
      return new Response("Upstream Fetch Error: " + err.message, { status: 502 });
    }

    const contentType = upstreamRes.headers.get("content-type") || "";
    const isM3U8 =
      url.pathname.endsWith(".m3u8") ||
      targetUrl.includes(".m3u8") ||
      contentType.includes("mpegurl") ||
      contentType.includes("application/x-mpegURL");

    // 4. If M3U8 Playlist, rewrite segment & sub-playlist URLs
    if (isM3U8) {
      const originalText = await upstreamRes.text();
      const lines = originalText.split("\n");
      const baseTargetUrl = new URL(targetUrl);

      const encodedHeaders = encodeURIComponent(JSON.stringify(Object.fromEntries(upstreamHeaders.entries())));

      const rewrittenLines = lines.map((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
          // Handle URI in tags like #EXT-X-KEY:METHOD=...,URI="..."
          return line.replace(/URI="([^"]+)"/g, (match, uri) => {
            const absoluteUri = new URL(uri, baseTargetUrl).toString();
            return `URI="https://v.1embed.cc/ts-proxy.ts?url=${encodeURIComponent(absoluteUri)}&headers=${encodedHeaders}"`;
          });
        }

        // Absolute URL resolution for relative paths
        const absoluteUrl = new URL(trimmed, baseTargetUrl).toString();
        const isSubM3u8 = absoluteUrl.includes(".m3u8") || absoluteUrl.includes("payload=");

        const endpoint = isSubM3u8 ? "m3u8-proxy.m3u8" : "ts-proxy.ts";
        return `https://v.1embed.cc/${endpoint}?url=${encodeURIComponent(absoluteUrl)}&headers=${encodedHeaders}`;
      });

      return new Response(rewrittenLines.join("\n"), {
        status: upstreamRes.status,
        headers: {
          "Content-Type": "application/vnd.apple.mpegurl",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "*",
          "Cache-Control": "no-cache, no-store",
        },
      });
    }

    // 5. Binary Streaming for TS chunks / MP4 video files
    const responseHeaders = new Headers(upstreamRes.headers);
    responseHeaders.set("Access-Control-Allow-Origin", "*");
    responseHeaders.set("Access-Control-Allow-Headers": "*");
    responseHeaders.set("Access-Control-Expose-Headers", "Content-Length, Content-Range, Accept-Ranges");

    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      statusText: upstreamRes.statusText,
      headers: responseHeaders,
    });
  },
};
