/**
 * Issue #1494: route-level behaviour when Soroban RPC returns malformed data.
 *
 * The RPC server is a test double, but transactions, ScVals and addresses
 * come from the real Stellar SDK, so contract values are decoded exactly as
 * in production. Malformed responses must surface as a 502
 * `RPC_RESPONSE_INVALID` and must never be turned into a default value or
 * an unsigned transaction.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  Account,
  Address,
  Keypair,
  Networks,
  StrKey,
  nativeToScVal,
  xdr,
  type Transaction,
} from "@stellar/stellar-sdk";

const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 7));
const I128_MAX = (1n << 127n) - 1n;

const server = vi.hoisted(() => ({
  getAccount: vi.fn(),
  simulateTransaction: vi.fn(),
  prepareTransaction: vi.fn(),
  getEvents: vi.fn(),
}));

vi.mock("../services/stellar.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/stellar.js")>();
  return {
    ...actual,
    getStellarRpcServer: () => server,
    executeWithRetry: <T>(fn: () => Promise<T>) => fn(),
    loadStellarConfig: () => ({
      horizonUrl: "https://horizon.test",
      sorobanRpcUrl: "https://soroban.test",
      networkPassphrase: Networks.TESTNET,
      contractId: CONTRACT_ID,
      simulatorAccount: Keypair.random().publicKey(),
    }),
  };
});

vi.mock("../services/project-expiration.js", () => ({
  assertProjectNotExpired: vi.fn(async () => undefined),
  getProjectExpiration: vi.fn(async () => null),
  configureProjectExpiration: vi.fn(),
  recordSplitCreated: vi.fn(),
}));

vi.mock("../services/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), http: vi.fn() },
}));

import { splitsRouter } from "../routes/splits.js";
import { requestIdMiddleware } from "../middleware/request-id.js";
import { errorHandler, notFoundHandler } from "../middleware/error.js";
import { fetchProjectById } from "../services/splits.service.js";
import { RpcResponseValidationError } from "../lib/errors.js";

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(requestIdMiddleware);
  app.use("/splits", splitsRouter);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

const i128 = (value: bigint) => nativeToScVal(value, { type: "i128" });
const u32 = (value: number) => nativeToScVal(value, { type: "u32" });
const mapEntry = (key: string, val: xdr.ScVal) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(key), val });

function contractMethodOf(tx: Transaction): string {
  const op = tx.operations[0] as unknown as { func: xdr.HostFunction };
  return op.func.invokeContract().functionName().toString();
}

/** Answer each simulated contract call by its function name. */
function simulateReturns(byMethod: Record<string, unknown>) {
  server.simulateTransaction.mockImplementation(async (tx: Transaction) => {
    const method = contractMethodOf(tx);
    if (!(method in byMethod)) throw new Error(`unexpected contract call: ${method}`);
    return byMethod[method];
  });
}

const ok = (retval: xdr.ScVal) => ({ result: { retval, auth: [] }, latestLedger: 10 });

function event(value: xdr.ScVal, overrides: Record<string, unknown> = {}) {
  return {
    id: "0000004294967296-0000000001",
    txHash: "cd".repeat(32),
    ledger: 100,
    ledgerClosedAt: "2026-04-01T10:00:00Z",
    value,
    ...overrides,
  };
}

function expectRpcInvalid(res: request.Response) {
  expect(res.status).toBe(502);
  expect(res.body.code).toBe("RPC_RESPONSE_INVALID");
  expect(res.body.error).toBe("rpc_response_invalid");
  expect(typeof res.body.requestId).toBe("string");
  expect(typeof res.body.details.method).toBe("string");
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of Object.values(server)) fn.mockReset();
  server.getAccount.mockImplementation(async (address: string) => new Account(address, "1"));
});

describe("GET /splits/:projectId/history (#1494)", () => {
  const recipient = Keypair.random().publicKey();
  const paymentValue = (amount: bigint) =>
    xdr.ScVal.scvVec([Address.fromString(recipient).toScVal(), i128(amount)]);
  const roundValue = (round: number, total: bigint) => xdr.ScVal.scvVec([u32(round), i128(total)]);

  it("returns exact amounts for valid events, including max-precision i128", async () => {
    server.getEvents
      .mockResolvedValueOnce({ events: [event(roundValue(1, 0n))], cursor: "c1", latestLedger: 200 })
      .mockResolvedValueOnce({
        events: [event(paymentValue(I128_MAX), { ledgerClosedAt: "2026-04-01T10:00:01Z", unknownField: 1 })],
        cursor: "c2",
        latestLedger: 200,
      });

    const res = await request(createApp()).get("/splits/proj_1/history");

    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([
      expect.objectContaining({ type: "payment", recipient, amount: I128_MAX.toString() }),
      expect.objectContaining({ type: "round", round: 1, amount: "0" }),
    ]);
    expect(res.body.nextCursor).toBe("c1");
  });

  it("returns an empty list for empty pages", async () => {
    server.getEvents.mockResolvedValue({ events: [], latestLedger: 200 });

    const res = await request(createApp()).get("/splits/proj_1/history");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], nextCursor: null });
  });

  it.each([
    ["a page without events", { cursor: "c1", latestLedger: 200 }],
    ["a null page", null],
    ["an event with a malformed txHash", { events: [event(roundValue(1, 5n), { txHash: "0xabc" })] }],
    ["an event with a malformed timestamp", { events: [event(roundValue(1, 5n), { ledgerClosedAt: 12345 })] }],
    ["a round event with a negative total", { events: [event(roundValue(1, -5n))] }],
  ])("rejects %s", async (_label, roundPage) => {
    server.getEvents.mockResolvedValueOnce(roundPage).mockResolvedValueOnce({ events: [] });

    expectRpcInvalid(await request(createApp()).get("/splits/proj_1/history"));
  });

  it.each([
    ["a zero amount", paymentValue(0n)],
    ["a negative amount", paymentValue(-1n)],
    ["a non-address recipient", xdr.ScVal.scvVec([nativeToScVal("GABC", { type: "string" }), i128(5n)])],
  ])("rejects a payment event with %s", async (_label, value) => {
    server.getEvents.mockResolvedValueOnce({ events: [] }).mockResolvedValueOnce({ events: [event(value)] });

    expectRpcInvalid(await request(createApp()).get("/splits/proj_1/history"));
  });
});

describe("GET /splits/:projectId/claimable/:address (#1494)", () => {
  const address = Keypair.random().publicKey();
  const claimable = (claimed: bigint, round: number, last: bigint) =>
    xdr.ScVal.scvMap([
      mapEntry("claimed", i128(claimed)),
      mapEntry("distribution_round", u32(round)),
      mapEntry("last_claim_amount", i128(last)),
    ]);

  it("returns validated amounts as exact strings", async () => {
    simulateReturns({ get_claimable: ok(claimable(I128_MAX, 2, 0n)) });

    const res = await request(createApp()).get(`/splits/proj_1/claimable/${address}`);

    expect(res.status).toBe(200);
    expect(res.body.claimable).toEqual({
      claimed: I128_MAX.toString(),
      distribution_round: 2,
      last_claim_amount: "0",
    });
  });

  it("rejects a negative claimed balance", async () => {
    simulateReturns({ get_claimable: ok(claimable(-1n, 2, 0n)) });
    expectRpcInvalid(await request(createApp()).get(`/splits/proj_1/claimable/${address}`));
  });

  it("rejects a simulation 'success' without a result", async () => {
    simulateReturns({ get_claimable: { latestLedger: 10 } });
    expectRpcInvalid(await request(createApp()).get(`/splits/proj_1/claimable/${address}`));
  });

  it("keeps the existing 502 for a well-formed simulation error", async () => {
    simulateReturns({ get_claimable: { error: "HostError: Error(Contract, #2)", latestLedger: 10 } });

    const res = await request(createApp()).get(`/splits/proj_1/claimable/${address}`);

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("rpc_error");
  });
});

describe("POST /splits/:projectId/distribute pause check (#1494)", () => {
  const preparedTx = { toXDR: () => "AAAA", sequence: "2", fee: "100" };

  it("builds the transaction when the contract reports not paused", async () => {
    simulateReturns({ is_distributions_paused: ok(nativeToScVal(false)) });
    server.prepareTransaction.mockResolvedValue(preparedTx);

    const res = await request(createApp()).post("/splits/proj_1/distribute").send({});

    expect(res.status).toBe(200);
    expect(server.prepareTransaction).toHaveBeenCalledTimes(1);
  });

  it("still returns 409 when paused", async () => {
    simulateReturns({ is_distributions_paused: ok(nativeToScVal(true)) });

    const res = await request(createApp()).post("/splits/proj_1/distribute").send({});

    expect(res.status).toBe(409);
    expect(server.prepareTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ["a u32 instead of a bool", ok(u32(0))],
    ["a string instead of a bool", ok(nativeToScVal("false", { type: "string" }))],
    ["a success without a result", { latestLedger: 10 }],
  ])("never builds a distribution when the pause flag is %s", async (_label, simulated) => {
    simulateReturns({ is_distributions_paused: simulated });

    const res = await request(createApp()).post("/splits/proj_1/distribute").send({});

    expectRpcInvalid(res);
    expect(server.prepareTransaction).not.toHaveBeenCalled();
  });
});

describe("fetchProjectById balance decoding (#1494)", () => {
  const project = xdr.ScVal.scvMap([mapEntry("owner", Address.fromString(Keypair.random().publicKey()).toScVal())]);
  let n = 0;
  const uniqueId = () => `proj_fetch_${++n}`;

  it("decodes the project balance exactly", async () => {
    simulateReturns({ get_project: ok(project), get_balance: ok(i128(I128_MAX)) });

    await expect(fetchProjectById(uniqueId())).resolves.toMatchObject({ balance: I128_MAX.toString() });
  });

  it("rejects a negative balance instead of returning it", async () => {
    simulateReturns({ get_project: ok(project), get_balance: ok(i128(-10n)) });

    await expect(fetchProjectById(uniqueId())).rejects.toBeInstanceOf(RpcResponseValidationError);
  });

  it("rejects a get_project 'success' without a result instead of reporting not-found", async () => {
    simulateReturns({ get_project: { latestLedger: 10 } });

    await expect(fetchProjectById(uniqueId())).rejects.toBeInstanceOf(RpcResponseValidationError);
  });

  it("still reports not-found for a well-formed simulation error", async () => {
    simulateReturns({ get_project: { error: "HostError: Error(Contract, #2)", latestLedger: 10 } });

    await expect(fetchProjectById(uniqueId())).resolves.toBeNull();
  });
});
