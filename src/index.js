export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. Universal CORS Preflight (OPTIONS)
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
          redirect: "follow",
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

    // 3. Media & Stream Proxy Endpoint (?url=...)
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
      const initialTarget = new URL(targetUrlStr);

      // Parse headers
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
        initialTarget.origin + "/";

      const origin =
        url.searchParams.get("origin") ||
        url.searchParams.get("ori") ||
        parsedHeaders["Origin"] ||
        parsedHeaders["origin"] ||
        initialTarget.origin;

      const reqHeaders = new Headers();
      reqHeaders.set("User-Agent", request.headers.get("User-Agent") || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36");
      reqHeaders.set("Accept", request.headers.get("Accept") || "*/*");
      reqHeaders.set("Accept-Language", request.headers.get("Accept-Language") || "en-US,en;q=0.9");
      reqHeaders.set("Referer", referer);
      if (origin) {
        reqHeaders.set("Origin", origin);
      }

      for (const [key, value] of Object.entries(parsedHeaders)) {
        if (!["referer", "origin", "user-agent", "host"].includes(key.toLowerCase())) {
          reqHeaders.set(key, String(value));
        }
      }

      const rangeHeader = request.headers.get("Range");
      if (rangeHeader) {
        reqHeaders.set("Range", rangeHeader);
      }

      // Automatically FOLLOW 302 redirects from Peraspera to TotallyaCDN!
      const proxyRes = await fetch(targetUrlStr, {
        method: request.method,
        headers: reqHeaders,
        redirect: "follow",
      });

      // The final URL after 302 redirects (e.g. https://totallyacdn.org/...)
      const finalResolvedUrl = proxyRes.url || targetUrlStr;

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

      // Caching: no caching for playlists so rewriter is always fresh
      if (contentType === "video/mp2t" || contentType === "video/mp4") {
        resHeaders.set("Cache-Control", "public, max-age=31536000, immutable");
      } else if (isM3U8) {
        resHeaders.set("Cache-Control", "no-cache, no-store, must-revalidate, max-age=0");
        resHeaders.set("Pragma", "no-cache");
        resHeaders.set("Expires", "0");
      }

      if (!resHeaders.get("Accept-Ranges")) {
        resHeaders.set("Accept-Ranges", "bytes");
      }

      // 4. M3U8 Playlist Parser & Rewriter: Resolves all URIs relative to the final redirect destination (TotallyaCDN)
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

          if (trimmed.startsWith("#")) {
            if (trimmed.startsWith("#EXT-X-STREAM-INF")) {
              isNextStreamInf = true;
              isNextExtInf = false;
            } else if (trimmed.startsWith("#EXTINF")) {
              isNextExtInf = true;
              isNextStreamInf = false;
            }

            // Rewrite any URI attributes in #EXT-X-MEDIA, #EXT-X-MAP, #EXT-X-KEY
            return line.replace(/URI=(?:"([^"]+)"|'([^']+)'|([^\s,]+))/gi, (match, q1, q2, q3) => {
              const rawUri = q1 || q2 || q3;
              if (!rawUri) return match;
              try {
                const absUri = new URL(rawUri, finalResolvedUrl).href;
                const isMedia = trimmed.startsWith("#EXT-X-MEDIA");
                const endpoint = isMedia && (absUri.includes(".m3u8") || absUri.includes("m3u8-proxy") || absUri.includes("cdn-m3u8"))
                  ? "m3u8-proxy.m3u8"
                  : "ts-proxy.ts";
                return `URI="${proxyOrigin}/${endpoint}?url=${encodeURIComponent(absUri)}${extraParams}"`;
              } catch (e) {
                return match;
              }
            });
          }

          // Content Line (Playlist or Segment chunk)
          try {
            const absUri = new URL(trimmed, finalResolvedUrl).href;
            let endpoint = "ts-proxy.ts";
            if (isNextStreamInf || absUri.includes(".m3u8") || absUri.includes("m3u8-proxy") || absUri.includes("cdn-m3u8")) {
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

      // 5. Binary Video / Segment Stream
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
