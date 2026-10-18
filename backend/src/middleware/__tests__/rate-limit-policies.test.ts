import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Issue #1462: per-route rate limit policies.
 *
 * The limits are read from the environment at module import, so every case
 * resets the module registry and restores the environment afterwards.
 */
const TOUCHED_ENV = [
  "RATE_LIMIT_WINDOW_MS",
  "RATE_LIMIT_GLOBAL_MAX",
  "RATE_LIMIT_MAX",
  "RATE_LIMIT_WRITE_MAX",
  "RATE_LIMIT_ADMIN_MAX",
  "RATE_LIMIT_AUTH_WINDOW_MS",
  "RATE_LIMIT_AUTH_MAX",
  "RATE_LIMIT_SSE_MAX",
] as const;

const originalEnv: Record<string, string | undefined> = {};
for (const key of TOUCHED_ENV) {
  originalEnv[key] = process.env[key];
}

afterEach(() => {
  for (const key of TOUCHED_ENV) {
    if (originalEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = originalEnv[key];
    }
  }
  vi.resetModules();
});

async function loadRateLimitModule() {
  vi.resetModules();
  return import("../rate-limit.js");
}

describe("Issue #1462: rate limit policy registry", () => {
  it("exposes a policy for every route group", async () => {
    const mod = await loadRateLimitModule();

    const names = mod.listRateLimitPolicies().map((p) => p.name).sort();
    expect(names).toEqual(["admin", "auth", "global", "read", "sse", "write"]);
  });

  it("gives every policy a positive window, positive limit and env keys", async () => {
    const mod = await loadRateLimitModule();

    for (const policy of mod.listRateLimitPolicies()) {
      expect(policy.windowMs, policy.name).toBeGreaterThan(0);
      expect(policy.limit, policy.name).toBeGreaterThan(0);
      expect(policy.description.length, policy.name).toBeGreaterThan(0);
      expect(policy.env.windowMs.length, policy.name).toBeGreaterThan(0);
      expect(policy.env.limit.length, policy.name).toBeGreaterThan(0);
      expect(mod.getRateLimitPolicy(policy.name)).toBe(policy);
    }
  });

  it("keeps auth, write and admin budgets stricter than reads", async () => {
    const { getRateLimitPolicy } = await loadRateLimitModule();

    const read = getRateLimitPolicy("read");
    const auth = getRateLimitPolicy("auth");
    const write = getRateLimitPolicy("write");
    const admin = getRateLimitPolicy("admin");

    expect(auth.limit).toBeLessThan(read.limit);
    expect(write.limit).toBeLessThan(read.limit);
    expect(admin.limit).toBeLessThanOrEqual(write.limit);
    expect(auth.windowMs).toBeLessThan(read.windowMs);
  });

  it("honours environment overrides", async () => {
    process.env.RATE_LIMIT_MAX = "7";
    process.env.RATE_LIMIT_WRITE_MAX = "3";
    process.env.RATE_LIMIT_AUTH_WINDOW_MS = "60000";

    const { getRateLimitPolicy } = await loadRateLimitModule();

    expect(getRateLimitPolicy("read").limit).toBe(7);
    expect(getRateLimitPolicy("write").limit).toBe(3);
    expect(getRateLimitPolicy("auth").windowMs).toBe(60_000);
  });

  it("ignores invalid overrides instead of disabling the limit", async () => {
    process.env.RATE_LIMIT_MAX = "0";
    process.env.RATE_LIMIT_WRITE_MAX = "not-a-number";
    process.env.RATE_LIMIT_AUTH_MAX = "-5";

    const { getRateLimitPolicy } = await loadRateLimitModule();

    expect(getRateLimitPolicy("read").limit).toBe(100);
    expect(getRateLimitPolicy("write").limit).toBe(30);
    expect(getRateLimitPolicy("auth").limit).toBe(10);
  });
});

describe("Issue #1462: per-route enforcement", () => {
  it("applies distinct limits to read and write routes", async () => {
    process.env.RATE_LIMIT_MAX = "3";
    process.env.RATE_LIMIT_WRITE_MAX = "1";

    const { readLimiter, writeLimiter } = await loadRateLimitModule();

    const app = express();
    app.use(express.json());
    app.get("/read", readLimiter, (_req, res) => res.json({ ok: true }));
    app.post("/write", writeLimiter, (_req, res) => res.json({ ok: true }));

    for (let i = 0; i < 3; i++) {
      const res = await request(app).get("/read");
      expect(res.status).toBe(200);
    }
    const readBlocked = await request(app).get("/read");
    expect(readBlocked.status).toBe(429);

    const writeOk = await request(app).post("/write").send({});
    expect(writeOk.status).toBe(200);
    const writeBlocked = await request(app).post("/write").send({});
    expect(writeBlocked.status).toBe(429);
  });

  it("returns the stable rate-limit error envelope on 429", async () => {
    process.env.RATE_LIMIT_MAX = "1";

    const { readLimiter } = await loadRateLimitModule();

    const app = express();
    app.get("/read", readLimiter, (_req, res) => res.json({ ok: true }));

    await request(app).get("/read");
    const res = await request(app).get("/read");

    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({
      error: "rate_limited",
      code: "RATE_LIMITED",
      message: "Too many requests. Please try again later.",
    });
  });
});
