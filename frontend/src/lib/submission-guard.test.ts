import { describe, expect, it, vi } from "vitest";

import {
  IdempotencyKeyStore,
  TX_EXPIRY_MARGIN_MS,
  TX_VALIDITY_WINDOW_MS,
  createIdempotencyKey,
  isIdempotencyConflict,
  isUnconfirmedSubmission,
  resolveUnconfirmedSubmission,
} from "./submission-guard";

describe("createIdempotencyKey (#1266)", () => {
  it("returns a fresh key on every call", () => {
    const keys = new Set(Array.from({ length: 20 }, () => createIdempotencyKey()));
    expect(keys.size).toBe(20);
  });

  it("produces keys the backend accepts (1-255 chars of [A-Za-z0-9_.:-])", () => {
    expect(createIdempotencyKey()).toMatch(/^[A-Za-z0-9_.:-]{1,255}$/);
  });
});

describe("IdempotencyKeyStore (#1266)", () => {
  const payload = { projectId: "p1", collaborators: [{ address: "GA", basisPoints: 5000 }] };

  function storeWithCounter() {
    let n = 0;
    return new IdempotencyKeyStore(() => `key-${++n}`);
  }

  it("reuses the key for retries of the same payload", () => {
    const store = storeWithCounter();
    expect(store.keyFor(payload)).toBe("key-1");
    expect(store.keyFor({ ...payload })).toBe("key-1");
  });

  it("ignores object key order and undefined fields, like the backend", () => {
    const store = storeWithCounter();
    store.keyFor({ a: 1, b: { x: 1, y: 2 }, c: undefined });
    expect(store.keyFor({ b: { y: 2, x: 1 }, a: 1 })).toBe("key-1");
  });

  it("issues a new key when the payload changes", () => {
    const store = storeWithCounter();
    store.keyFor(payload);
    expect(store.keyFor({ ...payload, projectId: "p2" })).toBe("key-2");
    // Array order matters.
    expect(store.keyFor({ list: [1, 2] })).toBe("key-3");
    expect(store.keyFor({ list: [2, 1] })).toBe("key-4");
  });

  it("issues a new key for the same payload after reset()", () => {
    const store = storeWithCounter();
    store.keyFor(payload);
    store.reset();
    expect(store.keyFor(payload)).toBe("key-2");
  });
});

describe("error classification (#1266)", () => {
  it("treats a poll TimeoutError as unconfirmed, not a definitive failure", () => {
    const timeout = Object.assign(new Error("not confirmed in time"), { name: "TimeoutError" });
    expect(isUnconfirmedSubmission(timeout)).toBe(true);
    expect(isUnconfirmedSubmission(new Error("Transaction failed on ledger"))).toBe(false);
    expect(isUnconfirmedSubmission("TimeoutError")).toBe(false);
  });

  it("recognizes the backend's idempotency conflict code in either casing", () => {
    expect(isIdempotencyConflict({ code: "idempotency_key_conflict" })).toBe(true);
    expect(isIdempotencyConflict({ code: "IDEMPOTENCY_KEY_CONFLICT" })).toBe(true);
    expect(isIdempotencyConflict({ code: "idempotency_key_in_progress" })).toBe(false);
    expect(isIdempotencyConflict(null)).toBe(false);
  });
});

describe("resolveUnconfirmedSubmission (#1266)", () => {
  const submission = { hash: "HASH", submittedAt: 1_000 };
  const expiresAt = submission.submittedAt + TX_VALIDITY_WINDOW_MS + TX_EXPIRY_MARGIN_MS;
  const serverReturning = (status: string) => ({ getTransaction: vi.fn().mockResolvedValue({ status }) });

  it("reports a definitive success or failure from the ledger", async () => {
    expect(await resolveUnconfirmedSubmission(serverReturning("SUCCESS"), submission, 2_000)).toBe("succeeded");
    expect(await resolveUnconfirmedSubmission(serverReturning("FAILED"), submission, 2_000)).toBe("failed");
  });

  it("stays pending while a missing transaction could still land", async () => {
    expect(await resolveUnconfirmedSubmission(serverReturning("NOT_FOUND"), submission, expiresAt - 1)).toBe(
      "pending",
    );
  });

  it("reports expired once a missing transaction is past its validity window", async () => {
    expect(await resolveUnconfirmedSubmission(serverReturning("NOT_FOUND"), submission, expiresAt)).toBe(
      "expired",
    );
  });

  it("stays pending when the RPC call itself fails", async () => {
    const server = { getTransaction: vi.fn().mockRejectedValue(new Error("rpc down")) };
    expect(await resolveUnconfirmedSubmission(server, submission, expiresAt + 10_000)).toBe("pending");
  });
});
