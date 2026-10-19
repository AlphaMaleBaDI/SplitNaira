/**
 * Which requests may be retried automatically.
 *
 * A retry after a network failure or 5xx can repeat a side effect the server
 * already applied (the response was lost, not the request). Only requests that
 * are known to be idempotent are retried:
 *
 * - `GET`, `HEAD` and `OPTIONS` (safe methods; `GET` is the fetch default)
 * - any request carrying an `Idempotency-Key` header, which the backend uses
 *   to replay the original response instead of acting twice (#1266)
 * - requests explicitly marked `idempotent: true` by the caller
 *
 * Everything else (`POST`, `PUT`, `PATCH`, `DELETE`) fails fast and leaves
 * the decision to retry with the user. See docs/FRONTEND_RUNBOOK.md.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export interface RetryableInit {
  method?: string;
  headers?: HeadersInit;
  /** Caller assertion that repeating this request has no extra side effect. */
  idempotent?: boolean;
}

function hasIdempotencyKey(headers: HeadersInit | undefined): boolean {
  if (!headers) return false;
  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    return Boolean(headers.get("Idempotency-Key"));
  }
  const entries = Array.isArray(headers) ? headers : Object.entries(headers);
  return entries.some(([name, value]) => name.toLowerCase() === "idempotency-key" && Boolean(value));
}

export function isIdempotentRequest(init?: RetryableInit): boolean {
  if (init?.idempotent === true) return true;
  if (init?.idempotent === false) return false;
  const method = (init?.method ?? "GET").toUpperCase();
  return SAFE_METHODS.has(method) || hasIdempotencyKey(init?.headers);
}
