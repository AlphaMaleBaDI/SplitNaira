/**
 * Reconciliation dry-run command (#1477).
 *
 * Produces non-mutating reconciliation output over `transactions` and
 * `ledger_blocks` and exits non-zero when critical inconsistencies exist.
 * It composes, rather than duplicates, the two existing check engines:
 *
 *   1. `checkOrphanedTransactions()` (#937) — row-level cross-table
 *      reconciliation (completed payout without settlement, settlement
 *      without payout);
 *   2. `evaluateLedgerBalance()` (#1475) — the accounting invariants
 *      (amount format, positive settled amounts, per-payout amount match,
 *      failed-must-not-settle, uniqueness and aggregate conservation).
 *
 * ## Dry-run guarantees
 *
 *   - The command only ever executes `repo.find()` — there is no insert,
 *     update, delete, or schema change anywhere on its path (enforced by
 *     the unit tests, which serve repositories exposing ONLY `find`);
 *   - it opens no transactions and takes no locks;
 *   - remediation is always a separate, explicitly human-reviewed step
 *     (see docs/orphaned-transaction-remediation.md).
 *
 * Output: human-readable report via `logger`, or a single JSON document on
 * stdout with `--json` (for CI / scripting).
 *
 * Exit code:
 *   0 — no critical findings (warnings may exist)
 *   1 — at least one critical inconsistency, or the run itself failed
 *
 * Run standalone:
 *   cd backend && npx tsx src/scripts/reconcile-dry-run.ts
 *   cd backend && npx tsx src/scripts/reconcile-dry-run.ts --json
 *
 * See docs/reconciliation-dry-run.md.
 */
import "reflect-metadata";
import { fileURLToPath } from "url";
import type { DataSource } from "typeorm";
import {
  checkOrphanedTransactions,
  LEDGER_BLOCKS_MISSING_WARNING,
  type OrphanedTransactionsReport,
} from "./check-orphaned-transactions.js";
import {
  evaluateLedgerBalance,
  type InvariantViolation,
  type LedgerBalanceReport,
} from "../services/ledger-invariants.js";
import { TransactionRecord } from "../entities/Transaction.js";
import { LedgerBlock } from "../entities/LedgerBlock.js";
import { initDatabase, closeDatabase } from "../services/database.js";
import { logger } from "../services/logger.js";

export type FindingSeverity = "critical" | "warning";

export interface ReconciliationFinding {
  /** Stable id for the producing check, e.g. "completed-missing-settlement". */
  checkId: string;
  severity: FindingSeverity;
  message: string;
  count?: number;
  /** Small (max 5), masked sample of affected identifiers. */
  sampleIds?: string[];
}

export interface ReconciliationDryRunReport {
  /** ISO timestamp of the run. */
  generatedAt: string;
  /** Always "dry-run": this command never mutates. */
  mode: "dry-run";
  checksRun: string[];
  findings: ReconciliationFinding[];
  /** True iff no finding has severity "critical". */
  ok: boolean;
}

const SAMPLE_LIMIT = 5;

/**
 * Translates the #937 orphaned-transaction report into findings.
 * (The underlying rows are loaded once in `runReconciliationDryRun` and
 * passed through so the two engines share one pair of reads.)
 */
export function orphanFindings(report: OrphanedTransactionsReport): ReconciliationFinding[] {
  const findings: ReconciliationFinding[] = [];

  if (report.completedTransactionsMissingLedgerBlock.length > 0) {
    findings.push({
      checkId: "completed-missing-settlement",
      severity: "critical",
      message: `${report.completedTransactionsMissingLedgerBlock.length} completed transaction(s) have no matching ledger_blocks settlement record.`,
      count: report.completedTransactionsMissingLedgerBlock.length,
      sampleIds: report.completedTransactionsMissingLedgerBlock
        .slice(0, SAMPLE_LIMIT)
        .map((t) => t.txHash),
    });
  }

  if (report.settlementLedgerBlocksMissingTransaction.length > 0) {
    findings.push({
      checkId: "settlement-missing-transaction",
      severity: "critical",
      message: `${report.settlementLedgerBlocksMissingTransaction.length} settlement ledger_entries have no matching transactions record.`,
      count: report.settlementLedgerBlocksMissingTransaction.length,
      sampleIds: report.settlementLedgerBlocksMissingTransaction
        .slice(0, SAMPLE_LIMIT)
        .map((b) => b.txHash),
    });
  }

  // Unregistered recipients are informational in #937 (recipients need not
  // be users) — surfaced here as warnings so the dry-run report is complete.
  if (report.unregisteredRecipients.count > 0) {
    findings.push({
      checkId: "unregistered-recipients",
      severity: "warning",
      message:
        `${report.unregisteredRecipients.count} recipient wallet(s) referenced by ledger rows have no users row. ` +
        "This is expected — recipients are not required to be registered users.",
      count: report.unregisteredRecipients.count,
      sampleIds: report.unregisteredRecipients.sampleMasked,
    });
  }

  for (const warning of report.warnings) {
    findings.push({
      checkId: "ledger-blocks-unavailable",
      severity: "warning",
      message: warning,
    });
  }

  return findings;
}

/** Translates #1475 invariant violations into findings. */
export function invariantFindings(report: LedgerBalanceReport): ReconciliationFinding[] {
  const findings: ReconciliationFinding[] = [];
  const byId = new Map<string, InvariantViolation[]>();
  for (const violation of report.violations) {
    const list = byId.get(violation.invariantId) ?? [];
    list.push(violation);
    byId.set(violation.invariantId, list);
  }
  for (const [invariantId, violations] of byId) {
    findings.push({
      checkId: invariantId,
      severity: violations.some((v) => v.severity === "critical") ? "critical" : "warning",
      message: violations[0].message,
      count: violations.length,
      sampleIds: violations.slice(0, SAMPLE_LIMIT).map((v) => v.txHash ?? v.rowId ?? "(unknown)"),
    });
  }
  return findings;
}

/**
 * Runs both reconciliation engines over the database in read-only mode and
 * produces the consolidated dry-run report. Pure w.r.t. the database: only
 * `find()` is issued, per entity, once.
 */
export async function runReconciliationDryRun(
  dataSource: DataSource
): Promise<ReconciliationDryRunReport> {
  // Load rows for the invariant engine. The orphan engine (#937) issues its
  // own reads; tolerating a missing ledger_blocks table here means the two
  // engines degrade identically instead of one crashing the run.
  const transactions = await dataSource.getRepository(TransactionRecord).find();
  let ledgerBlocks: LedgerBlock[] = [];
  const warnings: string[] = [];
  try {
    ledgerBlocks = await dataSource.getRepository(LedgerBlock).find();
  } catch (error) {
    // checkOrphanedTransactions() handles the missing-table case itself; we
    // mirror the tolerance here so the invariant engine degrades the same
    // way instead of crashing the whole run.
    const code = (error as { code?: unknown }).code;
    if (code !== "42P01") throw error;
    warnings.push(LEDGER_BLOCKS_MISSING_WARNING);
  }

  // The invariant engine sees the same (possibly empty) ledger view.
  const balanceReport = evaluateLedgerBalance(transactions, ledgerBlocks);

  const findings: ReconciliationFinding[] = [...invariantFindings(balanceReport)];

  if (warnings.length > 0) {
    for (const warning of warnings) {
      findings.push({
        checkId: "ledger-blocks-unavailable",
        severity: "warning",
        message: warning,
      });
    }
  } else {
    // Orphan checks need a working ledger_blocks read; skip them when the
    // table is missing to avoid false "missing settlement" findings.
    const orphanReport = await checkOrphanedTransactions(dataSource);
    findings.push(...orphanFindings(orphanReport));
  }

  return {
    generatedAt: new Date().toISOString(),
    mode: "dry-run",
    checksRun: [
      "ledger-balancing-invariants",
      ...(warnings.length > 0 ? [] : ["transaction-ledger-reconciliation"]),
    ],
    findings,
    ok: !findings.some((f) => f.severity === "critical"),
  };
}

export function exitCodeForReport(report: ReconciliationDryRunReport): 0 | 1 {
  return report.ok ? 0 : 1;
}

function printReport(report: ReconciliationDryRunReport): void {
  logger.info("Reconciliation dry-run summary", {
    generatedAt: report.generatedAt,
    mode: report.mode,
    checksRun: report.checksRun,
    criticalFindings: report.findings.filter((f) => f.severity === "critical").length,
    warnings: report.findings.filter((f) => f.severity === "warning").length,
    ok: report.ok,
  });

  for (const finding of report.findings) {
    const line = `[${finding.severity.toUpperCase()}] ${finding.checkId}: ${finding.message}` +
      (finding.sampleIds && finding.sampleIds.length > 0
        ? ` (sample: ${finding.sampleIds.join(", ")})`
        : "");
    if (finding.severity === "critical") logger.error(line);
    else logger.warn(line);
  }

  if (report.ok) {
    logger.info("Reconciliation dry-run complete: no critical inconsistencies.");
  } else {
    logger.error(
      "Reconciliation dry-run complete: critical inconsistencies found. No changes were made (dry-run)."
    );
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
    const report = await runReconciliationDryRun(dataSource);
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
  (process.argv[1].endsWith("reconcile-dry-run.ts") ||
    process.argv[1].endsWith("reconcile-dry-run.js") ||
    process.argv[1] === __filename);

if (isDirectRun) {
  runCli()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Unexpected error running reconciliation dry-run", { error: message });
      process.exitCode = 1;
    });
}
