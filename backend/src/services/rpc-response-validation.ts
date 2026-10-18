import { scValToNative, type rpc, type xdr } from "@stellar/stellar-sdk";
import type { z } from "zod";

import {
  RpcJsonRpcError,
  RpcResponseValidationError,
  type RpcResponseIssue
} from "../lib/errors.js";
import {
  jsonRpcEnvelopeSchema,
  jsonRpcErrorObjectSchema,
  rawRpcResultSchemas
} from "../schemas/stellar-rpc.schemas.js";
import { logger } from "./logger.js";

/**
 * Issue #1494: validation of external Soroban RPC responses.
 *
 * - `installRpcResponseValidation` checks every raw JSON-RPC response on the
 *   SDK's HTTP client (envelope + per-method wire schema) before the SDK
 *   parses it.
 * - `parseRpcResponse`, `readSimulationRetval` and `decodeContractValue` check
 *   SDK-parsed responses and decoded contract values at the call site.
 *
 * Every failure is a `RpcResponseValidationError` (HTTP 502). Logs carry the
 * RPC method and failing field paths only, never the payload.
 */

const MAX_REPORTED_ISSUES = 10;
const ROOT_PATH = "(root)";

type IssuePath = readonly PropertyKey[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatPath(path: IssuePath): string {
  return path.length > 0 ? path.map(String).join(".") : ROOT_PATH;
}

function flattenIssues(issues: readonly z.core.$ZodIssue[], base: IssuePath = []): RpcResponseIssue[] {
  const flattened: RpcResponseIssue[] = [];
  for (const issue of issues) {
    const path = [...base, ...issue.path];
    if (issue.code === "invalid_union" && issue.errors.length > 0) {
      // Report the variant that came closest to matching instead of a bare
      // "invalid input" at the union's root.
      const closest = issue.errors.reduce((best, branch) => (branch.length < best.length ? branch : best));
      flattened.push(...flattenIssues(closest, path));
      continue;
    }
    flattened.push({ path: formatPath(path), message: issue.message });
  }
  return flattened;
}

/** Builds (and logs) the typed error for a response that failed validation. */
export function rpcResponseValidationError(
  method: string,
  issues: RpcResponseIssue[]
): RpcResponseValidationError {
  const reported = issues.slice(0, MAX_REPORTED_ISSUES);
  logger.warn("Stellar RPC response failed validation", { method, issues: reported });
  return new RpcResponseValidationError(method, reported);
}

function validateWith<S extends z.ZodType>(
  method: string,
  schema: S,
  payload: unknown,
  basePath: IssuePath
): z.output<S> {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw rpcResponseValidationError(method, flattenIssues(parsed.error.issues, basePath));
  }
  return parsed.data;
}

/**
 * Validates an SDK-parsed RPC response (or any value read from one) and
 * returns the typed result. Unknown extra fields are stripped, not rejected.
 *
 * @throws RpcResponseValidationError
 */
export function parseRpcResponse<S extends z.ZodType>(
  method: string,
  schema: S,
  payload: unknown
): z.output<S> {
  return validateWith(method, schema, payload, []);
}

/**
 * Decodes a contract value (`xdr.ScVal`) with `scValToNative` and validates
 * the native result, e.g. a stroop amount into an exact `bigint`.
 *
 * @throws RpcResponseValidationError when the value cannot be decoded or does
 *   not match `schema`.
 */
export function decodeContractValue<S extends z.ZodType>(
  method: string,
  schema: S,
  scVal: unknown
): z.output<S> {
  let native: unknown;
  try {
    native = scValToNative(scVal as xdr.ScVal);
  } catch {
    throw rpcResponseValidationError(method, [{ path: ROOT_PATH, message: "could not be decoded" }]);
  }
  return parseRpcResponse(method, schema, native);
}

/**
 * Returns the contract return value of a parsed `simulateTransaction`
 * response for a read-only contract call.
 *
 * - Well-formed simulation failure (`error` is a non-empty string): returns
 *   `undefined`, so callers keep their existing handling for that case.
 * - Success with a `result.retval`: returns it.
 * - Anything else, including a "success" with no result: throws. Callers
 *   must never fall back to a default value for a response they can't read.
 *
 * @throws RpcResponseValidationError
 */
export function readSimulationRetval(contractMethod: string, simulated: unknown): xdr.ScVal | undefined {
  const method = `simulateTransaction:${contractMethod}`;
  if (!isRecord(simulated)) {
    throw rpcResponseValidationError(method, [{ path: ROOT_PATH, message: "expected an object" }]);
  }

  if (simulated.error !== undefined) {
    if (typeof simulated.error === "string" && simulated.error.length > 0) {
      return undefined;
    }
    throw rpcResponseValidationError(method, [{ path: "error", message: "must be a non-empty string" }]);
  }

  const result = simulated.result;
  if (!isRecord(result) || result.retval === undefined) {
    throw rpcResponseValidationError(method, [
      { path: "result.retval", message: "is required for a successful contract call" }
    ]);
  }
  return result.retval as xdr.ScVal;
}

function sanitizeUpstreamMessage(message: string): string {
  const firstLine = message.split("\n")[0]?.trim() ?? "";
  return (
    firstLine
      // Long base64 runs are echoed XDR, never something an operator needs.
      .replace(/[A-Za-z0-9+/]{64,}={0,2}/g, "[REDACTED_XDR]")
      .slice(0, 512) || "Soroban RPC returned an error."
  );
}

/**
 * Validates a raw JSON-RPC 2.0 response body for `method`.
 *
 * - Empty, non-JSON or non-object bodies are rejected.
 * - `jsonrpc` must be `"2.0"` and `id` must echo the request id.
 * - Exactly one of `result` / `error` must be present.
 * - A well-formed `error` object becomes a `RpcJsonRpcError`; a malformed
 *   one is a validation error.
 * - `result` must not be null and must match the method's wire schema when
 *   one is registered in `rawRpcResultSchemas`.
 *
 * @throws RpcResponseValidationError | RpcJsonRpcError
 */
export function validateJsonRpcResponse(method: string, requestId: unknown, body: unknown): void {
  if (!isRecord(body)) {
    const empty = body === undefined || body === null || body === "";
    throw rpcResponseValidationError(method, [
      { path: ROOT_PATH, message: empty ? "response body is empty" : "response body is not a JSON object" }
    ]);
  }

  validateWith(method, jsonRpcEnvelopeSchema, body, []);
  if (body.id !== requestId) {
    throw rpcResponseValidationError(method, [{ path: "id", message: "does not match the request id" }]);
  }

  const hasError = Object.hasOwn(body, "error");
  const hasResult = Object.hasOwn(body, "result");
  if (hasError && hasResult) {
    throw rpcResponseValidationError(method, [
      { path: ROOT_PATH, message: "must contain exactly one of result or error" }
    ]);
  }

  if (hasError) {
    const rpcError = validateWith(method, jsonRpcErrorObjectSchema, body.error, ["error"]);
    throw new RpcJsonRpcError(method, rpcError.code, sanitizeUpstreamMessage(rpcError.message));
  }

  if (!hasResult || body.result === null || body.result === undefined) {
    throw rpcResponseValidationError(method, [{ path: "result", message: "is missing or null" }]);
  }

  const resultSchema = rawRpcResultSchemas[method];
  if (resultSchema) {
    validateWith(method, resultSchema, body.result, ["result"]);
  }
}

function readJsonRpcRequest(data: unknown): { method: string; id: unknown } | null {
  let body = data;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      return null;
    }
  }
  if (!isRecord(body) || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return null;
  }
  return { method: body.method, id: body.id };
}

const instrumentedClients = new WeakSet<object>();

/**
 * Registers a response interceptor on the SDK server's HTTP client so every
 * JSON-RPC response is validated before the SDK parses it. Non-JSON-RPC
 * requests made through the same client pass through untouched. Idempotent.
 *
 * Returns false when the server has no interceptable HTTP client (only the
 * case for test doubles; the real `rpc.Server` always has one).
 */
export function installRpcResponseValidation(server: Pick<rpc.Server, "httpClient">): boolean {
  const client = server.httpClient;
  if (!client?.interceptors?.response) {
    return false;
  }
  if (instrumentedClients.has(client)) {
    return true;
  }

  client.interceptors.response.use((response) => {
    const request = readJsonRpcRequest(response.config?.data);
    if (request) {
      validateJsonRpcResponse(request.method, request.id, response.data);
    }
    return response;
  });
  instrumentedClients.add(client);
  return true;
}
