/**
 * Email enumeration regression tests (#1449).
 *
 * Sign-in and recovery responses must not reveal whether an email address is
 * registered. Each test sends the same request for an address that has an
 * account and one that doesn't and requires the responses to be identical
 * apart from the per-request correlation id.
 *
 * Timing is not asserted: the registered path does extra work (a token and an
 * email send). The send is not awaited by the client in production, where the
 * provider queues it; see docs/auth-email-flows.md.
 */
import express from "express";
import request from "supertest";
import type { Response } from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { authEmailRouter } from "../routes/auth-email.js";
import { authAccountRouter } from "../routes/auth-account.js";
import { usersRouter } from "../routes/users.js";
import { errorHandler, notFoundHandler } from "../middleware/error.js";
import { requestIdMiddleware } from "../middleware/request-id.js";
import { signToken } from "../services/jwt.js";
import { verificationResendCooldown } from "../services/verification-resend-cooldown.js";

const WALLET_KNOWN = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
// Must pass the Stellar address checksum (POST /users/login validates it).
const WALLET_UNKNOWN = "GCNSJNUEJLYRS7FXIWVDUABVBP5PQHCWW6M7IQIBA66C5LCY2RAZ5LBI";

const KNOWN_VERIFIED = "verified@example.com";
const KNOWN_UNVERIFIED = "unverified@example.com";
const UNKNOWN = "nobody@example.com";

const findOneMock = vi.fn();
const sendMocks = {
  sendPasswordResetEmail: vi.fn(),
  sendVerificationEmail: vi.fn(),
  sendEmailChangeConfirmationEmail: vi.fn(),
  sendEmailChangeNoticeEmail: vi.fn(),
};

vi.mock("../services/database.js", () => ({
  getDataSource: () => ({
    getRepository: () => ({
      findOne: findOneMock,
      update: vi.fn(),
      save: vi.fn(),
      create: (x: unknown) => x,
      exists: vi.fn(),
    }),
  }),
  withTransaction: async (cb: (qr: unknown) => unknown) =>
    cb({
      manager: {
        getRepository: () => ({ findOne: findOneMock, save: vi.fn(), create: (x: unknown) => x }),
      },
    }),
}));

vi.mock("../services/session-revocation.js", () => ({
  getSessionVersion: async () => 0,
  getMaxSessionVersionForEmail: async () => 0,
  revokeSessionsForEmail: async () => 1,
  revokeSessionForWallet: async () => 1,
}));

vi.mock("../services/email-provider.js", async () => {
  const actual = await vi.importActual<typeof import("../services/email-provider.js")>(
    "../services/email-provider.js"
  );
  return { ...actual, getEmailProvider: () => sendMocks };
});

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use("/auth", authEmailRouter);
  app.use("/auth", authAccountRouter);
  app.use("/users", usersRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

/** What a client can observe, minus the per-request correlation id. */
function observable(res: Response) {
  const body = { ...(res.body as Record<string, unknown>) };
  delete body.requestId;
  const details = body.details as Record<string, unknown> | undefined;
  if (details) delete details.requestId;
  return {
    status: res.status,
    body,
    contentType: res.headers["content-type"],
    retryAfter: res.headers["retry-after"],
    contentLength: res.headers["content-length"],
  };
}

function usersByEmail(email: string) {
  if (email === KNOWN_VERIFIED) {
    return { id: "u-verified", email, emailVerifiedAt: new Date(), sessionVersion: 0 };
  }
  if (email === KNOWN_UNVERIFIED) {
    return { id: "u-unverified", email, emailVerifiedAt: null, sessionVersion: 0 };
  }
  return null;
}

describe("email enumeration (#1449)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verificationResendCooldown.clear();
    Object.values(sendMocks).forEach((m) => m.mockResolvedValue(undefined));
    findOneMock.mockImplementation(async ({ where }: { where: Record<string, unknown> }) => {
      if (typeof where.email === "string") return usersByEmail(where.email);
      if (where.walletAddress === WALLET_KNOWN) {
        return {
          id: "u-known",
          walletAddress: WALLET_KNOWN,
          email: KNOWN_VERIFIED,
          alias: null,
          role: "customer",
          isActive: true,
          sessionVersion: 0,
          createdAt: new Date("2026-01-01T00:00:00Z"),
          updatedAt: new Date("2026-01-01T00:00:00Z"),
        };
      }
      return null;
    });
  });

  describe("password recovery", () => {
    const requestReset = (app: express.Express, email: string) =>
      request(app).post("/auth/password-reset/request").send({ email });

    it("answers a registered and an unregistered address identically", async () => {
      const app = createApp();
      const known = await requestReset(app, KNOWN_VERIFIED);
      const unknown = await requestReset(app, UNKNOWN);

      expect(known.status).toBe(202);
      expect(observable(unknown)).toEqual(observable(known));
    });

    it("answers verified, unverified and unregistered accounts identically", async () => {
      const app = createApp();
      const results = [
        observable(await requestReset(app, KNOWN_VERIFIED)),
        observable(await requestReset(app, KNOWN_UNVERIFIED)),
        observable(await requestReset(app, UNKNOWN)),
      ];
      expect(results[1]).toEqual(results[0]);
      expect(results[2]).toEqual(results[0]);
    });

    it("sends an email only for a registered address, which the response does not reveal", async () => {
      const app = createApp();
      await requestReset(app, UNKNOWN);
      expect(sendMocks.sendPasswordResetEmail).not.toHaveBeenCalled();
      await requestReset(app, KNOWN_VERIFIED);
      expect(sendMocks.sendPasswordResetEmail).toHaveBeenCalledTimes(1);
    });

    it("does not echo the address back", async () => {
      const res = await requestReset(createApp(), UNKNOWN);
      expect(JSON.stringify(res.body)).not.toContain(UNKNOWN);
      expect(JSON.stringify(res.headers)).not.toContain(UNKNOWN);
    });

    it("rejects a malformed address the same way for everyone, without echoing it", async () => {
      const app = createApp();
      const a = await requestReset(app, "not-an-email");
      const b = await requestReset(app, "also not one");
      expect(a.status).toBe(400);
      expect(observable(b).status).toBe(400);
      expect(JSON.stringify(a.body)).not.toContain("not-an-email");
    });
  });

  describe("verification resend", () => {
    const resend = (app: express.Express, email: string) =>
      request(app).post("/auth/email-verification/resend").send({ email });

    it("answers unverified, already verified and unregistered addresses identically", async () => {
      const app = createApp();
      const unverified = await resend(app, KNOWN_UNVERIFIED);
      const verified = await resend(app, KNOWN_VERIFIED);
      const unknown = await resend(app, UNKNOWN);

      expect(unverified.status).toBe(202);
      expect(observable(verified)).toEqual(observable(unverified));
      expect(observable(unknown)).toEqual(observable(unverified));
    });

    it("applies the cooldown, and answers it identically, whether or not the address exists", async () => {
      const app = createApp();
      await resend(app, KNOWN_UNVERIFIED);
      await resend(app, UNKNOWN);

      const knownAgain = await resend(app, KNOWN_UNVERIFIED);
      const unknownAgain = await resend(app, UNKNOWN);

      expect(knownAgain.status).toBe(429);
      const known = observable(knownAgain);
      const unknown = observable(unknownAgain);
      // retryAfter may differ by a second between the two calls; the shape may not.
      expect(Object.keys(unknown.body).sort()).toEqual(Object.keys(known.body).sort());
      expect(unknown.status).toBe(known.status);
      expect(unknown.body.error).toBe(known.body.error);
      expect(unknown.body.code).toBe(known.body.code);
    });

    it("only sends to an unverified registered address", async () => {
      const app = createApp();
      await resend(app, KNOWN_VERIFIED);
      await resend(app, UNKNOWN);
      expect(sendMocks.sendVerificationEmail).not.toHaveBeenCalled();
      await resend(app, KNOWN_UNVERIFIED);
      expect(sendMocks.sendVerificationEmail).toHaveBeenCalledTimes(1);
    });
  });

  describe("sign-in", () => {
    const login = (app: express.Express, body: Record<string, unknown>) =>
      request(app).post("/users/login").send(body);

    it("signs in by wallet and ignores any email in the body", async () => {
      const app = createApp();
      const withKnownEmail = await login(app, {
        walletAddress: WALLET_UNKNOWN,
        email: KNOWN_VERIFIED,
      });
      const withUnknownEmail = await login(app, { walletAddress: WALLET_UNKNOWN, email: UNKNOWN });
      const withoutEmail = await login(app, { walletAddress: WALLET_UNKNOWN });

      expect(withoutEmail.status).toBe(404);
      expect(observable(withKnownEmail)).toEqual(observable(withoutEmail));
      expect(observable(withUnknownEmail)).toEqual(observable(withoutEmail));
    });

    it("does not reflect a submitted email in a failed sign-in", async () => {
      const res = await login(createApp(), {
        walletAddress: WALLET_UNKNOWN,
        email: KNOWN_VERIFIED,
      });
      expect(JSON.stringify(res.body)).not.toContain(KNOWN_VERIFIED);
    });

    it("never returns another account's email to an unauthenticated caller", async () => {
      const res = await login(createApp(), { walletAddress: WALLET_UNKNOWN });
      expect(JSON.stringify(res.body)).not.toMatch(/@example\.com/);
    });
  });

  describe("email change", () => {
    const requestChange = (app: express.Express, newEmail: string) =>
      request(app)
        .post("/auth/email-change/request")
        .set("Authorization", `Bearer ${signToken(WALLET_KNOWN, 0)}`)
        .send({ newEmail });

    it("answers the same whether the new address belongs to another account or not", async () => {
      const app = createApp();
      const taken = await requestChange(app, KNOWN_UNVERIFIED);
      const free = await requestChange(app, "brand-new@example.com");

      expect(taken.status).toBe(202);
      expect(observable(free)).toEqual(observable(taken));
    });

    it("never looks the new address up among existing accounts", async () => {
      const app = createApp();
      await requestChange(app, KNOWN_UNVERIFIED);
      await requestChange(app, "brand-new@example.com");

      const lookups = findOneMock.mock.calls.map((c) => c[0].where);
      expect(lookups.every((where) => where.email === undefined)).toBe(true);
    });
  });
});
