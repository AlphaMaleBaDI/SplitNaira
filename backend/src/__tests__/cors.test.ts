import { StrKey } from "@stellar/stellar-sdk";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import express from "express";
import cors from "cors";
import { resolveCorsOrigins } from "../config/cors.js";

/**
 * Builds a minimal Express app wired with the SAME `resolveCorsOrigins`
 * helper (and the same `credentials: false` decision) that `src/index.ts`
 * uses in production, so these tests exercise the real CORS logic rather
 * than a re-implementation of it.
 */
function buildApp(env: NodeJS.ProcessEnv) {
  const app = express();
  const origin = resolveCorsOrigins(env);
  app.use(cors({ origin, credentials: false }));
  app.get("/ping", (_req, res) => res.json({ ok: true }));
  return app;
}

describe("CORS preflight behaviour", () => {
  it("allows preflight from an explicitly allowed production origin", async () => {
    const app = buildApp({ NODE_ENV: "production", CORS_ORIGIN: "https://app.splitnaira.com" });
    const res = await request(app)
      .options("/ping")
      .set("Origin", "https://app.splitnaira.com")
      .set("Access-Control-Request-Method", "GET");

    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("https://app.splitnaira.com");
  });

  it("blocks preflight from an origin not in the allowlist", async () => {
    const app = buildApp({ NODE_ENV: "production", CORS_ORIGIN: "https://app.splitnaira.com" });
    const res = await request(app)
      .options("/ping")
      .set("Origin", "https://evil.example.com")
      .set("Access-Control-Request-Method", "GET");

    // cors middleware omits the header when origin is not allowed
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("allows multiple comma-separated origins", async () => {
    const app = buildApp({
      NODE_ENV: "production",
      CORS_ORIGIN: "https://app.splitnaira.com,https://splitnaira.com",
    });

    const res1 = await request(app)
      .options("/ping")
      .set("Origin", "https://app.splitnaira.com")
      .set("Access-Control-Request-Method", "GET");
    expect(res1.headers["access-control-allow-origin"]).toBe("https://app.splitnaira.com");

    const res2 = await request(app)
      .options("/ping")
      .set("Origin", "https://splitnaira.com")
      .set("Access-Control-Request-Method", "GET");
    expect(res2.headers["access-control-allow-origin"]).toBe("https://splitnaira.com");
  });

  it("allows the local development origin by default when CORS_ORIGIN is unset", async () => {
    const app = buildApp({ NODE_ENV: "development" });
    const res = await request(app)
      .options("/ping")
      .set("Origin", "http://localhost:3000")
      .set("Access-Control-Request-Method", "GET");

    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
  });

  it("does not reflect an arbitrary origin in local development", async () => {
    const app = buildApp({ NODE_ENV: "development" });
    const res = await request(app)
      .options("/ping")
      .set("Origin", "https://not-localhost.example.com")
      .set("Access-Control-Request-Method", "GET");

    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("serves non-browser requests with no Origin header without CORS headers", async () => {
    // Simulates curl / server-to-server calls / same-origin requests, which
    // never send an Origin header. The request itself must still succeed;
    // it simply carries no CORS headers because none were requested.
    const app = buildApp({ NODE_ENV: "production", CORS_ORIGIN: "https://app.splitnaira.com" });
    const res = await request(app).get("/ping");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("never sets Access-Control-Allow-Credentials, even for an allowed origin", async () => {
    // The API authenticates via a bearer token in the Authorization header
    // (see middleware/auth-jwt.ts), never cookies, so credentialed CORS is
    // intentionally disabled everywhere - this must stay false.
    const app = buildApp({ NODE_ENV: "production", CORS_ORIGIN: "https://app.splitnaira.com" });
    const res = await request(app)
      .options("/ping")
      .set("Origin", "https://app.splitnaira.com")
      .set("Access-Control-Request-Method", "GET");

    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("https://app.splitnaira.com");
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
  });
});

describe("resolveCorsOrigins", () => {
  it("rejects a wildcard origin in production", () => {
    expect(() => resolveCorsOrigins({ NODE_ENV: "production", CORS_ORIGIN: "*" })).toThrow(
      /wildcard.*not allowed in production/i,
    );
  });

  it("rejects a wildcard mixed in with explicit origins in production", () => {
    expect(() =>
      resolveCorsOrigins({ NODE_ENV: "production", CORS_ORIGIN: "https://app.splitnaira.com,*" }),
    ).toThrow(/wildcard.*not allowed in production/i);
  });

  it("allows a wildcard outside production", () => {
    expect(resolveCorsOrigins({ NODE_ENV: "development", CORS_ORIGIN: "*" })).toEqual(["*"]);
  });

  it("defaults to the local dev origin when CORS_ORIGIN is unset", () => {
    expect(resolveCorsOrigins({ NODE_ENV: "development" })).toEqual(["http://localhost:3000"]);
  });
});

describe("CORS production env validation", () => {
  // Minimal env that satisfies all required schema fields
  const requiredEnv: Record<string, string> = {
    NODE_ENV: "production",
    DATABASE_URL: "postgresql://user:pass@localhost:5432/splitnaira",
    HORIZON_URL: "https://horizon-testnet.stellar.org",
    SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
    SOROBAN_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
    // Issue #1502: this literal was well-formed but its StrKey checksum did not
    // match, so it failed startup validation. Generated through the SDK so the
    // fixture is always a contract ID the network would actually accept.
    CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32, 7)),
    SIMULATOR_ACCOUNT: "test_account",
    PAYMENTS_ADMIN_API_KEY: "test-admin-key",
  };

  beforeEach(() => {
    Object.entries(requiredEnv).forEach(([k, v]) => vi.stubEnv(k, v));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects wildcard CORS_ORIGIN in production", async () => {
    vi.stubEnv("CORS_ORIGIN", "*");
    const { validateEnv, clearEnvCache } = await import("../config/env.js");
    clearEnvCache();
    expect(() => validateEnv()).toThrow(/must not contain '\*'/i);
  });

  it("rejects missing CORS_ORIGIN in production", async () => {
    vi.unstubAllEnvs();
    Object.entries({ ...requiredEnv }).forEach(([k, v]) => vi.stubEnv(k, v));
    // Ensure CORS_ORIGIN is explicitly absent
    vi.stubEnv("CORS_ORIGIN", "");
    const { validateEnv, clearEnvCache } = await import("../config/env.js");
    clearEnvCache();
    expect(() => validateEnv()).toThrow(/CORS_ORIGIN is required in production/i);
  });

  it("accepts explicit origin(s) in production", async () => {
    vi.stubEnv("CORS_ORIGIN", "https://app.splitnaira.com");
    const { validateEnv, clearEnvCache } = await import("../config/env.js");
    clearEnvCache();
    const result = validateEnv();
    expect(result.CORS_ORIGIN).toBe("https://app.splitnaira.com");
  });
});
