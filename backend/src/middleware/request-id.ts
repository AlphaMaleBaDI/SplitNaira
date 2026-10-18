import type { RequestHandler } from "express";
import { randomUUID } from "crypto";
import { requestContext } from "../services/request-context.js";

/** Longest inbound correlation id we keep; matches `audit_log.request_id` (varchar 64). */
export const MAX_REQUEST_ID_LENGTH = 64;

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]+$/;
/** Three dot-separated base64url segments starting `eyJ` is a JWT, i.e. a credential. */
const JWT_SHAPED = /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

/**
 * Returns the trimmed inbound id when it is safe to log and echo, else null.
 *
 * Correlation ids are client-controlled and end up in every log line, the audit
 * log and response headers, so anything that is not a plain identifier is
 * dropped: whitespace/control characters (log injection), over-long values, and
 * values shaped like a bearer token, so a client that pastes a credential into
 * the header never gets it recorded or reflected (#1450).
 */
export function sanitizeInboundRequestId(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value || value.length > MAX_REQUEST_ID_LENGTH) return null;
  if (!SAFE_REQUEST_ID.test(value) || JWT_SHAPED.test(value)) return null;
  return value;
}

/**
 * Generates (or propagates) a request correlation id.
 * - Accepts inbound `x-request-id` or `x-correlation-id` when it passes
 *   {@link sanitizeInboundRequestId}; otherwise generates a UUID
 * - Always sets `res.locals.requestId`
 * - Mirrors both headers in the response for cross-service tracing
 * - Stores requestId in AsyncLocalStorage for automatic logger correlation
 */
export const requestIdMiddleware: RequestHandler = (req, res, next) => {
  const requestId =
    sanitizeInboundRequestId(req.header("x-request-id")) ??
    sanitizeInboundRequestId(req.header("x-correlation-id")) ??
    randomUUID();

  res.locals.requestId = requestId;
  res.setHeader("x-request-id", requestId);
  res.setHeader("x-correlation-id", requestId);

  requestContext.run({ requestId }, () => {
    next();
  });
};
