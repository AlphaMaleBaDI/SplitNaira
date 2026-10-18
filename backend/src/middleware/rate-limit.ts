import rateLimit from "express-rate-limit";
import type { Request, Response } from "express";

/**
 * Issue #1462: per-route rate limit policies.
 *
 * Every route group is mapped to a named, declarative policy instead of a
 * loose set of module constants. This keeps the limits:
 *
 *   - discoverable: `listRateLimitPolicies()` is the single source of truth
 *     used by docs and tests,
 *   - configurable: each policy reads its window/limit from the environment
 *     so production limits can be tightened without a code deploy,
 *   - auditable: auth, read, write, admin and operational traffic have
 *     deliberately distinct budgets (see docs/rate-limiting-guidance.md).
 *
 * Layering (outermost first), preserved from the original implementation:
 *   1. `global`  — volumetric safety net applied to every request
 *   2. `auth`    — credential-stuffing / replay bursts
 *   3. `admin`   — payments-admin surface
 *   4. `read`    — general reads
 *   5. `write`   — mutations
 *   6. `sse`     — event-stream connection rate
 */

export type RateLimitPolicyName =
  | "global"
  | "read"
  | "write"
  | "admin"
  | "auth"
  | "sse";

export interface RateLimitPolicy {
  name: RateLimitPolicyName;
  /** Human-readable summary surfaced by docs and the policy-listing helper. */
  description: string;
  /** Length of the rate-limit window, in milliseconds. */
  windowMs: number;
  /** Maximum requests permitted per window, per client identity. */
  limit: number;
  /** Environment variables that override `windowMs` / `limit`. */
  env: {
    windowMs: string;
    limit: string;
  };
}

/**
 * Reads a strictly-positive integer from the environment. Unset, empty,
 * non-numeric, zero and negative values all fall back to `fallback` so a bad
 * override can never *disable* rate limiting (a zero/negative limit would).
 */
function readPositiveInt(envVar: string, fallback: number): number {
  const raw = process.env[envVar];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_AUTH_WINDOW_MS = 5 * 60 * 1000;

/**
 * Resolved policy table. Values reflect the environment at import time;
 * callers that need to reflect over the effective configuration should use
 * `listRateLimitPolicies()` rather than re-reading `process.env`.
 */
export const RATE_LIMIT_POLICIES: Record<RateLimitPolicyName, RateLimitPolicy> = {
  global: {
    name: "global",
    description: "Volumetric safety net applied to every request.",
    windowMs: readPositiveInt("RATE_LIMIT_WINDOW_MS", DEFAULT_WINDOW_MS),
    limit: readPositiveInt("RATE_LIMIT_GLOBAL_MAX", 500),
    env: { windowMs: "RATE_LIMIT_WINDOW_MS", limit: "RATE_LIMIT_GLOBAL_MAX" },
  },
  read: {
    name: "read",
    description: "General read endpoints (GET on resource collections).",
    windowMs: readPositiveInt("RATE_LIMIT_WINDOW_MS", DEFAULT_WINDOW_MS),
    limit: readPositiveInt("RATE_LIMIT_MAX", 100),
    env: { windowMs: "RATE_LIMIT_WINDOW_MS", limit: "RATE_LIMIT_MAX" },
  },
  write: {
    name: "write",
    description: "Mutation endpoints (create/update/delete).",
    windowMs: readPositiveInt("RATE_LIMIT_WINDOW_MS", DEFAULT_WINDOW_MS),
    limit: readPositiveInt("RATE_LIMIT_WRITE_MAX", 30),
    env: { windowMs: "RATE_LIMIT_WINDOW_MS", limit: "RATE_LIMIT_WRITE_MAX" },
  },
  admin: {
    name: "admin",
    description: "Payments-admin endpoints under /splits/admin.",
    windowMs: readPositiveInt("RATE_LIMIT_WINDOW_MS", DEFAULT_WINDOW_MS),
    limit: readPositiveInt("RATE_LIMIT_ADMIN_MAX", 20),
    env: { windowMs: "RATE_LIMIT_WINDOW_MS", limit: "RATE_LIMIT_ADMIN_MAX" },
  },
  auth: {
    name: "auth",
    description: "Auth / wallet endpoints (credential-stuffing protection).",
    windowMs: readPositiveInt("RATE_LIMIT_AUTH_WINDOW_MS", DEFAULT_AUTH_WINDOW_MS),
    limit: readPositiveInt("RATE_LIMIT_AUTH_MAX", 10),
    env: { windowMs: "RATE_LIMIT_AUTH_WINDOW_MS", limit: "RATE_LIMIT_AUTH_MAX" },
  },
  sse: {
    name: "sse",
    description: "Server-Sent Events connection rate.",
    windowMs: readPositiveInt("RATE_LIMIT_WINDOW_MS", DEFAULT_WINDOW_MS),
    limit: readPositiveInt("RATE_LIMIT_SSE_MAX", 20),
    env: { windowMs: "RATE_LIMIT_WINDOW_MS", limit: "RATE_LIMIT_SSE_MAX" },
  },
};

/** Returns the resolved policy for a route group. */
export function getRateLimitPolicy(name: RateLimitPolicyName): RateLimitPolicy {
  return RATE_LIMIT_POLICIES[name];
}

/** Returns every resolved policy, for docs and contract tests. */
export function listRateLimitPolicies(): RateLimitPolicy[] {
  return Object.values(RATE_LIMIT_POLICIES);
}

function rateLimitHandler(_req: Request, res: Response) {
  return res.status(429).json({
    error: "rate_limited",
    code: "RATE_LIMITED",
    message: "Too many requests. Please try again later.",
    retryAfter: res.getHeader("Retry-After"),
    requestId: res.locals.requestId as string | undefined,
  });
}

type RateLimitOptions = Parameters<typeof rateLimit>[0];

function createLimiter(
  policy: RateLimitPolicy,
  overrides: Partial<RateLimitOptions> = {},
) {
  return rateLimit({
    windowMs: policy.windowMs,
    limit: policy.limit,
    standardHeaders: true,
    legacyHeaders: false,
    handler: rateLimitHandler,
    ...overrides,
  });
}

/**
 * Global safety-net limiter — applied to EVERY route.
 * Protects the process from catastrophic volumetric floods.
 */
export const globalLimiter = createLimiter(RATE_LIMIT_POLICIES.global, {
  // Skip well-known health check calls from internal monitors.
  skip: (req) => req.path === "/health" && req.method === "GET",
});

/** General read endpoints. */
export const readLimiter = createLimiter(RATE_LIMIT_POLICIES.read);

/** Write / mutation endpoints. */
export const writeLimiter = createLimiter(RATE_LIMIT_POLICIES.write);

/** Admin endpoints. */
export const adminLimiter = createLimiter(RATE_LIMIT_POLICIES.admin);

/** Auth / wallet endpoints — strict burst cap against credential stuffing. */
export const authLimiter = createLimiter(RATE_LIMIT_POLICIES.auth);

/** SSE connection limiter — protects event stream endpoints. */
export const sseConnectionLimiter = createLimiter(RATE_LIMIT_POLICIES.sse);
