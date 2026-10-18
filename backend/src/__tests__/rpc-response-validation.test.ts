/**
 * Issue #1494: Soroban RPC response schema validation.
 *
 * Covers the wire-level JSON-RPC check (envelope + per-method result
 * schemas), the call-site helpers, the contract value schemas, and the
 * interceptor wired into a real `rpc.Server` through a stub HTTP adapter
 * (no network access needed).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Address, Keypair, StrKey, nativeToScVal, rpc, xdr } from "@stellar/stellar-sdk";

const loggerMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("../services/logger.js", () => ({ logger: loggerMock }));

import { RpcJsonRpcError, RpcResponseValidationError, translateSorobanError } from "../lib/errors.js";
import {
  claimableInfoSchema,
  contractU32Schema,
  payoutEventValueSchema,
  positiveStroopAmountSchema,
  stroopAmountSchema,
  txHashSchema,
} from "../schemas/stellar-rpc.schemas.js";
import {
  decodeContractValue,
  installRpcResponseValidation,
  readSimulationRetval,
  validateJsonRpcResponse,
} from "../services/rpc-response-validation.js";
import { getStellarRpcServer } from "../services/stellar.js";

const I128_MAX = (1n << 127n) - 1n;
const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 7));
const TX_HASH = "ab".repeat(32);
const SECRET_SEED = Keypair.random().secret();
const VALUE_XDR = nativeToScVal(1, { type: "u32" }).toXDR("base64");
const TOPIC_XDR = nativeToScVal("payment_sent", { type: "symbol" }).toXDR("base64");

function envelope(result: unknown, id: unknown = 1) {
  return { jsonrpc: "2.0", id, result };
}

function rawEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: "contract",
    id: "0000004294967296-0000000001",
    txHash: TX_HASH,
    ledger: 1234,
    ledgerClosedAt: "2026-04-01T10:00:00Z",
    contractId: CONTRACT_ID,
    topic: [TOPIC_XDR],
    value: VALUE_XDR,
    inSuccessfulContractCall: true,
    ...overrides,
  };
}

function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected function to throw");
}

function expectInvalid(fn: () => unknown, method: string, path?: string): RpcResponseValidationError {
  const error = captureError(fn);
  expect(error).toBeInstanceOf(RpcResponseValidationError);
  const validationError = error as RpcResponseValidationError;
  expect(validationError.method).toBe(method);
  expect(validationError.code).toBe("RPC_RESPONSE_INVALID");
  expect(validationError.statusCode).toBe(502);
  if (path) {
    expect(validationError.issues.map((issue) => issue.path)).toContain(path);
  }
  return validationError;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("contract value schemas", () => {
  describe("stroopAmountSchema", () => {
    it.each([
      ["zero", 0n, 0n],
      ["a plain number", 1_000_000, 1_000_000n],
      ["max i128", I128_MAX, I128_MAX],
      ["max safe integer", Number.MAX_SAFE_INTEGER, BigInt(Number.MAX_SAFE_INTEGER)],
    ])("accepts %s as an exact bigint", (_label, input, expected) => {
      const parsed = stroopAmountSchema.parse(input);
      expect(typeof parsed).toBe("bigint");
      expect(parsed).toBe(expected);
    });

    it.each([
      ["a negative amount", -1n],
      ["i128 overflow", I128_MAX + 1n],
      ["a float", 1.5],
      ["NaN", Number.NaN],
      ["Infinity", Number.POSITIVE_INFINITY],
      ["an unsafe integer", Number.MAX_SAFE_INTEGER + 2],
      ["a numeric string", "100"],
      ["a non-numeric string", "abc"],
      ["null", null],
      ["undefined", undefined],
    ])("rejects %s", (_label, input) => {
      expect(stroopAmountSchema.safeParse(input).success).toBe(false);
    });

    it("positive variant rejects zero but keeps max precision", () => {
      expect(positiveStroopAmountSchema.safeParse(0n).success).toBe(false);
      expect(positiveStroopAmountSchema.parse(1n)).toBe(1n);
      expect(positiveStroopAmountSchema.parse(I128_MAX)).toBe(I128_MAX);
    });
  });

  it("contractU32Schema accepts 0..2^32-1 as number or bigint and rejects the rest", () => {
    expect(contractU32Schema.parse(0)).toBe(0);
    expect(contractU32Schema.parse(4_294_967_295)).toBe(4_294_967_295);
    expect(contractU32Schema.parse(7n)).toBe(7);
    for (const bad of [-1, 4_294_967_296, 1.5, "7", true, null]) {
      expect(contractU32Schema.safeParse(bad).success).toBe(false);
    }
  });

  it("txHashSchema requires exactly 64 hex characters", () => {
    expect(txHashSchema.safeParse("ab".repeat(32)).success).toBe(true);
    expect(txHashSchema.safeParse("AB".repeat(32)).success).toBe(true);
    for (const bad of ["ab".repeat(31) + "a", "ab".repeat(33), "zz".repeat(32), "", "TX1"]) {
      expect(txHashSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("payoutEventValueSchema validates recipient and amount, tolerating extra elements", () => {
    const account = Keypair.random().publicKey();
    expect(payoutEventValueSchema.parse([account, 5n])).toEqual([account, 5n]);
    expect(payoutEventValueSchema.parse([CONTRACT_ID, 5n])).toEqual([CONTRACT_ID, 5n]);
    // collaborator_claimed carries a trailing round number.
    expect(payoutEventValueSchema.parse([account, 5n, 3])).toEqual([account, 5n, 3]);

    expect(payoutEventValueSchema.safeParse([account, 0n]).success).toBe(false);
    expect(payoutEventValueSchema.safeParse([account, -5n]).success).toBe(false);
    expect(payoutEventValueSchema.safeParse(["GABC", 5n]).success).toBe(false);
    expect(payoutEventValueSchema.safeParse([account]).success).toBe(false);
    expect(payoutEventValueSchema.safeParse({ recipient: account, amount: 5n }).success).toBe(false);
  });

  it("claimableInfoSchema keeps unknown fields and rejects negative balances", () => {
    const parsed = claimableInfoSchema.parse({
      claimed: 10n,
      distribution_round: 2,
      last_claim_amount: 0n,
      future_field: "kept",
    });
    expect(parsed).toMatchObject({ claimed: 10n, distribution_round: 2, last_claim_amount: 0n, future_field: "kept" });

    expect(
      claimableInfoSchema.safeParse({ claimed: -1n, distribution_round: 2, last_claim_amount: 0n }).success
    ).toBe(false);
    expect(claimableInfoSchema.safeParse({ distribution_round: 2, last_claim_amount: 0n }).success).toBe(false);
  });
});

describe("validateJsonRpcResponse: envelope", () => {
  it("accepts a valid response and ignores unknown extra fields", () => {
    expect(() =>
      validateJsonRpcResponse("getLatestLedger", 1, {
        ...envelope({ id: "abc", sequence: 42, protocolVersion: 22, somethingNew: true }),
        extra: "ignored",
      })
    ).not.toThrow();
  });

  it.each([
    ["an empty string body", "", "response body is empty"],
    ["a null body", null, "response body is empty"],
    ["an undefined body", undefined, "response body is empty"],
    ["an HTML error page", "<html>502 Bad Gateway</html>", "response body is not a JSON object"],
    ["a JSON array (batch) body", [envelope({ sequence: 1 })], "response body is not a JSON object"],
    ["a bare number", 42, "response body is not a JSON object"],
  ])("rejects %s", (_label, body, message) => {
    const error = expectInvalid(() => validateJsonRpcResponse("getLatestLedger", 1, body), "getLatestLedger", "(root)");
    expect(error.issues[0].message).toBe(message);
  });

  it("rejects a wrong or missing jsonrpc version", () => {
    expectInvalid(
      () => validateJsonRpcResponse("getLatestLedger", 1, { jsonrpc: "1.0", id: 1, result: { sequence: 1 } }),
      "getLatestLedger",
      "jsonrpc"
    );
    expectInvalid(
      () => validateJsonRpcResponse("getLatestLedger", 1, { id: 1, result: { sequence: 1 } }),
      "getLatestLedger",
      "jsonrpc"
    );
  });

  it("rejects a response whose id does not echo the request id", () => {
    expectInvalid(() => validateJsonRpcResponse("getLatestLedger", 1, envelope({ sequence: 1 }, 2)), "getLatestLedger", "id");
    expectInvalid(() => validateJsonRpcResponse("getLatestLedger", 1, envelope({ sequence: 1 }, "1")), "getLatestLedger", "id");
  });

  it("rejects a response carrying both result and error", () => {
    expectInvalid(
      () =>
        validateJsonRpcResponse("getLatestLedger", 1, {
          ...envelope({ sequence: 1 }),
          error: { code: -32000, message: "boom" },
        }),
      "getLatestLedger",
      "(root)"
    );
  });

  it.each([
    ["a null result", envelope(null)],
    ["a missing result", { jsonrpc: "2.0", id: 1 }],
  ])("rejects %s", (_label, body) => {
    expectInvalid(() => validateJsonRpcResponse("getHealth", 1, body), "getHealth", "result");
  });

  it("converts a well-formed JSON-RPC error object into a typed RpcJsonRpcError", () => {
    const error = captureError(() =>
      validateJsonRpcResponse("getEvents", 1, {
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32602, message: "startLedger must be positive\nstack trace line", data: { x: 1 } },
      })
    );
    expect(error).toBeInstanceOf(RpcJsonRpcError);
    const rpcError = error as RpcJsonRpcError;
    expect(rpcError.rpcCode).toBe(-32602);
    expect(rpcError.method).toBe("getEvents");
    expect(rpcError.message).toBe("startLedger must be positive");
    expect(rpcError.code).toBe("RPC_UPSTREAM_ERROR");
    expect(rpcError.statusCode).toBe(502);
  });

  it("redacts echoed XDR from upstream JSON-RPC error messages", () => {
    const xdrBlob = "A".repeat(120);
    const error = captureError(() =>
      validateJsonRpcResponse("simulateTransaction", 1, {
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32602, message: `invalid transaction ${xdrBlob}` },
      })
    ) as RpcJsonRpcError;
    expect(error.message).not.toContain(xdrBlob);
    expect(error.message).toContain("[REDACTED_XDR]");
  });

  it.each([
    ["a string error", "boom"],
    ["a null error", null],
    ["an error without a code", { message: "boom" }],
    ["an error with a string code", { code: "-32000", message: "boom" }],
    ["an error without a message", { code: -32000 }],
  ])("rejects a malformed JSON-RPC error object: %s", (_label, rpcError) => {
    expectInvalid(
      () => validateJsonRpcResponse("getEvents", 1, { jsonrpc: "2.0", id: 1, error: rpcError }),
      "getEvents"
    );
  });

  it("only checks the envelope for methods without a registered result schema", () => {
    expect(() => validateJsonRpcResponse("getHealth", 1, envelope({ status: "healthy" }))).not.toThrow();
  });

  it("never puts payload values into the error, its details or the log", () => {
    const error = expectInvalid(
      () =>
        validateJsonRpcResponse(
          "getEvents",
          1,
          envelope({ events: [rawEvent({ txHash: SECRET_SEED, value: SECRET_SEED })] })
        ),
      "getEvents",
      "result.events.0.txHash"
    );

    const surfaces = JSON.stringify({
      message: error.message,
      issues: error.issues,
      details: error.details,
      logs: loggerMock.warn.mock.calls,
    });
    expect(surfaces).not.toContain(SECRET_SEED);
    expect(loggerMock.warn).toHaveBeenCalledWith(
      "Stellar RPC response failed validation",
      expect.objectContaining({ method: "getEvents" })
    );
  });
});

describe("validateJsonRpcResponse: per-method result schemas", () => {
  it("getLatestLedger requires a u32 sequence", () => {
    expect(() => validateJsonRpcResponse("getLatestLedger", 1, envelope({ sequence: 0 }))).not.toThrow();
    for (const sequence of [undefined, -1, 1.5, "100", 4_294_967_296]) {
      expectInvalid(
        () => validateJsonRpcResponse("getLatestLedger", 1, envelope({ sequence })),
        "getLatestLedger",
        "result.sequence"
      );
    }
  });

  describe("getEvents", () => {
    it("accepts a realistic page, an empty page, and events without the optional ledger", () => {
      const ok = (result: unknown) => () => validateJsonRpcResponse("getEvents", 1, envelope(result));
      expect(ok({ events: [rawEvent()], cursor: "0000004294967296-0000000001", latestLedger: 1300 })).not.toThrow();
      expect(ok({ events: [], latestLedger: 1300 })).not.toThrow();
      expect(ok({ events: [rawEvent({ ledger: undefined, topic: undefined })] })).not.toThrow();
      expect(ok({ events: [rawEvent({ contractId: "" })] })).not.toThrow();
    });

    it("rejects a page without an events array, even when it carries a cursor", () => {
      expectInvalid(
        () => validateJsonRpcResponse("getEvents", 1, envelope({ cursor: "next", latestLedger: 1 })),
        "getEvents",
        "result.events"
      );
      expectInvalid(
        () => validateJsonRpcResponse("getEvents", 1, envelope({ events: null, cursor: "next" })),
        "getEvents",
        "result.events"
      );
    });

    it.each([
      ["txHash", { txHash: "not-a-hash" }],
      ["txHash", { txHash: undefined }],
      ["ledgerClosedAt", { ledgerClosedAt: "yesterday" }],
      ["contractId", { contractId: "GNOTACONTRACT" }],
      ["value", { value: "not base64!" }],
      ["value", { value: "" }],
      ["topic.0", { topic: [42] }],
      ["id", { id: "" }],
      ["ledger", { ledger: -1 }],
    ])("rejects a malformed event field: %s", (field, overrides) => {
      expectInvalid(
        () => validateJsonRpcResponse("getEvents", 1, envelope({ events: [rawEvent(overrides)] })),
        "getEvents",
        `result.events.0.${field}`
      );
    });
  });

  describe("simulateTransaction", () => {
    const success = {
      transactionData: VALUE_XDR,
      minResourceFee: "12345",
      results: [{ xdr: VALUE_XDR, auth: [] }],
      latestLedger: 10,
    };

    it("accepts a success, a success without results and a simulation error", () => {
      const ok = (result: unknown) => () => validateJsonRpcResponse("simulateTransaction", 1, envelope(result));
      expect(ok(success)).not.toThrow();
      expect(ok({ ...success, results: undefined })).not.toThrow();
      expect(ok({ error: "HostError: Error(Contract, #2)", latestLedger: 10 })).not.toThrow();
    });

    it("rejects a non-string error that the SDK would mistake for a success", () => {
      expectInvalid(
        () => validateJsonRpcResponse("simulateTransaction", 1, envelope({ error: { code: 7 }, latestLedger: 10 })),
        "simulateTransaction",
        "result.error"
      );
    });

    it.each([
      ["result.transactionData", { ...success, transactionData: undefined }],
      ["result.minResourceFee", { ...success, minResourceFee: "-5" }],
      ["result.minResourceFee", { ...success, minResourceFee: 100 }],
      ["result.results.0.xdr", { ...success, results: [{ xdr: "%%%" }] }],
      ["result.results", { ...success, results: [{ xdr: VALUE_XDR }, { xdr: VALUE_XDR }] }],
    ])("rejects a malformed success: %s", (path, result) => {
      expectInvalid(() => validateJsonRpcResponse("simulateTransaction", 1, envelope(result)), "simulateTransaction", path);
    });
  });

  it("getLedgerEntries tolerates null entries (account not found) but rejects malformed entries", () => {
    expect(() => validateJsonRpcResponse("getLedgerEntries", 1, envelope({ entries: null, latestLedger: 5 }))).not.toThrow();
    expect(() =>
      validateJsonRpcResponse("getLedgerEntries", 1, envelope({ entries: [{ key: VALUE_XDR, xdr: VALUE_XDR }], latestLedger: 5 }))
    ).not.toThrow();
    expectInvalid(
      () => validateJsonRpcResponse("getLedgerEntries", 1, envelope({ entries: [{ key: VALUE_XDR }], latestLedger: 5 })),
      "getLedgerEntries",
      "result.entries.0.xdr"
    );
  });
});

describe("readSimulationRetval", () => {
  const retval = nativeToScVal(true);

  it("returns the retval of a successful contract call", () => {
    expect(readSimulationRetval("is_token_allowed", { result: { retval, auth: [] }, latestLedger: 1 })).toBe(retval);
  });

  it("returns undefined for a well-formed simulation error", () => {
    expect(readSimulationRetval("get_project", { error: "HostError: Error(Contract, #2)" })).toBeUndefined();
  });

  it.each([
    ["a success without a result", { latestLedger: 1, transactionData: {} }, "result.retval"],
    ["a result without a retval", { result: { auth: [] } }, "result.retval"],
    ["an empty error string", { error: "" }, "error"],
    ["a non-string error", { error: { code: 1 } }, "error"],
    ["null", null, "(root)"],
    ["an array", [], "(root)"],
  ])("rejects %s instead of falling back to a default", (_label, simulated, path) => {
    expectInvalid(() => readSimulationRetval("is_distributions_paused", simulated), "simulateTransaction:is_distributions_paused", path);
  });
});

describe("decodeContractValue", () => {
  it("decodes i128 amounts exactly, beyond Number precision", () => {
    const big = (1n << 100n) + 1n;
    expect(decodeContractValue("m", stroopAmountSchema, nativeToScVal(big, { type: "i128" }))).toBe(big);
    expect(decodeContractValue("m", stroopAmountSchema, nativeToScVal(I128_MAX, { type: "i128" }))).toBe(I128_MAX);
    expect(decodeContractValue("m", stroopAmountSchema, nativeToScVal(0, { type: "i128" }))).toBe(0n);
  });

  it("rejects a negative i128 balance", () => {
    expectInvalid(() => decodeContractValue("m", stroopAmountSchema, nativeToScVal(-1, { type: "i128" })), "m", "(root)");
  });

  it("rejects a value of the wrong contract type", () => {
    expectInvalid(() => decodeContractValue("m", stroopAmountSchema, nativeToScVal("100", { type: "string" })), "m");
  });

  it("rejects something that is not an ScVal at all", () => {
    const error = expectInvalid(() => decodeContractValue("m", stroopAmountSchema, { not: "an ScVal" }), "m", "(root)");
    expect(error.issues[0].message).toBe("could not be decoded");
  });

  it("decodes a payout event tuple with a real address", () => {
    const recipient = Keypair.random().publicKey();
    const value = xdr.ScVal.scvVec([Address.fromString(recipient).toScVal(), nativeToScVal(250n, { type: "i128" })]);
    expect(decodeContractValue("getEvents:payment_sent", payoutEventValueSchema, value)).toEqual([recipient, 250n]);
  });
});

describe("translateSorobanError", () => {
  it("passes typed RPC boundary errors through instead of reclassifying them", () => {
    const invalid = new RpcResponseValidationError("getEvents", [{ path: "result.events", message: "x" }]);
    const upstream = new RpcJsonRpcError("getEvents", -32602, "resource not found");
    expect(translateSorobanError(invalid)).toBe(invalid);
    expect(translateSorobanError(upstream)).toBe(upstream);
  });
});

describe("installRpcResponseValidation on a real rpc.Server", () => {
  type StubAdapter = (config: { data?: unknown }) => Promise<unknown>;

  function respondWith(server: rpc.Server, body: unknown, overrideId = false): void {
    const adapter: StubAdapter = async (config) => {
      const requestId = JSON.parse(String(config.data)).id;
      const data =
        typeof body === "object" && body !== null && !Array.isArray(body) && !overrideId
          ? { ...(body as Record<string, unknown>), id: requestId }
          : body;
      return { data, status: 200, statusText: "OK", headers: {}, config };
    };
    server.httpClient.defaults.adapter = adapter as never;
  }

  function newServer(): rpc.Server {
    const server = new rpc.Server("https://soroban-testnet.stellar.org");
    expect(installRpcResponseValidation(server)).toBe(true);
    return server;
  }

  it("lets a valid response through to the SDK parser", async () => {
    const server = newServer();
    respondWith(server, envelope({ id: "x", sequence: 777, protocolVersion: 22 }));
    await expect(server.getLatestLedger()).resolves.toMatchObject({ sequence: 777 });
  });

  it("rejects a malformed result before the SDK sees it", async () => {
    const server = newServer();
    respondWith(server, envelope({ sequence: "777" }));
    await expect(server.getLatestLedger()).rejects.toBeInstanceOf(RpcResponseValidationError);
  });

  it("rejects a non-JSON body with a typed error instead of a TypeError", async () => {
    const server = newServer();
    respondWith(server, "<html>Bad gateway</html>");
    await expect(server.getLatestLedger()).rejects.toBeInstanceOf(RpcResponseValidationError);
  });

  it("rejects a response whose id does not match the request", async () => {
    const server = newServer();
    respondWith(server, envelope({ sequence: 1 }, 999), true);
    await expect(server.getLatestLedger()).rejects.toMatchObject({ name: "RpcResponseValidationError", method: "getLatestLedger" });
  });

  it("turns a JSON-RPC error object into RpcJsonRpcError instead of a thrown plain object", async () => {
    const server = newServer();
    respondWith(server, { jsonrpc: "2.0", error: { code: -32601, message: "method not found" } });
    const error = await server.getLatestLedger().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcJsonRpcError);
    expect(error).toMatchObject({ rpcCode: -32601, message: "method not found" });
  });

  it("validates SDK-internal calls too: prepareTransaction's simulateTransaction", async () => {
    const server = newServer();
    // A "success" missing transactionData would otherwise produce an
    // unusable transaction with an empty footprint.
    respondWith(server, envelope({ minResourceFee: "100", results: [{ xdr: VALUE_XDR }], latestLedger: 5 }));
    const source = Keypair.random().publicKey();
    const { Account, Contract, TransactionBuilder, Networks } = await import("@stellar/stellar-sdk");
    const tx = new TransactionBuilder(new Account(source, "1"), { fee: "100", networkPassphrase: Networks.TESTNET })
      .addOperation(new Contract(CONTRACT_ID).call("get_project_count"))
      .setTimeout(30)
      .build();
    await expect(server.prepareTransaction(tx)).rejects.toMatchObject({
      name: "RpcResponseValidationError",
      method: "simulateTransaction",
    });
  });

  it("is idempotent", () => {
    const server = newServer();
    const before = server.httpClient.interceptors.response.handlers.filter(Boolean).length;
    expect(installRpcResponseValidation(server)).toBe(true);
    expect(server.httpClient.interceptors.response.handlers.filter(Boolean).length).toBe(before);
  });

  it("reports test doubles without an HTTP client instead of throwing", () => {
    expect(installRpcResponseValidation({} as rpc.Server)).toBe(false);
  });

  describe("getStellarRpcServer()", () => {
    let original: unknown;
    afterEach(() => {
      getStellarRpcServer().httpClient.defaults.adapter = original as never;
    });

    it("returns a server with validation installed", async () => {
      const server = getStellarRpcServer();
      original = server.httpClient.defaults.adapter;
      respondWith(server, envelope(null));
      await expect(server.getLatestLedger()).rejects.toBeInstanceOf(RpcResponseValidationError);
    });
  });
});
