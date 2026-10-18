/**
 * Pending transaction aging report (#1476).
 *
 * Identifies `pending` transactions that have been stuck beyond configurable
 * thresholds and exposes the result as safe operator diagnostics:
 *
 *   - recipients are always masked (first 6 + last 4 chars) — the report is
 *     meant to be pasted into tickets/incidents, so raw wallet addresses are
 *     never printed (same convention as check-orphaned-transactions.ts);
 *   - amounts are summed with the exact fixed-point helpers
 *     (`lib/decimal-amounts.ts`), never via `Number()`;
 *   - the report is read-only: it only ever calls `repo.find()`.
 *
 * Thresholds (hours, environment-configurable):
 *
 *   PENDING_TX_AGING_WARNING_HOURS   default 24  — "stuck" bucket starts here
 *   PENDING_TX_AGING_CRITICAL_HOURS  default 72  — "critically stuck" starts here
 *
 * A transaction's age is `now - timestamp` (timestamps are epoch SECONDS,
 * per routes/transactions.ts). Rows whose timestamp is in the future
 * (clock skew or a bad write) are clamped to age 0 and reported as a
 * warning rather than silently ignored.
 *
 * Output: human-readable report via `logger`, or one JSON document with
 * `--json`. Exit code is 1 when any transaction is in the critical bucket,
 * 0 otherwise — so it can gate a cron alert.
 *
 * Run standalone:
 *   cd backend && npx tsx src/scripts/pending-transaction-aging-report.ts
 *   cd backend && npx tsx src/scripts/pending-transaction-aging-report.ts --json
 *
 * See docs/pending-transaction-aging-report.md.
 */
import "reflect-metadata";
import { fileURLToPath } from "url";
import type { DataSource } from "typeorm";
import { TransactionRecord } from "../entities/Transaction.js";
import { initDatabase, closeDatabase } from "../services/database.js";
import { logger } from "../services/logger.js";
import {
  isValidAmountString,
  sumAmounts,
} from "../lib/decimal-amounts.js";
import { maskWalletAddress } from "./check-orphaned-transactions.js";

export interface AgingThresholds {
  /** Hours after which a pending transaction is "stuck" (warning). */
  warningHours: number;
  /** Hours after which it is critically stuck (critical). */
  criticalHours: number;
}

export const DEFAULT_AGING_THRESHOLDS: AgingThresholds = {
  warningHours: 24,
  criticalHours: 72,
};

export type AgingBucketName = "fresh" | "warning" | "critical";

export interface AgingBucket {
  bucket: AgingBucketName;
  count: number;
  /** Age of the oldest transaction in this bucket, in hours (0 when empty). */
  oldestAgeHours: number;
  /** Exact sum of amounts in this bucket (invalid amounts are excluded and warned). */
  totalAmount: string;
  /** Up to 5 masked recipients, oldest first. */
  sampleRecipientsMasked: string[];
}

export interface StuckTransactionSummary {
  id: string;
  txHash: string;
  roundId: string;
  recipientMasked: string;
  ageHours: number;
  /** Amount as stored; only included when it satisfies the amount contract. */
  amount?: string;
}

export interface PendingTransactionAgingReport {
  generatedAt: string;
  thresholds: AgingThresholds;
  totalPending: number;
  buckets: Record<AgingBucketName, AgingBucket>;
  /** Every critical-bucket transaction, for alerting (masked). */
  criticalTransactions: StuckTransactionSummary[];
  warnings: string[];
}

export class ThresholdConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThresholdConfigurationError";
  }
}

/**
 * Parses and validates thresholds from an environment-like object.
 * Invalid configuration throws (fail loud: an operator running this command
 * with a silently-repaired threshold would misread the results).
 */
export function resolveAgingThresholds(
  env: Record<string, string | undefined> = process.env
): AgingThresholds {
  const parse = (raw: string | undefined, fallback: number, name: string): number => {
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      throw new ThresholdConfigurationError(
        `${name} must be a positive number of hours, got ${JSON.stringify(raw)}`
      );
    }
    return value;
  };
  const warningHours = parse(
    env.PENDING_TX_AGING_WARNING_HOURS,
    DEFAULT_AGING_THRESHOLDS.warningHours,
    "PENDING_TX_AGING_WARNING_HOURS"
  );
  const criticalHours = parse(
    env.PENDING_TX_AGING_CRITICAL_HOURS,
    DEFAULT_AGING_THRESHOLDS.criticalHours,
    "PENDING_TX_AGING_CRITICAL_HOURS"
  );
  if (criticalHours <= warningHours) {
    throw new ThresholdConfigurationError(
      `PENDING_TX_AGING_CRITICAL_HOURS (${criticalHours}) must be greater than ` +
        `PENDING_TX_AGING_WARNING_HOURS (${warningHours})`
    );
  }
  return { warningHours, criticalHours };
}

/** Maps an age in hours to its bucket. Boundary: exactly at a threshold counts as that bucket. */
export function classifyAge(ageHours: number, thresholds: AgingThresholds): AgingBucketName {
  if (ageHours >= thresholds.criticalHours) return "critical";
  if (ageHours >= thresholds.warningHours) return "warning";
  return "fresh";
}

const SAMPLE_LIMIT = 5;

export function buildPendingTransactionAgingReport(
  pendingTransactions: TransactionRecord[],
  options: { thresholds: AgingThresholds; nowMs: number }
): PendingTransactionAgingReport {
  const { thresholds, nowMs } = options;
  const warnings: string[] = [];

  const buckets: Record<AgingBucketName, AgingBucket> = {
    fresh: { bucket: "fresh", count: 0, oldestAgeHours: 0, totalAmount: "0", sampleRecipientsMasked: [] },
    warning: { bucket: "warning", count: 0, oldestAgeHours: 0, totalAmount: "0", sampleRecipientsMasked: [] },
    critical: { bucket: "critical", count: 0, oldestAgeHours: 0, totalAmount: "0", sampleRecipientsMasked: [] },
  };
  const criticalTransactions: StuckTransactionSummary[] = [];
  const amountsByBucket: Record<AgingBucketName, string[]> = { fresh: [], warning: [], critical: [] };

  const aged = pendingTransactions
    .map((tx) => {
      const ageSeconds = Math.floor(nowMs / 1000) - tx.timestamp;
      if (ageSeconds < 0) {
        warnings.push(
          `Transaction ${tx.txHash} has a timestamp in the future (skew ${-ageSeconds}s); treated as age 0.`
        );
      }
      const ageHours = Math.max(0, ageSeconds) / 3600;
      return { tx, ageHours };
    })
    .sort((a, b) => b.ageHours - a.ageHours); // oldest first

  for (const { tx, ageHours } of aged) {
    const name = classifyAge(ageHours, thresholds);
    const bucket = buckets[name];
    bucket.count += 1;
    if (bucket.oldestAgeHours < ageHours) bucket.oldestAgeHours = ageHours;
    if (bucket.sampleRecipientsMasked.length < SAMPLE_LIMIT) {
      bucket.sampleRecipientsMasked.push(maskWalletAddress(tx.recipient));
    }
    if (isValidAmountString(tx.amount)) {
      amountsByBucket[name].push(tx.amount);
    } else {
      warnings.push(
        `Transaction ${tx.txHash} has invalid amount ${JSON.stringify(tx.amount)}; excluded from bucket totals.`
      );
    }
    if (name === "critical") {
      criticalTransactions.push({
        id: tx.id,
        txHash: tx.txHash,
        roundId: tx.roundId,
        recipientMasked: maskWalletAddress(tx.recipient),
        ageHours: Math.round(ageHours * 100) / 100,
        ...(isValidAmountString(tx.amount) ? { amount: tx.amount } : {}),
      });
    }
  }

  for (const name of ["fresh", "warning", "critical"] as const) {
    buckets[name].totalAmount = sumAmounts(amountsByBucket[name]);
  }

  return {
    generatedAt: new Date(nowMs).toISOString(),
    thresholds,
    totalPending: pendingTransactions.length,
    buckets,
    criticalTransactions,
    warnings,
  };
}

/**
 * Loads pending transactions read-only and builds the report.
 * Only `repo.find()` is ever called — this command never mutates.
 */
export async function reportPendingTransactionAging(
  dataSource: DataSource,
  options: { thresholds: AgingThresholds; nowMs?: number }
): Promise<PendingTransactionAgingReport> {
  const repo = dataSource.getRepository(TransactionRecord);
  const pending = await repo.find({ where: { status: "pending" } });
  return buildPendingTransactionAgingReport(pending, {
    thresholds: options.thresholds,
    nowMs: options.nowMs ?? Date.now(),
  });
}

export function exitCodeForReport(report: PendingTransactionAgingReport): 0 | 1 {
  return report.buckets.critical.count > 0 ? 1 : 0;
}

function printReport(report: PendingTransactionAgingReport): void {
  logger.info("Pending transaction aging report", {
    generatedAt: report.generatedAt,
    thresholdsHours: report.thresholds,
    totalPending: report.totalPending,
    fresh: report.buckets.fresh.count,
    warning: report.buckets.warning.count,
    critical: report.buckets.critical.count,
  });

  for (const warning of report.warnings) logger.warn(warning);

  if (report.buckets.warning.count > 0) {
    logger.warn(
      `${report.buckets.warning.count} pending transaction(s) older than ${report.thresholds.warningHours}h ` +
        `(oldest ${Math.round(report.buckets.warning.oldestAgeHours)}h, total ${report.buckets.warning.totalAmount}). ` +
        `Recipients: ${report.buckets.warning.sampleRecipientsMasked.join(", ")}`
    );
  }
  if (report.criticalTransactions.length > 0) {
    logger.error(
      `${report.criticalTransactions.length} pending transaction(s) older than ${report.thresholds.criticalHours}h:`
    );
    for (const tx of report.criticalTransactions) {
      logger.error(
        `  id=${tx.id} txHash=${tx.txHash} roundId=${tx.roundId} recipient=${tx.recipientMasked} ` +
          `ageHours=${tx.ageHours} amount=${tx.amount ?? "(invalid)"}`
      );
    }
  }
}

async function runCli(): Promise<number> {
  let dataSource: DataSource;
  try {
    dataSource = await initDatabase();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Failed to connect to the database", { error: message });
    return 1;
  }

  try {
    const thresholds = resolveAgingThresholds();
    const report = await reportPendingTransactionAging(dataSource, { thresholds });
    if (process.argv.includes("--json")) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      printReport(report);
    }
    return exitCodeForReport(report);
  } finally {
    await closeDatabase();
  }
}

const __filename = fileURLToPath(import.meta.url);
const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith("pending-transaction-aging-report.ts") ||
    process.argv[1].endsWith("pending-transaction-aging-report.js") ||
    process.argv[1] === __filename);

if (isDirectRun) {
  runCli()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Unexpected error running pending transaction aging report", { error: message });
      process.exitCode = 1;
    });
}
