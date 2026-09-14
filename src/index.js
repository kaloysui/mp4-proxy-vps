export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. CORS preflight handler (OPTIONS)
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

    // 2. Subtitle Conversion (/vtt?url=...)
    if (url.pathname === "/vtt" || url.pathname === "/api/proxy/vtt") {
      const targetUrlStr = url.searchParams.get("url");
      if (!targetUrlStr) {
        return new Response("Missing target 'url' parameter", {
          status: 400,
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      }

      try {
        const targetUrl = new URL(targetUrlStr);
        const referer = url.searchParams.get("referer") || url.searchParams.get("ref") || targetUrl.origin + "/";
        const origin = url.searchParams.get("origin") || url.searchParams.get("ori") || targetUrl.origin;

        const subRes = await fetch(targetUrlStr, {
          headers: {
            "User-Agent": request.headers.get("User-Agent") || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
            "Referer": referer,
            "Origin": origin,
            "Accept-Language": request.headers.get("Accept-Language") || "en-US,en;q=0.9",
          },
        });

        if (!subRes.ok) {
          return new Response("Failed to fetch subtitle", {
            status: subRes.status,
            headers: { "Access-Control-Allow-Origin": "*" },
          });
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
        return new Response("Error converting subtitle: " + err.message, {
          status: 500,
          headers: { "Access-Control-Allow-Origin": "*" },
        });
      }
    }

    // 3. Main Streaming Media Proxy (?url=...)
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

      // Parse headers parameter
      const customHeadersRaw = url.searchParams.get("headers");
      let parsedHeaders = {};
      if (customHeadersRaw) {
        try {
          parsedHeaders = JSON.parse(customHeadersRaw);
        } catch (e) {}
      }

      // Dynamic Referer & Origin
      const referer =
        url.searchParams.get("referer") ||
        url.searchParams.get("ref") ||
        parsedHeaders["Referer"] ||
        parsedHeaders["referer"] ||
        targetUrl.origin + "/";

      const origin =
        url.searchParams.get("origin") ||
        url.searchParams.get("ori") ||
        parsedHeaders["Origin"] ||
        parsedHeaders["origin"] ||
        targetUrl.origin;

      const reqHeaders = new Headers();
      reqHeaders.set("User-Agent", request.headers.get("User-Agent") || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36");
      reqHeaders.set("Accept", request.headers.get("Accept") || "*/*");
      reqHeaders.set("Accept-Language", request.headers.get("Accept-Language") || "en-US,en;q=0.9");
      reqHeaders.set("Referer", referer);
      if (origin) {
        reqHeaders.set("Origin", origin);
      }

      // Forward extra headers
      for (const [key, value] of Object.entries(parsedHeaders)) {
        if (!["referer", "origin", "user-agent", "host"].includes(key.toLowerCase())) {
          reqHeaders.set(key, String(value));
        }
      }

      // Range header for seeking
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

      const isExplicitTs = url.pathname.endsWith(".ts");
      const isExplicitM3U8 = url.pathname.endsWith(".m3u8");
      let contentType = resHeaders.get("Content-Type") || "";

      const isM3U8 = !isExplicitTs && (isExplicitM3U8 || contentType.includes("mpegurl") || contentType.includes("application/x-mpegURL"));

      if (isM3U8) {
        contentType = "application/vnd.apple.mpegurl";
      } else if (isExplicitTs || contentType.includes("mp2t") || contentType.includes("video/ts")) {
        contentType = "video/mp2t";
      } else if (contentType.includes("video/mp4") || url.pathname.endsWith(".mp4")) {
        contentType = "video/mp4";
      }

      resHeaders.set("Content-Type", contentType);
      resHeaders.set("Content-Disposition", "inline");

      if (contentType === "video/mp2t" || contentType === "video/mp4") {
        resHeaders.set("Cache-Control", "public, max-age=31536000, immutable");
      } else if (isM3U8) {
        resHeaders.set("Cache-Control", "no-cache, no-store, must-revalidate");
      }

      if (!resHeaders.get("Accept-Ranges")) {
        resHeaders.set("Accept-Ranges", "bytes");
      }

      // 4. M3U8 Playlist Parser & URL Rewriter (Rewriting EVERYTHING including EXT-X-MAP, EXT-X-KEY, etc.)
      if (isM3U8 && proxyRes.ok) {
        const playlistText = await proxyRes.text();
        const proxyOrigin = url.origin;

        let extraParams = `&referer=${encodeURIComponent(referer)}`;
        if (origin) extraParams += `&origin=${encodeURIComponent(origin)}`;
        if (customHeadersRaw) extraParams += `&headers=${encodeURIComponent(customHeadersRaw)}`;

        const lines = playlistText.split("\n");
        let isNextStreamInf = false;
        let isNextExtInf = false;

        const rewrittenLines = lines.map((line) => {
          const trimmed = line.trim();
          if (!trimmed) return line;

          // Rewriting any tag that contains URI="..." or URI='...'
          if (trimmed.startsWith("#")) {
            if (trimmed.startsWith("#EXT-X-STREAM-INF")) {
              isNextStreamInf = true;
              isNextExtInf = false;
            } else if (trimmed.startsWith("#EXTINF")) {
              isNextExtInf = true;
              isNextStreamInf = false;
            }

            return line.replace(/URI=["']([^"']+)["']/gi, (match, rawUri) => {
              try {
                const absUri = new URL(rawUri, targetUrlStr).href;
                const isMediaTag = trimmed.startsWith("#EXT-X-MEDIA");
                const endpoint = isMediaTag && (absUri.includes(".m3u8") || absUri.includes("m3u8-proxy"))
                  ? "m3u8-proxy.m3u8"
                  : "ts-proxy.ts";
                return `URI="${proxyOrigin}/${endpoint}?url=${encodeURIComponent(absUri)}${extraParams}"`;
              } catch (e) {
                return match;
              }
            });
          }

          // Plain URL line (Playlist variant OR Segment chunk)
          try {
            const absUri = new URL(trimmed, targetUrlStr).href;
            let endpoint = "ts-proxy.ts";
            if (isNextStreamInf || absUri.includes(".m3u8") || absUri.includes("m3u8-proxy")) {
              endpoint = "m3u8-proxy.m3u8";
            } else if (isNextExtInf) {
              endpoint = "ts-proxy.ts";
            }

            isNextStreamInf = false;
            isNextExtInf = false;
            return `${proxyOrigin}/${endpoint}?url=${encodeURIComponent(absUri)}${extraParams}`;
          } catch (e) {
            isNextStreamInf = false;
            isNextExtInf = false;
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

      // 5. Binary Media Streaming for TS and MP4 chunks
      return new Response(proxyRes.body, {
        status: proxyRes.status,
        statusText: proxyRes.statusText,
        headers: resHeaders,
      });
    } catch (err) {
      return new Response("Stream Proxy Error: " + err.message, {
        status: 502,
        headers: { "Access-Control-Allow-Origin": "*" },
      });
    }
  },
};
