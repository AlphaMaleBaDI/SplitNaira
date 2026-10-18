/**
 * Email change confirmation workflow (#1448).
 *
 * Users and the audit log are replaced by in-memory stand-ins that follow the
 * same contract as the real repositories (including the conditional `update`),
 * so the real routes, tokens and middleware run end to end.
 */
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { authAccountRouter } from "../routes/auth-account.js";
import { usersRouter } from "../routes/users.js";
import { errorHandler, notFoundHandler } from "../middleware/error.js";
import { requestIdMiddleware } from "../middleware/request-id.js";
import { AuditLog } from "../entities/AuditLog.js";
import { signToken } from "../services/jwt.js";
import { signEmailFlowToken } from "../services/email-provider.js";
import { hashEmailForLog } from "../services/auth-events.js";

const WALLET = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const OLD_EMAIL = "old@example.com";
const NEW_EMAIL = "new@example.com";

interface FakeUser {
  id: string;
  walletAddress: string;
  email: string | null;
  emailVerifiedAt: Date | null;
  sessionVersion: number;
  deletedAt: Date | null;
  alias: string | null;
  role: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

let users: FakeUser[];
let auditRows: Array<Record<string, unknown>>;

const sendConfirmation = vi.fn();
const sendNotice = vi.fn();

function matchesCriteria(user: FakeUser, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, expected]) => {
    const actual = (user as unknown as Record<string, unknown>)[key];
    // typeorm's IsNull() is a FindOperator with type "isNull".
    if (
      expected &&
      typeof expected === "object" &&
      (expected as { type?: string }).type === "isNull"
    ) {
      return actual === null || actual === undefined;
    }
    return actual === expected;
  });
}

const userRepository = {
  // Like the real repository, hand out a snapshot, not the stored row.
  findOne: async ({ where }: { where: Record<string, unknown> }) => {
    const found = users.find((u) => matchesCriteria(u, where));
    return found ? { ...found } : null;
  },
  update: async (criteria: Record<string, unknown>, set: Record<string, unknown>) => {
    const matches = users.filter((u) => matchesCriteria(u, criteria));
    matches.forEach((u) => Object.assign(u, set));
    return { affected: matches.length };
  },
  save: async (u: FakeUser) => {
    const stored = users.find((row) => row.id === u.id);
    if (stored) Object.assign(stored, u);
    return { ...u };
  },
};

const auditRepository = {
  create: (row: Record<string, unknown>) => row,
  save: async (row: Record<string, unknown>) => {
    auditRows.push(row);
    return row;
  },
};

vi.mock("../services/database.js", () => ({
  getDataSource: () => ({
    getRepository: (entity: unknown) => (entity === AuditLog ? auditRepository : userRepository),
  }),
  withTransaction: async (cb: (qr: unknown) => unknown) =>
    cb({ manager: { getRepository: () => userRepository } }),
}));

vi.mock("../services/session-revocation.js", () => ({
  getSessionVersion: async (wallet: string) =>
    users.find((u) => u.walletAddress === wallet)?.sessionVersion ?? null,
  getMaxSessionVersionForEmail: async () => 0,
  revokeSessionsForEmail: async () => 1,
  revokeSessionForWallet: async (wallet: string, expected: number) => {
    const user = users.find((u) => u.walletAddress === wallet);
    if (!user || user.sessionVersion !== expected) return 0;
    user.sessionVersion += 1;
    return 1;
  },
}));

vi.mock("../services/email-provider.js", async () => {
  const actual = await vi.importActual<typeof import("../services/email-provider.js")>(
    "../services/email-provider.js"
  );
  return {
    ...actual,
    getEmailProvider: () => ({
      sendEmailChangeConfirmationEmail: sendConfirmation,
      sendEmailChangeNoticeEmail: sendNotice,
    }),
  };
});

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use("/auth", authAccountRouter);
  app.use("/users", usersRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

function makeUser(over: Partial<FakeUser> = {}): FakeUser {
  return {
    id: "user-1",
    walletAddress: WALLET,
    email: OLD_EMAIL,
    emailVerifiedAt: new Date("2026-01-01T00:00:00Z"),
    sessionVersion: 0,
    deletedAt: null,
    alias: null,
    role: "customer",
    isActive: true,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

const authHeader = (sv = 0) => `Bearer ${signToken(WALLET, sv)}`;

function requestChange(app: express.Express, newEmail: string, sv = 0) {
  return request(app)
    .post("/auth/email-change/request")
    .set("Authorization", authHeader(sv))
    .send({ newEmail });
}

function confirm(app: express.Express, token: string) {
  return request(app).post("/auth/email-change/confirm").send({ token });
}

/** Runs the request step and returns the token the new address would receive. */
async function issueToken(app: express.Express, newEmail = NEW_EMAIL): Promise<string> {
  await requestChange(app, newEmail).expect(202);
  const call = sendConfirmation.mock.calls.at(-1)?.[0];
  return call.token as string;
}

describe("email change confirmation (#1448)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    users = [makeUser()];
    auditRows = [];
    sendConfirmation.mockResolvedValue(undefined);
    sendNotice.mockResolvedValue(undefined);
  });

  describe("POST /auth/email-change/request", () => {
    it("requires authentication", async () => {
      const res = await request(createApp())
        .post("/auth/email-change/request")
        .send({ newEmail: NEW_EMAIL });
      expect(res.status).toBe(401);
      expect(sendConfirmation).not.toHaveBeenCalled();
    });

    it("sends the confirmation link to the NEW address and changes nothing yet", async () => {
      const res = await requestChange(createApp(), NEW_EMAIL);

      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({ success: true, requestId: res.headers["x-request-id"] });
      expect(sendConfirmation).toHaveBeenCalledTimes(1);
      const sent = sendConfirmation.mock.calls[0][0];
      expect(sent.to).toBe(NEW_EMAIL);
      expect(sent.confirmUrl).toContain(encodeURIComponent(sent.token));
      expect(users[0].email).toBe(OLD_EMAIL);
    });

    it("notifies the PRIOR address, naming the new one only in masked form", async () => {
      await requestChange(createApp(), NEW_EMAIL);

      expect(sendNotice).toHaveBeenCalledTimes(1);
      const notice = sendNotice.mock.calls[0][0];
      expect(notice).toMatchObject({
        to: OLD_EMAIL,
        kind: "requested",
        newEmailMasked: "n***@example.com",
      });
      expect(JSON.stringify(notice)).not.toContain(NEW_EMAIL);
    });

    it("skips the notice when the account has no prior address", async () => {
      users = [makeUser({ email: null, emailVerifiedAt: null })];
      const res = await requestChange(createApp(), NEW_EMAIL);

      expect(res.status).toBe(202);
      expect(sendConfirmation).toHaveBeenCalledTimes(1);
      expect(sendNotice).not.toHaveBeenCalled();
    });

    it("still succeeds if the notice to the prior address fails", async () => {
      sendNotice.mockRejectedValue(new Error("smtp down"));
      const res = await requestChange(createApp(), NEW_EMAIL);
      expect(res.status).toBe(202);
      expect(sendConfirmation).toHaveBeenCalledTimes(1);
    });

    it("fails the request if the confirmation cannot be sent (nothing is silently dropped)", async () => {
      sendConfirmation.mockRejectedValue(new Error("smtp down"));
      const res = await requestChange(createApp(), NEW_EMAIL);
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(auditRows).toHaveLength(0);
    });

    it("audits the request with hashes only", async () => {
      const res = await requestChange(createApp(), NEW_EMAIL);

      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]).toMatchObject({
        action: "email_change_requested",
        requestId: res.headers["x-request-id"],
        payload: {
          userId: "user-1",
          oldEmailHash: hashEmailForLog(OLD_EMAIL),
          newEmailHash: hashEmailForLog(NEW_EMAIL),
        },
      });
      const serialized = JSON.stringify(auditRows[0]);
      expect(serialized).not.toContain(OLD_EMAIL);
      expect(serialized).not.toContain(NEW_EMAIL);
    });

    it("rejects an invalid address", async () => {
      const res = await requestChange(createApp(), "not-an-email");
      expect(res.status).toBe(400);
      expect(sendConfirmation).not.toHaveBeenCalled();
    });

    it("rejects an address longer than the column allows", async () => {
      const res = await requestChange(createApp(), `${"a".repeat(130)}@example.com`);
      expect(res.status).toBe(400);
    });

    it("rejects the address the account already has, ignoring case and spacing", async () => {
      const res = await requestChange(createApp(), "  OLD@Example.com ");
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("EMAIL_UNCHANGED");
      expect(sendConfirmation).not.toHaveBeenCalled();
    });

    it("normalizes the new address before issuing the link", async () => {
      await requestChange(createApp(), "  New@Example.COM ");
      expect(sendConfirmation.mock.calls[0][0].to).toBe("new@example.com");
    });

    it("404s for an account that was deleted", async () => {
      users[0].deletedAt = new Date();
      const res = await requestChange(createApp(), NEW_EMAIL);
      expect(res.status).toBe(404);
      expect(sendConfirmation).not.toHaveBeenCalled();
    });
  });

  describe("POST /auth/email-change/confirm", () => {
    it("applies the change, marks the new address verified, and notifies the old one", async () => {
      const app = createApp();
      const token = await issueToken(app);
      sendNotice.mockClear();

      const res = await confirm(app, token);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        success: true,
        email: NEW_EMAIL,
        requestId: res.headers["x-request-id"],
      });
      expect(users[0].email).toBe(NEW_EMAIL);
      expect(users[0].emailVerifiedAt).toBeInstanceOf(Date);
      expect(users[0].emailVerifiedAt!.getTime()).toBeGreaterThan(new Date("2026-06-01").getTime());
      expect(sendNotice).toHaveBeenCalledTimes(1);
      expect(sendNotice.mock.calls[0][0]).toMatchObject({ to: OLD_EMAIL, kind: "completed" });
    });

    it("audits the completed change with hashes only", async () => {
      const app = createApp();
      const token = await issueToken(app);
      auditRows.length = 0;

      await confirm(app, token).expect(200);

      expect(auditRows).toHaveLength(1);
      expect(auditRows[0]).toMatchObject({
        action: "email_changed",
        payload: {
          userId: "user-1",
          oldEmailHash: hashEmailForLog(OLD_EMAIL),
          newEmailHash: hashEmailForLog(NEW_EMAIL),
        },
      });
      expect(JSON.stringify(auditRows[0])).not.toContain("@example.com");
    });

    it("works for an account that had no address", async () => {
      users = [makeUser({ email: null, emailVerifiedAt: null })];
      const app = createApp();
      const token = await issueToken(app);

      await confirm(app, token).expect(200);

      expect(users[0].email).toBe(NEW_EMAIL);
      expect(sendNotice).not.toHaveBeenCalled();
    });

    it("does not need a bearer token (the link proves control of the new address)", async () => {
      const app = createApp();
      const token = await issueToken(app);
      const res = await request(app).post("/auth/email-change/confirm").send({ token });
      expect(res.status).toBe(200);
    });

    it("is single use: replaying the link fails", async () => {
      const app = createApp();
      const token = await issueToken(app);
      await confirm(app, token).expect(200);

      const replay = await confirm(app, token);

      expect(replay.status).toBe(400);
      expect(replay.body.error).toBe("invalid_or_expired_token");
      expect(users[0].email).toBe(NEW_EMAIL);
    });

    it("applies exactly once when confirmed concurrently", async () => {
      const app = createApp();
      const token = await issueToken(app);
      sendNotice.mockClear();
      auditRows.length = 0;

      const results = await Promise.all([
        confirm(app, token),
        confirm(app, token),
        confirm(app, token),
      ]);

      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 400)).toHaveLength(2);
      expect(sendNotice).toHaveBeenCalledTimes(1);
      expect(auditRows).toHaveLength(1);
    });

    it("an older link stops working once a newer change was applied", async () => {
      const app = createApp();
      const first = await issueToken(app, "first@example.com");
      const second = await issueToken(app, "second@example.com");

      await confirm(app, second).expect(200);
      const stale = await confirm(app, first);

      expect(stale.status).toBe(400);
      expect(users[0].email).toBe("second@example.com");
    });

    it("dies after the user logs out (session version bumped)", async () => {
      const app = createApp();
      const token = await issueToken(app);
      await request(app).post("/auth/logout").set("Authorization", authHeader(0)).expect(200);

      const res = await confirm(app, token);

      expect(res.status).toBe(400);
      expect(users[0].email).toBe(OLD_EMAIL);
    });

    it("dies if the address changed by other means in the meantime", async () => {
      const app = createApp();
      const token = await issueToken(app);
      users[0].email = "someone-else@example.com";

      const res = await confirm(app, token);

      expect(res.status).toBe(400);
      expect(users[0].email).toBe("someone-else@example.com");
    });

    it("rejects the link for an account that was deleted", async () => {
      const app = createApp();
      const token = await issueToken(app);
      users[0].deletedAt = new Date();
      const res = await confirm(app, token);
      expect(res.status).toBe(400);
    });

    it("rejects a malformed token", async () => {
      const res = await confirm(createApp(), "garbage");
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_or_expired_token");
    });

    it("rejects a missing token with a validation error", async () => {
      const res = await request(createApp()).post("/auth/email-change/confirm").send({});
      expect(res.status).toBe(400);
    });

    it("rejects a token issued for another purpose", async () => {
      const wrongPurpose = signEmailFlowToken(NEW_EMAIL, "email_verification");
      const res = await confirm(createApp(), wrongPurpose);
      expect(res.status).toBe(400);
      expect(users[0].email).toBe(OLD_EMAIL);
    });

    it("rejects an email-change token missing the account binding", async () => {
      const unbound = signEmailFlowToken(NEW_EMAIL, "email_change");
      const res = await confirm(createApp(), unbound);
      expect(res.status).toBe(400);
      expect(users[0].email).toBe(OLD_EMAIL);
    });

    it("rejects an expired token", async () => {
      const secret = process.env.EMAIL_TOKEN_SECRET || process.env.JWT_SECRET || "dev-email-secret";
      const expired = jwt.sign(
        { email: NEW_EMAIL, purpose: "email_change", sv: 0, uid: "user-1", prev: OLD_EMAIL },
        secret,
        { expiresIn: -10 }
      );
      const res = await confirm(createApp(), expired);
      expect(res.status).toBe(400);
      expect(users[0].email).toBe(OLD_EMAIL);
    });

    it("rejects a token signed with another secret", async () => {
      const forged = jwt.sign(
        { email: NEW_EMAIL, purpose: "email_change", sv: 0, uid: "user-1", prev: OLD_EMAIL },
        "not-the-secret"
      );
      const res = await confirm(createApp(), forged);
      expect(res.status).toBe(400);
      expect(users[0].email).toBe(OLD_EMAIL);
    });

    it("still completes if the notice to the prior address fails", async () => {
      const app = createApp();
      const token = await issueToken(app);
      sendNotice.mockRejectedValue(new Error("smtp down"));

      const res = await confirm(app, token);

      expect(res.status).toBe(200);
      expect(users[0].email).toBe(NEW_EMAIL);
    });
  });

  describe("PATCH /users/me cannot bypass the confirmation", () => {
    function patchMe(app: express.Express, body: Record<string, unknown>) {
      return request(app).patch("/users/me").set("Authorization", authHeader()).send(body);
    }

    it("refuses to change the address directly and points at the workflow", async () => {
      const res = await patchMe(createApp(), { email: NEW_EMAIL });

      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/can't be changed/i);
      expect(JSON.stringify(res.body)).toContain("/auth/email-change/request");
      expect(users[0].email).toBe(OLD_EMAIL);
    });

    it("allows resending the current address (a no-op) alongside other fields", async () => {
      const res = await patchMe(createApp(), { email: "OLD@example.com", alias: "Neo" });
      expect(res.status).toBe(200);
      expect(users[0].alias).toBe("Neo");
      expect(users[0].email).toBe(OLD_EMAIL);
    });

    it("still updates the alias on its own", async () => {
      const res = await patchMe(createApp(), { alias: "Trinity" });
      expect(res.status).toBe(200);
      expect(res.body.alias).toBe("Trinity");
    });
  });
});
