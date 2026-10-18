/**
 * Email verification resend cooldown (#1443).
 */
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authEmailRouter } from "../routes/auth-email.js";
import { errorHandler, notFoundHandler } from "../middleware/error.js";
import { requestIdMiddleware } from "../middleware/request-id.js";
import { signEmailFlowToken } from "../services/email-provider.js";
import {
  ResendCooldown,
  resolveResendCooldownMs,
  verificationResendCooldown,
} from "../services/verification-resend-cooldown.js";

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

const EMAIL = "new-user@example.com";
const COOLDOWN_SECONDS = Math.ceil(verificationResendCooldown.cooldownMs / 1000);

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use("/auth", authEmailRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

function resend(app: express.Express, email = EMAIL) {
  return request(app).post("/auth/email-verification/resend").send({ email });
}

beforeEach(() => {
  vi.clearAllMocks();
  verificationResendCooldown.clear();
  findOneMock.mockResolvedValue({ email: EMAIL, emailVerifiedAt: null });
  updateMock.mockResolvedValue({ affected: 1 });
  sendVerificationEmailMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ResendCooldown", () => {
  it("allows the first request and blocks repeats until the cooldown elapses", () => {
    let now = 0;
    const cooldown = new ResendCooldown(60_000, () => now);

    expect(cooldown.tryAcquire(EMAIL)).toEqual({ ok: true });
    expect(cooldown.tryAcquire(EMAIL)).toEqual({ ok: false, retryAfterMs: 60_000 });

    now = 59_999;
    expect(cooldown.tryAcquire(EMAIL)).toEqual({ ok: false, retryAfterMs: 1 });

    now = 60_000;
    expect(cooldown.tryAcquire(EMAIL)).toEqual({ ok: true });
  });

  it("shares one cooldown across case and whitespace variants of an email", () => {
    const cooldown = new ResendCooldown(1_000, () => 0);
    expect(cooldown.tryAcquire("User@Example.com")).toEqual({ ok: true });
    expect(cooldown.tryAcquire("  user@example.COM ").ok).toBe(false);
  });

  it("tracks different emails independently", () => {
    const cooldown = new ResendCooldown(1_000, () => 0);
    expect(cooldown.tryAcquire("a@example.com").ok).toBe(true);
    expect(cooldown.tryAcquire("b@example.com").ok).toBe(true);
  });

  it("release() frees the slot immediately", () => {
    const cooldown = new ResendCooldown(1_000, () => 0);
    cooldown.tryAcquire(EMAIL);
    cooldown.release(EMAIL);
    expect(cooldown.tryAcquire(EMAIL).ok).toBe(true);
  });

  it.each([
    [undefined, 60_000],
    ["", 60_000],
    ["abc", 60_000],
    ["0", 60_000],
    ["-5", 60_000],
    ["120000", 120_000],
  ])("resolves EMAIL_VERIFICATION_RESEND_COOLDOWN_MS=%s to %i", (raw, expected) => {
    expect(resolveResendCooldownMs(raw)).toBe(expected);
  });
});

describe("POST /auth/email-verification/resend (#1443)", () => {
  it("sends a verification email and reports when the next resend is allowed", async () => {
    const res = await resend(createApp()).expect(202);

    expect(res.body).toEqual({ success: true, retryAfterSeconds: COOLDOWN_SECONDS });
    expect(sendVerificationEmailMock).toHaveBeenCalledTimes(1);
    const sent = sendVerificationEmailMock.mock.calls[0][0] as { to: string; verifyUrl: string };
    expect(sent.to).toBe(EMAIL);
    expect(sent.verifyUrl).toMatch(/\/verify-email\?token=/);
  });

  it("returns 429 with the remaining wait in the body and a Retry-After header", async () => {
    const app = createApp();
    await resend(app).expect(202);

    const res = await resend(app).expect(429);

    expect(res.headers["retry-after"]).toBe(String(COOLDOWN_SECONDS));
    expect(res.body).toMatchObject({
      error: "resend_cooldown",
      code: "RESEND_COOLDOWN",
      retryAfterSeconds: COOLDOWN_SECONDS,
      details: { retryAfterSeconds: COOLDOWN_SECONDS },
    });
    expect(typeof res.body.requestId).toBe("string");
    expect(sendVerificationEmailMock).toHaveBeenCalledTimes(1);
  });

  it("counts down the remaining wait and allows a resend exactly when the cooldown ends", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const app = createApp();
    await resend(app).expect(202);

    vi.advanceTimersByTime(verificationResendCooldown.cooldownMs - 1_500);
    expect((await resend(app).expect(429)).body.retryAfterSeconds).toBe(2);

    vi.advanceTimersByTime(1_499);
    expect((await resend(app).expect(429)).body.retryAfterSeconds).toBe(1);

    vi.advanceTimersByTime(1);
    await resend(app).expect(202);
    expect(sendVerificationEmailMock).toHaveBeenCalledTimes(2);
  });

  it("sends only one email when concurrent resends race for the same address", async () => {
    const app = createApp();
    let release: () => void = () => undefined;
    sendVerificationEmailMock.mockImplementation(() => new Promise<void>((r) => (release = r)));

    const pending = Array.from({ length: 5 }, (_, i) =>
      resend(app, i % 2 ? EMAIL.toUpperCase() : EMAIL).then((r) => r)
    );
    await vi.waitFor(() => expect(sendVerificationEmailMock).toHaveBeenCalledTimes(1));
    release();
    const results = await Promise.all(pending);

    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([202, 429, 429, 429, 429]);
    expect(sendVerificationEmailMock).toHaveBeenCalledTimes(1);
  });

  it("applies the same response and cooldown to unknown emails, without sending", async () => {
    findOneMock.mockResolvedValue(null);
    const app = createApp();

    const first = await resend(app, "nobody@example.com").expect(202);
    expect(first.body).toEqual({ success: true, retryAfterSeconds: COOLDOWN_SECONDS });
    await resend(app, "nobody@example.com").expect(429);
    expect(sendVerificationEmailMock).not.toHaveBeenCalled();
  });

  it("does not send to an already verified email but still applies the cooldown", async () => {
    findOneMock.mockResolvedValue({ email: EMAIL, emailVerifiedAt: new Date() });
    const app = createApp();

    await resend(app).expect(202);
    await resend(app).expect(429);
    expect(sendVerificationEmailMock).not.toHaveBeenCalled();
  });

  it("releases the cooldown when sending fails so the user can retry", async () => {
    const app = createApp();
    sendVerificationEmailMock.mockRejectedValueOnce(new Error("smtp down"));

    await resend(app).expect(500);
    await resend(app).expect(202);
    expect(sendVerificationEmailMock).toHaveBeenCalledTimes(2);
  });

  it("rejects an invalid email with 400 without consuming the cooldown", async () => {
    const app = createApp();
    await request(app).post("/auth/email-verification/resend").send({ email: "not-an-email" }).expect(400);
    await request(app).post("/auth/email-verification/resend").send({}).expect(400);
    await resend(app).expect(202);
  });

  it("does not let one email's cooldown block another", async () => {
    const app = createApp();
    await resend(app, "a@example.com").expect(202);
    await resend(app, "b@example.com").expect(202);
  });
});

describe("POST /auth/email-verification/confirm (#1443)", () => {
  it("marks accounts with the token's email as verified", async () => {
    const token = signEmailFlowToken(EMAIL, "email_verification");

    const res = await request(createApp())
      .post("/auth/email-verification/confirm")
      .send({ token })
      .expect(200);

    expect(res.body).toEqual({ success: true, email: EMAIL });
    expect(updateMock).toHaveBeenCalledTimes(1);
    const [criteria, changes] = updateMock.mock.calls[0];
    expect(criteria.email).toBe(EMAIL);
    expect(changes.emailVerifiedAt).toBeInstanceOf(Date);
  });

  it.each([
    ["a malformed token", "not-a-jwt"],
    ["a token for a different purpose", signEmailFlowToken(EMAIL, "password_reset")],
  ])("rejects %s with 400", async (_label, token) => {
    const res = await request(createApp())
      .post("/auth/email-verification/confirm")
      .send({ token })
      .expect(400);
    expect(res.body.error).toBe("invalid_or_expired_token");
    expect(updateMock).not.toHaveBeenCalled();
  });
});
