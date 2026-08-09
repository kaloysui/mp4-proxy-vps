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
        const targetUrl = new URL(targetUrlStr);
        const targetOrigin = targetUrl.origin;
        const customReferer = url.searchParams.get("referer");
        const customOrigin = url.searchParams.get("origin");

        const referer = customReferer || targetOrigin + "/";
        const origin = customOrigin || targetOrigin;

        const subRes = await fetch(targetUrlStr, {
          headers: {
            "User-Agent": request.headers.get("User-Agent") || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Referer": referer,
            "Origin": origin,
            "Accept-Language": request.headers.get("Accept-Language") || "en-US,en;q=0.9",
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
      return new Response(":)", {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    try {
      const targetUrl = new URL(targetUrlStr);
      const targetOrigin = targetUrl.origin;
      const customReferer = url.searchParams.get("referer");
      const customOrigin = url.searchParams.get("origin");

      const referer = customReferer || targetOrigin + "/";
      const origin = customOrigin || targetOrigin;

      const reqHeaders = new Headers();
      reqHeaders.set("User-Agent", request.headers.get("User-Agent") || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
      reqHeaders.set("Accept", request.headers.get("Accept") || "*/*");
      reqHeaders.set("Accept-Language", request.headers.get("Accept-Language") || "en-US,en;q=0.9");
      reqHeaders.set("Referer", referer);
      reqHeaders.set("Origin", origin);

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

      // Set aggressive caching for chunks/media, disable for playlists
      if (contentType === "video/mp2t" || contentType === "video/mp4" || contentType.includes("image/")) {
        resHeaders.set("Cache-Control", "public, max-age=31536000, immutable");
      } else if (contentType === "application/vnd.apple.mpegurl") {
        resHeaders.set("Cache-Control", "no-cache, no-store, must-revalidate");
      }

      if (!resHeaders.get("Accept-Ranges")) {
        resHeaders.set("Accept-Ranges", "bytes");
      }

      // If it's an m3u8 playlist, rewrite URIs inside the playlist text to route through the proxy
      if (contentType === "application/vnd.apple.mpegurl" && proxyRes.ok) {
        const playlistText = await proxyRes.text();
        const proxyOrigin = url.origin;
        
        // Prepare extra parameters to attach to inner stream URLs
        let extraParams = "";
        if (customReferer) extraParams += `&referer=${encodeURIComponent(customReferer)}`;
        if (customOrigin) extraParams += `&origin=${encodeURIComponent(customOrigin)}`;
        
        const rewrittenLines = playlistText.split("\n").map((line) => {
          const trimmed = line.trim();
          if (!trimmed) return line;

          if (trimmed.startsWith("#")) {
            return line.replace(/URI=["']([^"']+)["']/g, (match, p1) => {
              try {
                const absUri = new URL(p1, targetUrlStr).href;
                return `URI="${proxyOrigin}/?url=${encodeURIComponent(absUri)}${extraParams}"`;
              } catch (e) {
                return match;
              }
            });
          }

          try {
            const absUri = new URL(trimmed, targetUrlStr).href;
            return `${proxyOrigin}/?url=${encodeURIComponent(absUri)}${extraParams}`;
          } catch (e) {
            return line;
          }
        });

        // Delete these since we're modifying the body
        resHeaders.delete("Content-Encoding");
        resHeaders.delete("Content-Length");

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
