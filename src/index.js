// Secret Encryption Key for Bcine Proxy
const STREAM_SECRET = '1embed_secret_2026';

// In-Memory Short Key Store with LRU Cache
const tokenStore = new Map();
const MAX_CACHE_SIZE = 50000;

// 24-Hour IP Ban / Cooldown Map (IP -> Expiry Timestamp)
const bannedIpMap = new Map();
const BAN_DURATION_MS = 24 * 60 * 60 * 1000; // 24 Oras (1 Day)

function generateShortKey() {
  return Math.random().toString(36).substring(2, 10);
}

// High-Performance Zero-Failure URL-Safe Base64 XOR Cipher
function packSync(obj) {
  try {
    const jsonStr = JSON.stringify(obj);
    const encoder = new TextEncoder();
    const data = encoder.encode(jsonStr);
    const secret = encoder.encode(STREAM_SECRET);
    const encrypted = new Uint8Array(data.length);
    for (let i = 0; i < data.length; i++) {
      encrypted[i] = data[i] ^ secret[i % secret.length];
    }
    let binary = '';
    const len = encrypted.byteLength;
    for (let i = 0; i < len; i++) {
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
    const secret = encoder.encode(STREAM_SECRET);
    const decrypted = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) {
      decrypted[i] = bytes[i] ^ secret[i % secret.length];
    }
    const decoder = new TextDecoder();
    return JSON.parse(decoder.decode(decrypted));
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

// Hugot nga pagsusi kung gikan ba sa bcine.ru o main.bcine.ru
function isAuthorizedOrigin(request) {
  const reqOrigin = (request.headers.get("Origin") || "").toLowerCase();
  const reqReferer = (request.headers.get("Referer") || "").toLowerCase();

  // Kung naay gawas nga origin o referer nga dili bcine.ru -> Block/Ban
  if (reqOrigin && !reqOrigin.includes("bcine.ru") && !reqOrigin.includes("main.bcine.ru")) {
    return false;
  }
  if (reqReferer && !reqReferer.includes("bcine.ru") && !reqReferer.includes("main.bcine.ru")) {
    return false;
  }

  // Kung lehitimong gikan sa bcine domain
  if (reqOrigin.includes("bcine.ru") || reqReferer.includes("bcine.ru")) {
    return true;
  }

  // Kung video chunk request gikan sa browser player nga walay origin (standard HLS request)
  return true;
}

// 24-Hour Banning System para sa external abusers
function handleBanCheck(clientIp, isAuthorized) {
  const now = Date.now();
  
  if (bannedIpMap.has(clientIp)) {
    const bannedUntil = bannedIpMap.get(clientIp);
    if (now < bannedUntil) {
      return true; // Na-ban pa sulod sa 24 oras
    } else {
      bannedIpMap.delete(clientIp); // Na-expire na ang ban
    }
  }

  if (!isAuthorized) {
    bannedIpMap.set(clientIp, now + BAN_DURATION_MS);
    return true;
  }

  return false;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const clientIp = request.headers.get("CF-Connecting-IP") || "unknown-ip";
    const reqOrigin = request.headers.get("Origin") || "";

    // 1. Strict CORS Headers para sa bcine.ru domains
    const allowedOrigin = reqOrigin.includes("bcine.ru") ? reqOrigin : "https://main.bcine.ru";

    const corsHeaders = {
      "Access-Control-Allow-Origin": allowedOrigin,
      "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Range, DNT, User-Agent, X-Requested-With, If-Modified-Since, Cache-Control, Content-Type, Authorization",
      "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, Content-Type, Content-Disposition",
      "Access-Control-Allow-Credentials": "true",
      "Vary": "Origin, Access-Control-Request-Headers",
    };

    // 2. CORS Preflight (OPTIONS)
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders,
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // 3. Domain Check & 24-Hour Ban Enforcement
    const isAuthorized = isAuthorizedOrigin(request);
    const isBanned = handleBanCheck(clientIp, isAuthorized);

    if (isBanned) {
      return new Response("Visit main.bcine.ru to watch.", {
        status: 403,
        headers: {
          ...corsHeaders,
          "Content-Type": "text/plain; charset=utf-8",
        },
      });
    }

    // Extract Path Key
    const pathname = url.pathname.substring(1);
    const pathKey = pathname.replace(/\.(m3u8|ts|mp4|key|vtt)$/i, '');

    let payload = null;

    // A. Check encrypted payload token first (distributed across all Edge nodes)
    if (pathKey) {
      payload = unpackSync(pathKey);
    }

    // B. Check in-memory store fallback
    if (!payload && pathKey && tokenStore.has(pathKey)) {
      payload = tokenStore.get(pathKey);
    } 

    // C. Query Params fallback
    if (!payload) {
      const qd = url.searchParams.get("d");
      const qv = url.searchParams.get("v");
      const qurl = url.searchParams.get("url");

      if (qd) {
        payload = unpackSync(qd);
      } else if (qv && tokenStore.has(qv)) {
        payload = tokenStore.get(qv);
      } else if (qurl) {
        payload = {
          u: qurl,
          r: url.searchParams.get("referer") || url.searchParams.get("ref") || "",
          o: url.searchParams.get("origin") || url.searchParams.get("ori") || "",
        };
      }
    }

    // 4. Subtitle Endpoint with Edge Caching
    if (url.pathname.includes("vtt")) {
      if (!payload || !payload.u) {
        return new Response("Missing subtitle payload", { status: 400, headers: corsHeaders });
      }

      try {
        const subRes = await fetch(payload.u, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
            "Referer": payload.r || new URL(payload.u).origin + "/",
            "Origin": payload.o || new URL(payload.u).origin,
          },
          cf: { cacheEverything: true, cacheTtl: 86400 },
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
            "Cache-Control": "public, max-age=86400, s-maxage=86400",
          },
        });
      } catch (err) {
        return new Response("Subtitle error", { status: 500, headers: corsHeaders });
      }
    }

    // 5. Default Health Check
    if (!payload || !payload.u) {
      return new Response("Visit main.bcine.ru to watch.", {
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
      reqHeaders.set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36");
      reqHeaders.set("Accept", "*/*");
      reqHeaders.set("Referer", referer);
      if (origin) reqHeaders.set("Origin", origin);

      for (const [key, value] of Object.entries(parsedHeaders)) {
        if (!["referer", "origin", "user-agent", "host", "connection", "accept-encoding"].includes(key.toLowerCase())) {
          reqHeaders.set(key, String(value));
        }
      }

      const rangeHeader = request.headers.get("Range");
      if (rangeHeader) {
        reqHeaders.set("Range", rangeHeader);
      }

      const isExplicitSegment = url.pathname.endsWith(".ts") || url.pathname.endsWith(".mp4");
      const isExplicitM3U8 = url.pathname.endsWith(".m3u8");

      // TURBO FETCH: Cache video chunks at Cloudflare Edge to prevent playback cancellation
      const proxyRes = await fetch(targetUrlStr, {
        method: request.method,
        headers: reqHeaders,
        cf: isExplicitSegment ? { cacheEverything: true, cacheTtl: 86400 * 7 } : { cacheEverything: false },
        redirect: "follow",
      });

      const finalResolvedUrl = proxyRes.url || targetUrlStr;

      // Clean upstream CORS headers to avoid duplicate header conflicts
      const resHeaders = new Headers(proxyRes.headers);
      resHeaders.delete("access-control-allow-origin");
      resHeaders.delete("access-control-allow-methods");
      resHeaders.delete("access-control-allow-headers");
      resHeaders.delete("access-control-expose-headers");
      resHeaders.delete("content-security-policy");
      resHeaders.delete("x-frame-options");

      for (const [ck, cv] of Object.entries(corsHeaders)) {
        resHeaders.set(ck, cv);
      }

      let contentType = resHeaders.get("Content-Type") || "";
      const isM3U8 = !isExplicitSegment && (isExplicitM3U8 || contentType.includes("mpegurl") || contentType.includes("application/x-mpegURL") || contentType.includes("application/vnd.apple.mpegurl"));

      if (isM3U8) {
        contentType = "application/vnd.apple.mpegurl; charset=utf-8";
      } else if (contentType.includes("mp4") || contentType.includes("video/iso.segment") || url.pathname.endsWith(".mp4")) {
        contentType = "video/mp4";
      } else if (isExplicitSegment || contentType.includes("mp2t") || contentType.includes("video/ts")) {
        contentType = "video/mp2t";
      }

      resHeaders.set("Content-Type", contentType);
      resHeaders.set("Content-Disposition", "inline");

      if (isM3U8) {
        resHeaders.set("Cache-Control", "no-cache, no-store, must-revalidate, max-age=0");
      } else {
        resHeaders.set("Cache-Control", "public, max-age=604800, s-maxage=604800, immutable");
      }

      if (!resHeaders.get("Accept-Ranges")) {
        resHeaders.set("Accept-Ranges", "bytes");
      }

      // Handle HEAD request gracefully (Prevents player abort)
      if (request.method === "HEAD") {
        return new Response(null, {
          status: proxyRes.status,
          statusText: proxyRes.statusText,
          headers: resHeaders,
        });
      }

      // 6. Rewrite M3U8 Playlists using Self-Contained Encrypted Tokens
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

            // Rewrite URI tags inside #EXT-X-MEDIA, #EXT-X-KEY, #EXT-X-MAP
            return line.replace(/URI=(["'])(.*?)\1|URI=([^\s,]+)/gi, (match, quote, p1, p2) => {
              const rawUri = p1 || p2;
              if (!rawUri) return match;
              try {
                const absUri = new URL(rawUri, finalResolvedUrl).href;
                const isKey = trimmed.startsWith("#EXT-X-KEY");
                const isMap = trimmed.startsWith("#EXT-X-MAP");
                const isMedia = trimmed.startsWith("#EXT-X-MEDIA");
                
                let ext = "ts";
                if (isKey) ext = "key";
                else if (isMap) ext = "mp4";
                else if (isMedia && (absUri.includes(".m3u8") || absUri.includes("cdn-m3u8"))) ext = "m3u8";

                const q = quote || '"';
                const token = packSync({ u: absUri, r: referer, o: origin, h: parsedHeaders }) || saveToShortStore({ u: absUri, r: referer, o: origin, h: parsedHeaders });
                return `URI=${q}${proxyOrigin}/${token}.${ext}${q}`;
              } catch (e) {
                return match;
              }
            });
          }

          // Content Segments / Child Playlist Lines
          try {
            const absUri = new URL(trimmed, finalResolvedUrl).href;
            let ext = "ts";
            if (isNextStreamInf || absUri.includes(".m3u8") || absUri.includes("cdn-m3u8") || absUri.includes("/hls/")) {
              ext = "m3u8";
            } else if (isNextExtInf) {
              ext = absUri.includes(".mp4") ? "mp4" : "ts";
            }

            isNextStreamInf = false;
            isNextExtInf = false;
            
            const token = packSync({ u: absUri, r: referer, o: origin, h: parsedHeaders }) || saveToShortStore({ u: absUri, r: referer, o: origin, h: parsedHeaders });
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

      // 7. Video Chunk Stream Delivery
      return new Response(proxyRes.body, {
        status: proxyRes.status,
        statusText: proxyRes.statusText,
        headers: resHeaders,
      });
    } catch (err) {
      return new Response("Visit main.bcine.ru to watch.", {
        status: 502,
        headers: corsHeaders,
      });
    }
  },
};
