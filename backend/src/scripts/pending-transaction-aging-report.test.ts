import { describe, expect, it, vi } from "vitest";
import type { DataSource } from "typeorm";
import {
  buildPendingTransactionAgingReport,
  classifyAge,
  DEFAULT_AGING_THRESHOLDS,
  exitCodeForReport,
  reportPendingTransactionAging,
  resolveAgingThresholds,
  ThresholdConfigurationError,
  type AgingThresholds,
} from "./pending-transaction-aging-report.js";
import { TransactionRecord } from "../entities/Transaction.js";
import { maskWalletAddress } from "./check-orphaned-transactions.js";

/**
 * Pending transaction aging report (#1476).
 *
 * Success, failure and boundary cases for threshold resolution, bucket
 * classification and the read-only report builder. Timestamps are epoch
 * SECONDS (see routes/transactions.ts); `nowMs` is epoch milliseconds.
 */

const RECIPIENT_A = "GA111111111111111111111111111111111111111111111111AAAA";
const RECIPIENT_B = "GB222222222222222222222222222222222222222222222222BBBB";

const THRESHOLDS: AgingThresholds = { warningHours: 24, criticalHours: 72 };
// Fixed "now": 2026-01-10T00:00:00Z
const NOW_MS = Date.parse("2026-01-10T00:00:00Z");
const NOW_S = Math.floor(NOW_MS / 1000);

function pendingTx(overrides: Partial<TransactionRecord> = {}): TransactionRecord {
  return {
    id: "tx-1",
    roundId: "round-1",
    recipient: RECIPIENT_A,
    amount: "100",
    token: "native",
    timestamp: NOW_S - 3600, // 1h old by default
    txHash: "hash-1",
    status: "pending",
    ...overrides,
  } as TransactionRecord;
}

describe("resolveAgingThresholds", () => {
  it("falls back to defaults when nothing is configured", () => {
    expect(resolveAgingThresholds({})).toEqual(DEFAULT_AGING_THRESHOLDS);
  });

  it("parses configured hours", () => {
    expect(
      resolveAgingThresholds({
        PENDING_TX_AGING_WARNING_HOURS: "6",
        PENDING_TX_AGING_CRITICAL_HOURS: "48",
      })
    ).toEqual({ warningHours: 6, criticalHours: 48 });
  });

  it("rejects non-numeric, zero and negative thresholds", () => {
    for (const bad of ["abc", "0", "-1", "NaN", "1e309"]) {
      expect(() =>
        resolveAgingThresholds({ PENDING_TX_AGING_WARNING_HOURS: bad })
      ).toThrow(ThresholdConfigurationError);
    }
  });

  it("rejects a critical threshold that is not above the warning threshold", () => {
    expect(() =>
      resolveAgingThresholds({
        PENDING_TX_AGING_WARNING_HOURS: "72",
        PENDING_TX_AGING_CRITICAL_HOURS: "72",
      })
    ).toThrow(/must be greater than/);
    expect(() =>
      resolveAgingThresholds({
        PENDING_TX_AGING_WARNING_HOURS: "48",
        PENDING_TX_AGING_CRITICAL_HOURS: "24",
      })
    ).toThrow(/must be greater than/);
  });

  it("accepts fractional-hour thresholds", () => {
    expect(
      resolveAgingThresholds({
        PENDING_TX_AGING_WARNING_HOURS: "0.5",
        PENDING_TX_AGING_CRITICAL_HOURS: "1.25",
      })
    ).toEqual({ warningHours: 0.5, criticalHours: 1.25 });
  });
});

describe("classifyAge — threshold boundaries", () => {
  it("is fresh strictly below the warning threshold", () => {
    expect(classifyAge(23.999, THRESHOLDS)).toBe("fresh");
  });

  it("becomes warning exactly at the warning threshold", () => {
    expect(classifyAge(24, THRESHOLDS)).toBe("warning");
  });

  it("stays warning strictly below the critical threshold", () => {
    expect(classifyAge(71.999, THRESHOLDS)).toBe("warning");
  });

  it("becomes critical exactly at the critical threshold", () => {
    expect(classifyAge(72, THRESHOLDS)).toBe("critical");
    expect(classifyAge(1000, THRESHOLDS)).toBe("critical");
  });
});

describe("buildPendingTransactionAgingReport", () => {
  it("buckets transactions by age, oldest first, with exact totals", () => {
    const report = buildPendingTransactionAgingReport(
      [
        pendingTx({ id: "fresh", txHash: "h-fresh", timestamp: NOW_S - 3600, amount: "10.5" }),
        pendingTx({ id: "warn", txHash: "h-warn", timestamp: NOW_S - 25 * 3600, amount: "20" }),
        pendingTx({ id: "crit", txHash: "h-crit", timestamp: NOW_S - 100 * 3600, amount: "0.1" }),
      ],
      { thresholds: THRESHOLDS, nowMs: NOW_MS }
    );

    expect(report.totalPending).toBe(3);
    expect(report.buckets.fresh).toMatchObject({ count: 1, totalAmount: "10.5" });
    expect(report.buckets.warning).toMatchObject({ count: 1, totalAmount: "20" });
    expect(report.buckets.critical).toMatchObject({ count: 1, totalAmount: "0.1" });
    expect(report.buckets.warning.oldestAgeHours).toBeCloseTo(25);
    expect(report.buckets.critical.oldestAgeHours).toBeCloseTo(100);
    expect(report.criticalTransactions).toHaveLength(1);
    expect(report.criticalTransactions[0]).toMatchObject({
      id: "crit",
      txHash: "h-crit",
      ageHours: 100,
      amount: "0.1",
    });
  });

  it("puts a transaction exactly at the warning threshold in the warning bucket", () => {
    const report = buildPendingTransactionAgingReport(
      [pendingTx({ timestamp: NOW_S - 24 * 3600 })],
      { thresholds: THRESHOLDS, nowMs: NOW_MS }
    );
    expect(report.buckets.warning.count).toBe(1);
    expect(report.buckets.fresh.count).toBe(0);
  });

  it("puts a transaction exactly at the critical threshold in the critical bucket", () => {
    const report = buildPendingTransactionAgingReport(
      [pendingTx({ timestamp: NOW_S - 72 * 3600 })],
      { thresholds: THRESHOLDS, nowMs: NOW_MS }
    );
    expect(report.buckets.critical.count).toBe(1);
  });

  it("never emits unmasked wallet addresses", () => {
    const report = buildPendingTransactionAgingReport(
      [
        pendingTx({ id: "a", recipient: RECIPIENT_A, timestamp: NOW_S - 100 * 3600 }),
        pendingTx({ id: "b", recipient: RECIPIENT_B, timestamp: NOW_S - 200 * 3600 }),
      ],
      { thresholds: THRESHOLDS, nowMs: NOW_MS }
    );
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(RECIPIENT_A);
    expect(serialized).not.toContain(RECIPIENT_B);
    expect(report.buckets.critical.sampleRecipientsMasked).toEqual([
      maskWalletAddress(RECIPIENT_B), // oldest first
      maskWalletAddress(RECIPIENT_A),
    ]);
  });

  it("caps the sample list at 5 recipients", () => {
    const rows = Array.from({ length: 8 }, (_, i) =>
      pendingTx({ id: `tx-${i}`, recipient: `G${String(i).padStart(56, "0")}` })
    );
    const report = buildPendingTransactionAgingReport(rows, { thresholds: THRESHOLDS, nowMs: NOW_MS });
    expect(report.buckets.fresh.sampleRecipientsMasked).toHaveLength(5);
  });

  it("clamps future-timestamped rows to age 0 and warns instead of throwing", () => {
    const report = buildPendingTransactionAgingReport(
      [pendingTx({ txHash: "h-skew", timestamp: NOW_S + 600 })],
      { thresholds: THRESHOLDS, nowMs: NOW_MS }
    );
    expect(report.buckets.fresh.count).toBe(1);
    expect(report.buckets.fresh.oldestAgeHours).toBe(0);
    expect(report.warnings.some((w) => w.includes("h-skew") && w.includes("future"))).toBe(true);
  });

  it("excludes invalid amounts from bucket totals but keeps the row counted, with a warning", () => {
    const report = buildPendingTransactionAgingReport(
      [
        pendingTx({ id: "ok", txHash: "h-ok", amount: "5" }),
        pendingTx({ id: "bad", txHash: "h-bad", amount: "-5" }),
      ],
      { thresholds: THRESHOLDS, nowMs: NOW_MS }
    );
    expect(report.buckets.fresh.count).toBe(2);
    expect(report.buckets.fresh.totalAmount).toBe("5");
    expect(report.warnings.some((w) => w.includes("h-bad"))).toBe(true);
  });

  it("sums fractional amounts exactly (no float dust)", () => {
    const report = buildPendingTransactionAgingReport(
      [
        pendingTx({ id: "a", amount: "0.1" }),
        pendingTx({ id: "b", amount: "0.2" }),
      ],
      { thresholds: THRESHOLDS, nowMs: NOW_MS }
    );
    expect(report.buckets.fresh.totalAmount).toBe("0.3");
  });

  it("handles an empty pending set", () => {
    const report = buildPendingTransactionAgingReport([], { thresholds: THRESHOLDS, nowMs: NOW_MS });
    expect(report.totalPending).toBe(0);
    expect(report.buckets.fresh.count).toBe(0);
    expect(report.criticalTransactions).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(exitCodeForReport(report)).toBe(0);
  });
});

describe("exitCodeForReport", () => {
  it("returns 1 when the critical bucket is non-empty, 0 otherwise", () => {
    const clean = buildPendingTransactionAgingReport(
      [pendingTx({ timestamp: NOW_S - 3600 })],
      { thresholds: THRESHOLDS, nowMs: NOW_MS }
    );
    expect(exitCodeForReport(clean)).toBe(0);

    const stuck = buildPendingTransactionAgingReport(
      [pendingTx({ timestamp: NOW_S - 100 * 3600 })],
      { thresholds: THRESHOLDS, nowMs: NOW_MS }
    );
    expect(exitCodeForReport(stuck)).toBe(1);
  });
});

describe("reportPendingTransactionAging — read-only data access", () => {
  it("queries only pending rows through repo.find and never writes", async () => {
    const find = vi.fn().mockResolvedValue([pendingTx()]);
    const dataSource = {
      getRepository: vi.fn().mockReturnValue({ find }),
    } as unknown as DataSource;

    const report = await reportPendingTransactionAging(dataSource, {
      thresholds: THRESHOLDS,
      nowMs: NOW_MS,
    });

    expect(find).toHaveBeenCalledTimes(1);
    expect(find).toHaveBeenCalledWith({ where: { status: "pending" } });
    expect(report.totalPending).toBe(1);
    // The mock repository exposes ONLY `find`; if the implementation tried to
    // insert/update/delete anything it would have thrown a TypeError.
  });

  it("uses the current time when nowMs is not provided", async () => {
    const find = vi.fn().mockResolvedValue([]);
    const dataSource = {
      getRepository: vi.fn().mockReturnValue({ find }),
    } as unknown as DataSource;

    const before = Date.now();
    const report = await reportPendingTransactionAging(dataSource, { thresholds: THRESHOLDS });
    const after = Date.now();

    expect(Date.parse(report.generatedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(report.generatedAt)).toBeLessThanOrEqual(after);
  });
});
