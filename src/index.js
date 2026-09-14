// Secret Encryption Key for 1Embed Proxy
const STREAM_SECRET = '1embed_secret_2026';

// In-Memory Short Key Store (8-character random tokens)
const tokenStore = new Map();
const MAX_CACHE_SIZE = 15000;

// Rate Limiter Store (IP -> { count, startTime })
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60000; // 1 Minute window
const MAX_EXTERNAL_REQUESTS = 2;    // Max 2 requests for non-1embed origins

function generateShortKey() {
  return Math.random().toString(36).substring(2, 10);
}

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
    const json = decoder.decode(decrypted);
    return JSON.parse(json);
  } catch (e) {
    return null;
  }
}

function saveToShortStore(payload) {
  if (tokenStore.size >= MAX_CACHE_SIZE) {
    const oldestKey = tokenStore.keys().next().value;
    if (oldestKey) tokenStore.delete(oldestKey);
  }
  const key = generateShortKey();
  tokenStore.set(key, payload);
  return key;
}

// Check if Origin / Referer comes from 1embed.cc or authorized app domains
function checkIs1EmbedOrigin(request) {
  const reqOrigin = request.headers.get("Origin") || "";
  const reqReferer = request.headers.get("Referer") || "";

  const is1Embed =
    reqOrigin.includes("1embed.cc") ||
    reqReferer.includes("1embed.cc") ||
    reqOrigin.includes("run.app") ||
    reqReferer.includes("run.app") ||
    reqOrigin.includes("localhost") ||
    reqReferer.includes("localhost");

  return {
    is1Embed,
    allowedOrigin: reqOrigin || (is1Embed ? "https://1embed.cc" : "*")
  };
}

// Rate Limiter Enforcement (Only applies to external requests)
function checkRateLimit(clientIp) {
  const now = Date.now();
  const record = rateLimitMap.get(clientIp);

  if (!record || now - record.startTime > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(clientIp, { count: 1, startTime: now });
    return true; // Allowed
  }

  if (record.count >= MAX_EXTERNAL_REQUESTS) {
    return false; // Rate limit exceeded
  }

  record.count += 1;
  return true; // Allowed
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const clientIp = request.headers.get("CF-Connecting-IP") || "unknown-ip";
    const { is1Embed, allowedOrigin } = checkIs1EmbedOrigin(request);

    const corsHeaders = {
      "Access-Control-Allow-Origin": allowedOrigin,
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

    // 2. Enforce Rate Limit for Non-1embed Requests (Limit = 2)
    if (!is1Embed) {
      const allowed = checkRateLimit(clientIp);
      if (!allowed) {
        return new Response("Too Many Requests. Rate limit 2 per minute for unauthorized domains.", {
          status: 429,
          headers: corsHeaders,
        });
      }
    }

    // Extract path key (e.g. "/a8x9z2k1.ts" -> "a8x9z2k1", "/token.m3u8" -> "token")
    const pathname = url.pathname.substring(1);
    const pathKey = pathname.replace(/\.(m3u8|ts|mp4|vtt)$/i, '');

    let payload = null;

    // A. Check in-memory short key cache
    if (pathKey && tokenStore.has(pathKey)) {
      payload = tokenStore.get(pathKey);
    } 
    // B. Check if path is encrypted token
    else if (pathKey) {
      payload = unpackSync(pathKey);
    }

    // C. Fallbacks for query params (?v=, ?d=, ?url=)
    if (!payload) {
      const qv = url.searchParams.get("v");
      const qd = url.searchParams.get("d");
      const qurl = url.searchParams.get("url");

      if (qv && tokenStore.has(qv)) {
        payload = tokenStore.get(qv);
      } else if (qd) {
        payload = unpackSync(qd);
      } else if (qurl) {
        payload = {
          u: qurl,
          r: url.searchParams.get("referer") || url.searchParams.get("ref") || "",
          o: url.searchParams.get("origin") || url.searchParams.get("ori") || "",
        };
      }
    }

    // 3. Subtitle Conversion Endpoint (/vtt or /*.vtt)
    if (url.pathname.includes("vtt")) {
      if (!payload || !payload.u) {
        return new Response("Missing target subtitle parameter", {
          status: 400,
          headers: corsHeaders,
        });
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
        return new Response("Error converting subtitle: " + err.message, { status: 500, headers: corsHeaders });
      }
    }

    // 4. Media Streaming Proxy
    if (!payload || !payload.u) {
      return new Response("1Embed Stream Proxy Active", {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "text/plain; charset=utf-8",
        },
      });
    }

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

      for (const [key, value] of Object.entries(parsedHeaders)) {
        if (!["referer", "origin", "user-agent", "host"].includes(key.toLowerCase())) {
          reqHeaders.set(key, String(value));
        }
      }

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

      // 5. M3U8 Playlist Parser & Rewriter using Direct Path Clean URLs (e.g., /{shortKey}.ts)
      if (isM3U8 && proxyRes.ok) {
        const playlistText = await proxyRes.text();
        const proxyOrigin = url.origin;

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

            return line.replace(/URI=(["'])(.*?)\1|URI=([^\s,]+)/gi, (match, quote, p1, p2) => {
              const rawUri = p1 || p2;
              if (!rawUri) return match;
              try {
                const absUri = new URL(rawUri, finalResolvedUrl).href;
                const isMedia = trimmed.startsWith("#EXT-X-MEDIA");
                const ext = isMedia && (absUri.includes(".m3u8") || absUri.includes("cdn-m3u8")) ? "m3u8" : "ts";
                const q = quote || '"';
                
                const key = saveToShortStore({ u: absUri, r: referer, o: origin, h: parsedHeaders });
                return `URI=${q}${proxyOrigin}/${key}.${ext}${q}`;
              } catch (e) {
                return match;
              }
            });
          }

          // Content Line (Segment URL or Playlist Variant URL)
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
            
            const key = saveToShortStore({ u: absUri, r: referer, o: origin, h: parsedHeaders });
            return `${proxyOrigin}/${key}.${ext}`;
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

      // 6. Binary Streaming
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
