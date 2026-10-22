/**
 * Issue #1260: Database uniqueness constraint tests.
 *
 * Verifies that:
 * - PostgreSQL SQLSTATE 23505 (unique_violation) is converted to a 409
 *   response with a stable, machine-readable shape.
 * - Duplicate wallet-address registration is rejected with 409.
 * - The 23505 handler does not interfere with unrelated errors.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import { markStartupComplete } from "../routes/health.js";

// ── Environment stubs ────────────────────────────────────────────────────────
process.env.DATABASE_URL = "postgres://example.com/test";
process.env.SIMULATOR_ACCOUNT = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1";
process.env.CONTRACT_ID = "CBLASIRZ7CUKC7S5IS3VSNMQGKZ5FTRWLHZZXH7H4YG6ZLRFPJF5H2LR";
process.env.HORIZON_URL = "https://horizon-testnet.stellar.org";
process.env.SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
process.env.SOROBAN_NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

// ── Mocks ────────────────────────────────────────────────────────────────────

/** Simulates a PostgreSQL unique-violation (SQLSTATE 23505). */
function makeUniqueViolation(constraint = "UQ_users_email_notnull") {
  const err = new Error(`duplicate key value violates unique constraint "${constraint}"`);
  (err as NodeJS.ErrnoException & { code: string }).code = "23505";
  (err as unknown as Record<string, string>).constraint = constraint;
  return err;
}

const mockUserSave = vi.fn();
const mockUserExists = vi.fn();
const mockUserCreate = vi.fn((data: unknown) => data);

vi.mock("@stellar/stellar-sdk", () => ({
  Address: { fromString: vi.fn((a: string) => ({ toScVal: () => a, toString: () => a }) ) },
  BASE_FEE: "100",
  Contract: vi.fn().mockImplementation(() => ({ call: vi.fn().mockReturnValue({}) })),
  TransactionBuilder: vi.fn().mockImplementation(() => ({
    addOperation: vi.fn().mockReturnThis(),
    setTimeout: vi.fn().mockReturnThis(),
    build: vi.fn().mockReturnValue({ toXDR: () => "test_xdr" }),
  })),
  nativeToScVal: vi.fn((v: unknown) => ({ v })),
  scValToNative: vi.fn((v: unknown) => v),
  // user.schemas.ts uses StrKey.isValidEd25519PublicKey for wallet address validation
  StrKey: {
    isValidEd25519PublicKey: vi.fn((v: string) => /^G[A-Z2-7]{55}$/.test(v)),
    isValidContract: vi.fn(() => false),
  },
  rpc: {
    Server: vi.fn().mockImplementation(() => ({
      getAccount: vi.fn().mockResolvedValue({ accountId: () => "G_TEST", sequenceNumber: () => "1" }),
      simulateTransaction: vi.fn().mockResolvedValue({ result: { retval: null } }),
      prepareTransaction: vi.fn().mockResolvedValue({ toXDR: () => "test_xdr", sequence: "1", fee: "100" }),
    })),
  },
  xdr: { ScVal: { scvU32: vi.fn(), scvVec: vi.fn() } },
}));

vi.mock("../services/stellar.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/stellar.js")>();
  return {
    ...actual,
    loadStellarConfig: vi.fn(() => ({
      horizonUrl: "http://horizon",
      sorobanRpcUrl: "http://rpc",
      networkPassphrase: "test",
      contractId: "CBLASIRZ7CUKC7S5IS3VSNMQGKZ5FTRWLHZZXH7H4YG6ZLRFPJF5H2LR",
      simulatorAccount: "test_account",
    })),
    getStellarRpcServer: vi.fn(() => ({
      getAccount: vi.fn().mockResolvedValue({ accountId: () => "G_TEST", sequenceNumber: () => "1", incrementSequenceNumber: vi.fn() }),
      simulateTransaction: vi.fn().mockResolvedValue({ result: { retval: null } }),
      prepareTransaction: vi.fn().mockResolvedValue({ toXDR: () => "test_xdr", sequence: "1", fee: "100" }),
      getEvents: vi.fn().mockResolvedValue({ events: [] }),
    })),
    executeWithRetry: vi.fn(async (fn: () => unknown) => fn()),
    getCached: vi.fn(() => undefined),
    setCached: vi.fn(),
    invalidateCache: vi.fn(),
    invalidateCacheByPrefix: vi.fn(),
    getCacheStats: vi.fn(() => ({ hits: 0, misses: 0, evictions: 0 })),
    READ_CACHE_TTL_MS: 30000,
    checkSorobanReachability: vi.fn().mockResolvedValue({ rpc: { ok: true }, contract: { ok: true } }),
  };
});

vi.mock("../services/database.js", () => ({
  getDataSource: vi.fn(() => ({
    isInitialized: true,
    query: vi.fn().mockResolvedValue([{ one: 1 }]),
    getRepository: vi.fn(() => ({
      exists: mockUserExists,
      findOne: vi.fn().mockResolvedValue(null),
      create: mockUserCreate,
      save: mockUserSave,
    })),
  })),
  withTransaction: vi.fn(async (cb: (qr: unknown) => unknown) =>
    cb({
      manager: {
        getRepository: vi.fn(() => ({
          exists: mockUserExists,
          findOne: vi.fn().mockResolvedValue(null),
          create: mockUserCreate,
          save: mockUserSave,
        })),
      },
    })
  ),
  initDatabase: vi.fn().mockResolvedValue({}),
  closeDatabase: vi.fn().mockResolvedValue({}),
}));

const { app } = await import("../index.js");

describe("Issue #1260: DB uniqueness constraint → 409 responses", () => {
  beforeEach(() => {
    markStartupComplete();
    mockUserExists.mockReset();
    mockUserSave.mockReset();
    mockUserCreate.mockReset().mockImplementation((d: unknown) => d);
  });

  it("returns 409 when a PostgreSQL 23505 unique violation is raised during registration", async () => {
    // First call (walletAddress existence check) returns false so we proceed
    // to the transaction. Inside the transaction the DB raises 23505.
    mockUserExists.mockResolvedValue(false);
    mockUserSave.mockRejectedValue(makeUniqueViolation("UQ_users_email_notnull"));

    const res = await request(app)
      .post("/users/register")
      .send({
        walletAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        email: "duplicate@example.com",
        alias: "Test User",
      });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("DUPLICATE_RESOURCE");
    expect(res.body.error).toBe("conflict");
    expect(res.body.requestId).toBeTruthy();
  });

  it("returns 409 when walletAddress unique constraint is violated concurrently", async () => {
    // Application-level check passes (simulating a race), then DB raises 23505
    // on the wallet address constraint.
    mockUserExists.mockResolvedValue(false);
    mockUserSave.mockRejectedValue(makeUniqueViolation("UQ_users_walletAddress"));

    const res = await request(app)
      .post("/users/register")
      .send({
        walletAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        alias: "Concurrent User",
      });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("DUPLICATE_RESOURCE");
    expect(res.body.requestId).toBeTruthy();
  });

  it("returns 409 early (before transaction) when walletAddress already exists", async () => {
    mockUserExists.mockResolvedValue(true);

    const res = await request(app)
      .post("/users/register")
      .send({
        walletAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      });

    expect(res.status).toBe(409);
    // Application-level check returns the route's own conflict message
    expect(res.body.message).toMatch(/already registered/i);
    // DB save must never be reached
    expect(mockUserSave).not.toHaveBeenCalled();
  });

  it("does not convert unrelated DB errors to 409", async () => {
    mockUserExists.mockResolvedValue(false);
    const foreignKeyError = new Error("insert violates foreign key constraint");
    (foreignKeyError as NodeJS.ErrnoException & { code: string }).code = "23503";
    mockUserSave.mockRejectedValue(foreignKeyError);

    const res = await request(app)
      .post("/users/register")
      .send({
        walletAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      });

    // Foreign key violation is not handled specially; falls to 500
    expect(res.status).toBe(500);
  });

  it("response body contains no sensitive DB internals on 23505", async () => {
    mockUserExists.mockResolvedValue(false);
    mockUserSave.mockRejectedValue(
      makeUniqueViolation("UQ_users_email_notnull")
    );

    const res = await request(app)
      .post("/users/register")
      .send({
        walletAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
        email: "dup@example.com",
      });

    expect(res.status).toBe(409);
    const body = JSON.stringify(res.body);
    // Must not expose raw DB constraint names, table names, or full error text
    expect(body).not.toContain("duplicate key value violates");
    expect(body).not.toContain("UQ_users_email_notnull");
  });
});
