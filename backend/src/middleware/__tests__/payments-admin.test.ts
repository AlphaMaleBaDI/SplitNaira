import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import type { Request, Response } from "express";
import express from "express";
import request from "supertest";

import {
  requirePaymentsAdminAccess,
  enforcePaymentsAdminWriteEnabled,
} from "../payments-admin.js";
import { requestIdMiddleware } from "../request-id.js";
import { errorHandler, notFoundHandler } from "../error.js";
import { clearEnvCache } from "../../config/env.js";
import { logger } from "../../services/logger.js";

// splitsRouter is imported dynamically inside describe blocks after the
// @stellar/stellar-sdk mock below is registered (vi.mock is hoisted, but we
// keep the import next to the mock for clarity/consistency with
// routes/splits.test.ts).
import { splitsRouter } from "../../routes/splits.js";

// ---------------------------------------------------------------------------
// Issue #940: backend tests for the admin write-disable switch.
//
// The real mechanism under test lives in ../payments-admin.ts:
//   - requirePaymentsAdminAccess: no-ops when PAYMENTS_ADMIN_API_KEY isn't set
//     (not the subject of this issue, but part of the real middleware chain).
//   - enforcePaymentsAdminWriteEnabled: the write-disable switch itself. Lets
//     GET/HEAD/OPTIONS through unconditionally; for any other method, blocks
//     with 503 unless PAYMENTS_ADMIN_WRITE_ENABLED !== "false".
//
// index.ts mounts these for real as:
//   app.use("/splits/admin", adminLimiter, requirePaymentsAdminAccess,
//     enforcePaymentsAdminWriteEnabled, auditAdminMutationsMiddleware)
//
// This file builds an equivalent app (minus adminLimiter and
// auditAdminMutationsMiddleware, see report/comments below) and mounts
// splitsRouter directly under "/splits" so its own "/admin/..." route
// strings line up with the real "/splits/admin/*" mount point.
// ---------------------------------------------------------------------------

// ---- Mock @stellar/stellar-sdk (copied from routes/splits.test.ts) --------
// The admin route handlers under test call into services/stellar.ts, which
// talks to the Soroban RPC server via this SDK. None of these tests care
// about the *business logic* response bodies -- only whether the request
// ever reaches the route handler at all -- but the handlers still need to
// not throw before the write-disable middleware's behavior can be observed.
const getAccountMock = vi.fn();
const prepareTransactionMock = vi.fn();
const simulateTransactionMock = vi.fn();
const getEventsMock = vi.fn();

const serverMock = {
  getAccount: getAccountMock,
  prepareTransaction: prepareTransactionMock,
  simulateTransaction: simulateTransactionMock,
  getEvents: getEventsMock,
};

vi.mock("@stellar/stellar-sdk", () => {
  class ScMapEntry {
    key: unknown;
    val: unknown;
    constructor({ key, val }: { key: unknown; val: unknown }) {
      this.key = key;
      this.val = val;
    }
  }

  return {
    Address: {
      fromString: vi.fn((address: string) => ({
        toScVal: () => ({ address }),
      })),
    },
    BASE_FEE: 100,
    // NOTE: plain `function` implementations (not arrow functions) -- see
    // the comment on rpc.Server below for why this matters when these
    // classes are invoked with `new`.
    Contract: vi.fn().mockImplementation(function () {
      return {
        call: (method: string, ...args: unknown[]) => ({ method, args }),
      };
    }),
    TransactionBuilder: vi.fn().mockImplementation(function () {
      return {
        addOperation: function (op: unknown) {
          this.op = op;
          return this;
        },
        setTimeout: function () {
          return this;
        },
        build: function () {
          return { preparedOperation: this.op };
        },
      };
    }),
    nativeToScVal: vi.fn((value: unknown) => ({
      toXDR: () => `MOCKED_XDR_${value}`,
    })),
    scValToNative: vi.fn((value: unknown) => value),
    rpc: {
      // NOTE: deliberately a `function` expression, not an arrow function.
      // getStellarRpcServer() invokes this with `new rpc.Server(...)`, and
      // vitest 4's mock internals call the underlying implementation via
      // `Reflect.construct`, which throws "is not a constructor" for arrow
      // functions (they have no [[Construct]] slot). A plain function that
      // explicitly `return`s an object is constructible and JS's `new`
      // semantics use that returned object as the result, so this yields
      // `serverMock` either way. (routes/splits.test.ts's own copy of this
      // mock uses an arrow function here and is consequently broken against
      // this repo's pinned vitest@4.1.7 in this environment -- a
      // pre-existing issue in that file, unrelated to this issue's scope,
      // left unmodified.)
      Server: vi.fn(function StellarServer() {
        return serverMock;
      }),
    },
    xdr: {
      ScVal: {
        scvMap: (items: unknown[]) => items,
        scvU32: (value: number) => value,
        scvVec: (items: unknown[]) => items,
      },
      ScMapEntry,
    },
  };
});

/**
 * Builds a minimal app that mounts the real middleware chain the same way
 * src/index.ts does for "/splits/admin/*", except:
 *   - adminLimiter is deliberately excluded: rate limiting is already covered
 *     by middleware/__tests__/rateLimiter.test.ts and isn't this issue's
 *     subject; including it risks flaky 429s once this file's many test
 *     cases exceed its default 20-requests/15-min window.
 *   - auditAdminMutationsMiddleware is deliberately excluded: it requires a
 *     real DB connection via getDataSource(), which is out of scope for a
 *     write-disable-switch unit test and would need heavy, unrelated mocking.
 *
 * splitsRouter's own route strings already start with "/admin/...", so it is
 * mounted directly under "/splits" (not "/splits/admin") to avoid
 * double-prefixing -- this matches the real "/splits/admin/*" mount point.
 */
const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use(
    "/splits",
    requirePaymentsAdminAccess,
    enforcePaymentsAdminWriteEnabled,
    splitsRouter
  );
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
};

const TRACKED_ENV_KEYS = [
  "PAYMENTS_ADMIN_WRITE_ENABLED",
  "PAYMENTS_ADMIN_API_KEY",
] as const;

let envBackup: Partial<Record<(typeof TRACKED_ENV_KEYS)[number], string>>;

function setWritesEnabled(value: "true" | "false" | undefined): void {
  if (value === undefined) {
    delete process.env.PAYMENTS_ADMIN_WRITE_ENABLED;
  } else {
    process.env.PAYMENTS_ADMIN_WRITE_ENABLED = value;
  }
  clearEnvCache();
}

beforeAll(() => {
  // Required by config/env.ts's zod schema so getEnv() doesn't throw. Values
  // mirror routes/splits.test.ts's own setup.
  process.env.HORIZON_URL = process.env.HORIZON_URL ?? "https://horizon.test";
  process.env.SOROBAN_RPC_URL = process.env.SOROBAN_RPC_URL ?? "https://soroban.test";
  process.env.SOROBAN_NETWORK_PASSPHRASE =
    process.env.SOROBAN_NETWORK_PASSPHRASE ?? "Test SDF Network";
  process.env.CONTRACT_ID =
    process.env.CONTRACT_ID ?? "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  process.env.SIMULATOR_ACCOUNT = process.env.SIMULATOR_ACCOUNT ?? "GTESTSIMULATOR";
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "https://example.com/postgres";
});

beforeEach(() => {
  envBackup = {};
  for (const key of TRACKED_ENV_KEYS) {
    envBackup[key] = process.env[key];
  }
  // Keep requirePaymentsAdminAccess a no-op: this issue is about the
  // write-disable switch, not the API-key gate, which has its own scope.
  delete process.env.PAYMENTS_ADMIN_API_KEY;
  clearEnvCache();
  vi.clearAllMocks();
});

afterEach(() => {
  for (const key of TRACKED_ENV_KEYS) {
    const value = envBackup[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  clearEnvCache();
});

describe("admin write-disable switch: real middleware chain (Issue #940)", () => {
  // ---- Acceptance criterion: "Assert payment and admin mutation routes are blocked" ----
  it("blocks POST /splits/admin/pause-distributions with 503 when writes are disabled", async () => {
    setWritesEnabled("false");
    const app = buildApp();

    const res = await request(app)
      .post("/splits/admin/pause-distributions")
      .send({ admin: "GADMIN" })
      .expect(503);

    expect(res.body.error).toBe("payments_admin_writes_disabled");
    expect(res.body.requestId).toBeDefined();
    // The switch short-circuits before the route handler's own logic runs.
    expect(getAccountMock).not.toHaveBeenCalled();
    expect(prepareTransactionMock).not.toHaveBeenCalled();
  });

  it("blocks POST /splits/admin/allow-token with 503 when writes are disabled", async () => {
    setWritesEnabled("false");
    const app = buildApp();

    const res = await request(app)
      .post("/splits/admin/allow-token")
      .send({ admin: "GADMIN", token: "GTOKEN" })
      .expect(503);

    expect(res.body.error).toBe("payments_admin_writes_disabled");
    expect(getAccountMock).not.toHaveBeenCalled();
    expect(prepareTransactionMock).not.toHaveBeenCalled();
  });

  // ---- Acceptance criterion: "Allow safe read-only admin routes" ----
  it("allows GET /splits/admin/status through even when writes are disabled", async () => {
    setWritesEnabled("false");
    // Each contract read gets a value of its own type (#1494 rejects a
    // non-boolean pause flag). Reset first so values queued by earlier tests
    // can't leak in.
    simulateTransactionMock.mockReset();
    simulateTransactionMock.mockImplementation(async (tx: { preparedOperation: { method: string } }) => ({
      result: { retval: tx.preparedOperation.method === "is_distributions_paused" ? false : "GADMIN" },
    }));
    getAccountMock.mockResolvedValue({ accountId: "GTESTSIMULATOR" });

    const app = buildApp();
    const res = await request(app).get("/splits/admin/status").expect(200);

    expect(res.body).toHaveProperty("admin");
    expect(res.body).toHaveProperty("isPaused");
  });

  it("allows GET /splits/admin/token-count through even when writes are disabled", async () => {
    setWritesEnabled("false");
    simulateTransactionMock.mockResolvedValue({ result: { retval: 3 } });
    getAccountMock.mockResolvedValue({ accountId: "GTESTSIMULATOR" });

    const app = buildApp();
    const res = await request(app).get("/splits/admin/token-count").expect(200);

    expect(res.body).toHaveProperty("count");
  });

  // ---- Positive-path contrast: proves the middleware isn't a trivial
  // "always block" implementation, and that mutation routes work normally
  // when the switch is enabled (default, or explicit "true"). ----
  it("allows POST /splits/admin/pause-distributions through when the flag is unset (default enabled)", async () => {
    setWritesEnabled(undefined);
    getAccountMock.mockResolvedValue({ accountId: "GADMIN" });
    prepareTransactionMock.mockResolvedValue({
      toXDR: () => "XDR_PAUSE",
      sequence: "1",
      fee: "100",
    });

    const app = buildApp();
    const res = await request(app)
      .post("/splits/admin/pause-distributions")
      .send({ admin: "GADMIN" })
      .expect(200);

    expect(res.body.xdr).toBe("XDR_PAUSE");
    expect(getAccountMock).toHaveBeenCalledWith("GADMIN");
  });

  it("allows POST /splits/admin/allow-token through when PAYMENTS_ADMIN_WRITE_ENABLED=true", async () => {
    setWritesEnabled("true");
    getAccountMock.mockResolvedValue({ accountId: "GADMIN" });
    prepareTransactionMock.mockResolvedValue({
      toXDR: () => "XDR_ALLOW",
      sequence: "1",
      fee: "100",
    });

    const app = buildApp();
    const res = await request(app)
      .post("/splits/admin/allow-token")
      .send({ admin: "GADMIN", token: "GTOKEN" })
      .expect(200);

    expect(res.body.xdr).toBe("XDR_ALLOW");
    expect(getAccountMock).toHaveBeenCalledWith("GADMIN");
  });

  // ---- Acceptance criterion: "Log blocked attempts without secrets" ----
  it("logs a blocked write-disabled attempt with hashed ip, no secrets, no raw headers", async () => {
    setWritesEnabled("false");
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger);

    const app = buildApp();
    await request(app)
      .post("/splits/admin/pause-distributions")
      .set("x-admin-api-key", "super-secret-key-value")
      .send({ admin: "GADMIN" })
      .expect(503);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [message, meta] = warnSpy.mock.calls[0] as [string, Record<string, unknown>];
    expect(message).toBe("Blocked payments admin request");

    expect(meta.reason).toBe("writes_disabled");
    expect(meta.method).toBe("POST");
    expect(meta.path).toBe("/splits/admin/pause-distributions");

    // hashIp() produces a sha256 hash truncated to 16 hex chars -- never a
    // literal IP address.
    expect(meta.ip).toMatch(/^[0-9a-f]{16}$/);
    expect(meta.ip).not.toBe("127.0.0.1");
    expect(meta.ip).not.toBe("::1");
    expect(meta.ip).not.toBe("::ffff:127.0.0.1");

    // The logged payload only ever contains reason/method/path/ip -- no
    // header values (like the API key sent above) leak into it.
    expect(Object.keys(meta).sort()).toEqual(["ip", "method", "path", "reason"]);
    const serialized = JSON.stringify(meta);
    expect(serialized).not.toContain("super-secret-key-value");

    warnSpy.mockRestore();
  });
});

describe("enforcePaymentsAdminWriteEnabled: method-allowlist bypass resistance (Issue #940)", () => {
  // All real admin *mutation* routes in routes/splits.ts (allow-token,
  // disallow-token, pause-distributions, unpause-distributions,
  // withdraw-unallocated) are POST-only -- there is no PATCH/PUT/DELETE
  // admin route to hit through the router, so these method-allowlist checks
  // exercise the middleware function directly rather than fabricating a
  // nonexistent route. (routes/splits.ts does define PATCH
  // "/:projectId/metadata" and PUT "/:projectId/collaborators", but those
  // are project routes, not "/admin/..." routes, so they're out of scope
  // for this issue.)
  function createMockReq(method: string): Request {
    return {
      method,
      originalUrl: "/splits/admin/mock-route",
      ip: "203.0.113.5",
    } as unknown as Request;
  }

  function createMockRes(): Response {
    const res: Partial<Response> = {
      locals: { requestId: "test-request-id" },
    };
    res.status = vi.fn().mockReturnValue(res);
    res.json = vi.fn().mockReturnValue(res);
    return res as Response;
  }

  it("blocks PATCH when writes are disabled (method not in the GET/HEAD/OPTIONS allowlist)", () => {
    setWritesEnabled("false");
    const req = createMockReq("PATCH");
    const res = createMockRes();
    const next = vi.fn();

    enforcePaymentsAdminWriteEnabled(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "payments_admin_writes_disabled" })
    );
  });

  it("blocks DELETE when writes are disabled (method not in the GET/HEAD/OPTIONS allowlist)", () => {
    setWritesEnabled("false");
    const req = createMockReq("DELETE");
    const res = createMockRes();
    const next = vi.fn();

    enforcePaymentsAdminWriteEnabled(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it("allows GET, HEAD, and OPTIONS through unconditionally even when writes are disabled", () => {
    setWritesEnabled("false");

    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      const req = createMockReq(method);
      const res = createMockRes();
      const next = vi.fn();

      enforcePaymentsAdminWriteEnabled(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(res.status).not.toHaveBeenCalled();
    }
  });
});
