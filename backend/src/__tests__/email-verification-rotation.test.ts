/**
 * Email verification token rotation (#1444).
 *
 * The persisted store is replaced with an in-memory stand-in that follows the
 * same contract as the SQL: one live hash per address, consumed on first use,
 * expiry enforced on read. That lets these tests drive the real routes and
 * JWT code end to end. The SQL itself is covered by
 * `email-verification-token.test.ts` (query shape) and needs Postgres to run.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { errorHandler, notFoundHandler } from "../middleware/error.js";
import { requestIdMiddleware } from "../middleware/request-id.js";
import { verificationResendCooldown } from "../services/verification-resend-cooldown.js";

interface LiveToken {
  tokenHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
}

const tokenState = vi.hoisted(() => ({ store: new Map<string, LiveToken>() }));

const findOneMock = vi.fn();
const updateMock = vi.fn();
const sendVerificationEmailMock = vi.fn();

vi.mock("../services/database.js", () => ({
  getDataSource: () => ({
    getRepository: () => ({ findOne: findOneMock, update: updateMock }),
  }),
}));

vi.mock("../services/email-provider.js", async () => {
  const actual = await vi.importActual<typeof import("../services/email-provider.js")>(
    "../services/email-provider.js"
  );
  return {
    ...actual,
    getEmailProvider: () => ({ sendVerificationEmail: sendVerificationEmailMock }),
  };
});

vi.mock("../services/email-verification-token.js", async () => {
  const { signEmailFlowToken } = await vi.importActual<
    typeof import("../services/email-provider.js")
  >("../services/email-provider.js");
  const { createHash, randomUUID } = await import("node:crypto");
  const hash = (token: string) => createHash("sha256").update(token).digest("hex");
  const key = (email: string) => email.trim().toLowerCase();

  return {
    hashEmailVerificationToken: hash,
    issueEmailVerificationToken(email: string) {
      const token = signEmailFlowToken(email, "email_verification", { jti: randomUUID() });
      const payload = JSON.parse(
        Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")
      ) as { exp: number };
      return { token, tokenHash: hash(token), expiresAt: new Date(payload.exp * 1000) };
    },
    async rotateEmailVerificationToken(
      email: string,
      issued: { tokenHash: string; expiresAt: Date }
    ) {
      tokenState.store.set(key(email), {
        tokenHash: issued.tokenHash,
        expiresAt: issued.expiresAt,
        consumedAt: null,
      });
    },
    async consumeEmailVerificationToken(email: string, tokenHash: string, now = new Date()) {
      const record = tokenState.store.get(key(email));
      if (!record || record.consumedAt || record.tokenHash !== tokenHash) return false;
      if (record.expiresAt <= now) return false;
      record.consumedAt = now;
      return true;
    },
    async invalidateEmailVerificationToken(email: string, tokenHash: string) {
      const record = tokenState.store.get(key(email));
      if (record && record.tokenHash === tokenHash && !record.consumedAt) {
        record.consumedAt = new Date();
      }
    },
  };
});

import { authEmailRouter } from "../routes/auth-email.js";

const EMAIL = "artist@example.com";
const OTHER_EMAIL = "someone-else@example.com";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use("/auth", authEmailRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

async function issueToken(app: express.Express, email = EMAIL): Promise<string> {
  verificationResendCooldown.clear();
  await request(app).post("/auth/email-verification/resend").send({ email }).expect(202);
  const sent = sendVerificationEmailMock.mock.calls.at(-1)?.[0] as { token: string };
  return sent.token;
}

function confirm(app: express.Express, token: string, body: Record<string, unknown> = {}) {
  return request(app)
    .post("/auth/email-verification/confirm")
    .send({ token, ...body });
}

beforeEach(() => {
  vi.clearAllMocks();
  tokenState.store.clear();
  verificationResendCooldown.clear();
  findOneMock.mockResolvedValue({ email: EMAIL, emailVerifiedAt: null });
  updateMock.mockResolvedValue({ affected: 1 });
  sendVerificationEmailMock.mockResolvedValue(undefined);
});

describe("verification token rotation (#1444)", () => {
  it("verifies the account on first confirm", async () => {
    const app = createApp();
    const token = await issueToken(app);

    const res = await confirm(app, token).expect(200);

    expect(res.body).toEqual({ success: true, email: EMAIL });
    expect(updateMock).toHaveBeenCalledTimes(1);
    const [criteria, changes] = updateMock.mock.calls[0];
    expect(criteria.email).toBe(EMAIL);
    expect(changes.emailVerifiedAt).toBeInstanceOf(Date);
  });

  it("rejects a replayed token", async () => {
    const app = createApp();
    const token = await issueToken(app);

    await confirm(app, token).expect(200);
    const replay = await confirm(app, token).expect(400);

    expect(replay.body.error).toBe("invalid_or_expired_token");
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it("invalidates the previous token when a resend rotates it", async () => {
    const app = createApp();
    const first = await issueToken(app);
    const second = await issueToken(app);

    expect(first).not.toBe(second);
    await confirm(app, first).expect(400);
    await confirm(app, second).expect(200);
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a token whose stored expiry has passed even if the JWT is still valid", async () => {
    const app = createApp();
    const token = await issueToken(app);
    const record = tokenState.store.get(EMAIL);
    if (!record) throw new Error("expected a live token record");
    record.expiresAt = new Date(Date.now() - 1_000);

    await confirm(app, token).expect(400);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("lets only one of two concurrent confirms succeed", async () => {
    const app = createApp();
    const token = await issueToken(app);

    const results = await Promise.all([confirm(app, token), confirm(app, token)]);

    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
    expect(updateMock).toHaveBeenCalledTimes(1);
  });

  it("verifies the email inside the token, ignoring a body-supplied address", async () => {
    const app = createApp();
    const token = await issueToken(app);

    await confirm(app, token, { email: OTHER_EMAIL }).expect(200);

    const [criteria] = updateMock.mock.calls[0];
    expect(criteria.email).toBe(EMAIL);
    expect(criteria.email).not.toBe(OTHER_EMAIL);
  });

  it("does not rotate another address's live token", async () => {
    const app = createApp();
    const artistToken = await issueToken(app, EMAIL);
    await issueToken(app, OTHER_EMAIL);

    expect(tokenState.store.has(EMAIL)).toBe(true);
    await confirm(app, artistToken).expect(200);
  });

  it("invalidates the issued token when the verification email fails to send", async () => {
    const app = createApp();
    sendVerificationEmailMock.mockRejectedValueOnce(new Error("smtp down"));

    await request(app).post("/auth/email-verification/resend").send({ email: EMAIL }).expect(500);

    const attempted = sendVerificationEmailMock.mock.calls[0][0] as { token: string };
    await confirm(app, attempted.token).expect(400);

    // The cooldown was released, so the user can request a working link.
    await request(app).post("/auth/email-verification/resend").send({ email: EMAIL }).expect(202);
  });

  it("does not issue or rotate a token for an unknown address", async () => {
    const app = createApp();
    findOneMock.mockResolvedValue(null);

    await request(app)
      .post("/auth/email-verification/resend")
      .send({ email: "nobody@example.com" })
      .expect(202);

    expect(tokenState.store.size).toBe(0);
    expect(sendVerificationEmailMock).not.toHaveBeenCalled();
  });

  it("does not issue a new token for an already verified address", async () => {
    const app = createApp();
    findOneMock.mockResolvedValue({ email: EMAIL, emailVerifiedAt: new Date() });

    await request(app).post("/auth/email-verification/resend").send({ email: EMAIL }).expect(202);

    expect(tokenState.store.size).toBe(0);
    expect(sendVerificationEmailMock).not.toHaveBeenCalled();
  });
});
