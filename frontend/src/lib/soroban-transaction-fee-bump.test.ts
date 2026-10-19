/**
 * Issue #1496: fee-bump submission behaviour.
 *
 * `sendSorobanTransaction` and `submitSorobanTransactionAndPoll` both accept a
 * `FeeBumpTransaction`, but the existing suite only ever built a plain
 * `Transaction`. A fee bump is a different envelope — its hash covers the
 * inner transaction *and* the fee bump operation, and the envelope can be
 * rejected for reasons the inner transaction never sees — so "the shared code
 * path is the same" is an assumption, not a guarantee.
 *
 * These tests pin the fee-bump paths, and in particular that the hash the UI
 * blocks on is the hash of the *envelope* actually submitted. Tracking the
 * inner hash instead would let the UI unblock on a transaction that was never
 * accepted, which is the failure mode Issue #1494 exists to prevent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Account, Networks, Operation, TransactionBuilder, type rpc } from "@stellar/stellar-sdk";

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn(), init: vi.fn() }));

import * as Sentry from "@sentry/nextjs";
import { sendSorobanTransaction, submitSorobanTransactionAndPoll } from "./soroban-transaction";
import { RpcResponseValidationError } from "./stellar-rpc-validation";
import { isUnconfirmedSubmission } from "./submission-guard";

const HASH = "ab".repeat(32);
const SOURCE = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const FEE_SOURCE = "GBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function innerTransaction() {
  return new TransactionBuilder(new Account(SOURCE, "1"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.bumpSequence({ bumpTo: "2" }))
    .setTimeout(30)
    .build();
}

/** A well-formed fee-bump envelope wrapping `innerTransaction()`. */
function feeBumpTransaction() {
  return TransactionBuilder.buildFeeBumpTransaction(
    new Account(FEE_SOURCE, "1"),
    "200",
    innerTransaction(),
  );
}

function server(send: unknown, poll?: unknown) {
  return {
    sendTransaction: vi.fn().mockResolvedValue(send),
    pollTransaction: vi.fn().mockResolvedValue(poll),
  } as unknown as rpc.Server & {
    sendTransaction: ReturnType<typeof vi.fn>;
    pollTransaction: ReturnType<typeof vi.fn>;
  };
}

/** An envelope whose `hash()` throws, standing in for a structurally invalid one. */
function unhashedTransaction() {
  return { hash: () => { throw new Error("cannot hash"); } };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("fee-bump submission", () => {
  it("builds an envelope distinct from the transaction it wraps", () => {
    // If these ever matched, the hash-tracking tests below would be vacuous.
    const inner = innerTransaction();
    const bump = feeBumpTransaction();

    expect(bump.hash().toString("hex")).not.toBe(inner.hash().toString("hex"));
    expect(bump.toXDR()).not.toBe(inner.toXDR());
  });

  it.each(["PENDING", "DUPLICATE"])("resolves with the hash for an accepted %s fee bump", async (status) => {
    await expect(sendSorobanTransaction(server({ status, hash: HASH }), feeBumpTransaction())).resolves.toEqual({
      hash: HASH,
    });
  });

  it("submits the fee-bump envelope itself, not the inner transaction", async () => {
    const bump = feeBumpTransaction();
    const rpc = server({ status: "PENDING", hash: HASH });

    await sendSorobanTransaction(rpc, bump);

    expect(rpc.sendTransaction).toHaveBeenCalledTimes(1);
    expect(rpc.sendTransaction.mock.calls[0][0]).toBe(bump);
  });

  it("rejects a fee bump the network refuses", async () => {
    await expect(
      sendSorobanTransaction(
        server({ status: "ERROR", hash: HASH, errorResult: "tx_insufficient_fee" }),
        feeBumpTransaction(),
      ),
    ).rejects.toThrow();
  });

  it("reports a fee bump the network defers instead of calling it accepted", async () => {
    await expect(
      sendSorobanTransaction(server({ status: "TRY_AGAIN_LATER", hash: HASH }), feeBumpTransaction()),
    ).rejects.toThrow(/busy/);
  });
});

describe("fee-bump polling", () => {
  it("resolves once the envelope reaches a terminal success", async () => {
    await expect(
      submitSorobanTransactionAndPoll(
        server({ status: "PENDING", hash: HASH }, { status: "SUCCESS" }),
        feeBumpTransaction(),
      ),
    ).resolves.toEqual({ hash: HASH });
  });

  it("polls the hash the RPC returned, not the locally computed envelope hash", async () => {
    // The two disagree on purpose. Polling the local hash would confirm a
    // transaction the RPC never accepted.
    const rpc = server({ status: "PENDING", hash: HASH }, { status: "SUCCESS" });
    const bump = feeBumpTransaction();

    await submitSorobanTransactionAndPoll(rpc, bump);

    expect(rpc.pollTransaction).toHaveBeenCalledWith(HASH, expect.anything());
    expect(rpc.pollTransaction).not.toHaveBeenCalledWith(
      bump.hash().toString("hex"),
      expect.anything(),
    );
  });

  it("reports the local envelope hash as soon as the RPC accepts", async () => {
    const afterSubmitted = vi.fn();
    const bump = feeBumpTransaction();
    const localHash = bump.hash().toString("hex");

    await submitSorobanTransactionAndPoll(
      server({ status: "PENDING", hash: HASH }, { status: "SUCCESS" }),
      bump,
      { afterSubmitted },
    );

    expect(afterSubmitted).toHaveBeenCalledWith(HASH);
    expect(afterSubmitted).toHaveBeenCalledTimes(1);
    expect(localHash).not.toBe(HASH);
  });

  it("surfaces a ledger failure for a fee bump as a failure, never success", async () => {
    await expect(
      submitSorobanTransactionAndPoll(
        server({ status: "PENDING", hash: HASH }, { status: "FAILED" }),
        feeBumpTransaction(),
      ),
    ).rejects.toThrow();
  });

  it("treats an unconfirmed fee bump as unconfirmed rather than failed", async () => {
    const promise = submitSorobanTransactionAndPoll(
      server({ status: "PENDING", hash: HASH }, { status: "NOT_FOUND" }),
      feeBumpTransaction(),
    );

    await expect(promise).rejects.toThrow();
    await promise.catch((error: unknown) => {
      expect(isUnconfirmedSubmission(error)).toBe(true);
    });
  });
});

describe("malformed fee bumps", () => {
  it.each([
    ["a missing status", { hash: HASH }],
    ["an unknown status", { status: "SUCCESS", hash: HASH }],
    ["a PENDING response without a hash", { status: "PENDING" }],
    ["a malformed hash", { status: "PENDING", hash: "NOT_A_HASH" }],
    ["an empty response", undefined],
  ])("rejects a fee bump whose send response has %s", async (_label, response) => {
    await expect(sendSorobanTransaction(server(response), feeBumpTransaction())).rejects.toBeInstanceOf(
      RpcResponseValidationError,
    );
  });

  it("keeps the action blocked when the malformed response arrives for a fee bump", async () => {
    // The envelope may have reached the network, so the fee-bump hash is
    // reported through afterSubmitted even though the response is unusable.
    // Built once: `setTimeout(30)` makes a time-bounds envelope unique per
    // call, so a second feeBumpTransaction() would not hash to the same value.
    const afterSubmitted = vi.fn();
    const bump = feeBumpTransaction();

    await expect(
      submitSorobanTransactionAndPoll(server({ status: "PENDING" }), bump, { afterSubmitted }),
    ).rejects.toBeInstanceOf(RpcResponseValidationError);

    expect(afterSubmitted).toHaveBeenCalledWith(bump.hash().toString("hex"));
  });

  it("rejects an envelope whose hash cannot be computed, without claiming it was sent", async () => {
    // No local hash means nothing can be tracked, so nothing is claimed as
    // submitted. Reporting success here would invite a duplicate fee bump.
    const afterSubmitted = vi.fn();

    await expect(
      submitSorobanTransactionAndPoll(server({ status: "PENDING" }), unhashedTransaction(), { afterSubmitted }),
    ).rejects.toBeInstanceOf(RpcResponseValidationError);

    expect(afterSubmitted).not.toHaveBeenCalled();
  });

  it("reports a malformed fee-bump response to error tracking with the envelope hash", async () => {
    const bump = feeBumpTransaction();

    await sendSorobanTransaction(server({ status: "PENDING" }), bump).catch(() => {});

    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.any(RpcResponseValidationError),
      expect.objectContaining({
        extra: expect.objectContaining({ txHash: bump.hash().toString("hex") }),
      }),
    );
  });
});