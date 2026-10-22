/**
 * Backup restore drill: capture a baseline, then validate a restored copy.
 *
 * A backup is only proven once it has been restored and the recovered records
 * checked. This command does both halves of that check against Postgres:
 *
 *   1. `--capture <baseline.json>` against the SOURCE database (at backup time):
 *      records, per table, the row count and a SHA-256 checksum over every row
 *      (canonical JSON, sorted by primary key), plus financial totals for
 *      `transactions` and `ledger_blocks` (exact BigInt sums by token/status).
 *   2. `--validate <baseline.json>` against the RESTORED database:
 *      recomputes the same snapshot and diffs it against the baseline, then
 *      runs the existing relational audit (`runDatabaseConsistencyAudit`, #1338)
 *      on the restored data rather than re-implementing those checks.
 *
 * The drill passes only when every table is present, counts and checksums
 * match, financial totals match to the stroop, and the audit has no critical
 * finding. Exit code 1 otherwise.
 *
 * Safety:
 *   - Read-only: only `repo.find()` is ever called; nothing is written, migrated
 *     or deleted on either database.
 *   - The baseline holds counts, hashes and totals only, never row contents or
 *     wallet addresses, so it can be attached to drill evidence.
 *   - Validation refuses to run unless `RESTORE_DRILL_TARGET=restore`, so it
 *     can't be pointed at production by accident and mistaken for a drill.
 *
 * Run (see docs/runbooks/postgres-backup-restore.md § Restore drill):
 *   cd backend && npx tsx src/scripts/restore-drill.ts --capture drill/baseline.json
 *   cd backend && RESTORE_DRILL_TARGET=restore DATABASE_URL=<restored> \
 *     npx tsx src/scripts/restore-drill.ts --validate drill/baseline.json [--json]
 */
import "reflect-metadata";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "url";
import type { DataSource, EntityTarget, ObjectLiteral } from "typeorm";

import { User } from "../entities/User.js";
import { TransactionRecord } from "../entities/Transaction.js";
import { LedgerBlock } from "../entities/LedgerBlock.js";
import { Notification } from "../entities/Notification.js";
import { NotificationPreference } from "../entities/NotificationPreference.js";
import { SplitCancellation } from "../entities/SplitCancellation.js";
import { initDatabase, closeDatabase } from "../services/database.js";
import { logger } from "../services/logger.js";
import { sanitizeErrorMessage } from "./check-orphaned-transactions.js";
import {
  runDatabaseConsistencyAudit,
  type ConsistencyFinding,
} from "./audit-database-consistency.js";

export const DRILL_BASELINE_SCHEMA = "splitnaira.restore-drill-baseline";
export const DRILL_BASELINE_VERSION = 1;

/** Tables covered by the drill, in a fixed order so reports are stable. */
export const DRILL_TABLES: ReadonlyArray<[string, EntityTarget<ObjectLiteral>]> = [
  ["users", User],
  ["transactions", TransactionRecord],
  ["ledger_blocks", LedgerBlock],
  ["notifications", Notification],
  ["notification_preferences", NotificationPreference],
  ["split_cancellations", SplitCancellation],
];

/** Tables whose `amount` column carries funds and must reconcile exactly. */
const FINANCIAL_TABLES = new Set(["transactions", "ledger_blocks"]);

export interface TableSnapshot {
  available: boolean;
  rowCount: number;
  checksum: string;
  /** `token|status` (or `type`) -> exact stroop total, for financial tables. */
  amountTotals?: Record<string, string>;
  /** Rows whose amount isn't an integer string; reported, never summed. */
  invalidAmountRows?: number;
}

export interface DrillBaseline {
  schema: typeof DRILL_BASELINE_SCHEMA;
  version: number;
  capturedAt: string;
  tables: Record<string, TableSnapshot>;
}

export interface DrillFinding {
  checkId: string;
  severity: "critical" | "warning";
  table?: string;
  message: string;
}

export interface DrillReport {
  generatedAt: string;
  baselineCapturedAt: string;
  tablesChecked: string[];
  findings: DrillFinding[];
  consistencyFindings: ConsistencyFinding[];
  ok: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot
// ─────────────────────────────────────────────────────────────────────────────

function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  }
  return value ?? null;
}

/** Order-independent checksum: rows sorted by `id`, keys sorted, dates as ISO. */
export function checksumRows(rows: ObjectLiteral[]): string {
  const hash = createHash("sha256");
  const sorted = [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  for (const row of sorted) {
    hash.update(JSON.stringify(canonical(row)));
    hash.update("\n");
  }
  return hash.digest("hex");
}

const INTEGER_AMOUNT = /^-?\d+$/;

function amountTotals(table: string, rows: ObjectLiteral[]) {
  const totals = new Map<string, bigint>();
  let invalid = 0;
  for (const row of rows) {
    const raw = String(row.amount ?? "");
    if (!INTEGER_AMOUNT.test(raw)) {
      invalid += 1;
      continue;
    }
    const bucket =
      table === "transactions"
        ? `${row.token ?? "unknown"}|${row.status ?? "unknown"}`
        : `${row.type ?? "unknown"}`;
    totals.set(bucket, (totals.get(bucket) ?? 0n) + BigInt(raw));
  }
  const sortedTotals = Object.fromEntries(
    [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, v.toString()]),
  );
  return { amountTotals: sortedTotals, invalidAmountRows: invalid };
}

export async function captureSnapshot(dataSource: DataSource): Promise<Record<string, TableSnapshot>> {
  const tables: Record<string, TableSnapshot> = {};
  for (const [name, entity] of DRILL_TABLES) {
    let rows: ObjectLiteral[];
    try {
      rows = await dataSource.getRepository(entity).find();
    } catch {
      tables[name] = { available: false, rowCount: 0, checksum: "" };
      continue;
    }
    tables[name] = {
      available: true,
      rowCount: rows.length,
      checksum: checksumRows(rows),
      ...(FINANCIAL_TABLES.has(name) ? amountTotals(name, rows) : {}),
    };
  }
  return tables;
}

export async function captureBaseline(dataSource: DataSource, now = new Date()): Promise<DrillBaseline> {
  return {
    schema: DRILL_BASELINE_SCHEMA,
    version: DRILL_BASELINE_VERSION,
    capturedAt: now.toISOString(),
    tables: await captureSnapshot(dataSource),
  };
}

export function parseBaseline(raw: string): DrillBaseline {
  const parsed = JSON.parse(raw) as Partial<DrillBaseline>;
  if (parsed.schema !== DRILL_BASELINE_SCHEMA) {
    throw new Error(`Not a restore-drill baseline (schema "${String(parsed.schema)}")`);
  }
  if (parsed.version !== DRILL_BASELINE_VERSION) {
    throw new Error(
      `Unsupported baseline version ${String(parsed.version)}; expected ${DRILL_BASELINE_VERSION}. Re-capture it.`,
    );
  }
  if (!parsed.tables || typeof parsed.tables !== "object" || typeof parsed.capturedAt !== "string") {
    throw new Error("Malformed restore-drill baseline: missing tables or capturedAt");
  }
  return parsed as DrillBaseline;
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

export function compareSnapshots(
  baseline: Record<string, TableSnapshot>,
  restored: Record<string, TableSnapshot>,
): DrillFinding[] {
  const findings: DrillFinding[] = [];
  const critical = (checkId: string, table: string, message: string) =>
    findings.push({ checkId, severity: "critical", table, message });

  for (const [table, base] of Object.entries(baseline)) {
    const got = restored[table];
    if (!base.available) {
      findings.push({
        checkId: "table-unavailable-at-capture",
        severity: "warning",
        table,
        message: `${table} was unavailable when the baseline was captured; it was not verified.`,
      });
      continue;
    }
    if (!got || !got.available) {
      critical("table-missing", table, `${table} is missing or unreadable in the restored database.`);
      continue;
    }
    if (got.rowCount !== base.rowCount) {
      const diff = got.rowCount - base.rowCount;
      critical(
        "row-count-mismatch",
        table,
        `${table}: restored ${got.rowCount} row(s), baseline ${base.rowCount} (${diff > 0 ? "+" : ""}${diff}).`,
      );
    }
    if (got.checksum !== base.checksum) {
      critical("checksum-mismatch", table, `${table}: row contents differ from the baseline.`);
    }
    if (base.amountTotals) {
      const keys = new Set([...Object.keys(base.amountTotals), ...Object.keys(got.amountTotals ?? {})]);
      for (const key of [...keys].sort()) {
        const expected = base.amountTotals[key] ?? "0";
        const actual = got.amountTotals?.[key] ?? "0";
        if (expected !== actual) {
          critical(
            "financial-total-mismatch",
            table,
            `${table} [${key}]: restored total ${actual}, baseline ${expected}.`,
          );
        }
      }
    }
    if ((got.invalidAmountRows ?? 0) > 0) {
      critical(
        "invalid-amount",
        table,
        `${table}: ${got.invalidAmountRows} row(s) have a non-integer amount and can't be reconciled.`,
      );
    }
  }

  for (const table of Object.keys(restored)) {
    if (!(table in baseline)) {
      findings.push({
        checkId: "table-not-in-baseline",
        severity: "warning",
        table,
        message: `${table} exists in the restore but not in the baseline; re-capture to include it.`,
      });
    }
  }
  return findings;
}

export async function validateRestore(
  baseline: DrillBaseline,
  restored: DataSource,
  now = new Date(),
): Promise<DrillReport> {
  const snapshot = await captureSnapshot(restored);
  const findings = compareSnapshots(baseline.tables, snapshot);
  const audit = await runDatabaseConsistencyAudit(restored);
  return {
    generatedAt: now.toISOString(),
    baselineCapturedAt: baseline.capturedAt,
    tablesChecked: Object.keys(baseline.tables),
    findings,
    consistencyFindings: audit.findings,
    ok: audit.ok && !findings.some((f) => f.severity === "critical"),
  };
}

/** Validation must target an isolated restore, never the live database. */
export function assertRestoreTarget(env: NodeJS.ProcessEnv = process.env): void {
  if (env.RESTORE_DRILL_TARGET !== "restore") {
    throw new Error(
      "Refusing to validate: set RESTORE_DRILL_TARGET=restore and point DATABASE_URL at the restored copy.",
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

function option(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function runCli(): Promise<number> {
  const capturePath = option("--capture");
  const validatePath = option("--validate");
  const json = process.argv.includes("--json");
  if (Boolean(capturePath) === Boolean(validatePath)) {
    logger.error("Usage: restore-drill.ts --capture <baseline.json> | --validate <baseline.json> [--json]");
    return 2;
  }

  let baseline: DrillBaseline | undefined;
  if (validatePath) {
    try {
      assertRestoreTarget();
      baseline = parseBaseline(readFileSync(validatePath, "utf8"));
    } catch (error) {
      logger.error(error instanceof Error ? error.message : String(error));
      return 2;
    }
  }

  let dataSource: DataSource;
  try {
    dataSource = await initDatabase();
  } catch (error) {
    logger.error("Failed to connect to the database", {
      error: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
    });
    return 1;
  }

  try {
    if (capturePath) {
      const captured = await captureBaseline(dataSource);
      writeFileSync(capturePath, `${JSON.stringify(captured, null, 2)}\n`);
      logger.info("Restore-drill baseline captured", {
        path: capturePath,
        tables: Object.fromEntries(Object.entries(captured.tables).map(([t, s]) => [t, s.rowCount])),
      });
      return 0;
    }

    const report = await validateRestore(baseline as DrillBaseline, dataSource);
    if (json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      for (const f of [...report.findings, ...report.consistencyFindings]) {
        (f.severity === "critical" ? logger.error : logger.warn)(`[${f.checkId}] ${f.message}`);
      }
      logger.info(report.ok ? "Restore drill PASSED" : "Restore drill FAILED", {
        tablesChecked: report.tablesChecked,
        critical: [...report.findings, ...report.consistencyFindings].filter((f) => f.severity === "critical").length,
      });
    }
    return report.ok ? 0 : 1;
  } finally {
    await closeDatabase();
  }
}

const __filename = fileURLToPath(import.meta.url);
const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith("restore-drill.ts") ||
    process.argv[1].endsWith("restore-drill.js") ||
    process.argv[1] === __filename);

if (isDirectRun) {
  runCli()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      logger.error("Unexpected error running restore drill", {
        error: sanitizeErrorMessage(error instanceof Error ? error.message : String(error)),
      });
      process.exitCode = 1;
    });
}
