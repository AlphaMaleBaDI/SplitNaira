import { describe, expect, it } from "vitest";
import {
  evaluateLedgerBalance,
  totalCompletedAmount,
  type InvariantViolation,
} from "./ledger-invariants.js";
import type { TransactionRecord } from "../entities/Transaction.js";
import type { LedgerBlock } from "../entities/LedgerBlock.js";

/**
 * Ledger entry balancing invariants (#1475).
 *
 * Every test drives `evaluateLedgerBalance` with in-memory rows (same
 * mocked-row style as scripts/check-orphaned-transactions.test.ts) across
 * the success, failure and boundary cases for each invariant.
 */

const RECIPIENT_A = "GA111111111111111111111111111111111111111111111111AAAA";

function tx(overrides: Partial<TransactionRecord> = {}): TransactionRecord {
  return {
    id: "tx-1",
    roundId: "round-1",
    recipient: RECIPIENT_A,
    amount: "100",
    token: "native",
    timestamp: 1732012800,
    txHash: "hash-1",
    status: "completed",
    ...overrides,
  } as TransactionRecord;
}

function block(overrides: Partial<LedgerBlock> = {}): LedgerBlock {
  return {
    id: "block-1",
    ledgerSeq: 100,
    txHash: "hash-1",
    type: "settlement",
    projectId: "project-1",
    recipient: RECIPIENT_A,
    amount: "100",
    ledgerClosedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  } as LedgerBlock;
}

function idsOf(violations: InvariantViolation[]): string[] {
  return violations.map((v) => v.invariantId);
}

describe("evaluateLedgerBalance — success cases", () => {
  it("reports balanced for an empty database", () => {
    const report = expectBalance([], []);
    expect(report.totals.completedTotal).toBe("0");
    expect(report.totals.settledTotal).toBe("0");
  });

  it("reports balanced when every completed payout has a matching settlement of the same amount", () => {
    const report = expectBalance(
      [
        tx({ id: "tx-1", txHash: "hash-1", roundId: "round-1", amount: "100" }),
        tx({ id: "tx-2", txHash: "hash-2", roundId: "round-1", amount: "50.5" }),
        tx({ id: "tx-3", txHash: "hash-3", roundId: "round-2", amount: "0.0000001" }),
      ],
      [
        block({ txHash: "hash-1", amount: "100.0000000" }), // canonical-equal to "100"
        block({ id: "block-2", txHash: "hash-2", amount: "50.5" }),
        block({ id: "block-3", txHash: "hash-3", amount: "0.0000001" }),
      ]
    );
    expect(report.totals.completedTotal).toBe("150.5000001");
    expect(report.totals.settledTotal).toBe("150.5000001");
    expect(report.rounds).toEqual([
      { roundId: "round-1", completedTotal: "150.5", settledTotal: "150.5", completedCount: 2, settledCount: 2 },
      { roundId: "round-2", completedTotal: "0.0000001", settledTotal: "0.0000001", completedCount: 1, settledCount: 1 },
    ]);
  });

  it("treats a pending transaction with no settlement as balanced (settlement lag is #1476, not a violation)", () => {
    const report = expectBalance([tx({ status: "pending" })], []);
    expect(report.rounds[0]).toMatchObject({ completedCount: 0, completedTotal: "0" });
  });

  it("tolerates milestone ledger entries (non-settlement types are not payout settlements)", () => {
    const report = expectBalance(
      [tx({ amount: "10" })],
      [block({ amount: "10" }), block({ id: "block-2", txHash: "hash-ms", type: "milestone", amount: "999" })]
    );
    expect(report.totals.settledTotal).toBe("10");
  });
});

describe("evaluateLedgerBalance — INV-1 amount format", () => {
  it("flags a transaction amount the DB check constraint would reject", () => {
    const report = evaluateLedgerBalance([tx({ amount: "1.12345678" })], []);
    expect(idsOf(report.violations)).toContain("INV-1-invalid-amount-format");
    expect(report.balanced).toBe(false);
  });

  it("flags negative and non-numeric transaction amounts", () => {
    expect(idsOf(evaluateLedgerBalance([tx({ amount: "-5" })], []).violations)).toContain(
      "INV-1-invalid-amount-format"
    );
    expect(idsOf(evaluateLedgerBalance([tx({ amount: "abc" })], []).violations)).toContain(
      "INV-1-invalid-amount-format"
    );
  });

  it("flags a settlement amount the DB would reject", () => {
    const report = evaluateLedgerBalance([], [block({ amount: "01" })]);
    expect(idsOf(report.violations)).toContain("INV-1-invalid-amount-format");
  });

  it("accepts boundary-valid amounts (minimum positive, near-maximum i128)", () => {
    const min = "0.0000001";
    // One unit under the i128 maximum, so min + nearMax === max exactly.
    const nearMax = "170141183460469231731687303715884105726.9999999";
    const max = "170141183460469231731687303715884105727";
    const report = expectBalance(
      [tx({ id: "a", txHash: "h-a", amount: min }), tx({ id: "b", txHash: "h-b", amount: nearMax })],
      [block({ txHash: "h-a", amount: min }), block({ id: "block-b", txHash: "h-b", amount: nearMax })]
    );
    expect(report.totals.completedTotal).toBe(max);
    expect(report.totals.settledTotal).toBe(max);
  });

  it("flags amounts whose exact sum overflows the i128 bound", () => {
    const max = "170141183460469231731687303715884105727";
    const report = evaluateLedgerBalance(
      [tx({ id: "a", txHash: "h-a", amount: max }), tx({ id: "b", txHash: "h-b", amount: max })],
      [block({ txHash: "h-a", amount: max }), block({ id: "block-b", txHash: "h-b", amount: max })]
    );
    expect(idsOf(report.violations)).toContain("INV-5-amount-overflow");
  });

  it("flags amounts past the i128 boundary", () => {
    const report = evaluateLedgerBalance([tx({ amount: "170141183460469231731687303715884105728" })], []);
    expect(idsOf(report.violations)).toContain("INV-1-invalid-amount-format");
  });
});

describe("evaluateLedgerBalance — INV-2 completed payouts are positive", () => {
  it("flags a completed transaction with amount 0", () => {
    const report = evaluateLedgerBalance([tx({ amount: "0" })], [block({ amount: "0" })]);
    expect(idsOf(report.violations)).toContain("INV-2-nonzero-completed-amount");
  });

  it("does not flag zero-amount pending or failed transactions", () => {
    const report = evaluateLedgerBalance(
      [tx({ id: "p", txHash: "h-p", status: "pending", amount: "0" })],
      []
    );
    expect(idsOf(report.violations)).not.toContain("INV-2-nonzero-completed-amount");
    expect(report.balanced).toBe(true);
  });
});

describe("evaluateLedgerBalance — INV-3 settled amount match", () => {
  it("flags a mismatch between completed transaction and its settlement entry", () => {
    const report = evaluateLedgerBalance([tx({ amount: "100" })], [block({ amount: "99.9999999" })]);
    const match = report.violations.find((v) => v.invariantId === "INV-3-amount-match");
    expect(match).toBeDefined();
    expect(match?.txHash).toBe("hash-1");
    expect(match?.message).toContain("100");
    expect(match?.message).toContain("99.9999999");
  });

  it("accepts numerically-equal strings in different canonical forms", () => {
    const report = expectBalance([tx({ amount: "100" })], [block({ amount: "100.0000000" })]);
    expect(idsOf(report.violations)).not.toContain("INV-3-amount-match");
  });

  it("flags a mismatch only once per payout even with duplicate settlement rows", () => {
    const report = evaluateLedgerBalance(
      [tx({ amount: "100" })],
      [block({ amount: "90" }), block({ id: "block-2", amount: "90" })]
    );
    const matches = report.violations.filter((v) => v.invariantId === "INV-3-amount-match");
    expect(matches).toHaveLength(1);
  });
});

describe("evaluateLedgerBalance — INV-4 failed payouts must not settle", () => {
  it("flags a failed transaction that has a settlement entry", () => {
    const report = evaluateLedgerBalance([tx({ status: "failed" })], [block({ amount: "100" })]);
    expect(idsOf(report.violations)).toContain("INV-4-failed-not-settled");
  });

  it("does not flag a failed transaction without a settlement entry", () => {
    const report = evaluateLedgerBalance([tx({ status: "failed" })], []);
    expect(idsOf(report.violations)).not.toContain("INV-4-failed-not-settled");
  });

  it("does not count failed payouts in the settled/completed totals", () => {
    const report = expectBalance(
      [tx({ id: "f", txHash: "h-f", status: "failed", amount: "100" })],
      []
    );
    expect(report.totals.completedTotal).toBe("0");
  });
});

describe("evaluateLedgerBalance — INV-5 uniqueness and aggregate conservation", () => {
  it("flags duplicate settlement rows sharing one txHash", () => {
    const report = evaluateLedgerBalance(
      [tx({ amount: "100" })],
      [block({ amount: "100" }), block({ id: "block-2", amount: "100" })]
    );
    expect(idsOf(report.violations)).toContain("INV-5-duplicate-settlement-entry");
  });

  it("flags aggregate drift that per-row matching cannot see (settlement without transaction)", () => {
    // Every transaction matches its settlement, but an extra settlement row
    // for an unknown txHash tilts the aggregate. (The row itself is the
    // #937 orphan case; here we assert the totals invariant catches it too.)
    const report = evaluateLedgerBalance(
      [tx({ amount: "100" })],
      [block({ amount: "100" }), block({ id: "block-x", txHash: "hash-x", amount: "7" })]
    );
    const agg = report.violations.find((v) => v.invariantId === "INV-5-aggregate-conservation");
    expect(agg).toBeDefined();
    expect(report.totals.settledTotal).toBe("107");
    expect(report.totals.completedTotal).toBe("100");
  });

  it("passes when completed and settled totals agree across many rows", () => {
    const report = expectBalance(
      [
        tx({ id: "t1", txHash: "h1", amount: "33.3333334" }),
        tx({ id: "t2", txHash: "h2", amount: "33.3333333" }),
        tx({ id: "t3", txHash: "h3", amount: "33.3333333" }),
      ],
      [
        block({ txHash: "h1", amount: "33.3333334" }),
        block({ id: "b2", txHash: "h2", amount: "33.3333333" }),
        block({ id: "b3", txHash: "h3", amount: "33.3333333" }),
      ]
    );
    expect(report.totals.completedTotal).toBe("100");
    expect(report.totals.settledTotal).toBe("100");
  });
});

describe("totalCompletedAmount", () => {
  it("sums only completed, valid amounts exactly", () => {
    expect(
      totalCompletedAmount([
        tx({ id: "a", status: "completed", amount: "0.1" }),
        tx({ id: "b", status: "completed", amount: "0.2" }),
        tx({ id: "c", status: "pending", amount: "5" }),
        tx({ id: "d", status: "failed", amount: "7" }),
      ])
    ).toBe("0.3"); // exact — 0.1 + 0.2 !== 0.3 in floats
  });
});

/** Asserts a report is balanced, returning it for further assertions. */
function expectBalance(transactions: TransactionRecord[], blocks: LedgerBlock[]) {
  const report = evaluateLedgerBalance(transactions, blocks);
  expect(report.violations).toEqual([]);
  expect(report.balanced).toBe(true);
  return report;
}
