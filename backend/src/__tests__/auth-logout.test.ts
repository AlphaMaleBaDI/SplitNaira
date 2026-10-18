/**
 * Logout across browser tabs (#1451).
 *
 * Wallet JWTs are stateless, so every tab of a browser holds its own copy of
 * the same token. Logging out in one tab must leave the other tabs in the same
 * place a password reset would: their next request gets `401 SESSION_REVOKED`.
 *
 * `services/session-revocation.js` is replaced by an in-memory stand-in with
 * the same contract as the SQL (version-conditional bump), so the real routes,
 * middleware and JWT code run end to end. The SQL itself needs Postgres.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { authAccountRouter } from "../routes/auth-account.js";
import { authJwtMiddleware } from "../middleware/auth-jwt.js";
import { errorHandler, notFoundHandler } from "../middleware/error.js";
import { requestIdMiddleware } from "../middleware/request-id.js";
import { signToken } from "../services/jwt.js";

const WALLET_A = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const WALLET_B = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWHF";
const WALLET_NO_ROW = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCWHF";

let versions: Map<string, number>;
/** Simulates another tab logging out between the middleware check and the revoke. */
let raceBeforeRevoke = false;
const revokeCalls: Array<{ wallet: string; expected: number }> = [];

vi.mock("../services/session-revocation.js", () => ({
  getSessionVersion: async (wallet: string) => versions.get(wallet) ?? null,
  getMaxSessionVersionForEmail: async () => null,
  revokeSessionsForEmail: async () => 0,
  revokeSessionForWallet: async (wallet: string, expected: number) => {
    revokeCalls.push({ wallet, expected });
    if (raceBeforeRevoke) versions.set(wallet, (versions.get(wallet) ?? 0) + 1);
    const current = versions.get(wallet);
    if (current === undefined || current !== expected) return 0;
    versions.set(wallet, current + 1);
    return 1;
  },
}));

vi.mock("../services/database.js", () => ({
  getDataSource: () => ({ getRepository: () => ({}) }),
}));

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use("/auth", authAccountRouter);
  app.get("/protected", authJwtMiddleware, (req, res) => {
    res.json({ walletAddress: req.user?.walletAddress });
  });
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

const bearer = (token: string) => `Bearer ${token}`;

describe("POST /auth/logout across tabs (#1451)", () => {
  beforeEach(() => {
    versions = new Map([
      [WALLET_A, 0],
      [WALLET_B, 0],
    ]);
    revokeCalls.length = 0;
    raceBeforeRevoke = false;
  });

  it("logs the current session out and reports it", async () => {
    const app = createApp();
    const token = signToken(WALLET_A, 0);

    const res = await request(app).post("/auth/logout").set("Authorization", bearer(token));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, sessionsRevoked: true });
    expect(res.body.requestId).toBe(res.headers["x-request-id"]);
    expect(versions.get(WALLET_A)).toBe(1);
  });

  it("rejects the same token afterwards with SESSION_REVOKED", async () => {
    const app = createApp();
    const token = signToken(WALLET_A, 0);
    await request(app).post("/auth/logout").set("Authorization", bearer(token)).expect(200);

    const res = await request(app).get("/protected").set("Authorization", bearer(token));

    expect(res.status).toBe(401);
    expect(res.body.code).toBe("SESSION_REVOKED");
  });

  it("invalidates every other tab holding a token for the same wallet", async () => {
    const app = createApp();
    // Same wallet, same session version: tab 1 and tab 2 each hold a copy.
    const tab1 = signToken(WALLET_A, 0);
    const tab2 = signToken(WALLET_A, 0);
    await request(app).get("/protected").set("Authorization", bearer(tab2)).expect(200);

    await request(app).post("/auth/logout").set("Authorization", bearer(tab1)).expect(200);

    const res = await request(app).get("/protected").set("Authorization", bearer(tab2));
    expect(res.status).toBe(401);
    // Exactly the response a password reset gives, so clients need one code path.
    expect(res.body).toMatchObject({
      error: "unauthorized",
      code: "SESSION_REVOKED",
      message: "Session has been revoked. Please log in again.",
    });
    expect(res.body.requestId).toBe(res.headers["x-request-id"]);
  });

  it("answers every other tab's next request the same way, whatever it calls", async () => {
    const app = createApp();
    const tabs = [signToken(WALLET_A, 0), signToken(WALLET_A, 0), signToken(WALLET_A, 0)];
    await request(app).post("/auth/logout").set("Authorization", bearer(tabs[0])).expect(200);

    for (const tab of tabs) {
      const protectedRes = await request(app).get("/protected").set("Authorization", bearer(tab));
      const logoutRes = await request(app).post("/auth/logout").set("Authorization", bearer(tab));
      expect(protectedRes.status).toBe(401);
      expect(logoutRes.status).toBe(401);
      expect(protectedRes.body.code).toBe("SESSION_REVOKED");
      expect(logoutRes.body.code).toBe("SESSION_REVOKED");
    }
    // Rejected logouts never reach the revoke call, so the version moves only once.
    expect(versions.get(WALLET_A)).toBe(1);
  });

  it("lets the user sign in again with a token for the new session version", async () => {
    const app = createApp();
    const oldToken = signToken(WALLET_A, 0);
    await request(app).post("/auth/logout").set("Authorization", bearer(oldToken)).expect(200);

    // POST /users/login issues signToken(wallet, user.sessionVersion).
    const freshToken = signToken(WALLET_A, versions.get(WALLET_A)!);
    await request(app).get("/protected").set("Authorization", bearer(freshToken)).expect(200);
    await request(app).get("/protected").set("Authorization", bearer(oldToken)).expect(401);
  });

  it("does not affect other wallets", async () => {
    const app = createApp();
    const a = signToken(WALLET_A, 0);
    const b = signToken(WALLET_B, 0);

    await request(app).post("/auth/logout").set("Authorization", bearer(a)).expect(200);

    await request(app).get("/protected").set("Authorization", bearer(b)).expect(200);
    expect(versions.get(WALLET_B)).toBe(0);
  });

  it("revokes only the version the token carries (a stale logout cannot kill a newer session)", async () => {
    const app = createApp();
    // The wallet already moved to version 3 (e.g. logged out and in several times).
    versions.set(WALLET_A, 3);
    const current = signToken(WALLET_A, 3);

    await request(app).post("/auth/logout").set("Authorization", bearer(current)).expect(200);

    expect(revokeCalls).toEqual([{ wallet: WALLET_A, expected: 3 }]);
    expect(versions.get(WALLET_A)).toBe(4);
  });

  it("two tabs logging out at once leave the account signed out exactly once", async () => {
    const app = createApp();
    const tab1 = signToken(WALLET_A, 0);
    const tab2 = signToken(WALLET_A, 0);

    const [r1, r2] = await Promise.all([
      request(app).post("/auth/logout").set("Authorization", bearer(tab1)),
      request(app).post("/auth/logout").set("Authorization", bearer(tab2)),
    ]);

    // Neither tab is left with an error it can't interpret.
    for (const r of [r1, r2]) {
      expect([200, 401]).toContain(r.status);
      if (r.status === 401) expect(r.body.code).toBe("SESSION_REVOKED");
    }
    expect(r1.status === 200 || r2.status === 200).toBe(true);
    // The conditional bump applies at most once, so a login that follows survives.
    expect(versions.get(WALLET_A)).toBe(1);
    await request(app).get("/protected").set("Authorization", bearer(tab1)).expect(401);
    await request(app).get("/protected").set("Authorization", bearer(tab2)).expect(401);
  });

  it("reports sessionsRevoked:false when another tab logged out first (race after the auth check)", async () => {
    const app = createApp();
    const token = signToken(WALLET_A, 0);
    raceBeforeRevoke = true;

    const res = await request(app).post("/auth/logout").set("Authorization", bearer(token));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, sessionsRevoked: false });
    // The other tab's logout stands; this one did not bump again.
    expect(versions.get(WALLET_A)).toBe(1);
    raceBeforeRevoke = false;
    await request(app).get("/protected").set("Authorization", bearer(token)).expect(401);
  });

  it("treats a wallet with no account row as nothing to revoke, not an error", async () => {
    const app = createApp();
    const token = signToken(WALLET_NO_ROW, 0);

    const res = await request(app).post("/auth/logout").set("Authorization", bearer(token));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, sessionsRevoked: false });
  });

  describe("failure cases", () => {
    it("rejects a request with no token", async () => {
      const res = await request(createApp()).post("/auth/logout");
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("UNAUTHORIZED");
    });

    it("rejects a malformed token", async () => {
      const res = await request(createApp())
        .post("/auth/logout")
        .set("Authorization", bearer("not-a-jwt"));
      expect(res.status).toBe(401);
      expect(res.body.code).toBe("UNAUTHORIZED");
    });

    it("rejects a token signed with the wrong secret", async () => {
      const jwt = (await import("jsonwebtoken")).default;
      const forged = jwt.sign({ walletAddress: WALLET_A, sv: 0 }, "some-other-secret");
      const res = await request(createApp())
        .post("/auth/logout")
        .set("Authorization", bearer(forged));
      expect(res.status).toBe(401);
      expect(versions.get(WALLET_A)).toBe(0);
    });

    it("rejects an expired token without revoking anything", async () => {
      const jwt = (await import("jsonwebtoken")).default;
      const expired = jwt.sign(
        { walletAddress: WALLET_A, sv: 0 },
        process.env.JWT_SECRET || "dev-secret-change-in-production",
        { expiresIn: -10 }
      );
      const res = await request(createApp())
        .post("/auth/logout")
        .set("Authorization", bearer(expired));
      expect(res.status).toBe(401);
      expect(revokeCalls).toHaveLength(0);
      expect(versions.get(WALLET_A)).toBe(0);
    });

    it("does not accept GET (logout changes state)", async () => {
      const res = await request(createApp())
        .get("/auth/logout")
        .set("Authorization", bearer(signToken(WALLET_A, 0)));
      expect(res.status).toBe(404);
      expect(versions.get(WALLET_A)).toBe(0);
    });
  });
});
