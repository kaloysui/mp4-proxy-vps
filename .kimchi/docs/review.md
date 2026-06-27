# Code Review: Cloudflare Worker MP4 Proxy

## Verdict: NEEDS_FIXES

The implementation is functionally correct and matches the supplied implementation plan, but one reviewed file still contains a stale HLS reference and the design spec has a minor status-code inconsistency that should be resolved.

## Issues

### 1. Stale HLS reference in `package.json`

- **File:** `/root/mp4-proxy-vps/package.json`
- **Line:** 4
- **Problem:** The `description` field still reads `"Cloudflare Worker MP4/HLS proxy for 1embed.cc"`. The Worker no longer supports HLS / `.m3u8` playlists, and the README correctly states MP4-only behavior. This stale reference is confusing and inconsistent with the spec.
- **Suggested fix:** Update the description to `"Cloudflare Worker MP4 proxy for 1embed.cc"`.

### 2. Upstream 5xx responses are mapped to 502, conflicting with the design spec

- **File:** `/root/mp4-proxy-vps/src/index.js`
- **Lines:** 134-136
- **Problem:** The design spec states: "If upstream status is 403/5xx and retry also fails, return the upstream status with plain-text body." The current code maps any upstream 5xx to status `502`:

  ```javascript
  if (!resp.ok && resp.status !== 206) {
    return errorResponse(`Upstream error: ${resp.status}`, resp.status >= 500 ? 502 : resp.status);
  }
  ```

  This means an upstream `503` is returned to the client as `502`, which deviates from the spec. The implementation plan's code snippet contains the same mapping, so the implementation matches the plan but not the design spec text.
- **Suggested fix:** Either update the design spec to document the 502 mapping (if intentional), or change the code to return the original upstream status for 5xx responses:

  ```javascript
  return errorResponse(`Upstream error: ${resp.status}`, resp.status);
  ```

## Verification Performed

- Read design spec and implementation plan.
- Reviewed `src/index.js`, `README.md`, `wrangler.toml`, and `package.json`.
- Confirmed no `.m3u8` / HLS playlist rewriting logic remains in `src/index.js`.
- Confirmed `USER_AGENTS` list and `randomUserAgent()` are present and used for every upstream request and retry.
- Confirmed `shouldRetry(status)` only retries on `403` and `5xx`, not `404`.
- Confirmed domain restriction is case-insensitive and correctly rejects `evil1embed.cc` and `1embed.cc.evil.com` while allowing `1embed.cc` and `*.1embed.cc`.
- Confirmed CORS headers are present on success, error, and `OPTIONS` preflight responses.
- Confirmed `Range` header is forwarded; verified `206 Partial Content` response with `Content-Range` and `Accept-Ranges` headers.
- Ran `npx wrangler deploy --dry-run`: passed.
- Ran local curl smoke tests with `npx wrangler dev --local --port 8787`:
  - Forbidden origin (`evil1embed.cc`): `403 Forbidden` with CORS headers.
  - Missing `url`: `400 Missing url` with CORS headers.
  - Invalid URL: `400 Invalid URL` with CORS headers.
  - `POST` method: `405 Method Not Allowed` with CORS headers.
  - Trailing slash `/mp4-proxy/`: accepted (returns upstream status, not Worker 404).
  - Allowed referer from subdomain (`sub.1embed.cc`): accepted.
  - Case-insensitive origin (`1EmBed.CC`): accepted.
  - Range request to MDN sample MP4: `206 Partial Content` with correct headers.
  - `OPTIONS` preflight: `204 No Content` with correct CORS headers.

## Other Observations

- `wrangler.toml` routes are intentionally commented out as placeholders; this is consistent with the spec/plan and acceptable for a dry-run review.
- No unit/integration test files exist. Consider adding automated tests for the retry logic and domain restriction if the project grows.
- No linting configuration is present; consider adding `eslint` or `prettier` for consistency.
