import type { rpc } from "@stellar/stellar-sdk";
import { z } from "zod";

/**
 * Issue #1494: schema validation for Soroban RPC responses used by the
 * frontend (`sendTransaction`, `getTransaction` / `pollTransaction`).
 *
 * Mirrors backend/src/schemas/stellar-rpc.schemas.ts and
 * backend/src/services/rpc-response-validation.ts:
 *  1. `installRpcResponseValidation` checks every raw JSON-RPC response on
 *     the SDK's HTTP client (envelope + per-method wire schema) before the
 *     SDK parses it.
 *  2. `parseSendTransactionResponse` / `parseGetTransactionResponse` check the
 *     SDK-parsed response where it is used.
 *
 * Only fields the app (or the SDK parser) reads are validated; unknown extra
 * fields are ignored. A missing, unknown or malformed status is never a
 * success. See docs/stellar-rpc-response-validation.md.
 */

export interface RpcResponseIssue {
  path: string;
  message: string;
}

/** A Soroban RPC response did not match its schema. Carries no payload values. */
export class RpcResponseValidationError extends Error {
  constructor(
    public readonly method: string,
    public readonly issues: RpcResponseIssue[],
  ) {
    super(
      `The Stellar network returned an unexpected response (${method}). ` +
        "Check the explorer before retrying.",
    );
    this.name = "RpcResponseValidationError";
  }
}

/** A well-formed JSON-RPC `error` object, which the SDK would otherwise throw as a plain object. */
export class RpcJsonRpcError extends Error {
  constructor(
    public readonly method: string,
    public readonly rpcCode: number,
    message: string,
  ) {
    super(message);
    this.name = "RpcJsonRpcError";
  }
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const txHashSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, "must be a 64-character hex transaction hash");

const base64XdrSchema = z
  .string()
  .min(1, "must not be empty")
  .regex(/^[A-Za-z0-9+/]+={0,2}$/, "must be base64-encoded XDR")
  .refine((value) => value.length % 4 === 0, "must be base64-encoded XDR");

const jsonRpcEnvelopeSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]),
});

const jsonRpcErrorObjectSchema = z.object({
  code: z.number().int(),
  message: z.string(),
});

export const SEND_TRANSACTION_STATUSES = ["PENDING", "DUPLICATE", "TRY_AGAIN_LATER", "ERROR"] as const;
export const GET_TRANSACTION_STATUSES = ["SUCCESS", "FAILED", "NOT_FOUND"] as const;

const sendStatusSchema = z.enum(SEND_TRANSACTION_STATUSES);
const getStatusSchema = z.enum(GET_TRANSACTION_STATUSES);

// The network accepted the transaction, so the hash is what we track it by.
const acceptedSendStatuses = new Set<string>(["PENDING", "DUPLICATE"]);

export const rawSendTransactionResultSchema = z
  .object({
    status: sendStatusSchema,
    hash: z.string().optional(),
    errorResultXdr: base64XdrSchema.optional(),
    diagnosticEventsXdr: z.array(base64XdrSchema).optional(),
  })
  .superRefine((result, ctx) => {
    if (acceptedSendStatuses.has(result.status) && !txHashSchema.safeParse(result.hash).success) {
      ctx.addIssue({ code: "custom", path: ["hash"], message: "must be a 64-character hex transaction hash" });
    }
  });

export const rawGetTransactionResultSchema = z.object({
  status: getStatusSchema,
  resultXdr: base64XdrSchema.optional(),
});

const rawRpcResultSchemas: Readonly<Record<string, z.ZodType>> = {
  sendTransaction: rawSendTransactionResultSchema,
  getTransaction: rawGetTransactionResultSchema,
};

/** SDK-parsed `sendTransaction` response (XDR fields are already decoded). */
export const sendTransactionResponseSchema = z
  .object({
    status: sendStatusSchema,
    hash: z.string().optional(),
    errorResult: z.unknown().optional(),
  })
  .superRefine((result, ctx) => {
    if (acceptedSendStatuses.has(result.status) && !txHashSchema.safeParse(result.hash).success) {
      ctx.addIssue({ code: "custom", path: ["hash"], message: "must be a 64-character hex transaction hash" });
    }
  });

/** SDK-parsed `getTransaction` / `pollTransaction` response. */
export const getTransactionResponseSchema = z.object({
  status: getStatusSchema,
  resultXdr: z.unknown().optional(),
});

export type ValidatedSendTransactionResponse = z.infer<typeof sendTransactionResponseSchema>;
export type ValidatedGetTransactionResponse = z.infer<typeof getTransactionResponseSchema>;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toIssues(error: z.ZodError, basePath: readonly PropertyKey[]): RpcResponseIssue[] {
  return error.issues.slice(0, 10).map((issue) => {
    const path = [...basePath, ...issue.path];
    return { path: path.length > 0 ? path.map(String).join(".") : "(root)", message: issue.message };
  });
}

function validateWith<S extends z.ZodType>(
  method: string,
  schema: S,
  payload: unknown,
  basePath: readonly PropertyKey[] = [],
): z.output<S> {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new RpcResponseValidationError(method, toIssues(parsed.error, basePath));
  }
  return parsed.data;
}

/** @throws RpcResponseValidationError */
export function parseSendTransactionResponse(response: unknown): ValidatedSendTransactionResponse {
  return validateWith("sendTransaction", sendTransactionResponseSchema, response);
}

/** @throws RpcResponseValidationError */
export function parseGetTransactionResponse(response: unknown): ValidatedGetTransactionResponse {
  return validateWith("getTransaction", getTransactionResponseSchema, response);
}

/**
 * Validates a raw JSON-RPC 2.0 response body for `method`: JSON object body,
 * `jsonrpc: "2.0"`, matching `id`, exactly one of `result`/`error`, non-null
 * `result` matching the method's wire schema. A well-formed `error` object
 * becomes an `RpcJsonRpcError`.
 *
 * @throws RpcResponseValidationError | RpcJsonRpcError
 */
export function validateJsonRpcResponse(method: string, requestId: unknown, body: unknown): void {
  if (!isRecord(body)) {
    const empty = body === undefined || body === null || body === "";
    throw new RpcResponseValidationError(method, [
      { path: "(root)", message: empty ? "response body is empty" : "response body is not a JSON object" },
    ]);
  }

  validateWith(method, jsonRpcEnvelopeSchema, body);
  if (body.id !== requestId) {
    throw new RpcResponseValidationError(method, [{ path: "id", message: "does not match the request id" }]);
  }

  const hasError = Object.hasOwn(body, "error");
  const hasResult = Object.hasOwn(body, "result");
  if (hasError && hasResult) {
    throw new RpcResponseValidationError(method, [
      { path: "(root)", message: "must contain exactly one of result or error" },
    ]);
  }

  if (hasError) {
    const rpcError = validateWith(method, jsonRpcErrorObjectSchema, body.error, ["error"]);
    const message = rpcError.message.split("\n")[0]?.trim().slice(0, 512) || "Soroban RPC returned an error.";
    throw new RpcJsonRpcError(method, rpcError.code, message);
  }

  if (!hasResult || body.result === null || body.result === undefined) {
    throw new RpcResponseValidationError(method, [{ path: "result", message: "is missing or null" }]);
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
 * Validates every JSON-RPC response on the server's HTTP client before the
 * SDK parses it. Non-JSON-RPC requests pass through. Idempotent. Returns
 * false for test doubles without an HTTP client.
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
