/**
 * Duplicate-submission helpers for payment and split actions (#1266).
 *
 * Three ideas:
 *  - An idempotency key per logical create attempt, reused for retries of the
 *    same payload and rotated when the payload changes or the attempt
 *    succeeds. The backend replays the original response for a reused key.
 *  - A distinction between definitive failures (safe to re-enable the
 *    action) and unconfirmed submissions (the transaction reached the network
 *    but its outcome is unknown, so retrying could pay twice).
 *  - A way to resolve an unconfirmed submission by asking the RPC, or by
 *    waiting out the transaction's validity window.
 */

/** Built transactions are valid for 300s (`setTimeout(300)` in the backend's transaction builders). */
export const TX_VALIDITY_WINDOW_MS = 300_000;
/** Extra margin for clock skew and ledger close time before treating a missing transaction as expired. */
export const TX_EXPIRY_MARGIN_MS = 60_000;

export function createIdempotencyKey(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  return `idem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Hands out the same idempotency key for the same payload until `reset()`.
 * Matches the backend's comparison: object key order doesn't matter, and
 * any other difference counts as a new request with a new key.
 */
export class IdempotencyKeyStore {
  private current: { fingerprint: string; key: string } | null = null;

  constructor(private readonly generate: () => string = createIdempotencyKey) {}

  keyFor(payload: unknown): string {
    const fingerprint = stableStringify(payload);
    if (this.current?.fingerprint !== fingerprint) {
      this.current = { fingerprint, key: this.generate() };
    }
    return this.current.key;
  }

  /** Call after the attempt succeeds (or after a 409 conflict) so the next attempt gets a new key. */
  reset(): void {
    this.current = null;
  }
}

/**
 * True when a transaction was submitted but not confirmed in time
 * (`submitSorobanTransactionAndPoll` throws a `TimeoutError`). The outcome is
 * unknown, so the action must not be re-enabled blindly.
 */
export function isUnconfirmedSubmission(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

/** True for the backend's 409 when a retry reused a key with a different payload. */
export function isIdempotencyConflict(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code.toLowerCase() === "idempotency_key_conflict";
}

export interface UnconfirmedSubmission {
  hash: string;
  /** Epoch ms when the transaction was submitted. */
  submittedAt: number;
}

export type UnconfirmedResolution = "succeeded" | "failed" | "expired" | "pending";

interface TransactionStatusSource {
  getTransaction(hash: string): Promise<{ status: string }>;
}

/**
 * Asks the RPC what happened to an unconfirmed transaction.
 *  - `succeeded`/`failed`: definitive ledger outcome.
 *  - `expired`: still not found after the validity window, so it can never
 *    land and the action is safe to retry.
 *  - `pending`: not found yet but could still land. Keep the action blocked.
 * RPC errors count as `pending`: not knowing is not a reason to unblock.
 */
export async function resolveUnconfirmedSubmission(
  server: TransactionStatusSource,
  submission: UnconfirmedSubmission,
  now: number = Date.now(),
): Promise<UnconfirmedResolution> {
  let status: string;
  try {
    status = (await server.getTransaction(submission.hash)).status;
  } catch {
    return "pending";
  }
  if (status === "SUCCESS") return "succeeded";
  if (status === "FAILED") return "failed";
  if (now - submission.submittedAt >= TX_VALIDITY_WINDOW_MS + TX_EXPIRY_MARGIN_MS) return "expired";
  return "pending";
}
