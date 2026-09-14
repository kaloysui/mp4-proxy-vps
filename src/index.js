export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. Handle CORS preflight requests (OPTIONS)
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // 2. Subtitle Conversion Endpoint (/vtt?url=... o /api/proxy/vtt)
    if (url.pathname === "/vtt" || url.pathname === "/api/proxy/vtt") {
      const targetUrlStr = url.searchParams.get("url");
      if (!targetUrlStr) {
        return new Response("Missing target 'url' parameter", { status: 400 });
      }

      try {
        const targetUrl = new URL(targetUrlStr);
        const customReferer = url.searchParams.get("referer") || url.searchParams.get("ref");
        const customOrigin = url.searchParams.get("origin") || url.searchParams.get("ori");

        const referer = customReferer || targetUrl.origin + "/";
        const origin = customOrigin || targetUrl.origin;

        const subRes = await fetch(targetUrlStr, {
          headers: {
            "User-Agent": request.headers.get("User-Agent") || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
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
            "Cache-Control": "public, max-age=86400",
          },
        });
      } catch (err) {
        return new Response("Error converting subtitle: " + err.message, { status: 500 });
      }
    }

    // 3. Media & File Proxy Endpoint (?url=...)
    const targetUrlStr = url.searchParams.get("url");

    if (!targetUrlStr) {
      return new Response("1Embed Streaming Proxy is Online :)", {
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
      const targetHost = targetUrl.hostname.toLowerCase();

      // Read custom query parameters
      const customReferer = url.searchParams.get("referer") || url.searchParams.get("ref");
      const customOrigin = url.searchParams.get("origin") || url.searchParams.get("ori");
      const customHeadersRaw = url.searchParams.get("headers");

      let parsedHeaders = {};
      if (customHeadersRaw) {
        try {
          parsedHeaders = JSON.parse(customHeadersRaw);
        } catch (e) {
          // Ignore JSON parse errors
        }
      }

      // Determine default Referer and Origin based on stream provider
      let referer = customReferer || parsedHeaders["Referer"] || parsedHeaders["referer"];
      let origin = customOrigin || parsedHeaders["Origin"] || parsedHeaders["origin"];

      if (!referer) {
        if (targetHost.includes("peraspera") || targetHost.includes("atlantic") || targetHost.includes("workers.dev")) {
          referer = "https://atlantic.st/";
          origin = origin || "https://atlantic.st";
        } else if (targetHost.includes("stellar") || targetHost.includes("dryland")) {
          referer = "https://stellar.gdn/";
          origin = origin || "https://stellar.gdn";
        } else if (targetHost.includes("rabbitstream") || targetHost.includes("megacloud") || targetHost.includes("dokicloud")) {
          referer = "https://megacloud.tv/";
          origin = origin || "https://megacloud.tv";
        } else {
          referer = targetOrigin + "/";
          origin = origin || targetOrigin;
        }
      }

      const reqHeaders = new Headers();
      reqHeaders.set("User-Agent", request.headers.get("User-Agent") || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36");
      reqHeaders.set("Accept", request.headers.get("Accept") || "*/*");
      reqHeaders.set("Accept-Language", request.headers.get("Accept-Language") || "en-US,en;q=0.9");
      reqHeaders.set("Referer", referer);
      if (origin) {
        reqHeaders.set("Origin", origin);
      }

      // Apply other passed custom headers
      for (const [key, value] of Object.entries(parsedHeaders)) {
        if (!["referer", "origin", "user-agent", "host"].includes(key.toLowerCase())) {
          reqHeaders.set(key, String(value));
        }
      }

      // Pass Range headers for smooth seeking/streaming
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
      resHeaders.set("Access-Control-Allow-Headers", "*");
      resHeaders.set(
        "Access-Control-Expose-Headers",
        "Content-Length, Content-Range, Accept-Ranges, Content-Type, Content-Disposition"
      );

      const cleanUrlPath = targetUrlStr.split("?")[0].toLowerCase();
      let contentType = resHeaders.get("Content-Type") || "";

      // Content-Type detection
      const isM3U8 =
        url.pathname.endsWith(".m3u8") ||
        cleanUrlPath.endsWith(".m3u8") ||
        contentType.includes("mpegurl") ||
        contentType.includes("application/x-mpegURL") ||
        (targetUrlStr.includes("payload=") && !cleanUrlPath.endsWith(".ts"));

      if (isM3U8) {
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

      // Set caching policies
      if (contentType === "video/mp2t" || contentType === "video/mp4" || contentType.includes("image/")) {
        resHeaders.set("Cache-Control", "public, max-age=31536000, immutable");
      } else if (isM3U8) {
        resHeaders.set("Cache-Control", "no-cache, no-store, must-revalidate");
      }

      if (!resHeaders.get("Accept-Ranges")) {
        resHeaders.set("Accept-Ranges", "bytes");
      }

      // 4. M3U8 Playlist URL Rewriter
      if (isM3U8 && proxyRes.ok) {
        const playlistText = await proxyRes.text();
        const proxyOrigin = url.origin;

        // Build header parameters to attach to inner stream URLs
        let extraParams = `&referer=${encodeURIComponent(referer)}`;
        if (origin) extraParams += `&origin=${encodeURIComponent(origin)}`;
        if (customHeadersRaw) extraParams += `&headers=${encodeURIComponent(customHeadersRaw)}`;

        const rewrittenLines = playlistText.split("\n").map((line) => {
          const trimmed = line.trim();
          if (!trimmed) return line;

          if (trimmed.startsWith("#")) {
            // Handle AES key tags: #EXT-X-KEY:METHOD=AES-128,URI="..."
            return line.replace(/URI=["']([^"']+)["']/g, (match, p1) => {
              try {
                const absUri = new URL(p1, targetUrlStr).href;
                return `URI="${proxyOrigin}/ts-proxy.ts?url=${encodeURIComponent(absUri)}${extraParams}"`;
              } catch (e) {
                return match;
              }
            });
          }

          try {
            const absUri = new URL(trimmed, targetUrlStr).href;
            const isSubPlaylist = absUri.includes(".m3u8") || (absUri.includes("payload=") && !absUri.includes(".ts"));
            const endpoint = isSubPlaylist ? "m3u8-proxy.m3u8" : "ts-proxy.ts";
            return `${proxyOrigin}/${endpoint}?url=${encodeURIComponent(absUri)}${extraParams}`;
          } catch (e) {
            return line;
          }
        });

        resHeaders.delete("Content-Encoding");
        resHeaders.delete("Content-Length");

        return new Response(rewrittenLines.join("\n"), {
          status: proxyRes.status,
          statusText: proxyRes.statusText,
          headers: resHeaders,
        });
      }

      // 5. Binary Media Streaming for TS and MP4
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
