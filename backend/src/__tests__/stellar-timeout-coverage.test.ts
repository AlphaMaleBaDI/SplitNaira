/**
 * Issue #1261: Transaction timeout coverage for external Stellar calls.
 *
 * Verifies that:
 * - Timeouts are correctly classified as `timeout` (not `permanent`/`transient`).
 * - Terminal errors (tx_bad_seq) are classified as `permanent`.
 * - Transient connectivity errors are classified as `transient`.
 * - withStellarTimeoutGuard rolls back cleanly and re-throws on timeout.
 * - DB transactions are NOT left open when a Stellar call times out.
 * - The onTimeout callback fires exactly once on timeout.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  classifyStellarFailure,
  isStellarTimeoutFailure,
  withStellarTimeoutGuard,
} from "../services/stellar-timeout.js";
import { RpcTimeoutError, RpcError } from "../services/stellar.js";

// ── classifyStellarFailure ────────────────────────────────────────────────────

describe("classifyStellarFailure", () => {
  it("classifies RpcTimeoutError as timeout", () => {
    expect(classifyStellarFailure(new RpcTimeoutError())).toBe("timeout");
  });

  it("classifies RpcTimeoutError with custom message as timeout", () => {
    expect(classifyStellarFailure(new RpcTimeoutError("custom message"))).toBe("timeout");
  });

  it("classifies tx_bad_seq as permanent", () => {
    expect(classifyStellarFailure(new Error("tx_bad_seq error"))).toBe("permanent");
  });

  it("classifies tx_bad_auth as permanent", () => {
    expect(classifyStellarFailure(new Error("tx_bad_auth"))).toBe("permanent");
  });

  it("classifies tx_insufficient_balance as permanent", () => {
    expect(classifyStellarFailure(new Error("tx_insufficient_balance"))).toBe("permanent");
  });

  it("classifies tx_failed as permanent", () => {
    expect(classifyStellarFailure(new Error("tx_failed"))).toBe("permanent");
  });

  it("classifies tx_malformed as permanent", () => {
    expect(classifyStellarFailure(new Error("tx_malformed"))).toBe("permanent");
  });

  it("classifies ECONNREFUSED as transient", () => {
    expect(classifyStellarFailure(new Error("ECONNREFUSED at 127.0.0.1"))).toBe("transient");
  });

  it("classifies fetch failed as transient", () => {
    expect(classifyStellarFailure(new Error("fetch failed: unable to connect"))).toBe("transient");
  });

  it("classifies unknown errors as transient (safe default)", () => {
    expect(classifyStellarFailure(new Error("some unknown error"))).toBe("transient");
    expect(classifyStellarFailure(null)).toBe("transient");
    expect(classifyStellarFailure("string error")).toBe("transient");
    expect(classifyStellarFailure(undefined)).toBe("transient");
  });

  it("classifies RpcError (non-timeout) as transient by default", () => {
    // RpcError without timeout message → transient
    expect(classifyStellarFailure(new RpcError("RPC failed", 502))).toBe("transient");
  });
});

// ── isStellarTimeoutFailure ───────────────────────────────────────────────────

describe("isStellarTimeoutFailure", () => {
  it("returns true for RpcTimeoutError", () => {
    expect(isStellarTimeoutFailure(new RpcTimeoutError())).toBe(true);
  });

  it("returns false for plain Error", () => {
    expect(isStellarTimeoutFailure(new Error("timeout"))).toBe(false);
  });

  it("returns false for null", () => {
    expect(isStellarTimeoutFailure(null)).toBe(false);
  });

  it("returns false for RpcError (not timeout subclass)", () => {
    expect(isStellarTimeoutFailure(new RpcError("fail", 502))).toBe(false);
  });
});

// ── withStellarTimeoutGuard ───────────────────────────────────────────────────

describe("withStellarTimeoutGuard", () => {
  it("returns the resolved value on success", async () => {
    const result = await withStellarTimeoutGuard(async () => "ok");
    expect(result).toBe("ok");
  });

  it("re-throws non-timeout errors unchanged", async () => {
    const original = new Error("some rpc error");
    await expect(
      withStellarTimeoutGuard(async () => { throw original; })
    ).rejects.toThrow("some rpc error");
  });

  it("re-throws RpcTimeoutError on timeout", async () => {
    await expect(
      withStellarTimeoutGuard(async () => { throw new RpcTimeoutError(); })
    ).rejects.toBeInstanceOf(RpcTimeoutError);
  });

  it("calls onTimeout callback exactly once when a timeout occurs", async () => {
    const onTimeout = vi.fn();
    await expect(
      withStellarTimeoutGuard(async () => { throw new RpcTimeoutError(); }, onTimeout)
    ).rejects.toBeInstanceOf(RpcTimeoutError);

    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onTimeout.mock.calls[0][0]).toBeInstanceOf(RpcTimeoutError);
  });

  it("does NOT call onTimeout callback for non-timeout errors", async () => {
    const onTimeout = vi.fn();
    await expect(
      withStellarTimeoutGuard(
        async () => { throw new RpcError("rpc error", 502); },
        onTimeout
      )
    ).rejects.toBeInstanceOf(RpcError);

    expect(onTimeout).not.toHaveBeenCalled();
  });

  /**
   * DB transaction not left open on Stellar timeout.
   *
   * Simulates a route handler that:
   * 1. Opens a DB transaction (queryRunner).
   * 2. Calls a Stellar operation via withStellarTimeoutGuard.
   * 3. On timeout, the guard throws; the outer catch rolls back and releases.
   *
   * Verifies that rollbackTransaction() and release() are both called,
   * confirming no connection is held open.
   */
  it("does not leave DB transaction open when Stellar call times out", async () => {
    const rollbackTransaction = vi.fn().mockResolvedValue(undefined);
    const release = vi.fn().mockResolvedValue(undefined);
    const commitTransaction = vi.fn().mockResolvedValue(undefined);

    const fakeQueryRunner = {
      connect: vi.fn().mockResolvedValue(undefined),
      startTransaction: vi.fn().mockResolvedValue(undefined),
      commitTransaction,
      rollbackTransaction,
      release,
    };

    async function simulateRouteHandler() {
      await fakeQueryRunner.connect();
      await fakeQueryRunner.startTransaction();
      try {
        // Stellar call times out inside the DB transaction
        await withStellarTimeoutGuard(async () => {
          throw new RpcTimeoutError("Stellar RPC timed out");
        });
        await fakeQueryRunner.commitTransaction();
      } catch (error) {
        // Route handler rolls back on any error
        await fakeQueryRunner.rollbackTransaction();
        throw error;
      } finally {
        await fakeQueryRunner.release();
      }
    }

    await expect(simulateRouteHandler()).rejects.toBeInstanceOf(RpcTimeoutError);

    // Transaction must be rolled back — never left open
    expect(rollbackTransaction).toHaveBeenCalledTimes(1);
    // Connection must be released back to the pool
    expect(release).toHaveBeenCalledTimes(1);
    // Commit must NOT have been called
    expect(commitTransaction).not.toHaveBeenCalled();
  });

  it("resolves correctly even after a previous timeout in the same test", async () => {
    // Ensure no state leaks between guard invocations
    const guard1 = withStellarTimeoutGuard(async () => { throw new RpcTimeoutError(); });
    await expect(guard1).rejects.toBeInstanceOf(RpcTimeoutError);

    const guard2 = withStellarTimeoutGuard(async () => 42);
    await expect(guard2).resolves.toBe(42);
  });
});

// ── executeWithRetry timeout classification (integration) ─────────────────────

describe("executeWithRetry timeout semantics", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("throws RpcTimeoutError when the operation exceeds timeoutMs", async () => {
    const { executeWithRetry } = await import("../services/stellar.js");

    const slowOp = () => new Promise<never>((_, reject) => {
      // This will never resolve, simulating an infinite hang
      setTimeout(() => reject(new Error("should not reach")), 999_999);
    });

    const promise = executeWithRetry(slowOp, {
      maxRetries: 0,
      timeoutMs: 100,
      operation: "test_timeout_op",
    });

    // Advance past the timeout
    vi.advanceTimersByTime(200);

    await expect(promise).rejects.toBeInstanceOf(RpcTimeoutError);

    vi.useRealTimers();
  });
});
