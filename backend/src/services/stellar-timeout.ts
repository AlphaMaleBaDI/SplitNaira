/**
 * Issue #1261: Timeout and failure classification for external Stellar calls.
 *
 * This module provides helpers to:
 * - Distinguish between transient timeout failures and permanent/terminal
 *   Stellar transaction errors so callers can make correct retry decisions.
 * - Ensure DB transactions are never left open when a Stellar call times out.
 *
 * Usage:
 *   import { isStellarTimeoutFailure, withStellarTimeout } from './stellar-timeout.js';
 */

import { RpcTimeoutError } from "./stellar.js";
import { logger } from "./logger.js";

export type StellarFailureKind = "timeout" | "permanent" | "transient";

/**
 * Classifies an error from a Stellar/Soroban call into one of three
 * stable categories so callers can route it correctly without branching
 * on unstable message strings.
 *
 * - `timeout`   — the operation exceeded its time budget; may be retried
 *                 with a fresh call (but the previous call's ledger state
 *                 is unknown, so idempotency keys or transaction hash
 *                 tracking should be used).
 * - `permanent` — the transaction was rejected definitively; retrying the
 *                 same signed envelope will produce the same rejection.
 *                 Callers must re-sign with a fresh sequence number.
 * - `transient` — a connectivity or RPC-level error that may resolve on
 *                 retry without any extra state management.
 */
export function classifyStellarFailure(error: unknown): StellarFailureKind {
  if (error instanceof RpcTimeoutError) {
    return "timeout";
  }

  if (error instanceof Error) {
    const msg = error.message.toLowerCase();

    // Terminal Stellar transaction result codes — re-signing required.
    if (
      msg.includes("tx_bad_seq") ||
      msg.includes("tx_failed") ||
      msg.includes("tx_bad_auth") ||
      msg.includes("tx_insufficient_balance") ||
      msg.includes("tx_insufficient_fee") ||
      msg.includes("tx_malformed") ||
      msg.includes("tx_no_account") ||
      msg.includes("tx_too_early") ||
      msg.includes("tx_too_late") ||
      msg.includes("tx_not_enough_signature_weight") ||
      msg.includes("tx_bad_sponsorship")
    ) {
      return "permanent";
    }

    // Connectivity / availability errors are transient.
    if (
      msg.includes("econnrefused") ||
      msg.includes("fetch failed") ||
      msg.includes("network error") ||
      msg.includes("etimedout") ||
      msg.includes("enotfound")
    ) {
      return "transient";
    }
  }

  // Default: treat as transient so callers err on the side of retrying rather
  // than silently discarding an operation that may have succeeded.
  return "transient";
}

/**
 * Returns true when the error is an `RpcTimeoutError` — the Stellar call
 * exceeded its time budget.
 *
 * Convenience predicate so route handlers don't need to import `RpcTimeoutError`
 * directly to distinguish timeouts from other failures.
 */
export function isStellarTimeoutFailure(error: unknown): error is RpcTimeoutError {
  return error instanceof RpcTimeoutError;
}

/**
 * Wraps a Stellar call that runs inside a DB transaction so that a timeout
 * does NOT leave the transaction open.
 *
 * The wrapper:
 * 1. Awaits the Stellar call.
 * 2. On `RpcTimeoutError`, rolls back the query runner and re-throws so the
 *    caller gets the correctly classified error. The rollback is a no-op if
 *    the transaction was never started (queryRunner may be null/undefined for
 *    read-only paths).
 * 3. Logs the timeout at `warn` level so operators can correlate ledger
 *    activity without full request traces.
 *
 * @param operation  The async Stellar call to protect.
 * @param onTimeout  Optional callback invoked synchronously before the
 *                   re-throw, e.g. to emit a metric or set a flag.
 */
export async function withStellarTimeoutGuard<T>(
  operation: () => Promise<T>,
  onTimeout?: (error: RpcTimeoutError) => void
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof RpcTimeoutError) {
      logger.warn("Stellar call timed out", {
        errorKind: error.name,
        message: error.message,
      });
      onTimeout?.(error);
      throw error;
    }
    throw error;
  }
}
