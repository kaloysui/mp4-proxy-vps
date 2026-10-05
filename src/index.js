// Secret Key para sa Token Encryption
const STREAM_SECRET = '1embed_secret_2026';

function packSync(obj) {
  try {
    const json = JSON.stringify(obj);
    const encoder = new TextEncoder();
    const jsonBytes = encoder.encode(json);
    const secretBytes = encoder.encode(STREAM_SECRET);
    const encrypted = new Uint8Array(jsonBytes.length);
    for (let i = 0; i < jsonBytes.length; i++) {
      encrypted[i] = jsonBytes[i] ^ secretBytes[i % secretBytes.length];
    }
    let binary = '';
    for (let i = 0; i < encrypted.length; i++) {
      binary += String.fromCharCode(encrypted[i]);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  } catch (e) {
    return null;
  }
}

function unpackSync(token) {
  if (!token) return null;
  try {
    let base64 = token.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4 !== 0) base64 += '=';
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const encoder = new TextEncoder();
    const secretBytes = encoder.encode(STREAM_SECRET);
    const decrypted = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) {
      decrypted[i] = bytes[i] ^ secretBytes[i % secretBytes.length];
    }
    const decoder = new TextDecoder();
    return JSON.parse(decoder.decode(decrypted));
  } catch (e) {
    return null;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Bukas sa lahat ng domains (Wildcard CORS)
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, Content-Type, Content-Disposition",
    };

    // 1. CORS Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders,
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // 2. I-extract ang payload mula sa URL Path o Query
    const pathname = url.pathname.substring(1);
    const tokenFromPath = pathname.replace(/\.(m3u8|ts|mp4|vtt|key)$/i, '');

    let payload = null;

    // A. Subukang i-decode mula sa encrypted path token
    if (tokenFromPath) {
      payload = unpackSync(tokenFromPath);
    }

    // B. Subukang i-decode mula sa query params (?d= o ?url=)
    if (!payload) {
      const qd = url.searchParams.get("d");
      const qurl = url.searchParams.get("url");

      if (qd) {
        payload = unpackSync(qd);
      } else if (qurl) {
        payload = {
          u: qurl,
          r: url.searchParams.get("referer") || url.searchParams.get("ref") || "",
          o: url.searchParams.get("origin") || url.searchParams.get("ori") || "",
        };
      }
    }

    // 3. Subtitle / WebVTT Conversion Endpoint
    if (url.pathname.includes("vtt")) {
      if (!payload || !payload.u) {
        return new Response("Missing subtitle payload", { status: 400, headers: corsHeaders });
      }

      try {
        const subRes = await fetch(payload.u, {
          headers: {
            "User-Agent": request.headers.get("User-Agent") || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/127.0.0.0 Safari/537.36",
            "Referer": payload.r || new URL(payload.u).origin + "/",
            "Origin": payload.o || new URL(payload.u).origin,
            "Accept-Language": "en-US,en;q=0.9",
          },
          redirect: "follow",
        });

        if (!subRes.ok) {
          return new Response("Failed to fetch subtitle", { status: subRes.status, headers: corsHeaders });
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
            ...corsHeaders,
            "Content-Type": "text/vtt; charset=utf-8",
            "Cache-Control": "public, max-age=86400",
          },
        });
      } catch (err) {
        return new Response("Subtitle Error: " + err.message, { status: 500, headers: corsHeaders });
      }
    }

    // 4. Default greeting kung walang payload
    if (!payload || !payload.u) {
      return new Response("Stream Proxy Active (Open Access)", {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "text/plain; charset=utf-8",
        },
      });
    }

    // 5. Media Proxy Handler
    try {
      const targetUrlStr = payload.u;
      const initialTarget = new URL(targetUrlStr);

      const referer = payload.r || initialTarget.origin + "/";
      const origin = payload.o || initialTarget.origin;
      const parsedHeaders = payload.h || {};

      const reqHeaders = new Headers();
      reqHeaders.set("User-Agent", request.headers.get("User-Agent") || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/127.0.0.0 Safari/537.36");
      reqHeaders.set("Accept", request.headers.get("Accept") || "*/*");
      reqHeaders.set("Accept-Language", request.headers.get("Accept-Language") || "en-US,en;q=0.9");
      reqHeaders.set("Referer", referer);
      if (origin) reqHeaders.set("Origin", origin);

      // Custom headers
      for (const [key, value] of Object.entries(parsedHeaders)) {
        if (!["referer", "origin", "user-agent", "host"].includes(key.toLowerCase())) {
          reqHeaders.set(key, String(value));
        }
      }

      // Range header para sa video seeking
      const rangeHeader = request.headers.get("Range");
      if (rangeHeader) {
        reqHeaders.set("Range", rangeHeader);
      }

      const proxyRes = await fetch(targetUrlStr, {
        method: request.method,
        headers: reqHeaders,
        redirect: "follow",
      });

      const finalResolvedUrl = proxyRes.url || targetUrlStr;

      const resHeaders = new Headers(proxyRes.headers);
      for (const [ck, cv] of Object.entries(corsHeaders)) {
        resHeaders.set(ck, cv);
      }

      const isExplicitSegment = url.pathname.endsWith(".ts") || url.pathname.endsWith(".mp4");
      const isExplicitM3U8 = url.pathname.endsWith(".m3u8");
      let contentType = resHeaders.get("Content-Type") || "";

      const isM3U8 = !isExplicitSegment && (isExplicitM3U8 || contentType.includes("mpegurl") || contentType.includes("application/x-mpegURL"));

      if (isM3U8) {
        contentType = "application/vnd.apple.mpegurl";
      } else if (contentType.includes("mp4") || contentType.includes("video/iso.segment") || url.pathname.endsWith(".mp4")) {
        contentType = "video/mp4";
      } else if (isExplicitSegment || contentType.includes("mp2t") || contentType.includes("video/ts")) {
        contentType = "video/mp2t";
      }

      resHeaders.set("Content-Type", contentType);
      resHeaders.set("Content-Disposition", "inline");

      if (isM3U8) {
        resHeaders.set("Cache-Control", "no-cache, no-store, must-revalidate, max-age=0");
        resHeaders.set("Pragma", "no-cache");
        resHeaders.set("Expires", "0");
      } else {
        resHeaders.set("Cache-Control", "public, max-age=31536000, immutable");
      }

      if (!resHeaders.get("Accept-Ranges")) {
        resHeaders.set("Accept-Ranges", "bytes");
      }

      // 6. M3U8 Playlist Parsing at Pag-rewrite gamit ang Stateless Encrypted URLs
      if (isM3U8 && proxyRes.ok) {
        const rawPlaylist = await proxyRes.text();
        const proxyOrigin = url.origin;

        // Linisin ang CRLF (\r\n) line breaks
        const lines = rawPlaylist.replace(/\r/g, "").split("\n");
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

            // I-rewrite ang URI attributes (hal. #EXT-X-MEDIA, #EXT-X-KEY)
            return line.replace(/URI=(["'])(.*?)\1|URI=([^\s,]+)/gi, (match, quote, p1, p2) => {
              const rawUri = p1 || p2;
              if (!rawUri) return match;
              try {
                const absUri = new URL(rawUri, finalResolvedUrl).href;
                const isMedia = trimmed.startsWith("#EXT-X-MEDIA");
                const isKey = trimmed.startsWith("#EXT-X-KEY");

                let ext = "ts";
                if (isKey) ext = "key";
                else if (isMedia && (absUri.includes(".m3u8") || absUri.includes("cdn-m3u8"))) ext = "m3u8";

                const q = quote || '"';
                const token = packSync({ u: absUri, r: referer, o: origin, h: parsedHeaders });
                return `URI=${q}${proxyOrigin}/${token}.${ext}${q}`;
              } catch (e) {
                return match;
              }
            });
          }

          // Content Stream / TS Segment Line
          try {
            const absUri = new URL(trimmed, finalResolvedUrl).href;
            let ext = "ts";
            if (isNextStreamInf || absUri.includes(".m3u8") || absUri.includes("cdn-m3u8")) {
              ext = "m3u8";
            } else if (isNextExtInf) {
              ext = "ts";
            }

            isNextStreamInf = false;
            isNextExtInf = false;

            const token = packSync({ u: absUri, r: referer, o: origin, h: parsedHeaders });
            return `${proxyOrigin}/${token}.${ext}`;
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

      // 7. Binary Stream Passthrough
      return new Response(proxyRes.body, {
        status: proxyRes.status,
        statusText: proxyRes.statusText,
        headers: resHeaders,
      });

    } catch (err) {
      return new Response("Stream Proxy Error: " + err.message, {
        status: 502,
        headers: corsHeaders,
      });
    }
  },
};
