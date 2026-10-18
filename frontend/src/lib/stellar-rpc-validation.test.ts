/**
 * Issue #1494: Soroban RPC response validation in the frontend.
 */
import { describe, expect, it } from "vitest";
import { rpc } from "@stellar/stellar-sdk";

import {
  RpcJsonRpcError,
  RpcResponseValidationError,
  installRpcResponseValidation,
  parseGetTransactionResponse,
  parseSendTransactionResponse,
  validateJsonRpcResponse,
} from "./stellar-rpc-validation";

const HASH = "ab".repeat(32);
const XDR = "AAAAAQ==";

const envelope = (result: unknown, id: unknown = 1) => ({ jsonrpc: "2.0", id, result });

function captureError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected function to throw");
}

function expectInvalid(fn: () => unknown, path: string): RpcResponseValidationError {
  const error = captureError(fn);
  expect(error).toBeInstanceOf(RpcResponseValidationError);
  const invalid = error as RpcResponseValidationError;
  expect(invalid.issues.map((issue) => issue.path)).toContain(path);
  return invalid;
}

describe("parseSendTransactionResponse", () => {
  it.each(["PENDING", "DUPLICATE"])("accepts an accepted %s submission with a hex hash", (status) => {
    expect(parseSendTransactionResponse({ status, hash: HASH, latestLedger: 1, extra: true })).toMatchObject({
      status,
      hash: HASH,
    });
  });

  it.each(["ERROR", "TRY_AGAIN_LATER"])("accepts a well-formed %s response without a hash", (status) => {
    expect(parseSendTransactionResponse({ status }).status).toBe(status);
  });

  it.each([
    ["a missing status", { hash: HASH }, "status"],
    ["an unknown status", { status: "SUCCESS", hash: HASH }, "status"],
    ["a lowercase status", { status: "pending", hash: HASH }, "status"],
    ["a PENDING response without a hash", { status: "PENDING" }, "hash"],
    ["a PENDING response with a short hash", { status: "PENDING", hash: "abc" }, "hash"],
    ["a DUPLICATE response with a non-hex hash", { status: "DUPLICATE", hash: "zz".repeat(32) }, "hash"],
    ["null", null, "(root)"],
  ])("rejects %s", (_label, response, path) => {
    const error = expectInvalid(() => parseSendTransactionResponse(response), path);
    expect(error.method).toBe("sendTransaction");
    expect(error.message).toMatch(/Check the explorer before retrying/);
  });
});

describe("parseGetTransactionResponse", () => {
  it.each(["SUCCESS", "FAILED", "NOT_FOUND"])("accepts %s", (status) => {
    expect(parseGetTransactionResponse({ status, txHash: HASH }).status).toBe(status);
  });

  it.each([[{}], [{ status: "success" }], [{ status: "PENDING" }], [{ status: 1 }], [undefined]])(
    "rejects %j",
    (response) => {
      expect(() => parseGetTransactionResponse(response)).toThrow(RpcResponseValidationError);
    },
  );
});

describe("validateJsonRpcResponse", () => {
  it("accepts valid sendTransaction and getTransaction results, ignoring extra fields", () => {
    expect(() =>
      validateJsonRpcResponse("sendTransaction", 1, envelope({ status: "PENDING", hash: HASH, latestLedger: 5, newField: 1 })),
    ).not.toThrow();
    expect(() =>
      validateJsonRpcResponse("sendTransaction", 1, envelope({ status: "ERROR", hash: HASH, errorResultXdr: XDR })),
    ).not.toThrow();
    expect(() =>
      validateJsonRpcResponse("getTransaction", 1, envelope({ status: "FAILED", resultXdr: XDR, latestLedger: 9 })),
    ).not.toThrow();
  });

  it.each([
    ["an empty body", "", "(root)"],
    ["a null body", null, "(root)"],
    ["a non-JSON body", "<html>Bad gateway</html>", "(root)"],
    ["a wrong jsonrpc version", { jsonrpc: "1.0", id: 1, result: { status: "SUCCESS" } }, "jsonrpc"],
    ["a mismatched id", envelope({ status: "SUCCESS" }, 7), "id"],
    ["a null result", envelope(null), "result"],
    ["both result and error", { ...envelope({ status: "SUCCESS" }), error: { code: 1, message: "x" } }, "(root)"],
    ["a malformed error object", { jsonrpc: "2.0", id: 1, error: { message: "no code" } }, "error.code"],
    ["an unknown send status", envelope({ status: "OK", hash: HASH }), "result.status"],
    ["a PENDING send without a hash", envelope({ status: "PENDING" }), "result.hash"],
    ["malformed errorResultXdr", envelope({ status: "ERROR", errorResultXdr: "%%%" }), "result.errorResultXdr"],
  ])("rejects %s", (_label, body, path) => {
    expectInvalid(() => validateJsonRpcResponse("sendTransaction", 1, body), path);
  });

  it("rejects an unknown getTransaction status", () => {
    expectInvalid(() => validateJsonRpcResponse("getTransaction", 1, envelope({ status: "success" })), "result.status");
  });

  it("converts a well-formed JSON-RPC error object into RpcJsonRpcError", () => {
    const error = captureError(() =>
      validateJsonRpcResponse("sendTransaction", 1, {
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32602, message: "invalid transaction\nmore detail" },
      }),
    );
    expect(error).toBeInstanceOf(RpcJsonRpcError);
    expect(error).toMatchObject({ rpcCode: -32602, method: "sendTransaction", message: "invalid transaction" });
  });
});

describe("installRpcResponseValidation on a real rpc.Server", () => {
  function serverRespondingWith(body: unknown, keepId = false): rpc.Server {
    const server = new rpc.Server("https://soroban-testnet.stellar.org");
    expect(installRpcResponseValidation(server)).toBe(true);
    server.httpClient.defaults.adapter = (async (config: { data?: unknown }) => {
      const requestId = JSON.parse(String(config.data)).id;
      const data =
        typeof body === "object" && body !== null && !keepId ? { ...(body as object), id: requestId } : body;
      return { data, status: 200, statusText: "OK", headers: {}, config };
    }) as never;
    return server;
  }

  it("passes a valid getTransaction response to the SDK", async () => {
    const server = serverRespondingWith(
      envelope({ status: "NOT_FOUND", txHash: HASH, latestLedger: 1, latestLedgerCloseTime: 1, oldestLedger: 1, oldestLedgerCloseTime: 1 }),
    );
    await expect(server.getTransaction(HASH)).resolves.toMatchObject({ status: "NOT_FOUND" });
  });

  it("rejects a malformed getTransaction status before the SDK parses it", async () => {
    const server = serverRespondingWith(envelope({ status: "DONE", txHash: HASH }));
    await expect(server.getTransaction(HASH)).rejects.toBeInstanceOf(RpcResponseValidationError);
  });

  it("rejects a non-JSON body with a typed error", async () => {
    const server = serverRespondingWith("<html>oops</html>");
    await expect(server.getTransaction(HASH)).rejects.toBeInstanceOf(RpcResponseValidationError);
  });

  it("rejects a response with a mismatched id", async () => {
    const server = serverRespondingWith(envelope({ status: "NOT_FOUND" }, 99), true);
    await expect(server.getTransaction(HASH)).rejects.toBeInstanceOf(RpcResponseValidationError);
  });

  it("throws RpcJsonRpcError instead of a plain object for JSON-RPC errors", async () => {
    const server = serverRespondingWith({ jsonrpc: "2.0", error: { code: -32601, message: "method not found" } });
    await expect(server.getTransaction(HASH)).rejects.toBeInstanceOf(RpcJsonRpcError);
  });

  it("is idempotent and tolerates test doubles", () => {
    const server = new rpc.Server("https://soroban-testnet.stellar.org");
    installRpcResponseValidation(server);
    const count = server.httpClient.interceptors.response.handlers.filter(Boolean).length;
    installRpcResponseValidation(server);
    expect(server.httpClient.interceptors.response.handlers.filter(Boolean).length).toBe(count);
    expect(installRpcResponseValidation({} as rpc.Server)).toBe(false);
  });
});
