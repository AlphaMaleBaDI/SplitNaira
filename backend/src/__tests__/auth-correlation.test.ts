/**
 * Authentication event correlation IDs (#1450).
 *
 * The request correlation id has to reach (a) the response, header and body,
 * and (b) the auth log lines, and neither may ever contain a credential: not
 * the bearer token, not a reset/confirmation token or the link carrying it.
 */
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authEmailRouter } from "../routes/auth-email.js";
import { authAccountRouter } from "../routes/auth-account.js";
import { authJwtMiddleware } from "../middleware/auth-jwt.js";
import { errorHandler, notFoundHandler } from "../middleware/error.js";
import {
  MAX_REQUEST_ID_LENGTH,
  requestIdMiddleware,
  sanitizeInboundRequestId,
} from "../middleware/request-id.js";
import { hashEmailForLog, logAuthEvent } from "../services/auth-events.js";
import { redactUrlForLog, maskEmail } from "../services/email-provider.js";
import { signToken } from "../services/jwt.js";
import { logger } from "../services/logger.js";

const WALLET = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const EMAIL = "person@example.com";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let sessionVersion = 0;
const findOneMock = vi.fn();

vi.mock("../services/session-revocation.js", () => ({
  getSessionVersion: async () => sessionVersion,
  getMaxSessionVersionForEmail: async () => 0,
  revokeSessionsForEmail: async () => 0,
  revokeSessionForWallet: async (_wallet: string, expected: number) => {
    if (expected !== sessionVersion) return 0;
    sessionVersion += 1;
    return 1;
  },
}));

vi.mock("../services/database.js", () => ({
  getDataSource: () => ({
    getRepository: () => ({ findOne: findOneMock, update: vi.fn() }),
  }),
}));

// The real console provider is used on purpose: it is the code that writes
// reset/confirmation links to the log.

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use("/auth", authEmailRouter);
  app.use("/auth", authAccountRouter);
  app.get("/protected", authJwtMiddleware, (_req, res) => res.json({ ok: true }));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

/** Every argument of every log call made while `fn` runs, as one string. */
async function captureLogs(fn: () => Promise<void>): Promise<{ text: string; calls: unknown[][] }> {
  const calls: unknown[][] = [];
  const spies = (["info", "warn", "error", "debug", "http"] as const).map((level) =>
    vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
      calls.push([level, ...args]);
      return logger;
    }) as never)
  );
  try {
    await fn();
  } finally {
    spies.forEach((spy) => spy.mockRestore());
  }
  return { text: JSON.stringify(calls), calls };
}

describe("sanitizeInboundRequestId", () => {
  it("keeps ordinary identifiers (trimmed)", () => {
    expect(sanitizeInboundRequestId("  req-123  ")).toBe("req-123");
    expect(sanitizeInboundRequestId("9b2f7c1e-0a4d-4c55-9a43-1f2e3d4c5b6a")).toBe(
      "9b2f7c1e-0a4d-4c55-9a43-1f2e3d4c5b6a"
    );
    expect(sanitizeInboundRequestId("svc:trace.ID_7")).toBe("svc:trace.ID_7");
  });

  it("accepts the maximum length and rejects one more", () => {
    expect(sanitizeInboundRequestId("a".repeat(MAX_REQUEST_ID_LENGTH))).toBeTruthy();
    expect(sanitizeInboundRequestId("a".repeat(MAX_REQUEST_ID_LENGTH + 1))).toBeNull();
  });

  it.each([
    ["empty", ""],
    ["whitespace only", "   "],
    ["undefined", undefined],
    ["inner whitespace", "two words"],
    ["newline (log injection)", "abc\nlevel=error"],
    ["quotes/braces", '{"a":"b"}'],
    ["a bearer credential", "Bearer abc.def.ghi"],
    ["a JWT", "eyJhbGciOiJIUzI1NiJ9.eyJ3YWxsZXQiOiJHQUFBIn0.c2lnbmF0dXJl"],
  ])("rejects %s", (_name, value) => {
    expect(sanitizeInboundRequestId(value as string | undefined)).toBeNull();
  });
});

describe("request id middleware", () => {
  it("echoes a safe inbound id in both headers", async () => {
    const res = await request(createApp()).get("/protected").set("x-request-id", "trace-42");
    expect(res.headers["x-request-id"]).toBe("trace-42");
    expect(res.headers["x-correlation-id"]).toBe("trace-42");
  });

  it("generates a UUID instead of echoing an unsafe id", async () => {
    const res = await request(createApp())
      .get("/protected")
      .set("x-request-id", "has spaces and = signs");
    expect(res.headers["x-request-id"]).toMatch(UUID_RE);
  });

  it("never reflects a token pasted into the id header", async () => {
    const jwtLike = "eyJhbGciOiJIUzI1NiJ9.eyJ3YWxsZXQiOiJHQUFBIn0.c2lnbmF0dXJl";
    const res = await request(createApp()).get("/protected").set("x-request-id", jwtLike);
    expect(res.headers["x-request-id"]).not.toContain("eyJ");
    expect(JSON.stringify(res.body)).not.toContain(jwtLike);
  });

  it("falls back to x-correlation-id when x-request-id is unusable", async () => {
    const res = await request(createApp())
      .get("/protected")
      .set("x-request-id", "bad id")
      .set("x-correlation-id", "corr-9");
    expect(res.headers["x-request-id"]).toBe("corr-9");
  });
});

describe("correlation ids in auth responses", () => {
  beforeEach(() => {
    sessionVersion = 0;
    findOneMock.mockReset();
  });

  it("is in the body and header of a rejected request", async () => {
    const res = await request(createApp()).get("/protected").set("x-request-id", "corr-401");
    expect(res.status).toBe(401);
    expect(res.body.requestId).toBe("corr-401");
    expect(res.headers["x-request-id"]).toBe("corr-401");
  });

  it("is in the body of a revoked-session rejection", async () => {
    const app = createApp();
    const token = signToken(WALLET, 0);
    sessionVersion = 1;
    const res = await request(app)
      .get("/protected")
      .set("Authorization", `Bearer ${token}`)
      .set("x-request-id", "corr-revoked");
    expect(res.body).toMatchObject({ code: "SESSION_REVOKED", requestId: "corr-revoked" });
  });

  it("is in the body of a successful logout", async () => {
    const res = await request(createApp())
      .post("/auth/logout")
      .set("Authorization", `Bearer ${signToken(WALLET, 0)}`)
      .set("x-request-id", "corr-logout");
    expect(res.status).toBe(200);
    expect(res.body.requestId).toBe("corr-logout");
  });

  it("is in the header of every email-flow response and the body of its errors, including the no-account path", async () => {
    findOneMock.mockResolvedValue(null);
    const app = createApp();

    const reset = await request(app)
      .post("/auth/password-reset/request")
      .set("x-request-id", "corr-reset")
      .send({ email: EMAIL });
    const resend = await request(app)
      .post("/auth/email-verification/resend")
      .set("x-request-id", "corr-resend")
      .send({ email: "other@example.com" });
    const badConfirm = await request(app)
      .post("/auth/password-reset/confirm")
      .set("x-request-id", "corr-confirm")
      .send({ token: "garbage", newPassword: "longenough1" });

    expect(reset.headers["x-request-id"]).toBe("corr-reset");
    expect(resend.headers["x-request-id"]).toBe("corr-resend");
    expect(badConfirm.status).toBe(400);
    expect(badConfirm.headers["x-request-id"]).toBe("corr-confirm");
    expect(badConfirm.body.requestId).toBe("corr-confirm");
  });
});

describe("correlation ids and secrets in auth logs", () => {
  beforeEach(() => {
    sessionVersion = 0;
    findOneMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs auth events with the request's correlation id", async () => {
    const app = createApp();
    const token = signToken(WALLET, 0);

    const { calls } = await captureLogs(async () => {
      await request(app)
        .post("/auth/logout")
        .set("Authorization", `Bearer ${token}`)
        .set("x-request-id", "corr-log-1");
      await request(app).get("/protected").set("x-request-id", "corr-log-2");
    });

    const events = calls
      .filter((c) => c[1] === "auth_event")
      .map((c) => c[2] as Record<string, unknown>);
    expect(events).toContainEqual(
      expect.objectContaining({ event: "logout", outcome: "success", requestId: "corr-log-1" })
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "session_rejected",
        outcome: "failure",
        reason: "MISSING_TOKEN",
        requestId: "corr-log-2",
      })
    );
  });

  it("logs a revoked-session rejection with its reason", async () => {
    const app = createApp();
    const stale = signToken(WALLET, 0);
    sessionVersion = 4;

    const { calls } = await captureLogs(async () => {
      await request(app)
        .get("/protected")
        .set("Authorization", `Bearer ${stale}`)
        .set("x-request-id", "corr-log-3");
    });

    const event = calls.find((c) => c[1] === "auth_event")?.[2] as Record<string, unknown>;
    expect(event).toMatchObject({
      event: "session_rejected",
      reason: "SESSION_REVOKED",
      requestId: "corr-log-3",
    });
  });

  it("never logs the bearer token", async () => {
    const app = createApp();
    const token = signToken(WALLET, 0);

    const { text } = await captureLogs(async () => {
      await request(app).post("/auth/logout").set("Authorization", `Bearer ${token}`);
      // Second use of the same token is rejected as revoked.
      await request(app).get("/protected").set("Authorization", `Bearer ${token}`);
      await request(app).get("/protected").set("Authorization", "Bearer garbage.token.value");
    });

    expect(text).not.toContain(token);
    expect(text).not.toContain(token.split(".")[1]); // payload segment
    expect(text).not.toContain("garbage.token.value");
  });

  it("never logs a reset token or the link that carries it", async () => {
    findOneMock.mockResolvedValue({ id: "user-1", email: EMAIL });
    const app = createApp();
    let issuedToken = "";

    const { text } = await captureLogs(async () => {
      await request(app)
        .post("/auth/password-reset/request")
        .send({ email: EMAIL, resetUrlBase: "https://example.com/reset" });
    });
    // Recover the token the same way a user would: from the (redacted) log, which must not have it.
    issuedToken = (text.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/) ?? [""])[0];

    expect(issuedToken).toBe("");
    expect(text).not.toContain("token=");
    expect(text).toContain("https://example.com/reset"); // origin + path are still useful
  });

  it("records the email only as a hash in auth events", async () => {
    findOneMock.mockResolvedValue({ id: "user-1", email: EMAIL });
    const app = createApp();

    const { calls } = await captureLogs(async () => {
      await request(app).post("/auth/password-reset/request").send({ email: EMAIL });
    });

    const event = calls.find((c) => c[1] === "auth_event")?.[2] as Record<string, unknown>;
    expect(event).toMatchObject({
      event: "password_reset_requested",
      outcome: "success",
      userId: "user-1",
      emailHash: hashEmailForLog(EMAIL),
    });
    expect(JSON.stringify(event)).not.toContain(EMAIL);
    expect(event).not.toHaveProperty("email");
  });
});

describe("logAuthEvent", () => {
  it("drops a reason that is not a plain code (it could carry user input)", async () => {
    const { calls } = await captureLogs(async () => {
      logAuthEvent({ locals: { requestId: "r1" } }, "login", "failure", {
        reason: "wallet GAAA... not found for person@example.com",
      });
    });
    expect(calls[0][2]).not.toHaveProperty("reason");
    expect(calls[0][0]).toBe("warn");
  });

  it("hashes emails case-insensitively and stably", () => {
    expect(hashEmailForLog("A@B.com")).toBe(hashEmailForLog(" a@b.COM "));
    expect(hashEmailForLog("a@b.com")).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("log-safe helpers", () => {
  it("redactUrlForLog keeps origin and path and drops query and fragment", () => {
    expect(redactUrlForLog("https://app.example.com/reset?token=SECRET&x=1#frag")).toBe(
      "https://app.example.com/reset"
    );
    expect(redactUrlForLog("not a url")).toBe("[invalid-url]");
  });

  it("maskEmail hides the local part", () => {
    expect(maskEmail("person@example.com")).toBe("p***@example.com");
    expect(maskEmail("nope")).toBe("***");
  });
});
