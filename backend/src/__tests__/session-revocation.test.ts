/**
 * Password reset session invalidation (#1446).
 *
 * `services/session-revocation.ts` is replaced with an in-memory stand-in
 * that follows the same contract as the SQL (per-email bump, conditional on
 * no account having moved past the token's version). That lets these tests
 * drive the real routes, middleware, and JWT code end to end. The SQL itself
 * needs Postgres and is not exercised here.
 */
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { authEmailRouter } from "../routes/auth-email.js";
import { authJwtMiddleware } from "../middleware/auth-jwt.js";
import { errorHandler, notFoundHandler } from "../middleware/error.js";
import { requestIdMiddleware } from "../middleware/request-id.js";
import { signToken, verifyToken } from "../services/jwt.js";
import { signEmailFlowToken } from "../services/email-provider.js";

const WALLET_A = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const WALLET_B = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWHF";
const WALLET_OTHER = "GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCWHF";
const EMAIL = "owner@example.com";

interface FakeUser {
  walletAddress: string;
  email: string;
  sessionVersion: number;
}

let users: FakeUser[];
const sendPasswordResetEmailMock = vi.fn();
const getSessionVersionMock = vi.fn();

vi.mock("../services/session-revocation.js", () => ({
  getSessionVersion: (wallet: string) => getSessionVersionMock(wallet),
  getMaxSessionVersionForEmail: async (email: string) => {
    const matches = users.filter((u) => u.email === email);
    return matches.length ? Math.max(...matches.map((u) => u.sessionVersion)) : null;
  },
  revokeSessionsForEmail: async (email: string, expectedVersion: number) => {
    const matches = users.filter((u) => u.email === email);
    if (matches.some((u) => u.sessionVersion > expectedVersion)) return 0;
    matches.forEach((u) => (u.sessionVersion += 1));
    return matches.length;
  },
}));

vi.mock("../services/database.js", () => ({
  getDataSource: () => ({
    getRepository: () => ({
      findOne: async ({ where }: { where: { email: string } }) =>
        users.find((u) => u.email === where.email) ?? null,
    }),
  }),
}));

vi.mock("../services/email-provider.js", async () => {
  const actual = await vi.importActual<typeof import("../services/email-provider.js")>(
    "../services/email-provider.js"
  );
  return {
    ...actual,
    getEmailProvider: () => ({ sendPasswordResetEmail: sendPasswordResetEmailMock }),
  };
});

function lookupFromFakeUsers(wallet: string) {
  const user = users.find((u) => u.walletAddress === wallet);
  return Promise.resolve(user ? user.sessionVersion : null);
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use("/auth", authEmailRouter);
  app.get("/protected", authJwtMiddleware, (req, res) => {
    res.json({ walletAddress: req.user?.walletAddress });
  });
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

/** Signs in the way /users/login does: a token at the user's current version. */
function login(wallet: string): string {
  const user = users.find((u) => u.walletAddress === wallet)!;
  return signToken(wallet, user.sessionVersion);
}

async function requestResetToken(app: express.Express): Promise<string> {
  await request(app).post("/auth/password-reset/request").send({ email: EMAIL }).expect(202);
  const call = sendPasswordResetEmailMock.mock.calls.at(-1)![0] as { token: string };
  return call.token;
}

function getProtected(app: express.Express, token: string) {
  return request(app).get("/protected").set("Authorization", `Bearer ${token}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  users = [
    { walletAddress: WALLET_A, email: EMAIL, sessionVersion: 0 },
    { walletAddress: WALLET_B, email: EMAIL, sessionVersion: 0 },
    { walletAddress: WALLET_OTHER, email: "someone-else@example.com", sessionVersion: 0 },
  ];
  sendPasswordResetEmailMock.mockResolvedValue(undefined);
  getSessionVersionMock.mockImplementation(lookupFromFakeUsers);
});

describe("JWT session version claim (#1446)", () => {
  it("embeds the session version as the sv claim", () => {
    expect(verifyToken(signToken(WALLET_A, 3))).toMatchObject({ walletAddress: WALLET_A, sv: 3 });
    expect(verifyToken(signToken(WALLET_A))).toMatchObject({ sv: 0 });
  });
});

describe("authJwtMiddleware session revocation (#1446)", () => {
  it("accepts a token whose sv matches the current session version", async () => {
    users[0].sessionVersion = 2;
    const res = await getProtected(createApp(), signToken(WALLET_A, 2)).expect(200);
    expect(res.body.walletAddress).toBe(WALLET_A);
  });

  it("rejects a token issued at an older session version with 401 SESSION_REVOKED", async () => {
    users[0].sessionVersion = 1;
    const res = await getProtected(createApp(), signToken(WALLET_A, 0)).expect(401);
    expect(res.body).toMatchObject({ error: "unauthorized", code: "SESSION_REVOKED" });
    expect(typeof res.body.requestId).toBe("string");
  });

  it("rejects a token claiming a newer version than the user has", async () => {
    await getProtected(createApp(), signToken(WALLET_A, 5)).expect(401);
  });

  it("treats a token without an sv claim (issued before #1446) as version 0", async () => {
    const legacy = jwt.sign({ walletAddress: WALLET_A }, process.env.JWT_SECRET || "dev-secret-change-in-production");
    await getProtected(createApp(), legacy).expect(200);

    users[0].sessionVersion = 1;
    await getProtected(createApp(), legacy).expect(401);
  });

  it("keeps the previous behavior for a wallet with no user row", async () => {
    getSessionVersionMock.mockResolvedValue(null);
    await getProtected(createApp(), signToken(WALLET_A, 7)).expect(200);
  });

  it("fails closed when the session lookup throws", async () => {
    getSessionVersionMock.mockRejectedValue(new Error("db down"));
    const res = await getProtected(createApp(), signToken(WALLET_A, 0));
    expect(res.status).toBe(500);
    expect(res.body.walletAddress).toBeUndefined();
  });
});

describe("POST /auth/password-reset/confirm session invalidation (#1446)", () => {
  it("revokes existing sessions for every account with the email, and only those", async () => {
    const app = createApp();
    const tokenA = login(WALLET_A);
    const tokenB = login(WALLET_B);
    const tokenOther = login(WALLET_OTHER);

    const resetToken = await requestResetToken(app);
    const res = await request(app)
      .post("/auth/password-reset/confirm")
      .send({ token: resetToken, newPassword: "new-password-123" })
      .expect(200);

    expect(res.body).toEqual({ success: true, email: EMAIL, sessionsRevoked: true });
    await getProtected(app, tokenA).expect(401);
    await getProtected(app, tokenB).expect(401);
    // Different email: intentionally retained.
    await getProtected(app, tokenOther).expect(200);
  });

  it("does not issue a new session; logging in again yields a working token", async () => {
    const app = createApp();
    const resetToken = await requestResetToken(app);
    const res = await request(app)
      .post("/auth/password-reset/confirm")
      .send({ token: resetToken, newPassword: "new-password-123" })
      .expect(200);

    expect(res.body.token).toBeUndefined();
    await getProtected(app, login(WALLET_A)).expect(200);
  });

  it("makes the reset token single-use", async () => {
    const app = createApp();
    const resetToken = await requestResetToken(app);
    const body = { token: resetToken, newPassword: "new-password-123" };

    await request(app).post("/auth/password-reset/confirm").send(body).expect(200);
    const replay = await request(app).post("/auth/password-reset/confirm").send(body).expect(400);

    expect(replay.body.error).toBe("invalid_or_expired_token");
    expect(users[0].sessionVersion).toBe(1);
  });

  it("lets only one of two concurrent confirms with the same token succeed", async () => {
    const app = createApp();
    const resetToken = await requestResetToken(app);
    const body = { token: resetToken, newPassword: "new-password-123" };

    const results = await Promise.all([
      request(app).post("/auth/password-reset/confirm").send(body),
      request(app).post("/auth/password-reset/confirm").send(body),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    expect(users[0].sessionVersion).toBe(1);
  });

  it("rejects an older reset token once a newer reset has been confirmed", async () => {
    const app = createApp();
    const first = await requestResetToken(app);
    const second = await requestResetToken(app);

    await request(app)
      .post("/auth/password-reset/confirm")
      .send({ token: second, newPassword: "new-password-123" })
      .expect(200);
    await request(app)
      .post("/auth/password-reset/confirm")
      .send({ token: first, newPassword: "new-password-123" })
      .expect(400);
  });

  it("accepts a reset token issued before #1446 (no sv claim) against version 0", async () => {
    const legacy = jwt.sign(
      { email: EMAIL, purpose: "password_reset" },
      process.env.EMAIL_TOKEN_SECRET || process.env.JWT_SECRET || "dev-email-secret"
    );
    await request(createApp())
      .post("/auth/password-reset/confirm")
      .send({ token: legacy, newPassword: "new-password-123" })
      .expect(200);
    expect(users[0].sessionVersion).toBe(1);
  });

  it("does not revoke anything for an invalid, expired, or wrong-purpose token", async () => {
    const app = createApp();
    const wrongPurpose = signEmailFlowToken(EMAIL, "invitation");
    const expired = jwt.sign(
      { email: EMAIL, purpose: "password_reset", sv: 0, exp: Math.floor(Date.now() / 1000) - 10 },
      process.env.EMAIL_TOKEN_SECRET || process.env.JWT_SECRET || "dev-email-secret"
    );

    for (const token of ["not-a-jwt", wrongPurpose, expired]) {
      const res = await request(app)
        .post("/auth/password-reset/confirm")
        .send({ token, newPassword: "new-password-123" })
        .expect(400);
      expect(res.body.error).toBe("invalid_or_expired_token");
    }
    expect(users.every((u) => u.sessionVersion === 0)).toBe(true);
  });

  it("rejects a too-short new password before touching sessions", async () => {
    const app = createApp();
    const resetToken = await requestResetToken(app);
    await request(app)
      .post("/auth/password-reset/confirm")
      .send({ token: resetToken, newPassword: "short" })
      .expect(400);
    expect(users[0].sessionVersion).toBe(0);
  });

  it("returns 400 when the email no longer has any account", async () => {
    const app = createApp();
    const resetToken = await requestResetToken(app);
    users = users.filter((u) => u.email !== EMAIL);

    await request(app)
      .post("/auth/password-reset/confirm")
      .send({ token: resetToken, newPassword: "new-password-123" })
      .expect(400);
  });
});
