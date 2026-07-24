export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. Handle CORS preflight requests (OPTIONS) for 1embed.cc & players
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
            "Referer": "https://netfilm.world/",
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

    // 3. MP4 / Video Stream Proxy Endpoint (?url=...&referer=...)
    const targetUrlStr = url.searchParams.get("url");
    const referer = url.searchParams.get("referer") || "https://netfilm.world/";

    if (!targetUrlStr) {
      return new Response(
        "Cloudflare Stream Proxy Worker Active! Usage: ?url=<encoded_video_url>&referer=<optional_referer>",
        { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Access-Control-Allow-Origin": "*" } }
      );
    }

    try {
      const reqHeaders = new Headers();
      reqHeaders.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
      reqHeaders.set("Referer", referer);
      reqHeaders.set("Accept", "*/*");

      // Pass Range headers for seeking/fast-forwarding videos
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

      // Force video/mp4 Content-Type if missing
      const contentType = resHeaders.get("Content-Type");
      if (!contentType || contentType === "application/octet-stream") {
        resHeaders.set("Content-Type", "video/mp4");
      }

      // Force INLINE disposition so 1embed.cc plays video inline instead of downloading
      resHeaders.set("Content-Disposition", "inline");

      // Ensure Accept-Ranges is present for seeking
      if (!resHeaders.get("Accept-Ranges")) {
        resHeaders.set("Accept-Ranges", "bytes");
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