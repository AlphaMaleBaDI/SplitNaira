/**
 * Data integrity check for orphaned transaction records (#937).
 *
 * `transactions` (TransactionRecord) has no real foreign keys: `roundId` and
 * `recipient` are plain varchars pointing at on-chain Soroban state, not at
 * any local table (there are zero `@ManyToOne`/`@JoinColumn` relations
 * anywhere in `src/entities`). So the classic "dangling FK" definition of
 * "orphaned" does not apply here.
 *
 * What *can* legitimately drift is reconciliation between the two places a
 * completed distribution might be recorded:
 *   - `transactions`, written by this app when it observes a payout, and
 *   - `ledger_blocks`, which this repo only ever *reads* from
 *     (`services/ledger.service.ts`, `routes/ledger.ts`) and never writes to,
 *     and which — notably — has NO migration creating it at all (see
 *     `src/migrations/`). On a freshly migrated database the table will not
 *     exist; this script treats that as a first-class, clearly reported
 *     condition rather than a crash.
 *
 * Detected conditions:
 *   1. A `completed` transaction with no matching `ledger_blocks` row
 *      (by `txHash`) — the app believes a payout settled but there is no
 *      independent on-chain settlement record on file.
 *   2. A `settlement`-type `ledger_blocks` row with no matching
 *      `transactions` row (by `txHash`) — the reverse drift signal.
 *   3. (Informational only, not a hard orphan) recipient wallet addresses
 *      referenced by `transactions`/`ledger_blocks` with no matching
 *      `users.walletAddress` row. Recipients are wallet addresses and are
 *      NOT required to be registered users anywhere in this codebase
 *      (`routes/transactions.ts` never checks `users` before accepting or
 *      returning a transaction), so this is reported as a count/sample only.
 *
 * Run standalone:
 *   cd backend && npx tsx src/scripts/check-orphaned-transactions.ts
 *   cd backend && npx tsx src/scripts/check-orphaned-transactions.ts --cleanup-preview
 *
 * Both invocations are read-only. The preview flag makes the cleanup intent
 * explicit but never changes or deletes records; see
 * docs/orphaned-transaction-remediation.md for why automatic deletion is
 * unsafe and how to remediate findings.
 */
import "reflect-metadata";
import { fileURLToPath } from "url";
import { In, type DataSource } from "typeorm";
import { TransactionRecord } from "../entities/Transaction.js";
import { LedgerBlock } from "../entities/LedgerBlock.js";
import { User } from "../entities/User.js";
import { initDatabase, closeDatabase } from "../services/database.js";
import { logger } from "../services/logger.js";

/** Postgres error code for "relation does not exist" (undefined_table). */
const UNDEFINED_TABLE_ERROR_CODE = "42P01";

export const LEDGER_BLOCKS_MISSING_WARNING =
  "The ledger_blocks table does not exist in this database (no migration in " +
  "src/migrations currently creates it). Cross-checks between transactions " +
  "and ledger_blocks were skipped for this run.";

/**
 * Masks a wallet address for safe display: first 6 + last 4 characters,
 * mirroring the truncation convention already used in
 * frontend/src/components/projects/ProjectsList.tsx.
 */
export function maskWalletAddress(address: string): string {
  if (!address) return "(none)";
  if (address.length <= 10) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export interface CompletedTransactionMissingLedgerBlock {
  id: string;
  roundId: string;
  txHash: string;
  recipientMasked: string;
  timestamp: number;
}

export interface SettlementLedgerBlockMissingTransaction {
  id: string;
  ledgerSeq: number;
  txHash: string;
  projectId?: string;
  recipientMasked?: string;
  ledgerClosedAt: Date;
}

export interface UnregisteredRecipientsSummary {
  count: number;
  sampleMasked: string[];
}

export interface OrphanedTransactionsReport {
  /** Whether the ledger_blocks table could be queried at all. */
  ledgerBlocksTableAvailable: boolean;
  completedTransactionsMissingLedgerBlock: CompletedTransactionMissingLedgerBlock[];
  settlementLedgerBlocksMissingTransaction: SettlementLedgerBlockMissingTransaction[];
  /** Informational only — recipients need not be registered users. */
  unregisteredRecipients: UnregisteredRecipientsSummary;
  warnings: string[];
}

function isUndefinedTableError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === UNDEFINED_TABLE_ERROR_CODE
  );
}

const WALLET_LOOKUP_CHUNK_SIZE = 1000;

export interface OrphanedTransactionsCliOptions {
  cleanupPreview: boolean;
}

const DISABLED_DESTRUCTIVE_FLAGS = new Set(["--apply", "--cleanup", "--delete"]);

export function parseOrphanedTransactionsCliOptions(
  args: readonly string[]
): OrphanedTransactionsCliOptions {
  const destructiveFlag = args.find((arg) => DISABLED_DESTRUCTIVE_FLAGS.has(arg));
  if (destructiveFlag) {
    throw new Error(
      `Destructive orphan cleanup is not supported (${destructiveFlag}); review findings and remediate them manually.`
    );
  }

  if (args.length === 0) return { cleanupPreview: false };
  if (args.length === 1 && args[0] === "--cleanup-preview") {
    return { cleanupPreview: true };
  }

  throw new Error(`Unsupported orphan-check option(s): ${args.join(" ")}`);
}

async function findExistingWalletAddresses(
  userRepo: ReturnType<DataSource["getRepository"]>,
  addresses: string[]
): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < addresses.length; i += WALLET_LOOKUP_CHUNK_SIZE) {
    const chunk = addresses.slice(i, i + WALLET_LOOKUP_CHUNK_SIZE);
    if (chunk.length === 0) continue;
    const rows = await userRepo.find({ where: { walletAddress: In(chunk) } });
    for (const row of rows as Array<{ walletAddress: string }>) {
      found.add(row.walletAddress);
    }
  }
  return found;
}

/**
 * Core detection logic, extracted so it can be exercised directly in tests
 * against a mocked DataSource/repository set (see the co-located test file)
 * without requiring a live Postgres connection.
 *
 * Note on scale: this loads the full `transactions` and `ledger_blocks`
 * tables into memory to diff by txHash in JS. That's fine for an
 * occasional/cron-style integrity check at this project's current data
 * volume; if either table grows very large, consider windowing this by a
 * timestamp/ledgerSeq range instead of scanning the whole table.
 */
export async function checkOrphanedTransactions(
  dataSource: DataSource
): Promise<OrphanedTransactionsReport> {
  const warnings: string[] = [];
  const transactionRepo = dataSource.getRepository(TransactionRecord);
  const ledgerBlockRepo = dataSource.getRepository(LedgerBlock);
  const userRepo = dataSource.getRepository(User);

  const transactions = await transactionRepo.find();

  let ledgerBlocksTableAvailable = true;
  let ledgerBlocks: LedgerBlock[] = [];
  try {
    ledgerBlocks = await ledgerBlockRepo.find();
  } catch (error) {
    if (isUndefinedTableError(error)) {
      ledgerBlocksTableAvailable = false;
      warnings.push(LEDGER_BLOCKS_MISSING_WARNING);
    } else {
      throw error;
    }
  }

  const ledgerBlockTxHashes = new Set(ledgerBlocks.map((b) => b.txHash));
  const transactionTxHashes = new Set(transactions.map((t) => t.txHash));

  const completedTransactionsMissingLedgerBlock: CompletedTransactionMissingLedgerBlock[] =
    ledgerBlocksTableAvailable
      ? transactions
          .filter((t) => t.status === "completed" && !ledgerBlockTxHashes.has(t.txHash))
          .map((t) => ({
            id: t.id,
            roundId: t.roundId,
            txHash: t.txHash,
            recipientMasked: maskWalletAddress(t.recipient),
            timestamp: t.timestamp,
          }))
      : [];

  const settlementLedgerBlocksMissingTransaction: SettlementLedgerBlockMissingTransaction[] =
    ledgerBlocksTableAvailable
      ? ledgerBlocks
          .filter((b) => b.type === "settlement" && !transactionTxHashes.has(b.txHash))
          .map((b) => ({
            id: b.id,
            ledgerSeq: b.ledgerSeq,
            txHash: b.txHash,
            projectId: b.projectId,
            recipientMasked: b.recipient ? maskWalletAddress(b.recipient) : undefined,
            ledgerClosedAt: b.ledgerClosedAt,
          }))
      : [];

  const distinctRecipients = Array.from(
    new Set<string>([
      ...transactions.map((t) => t.recipient),
      ...ledgerBlocks.map((b) => b.recipient).filter((r): r is string => Boolean(r)),
    ])
  );

  const existingWallets = await findExistingWalletAddresses(userRepo, distinctRecipients);
  const unregistered = distinctRecipients.filter((r) => !existingWallets.has(r));

  return {
    ledgerBlocksTableAvailable,
    completedTransactionsMissingLedgerBlock,
    settlementLedgerBlocksMissingTransaction,
    unregisteredRecipients: {
      count: unregistered.length,
      sampleMasked: unregistered.slice(0, 5).map(maskWalletAddress),
    },
    warnings,
  };
}

/**
 * Strips anything that looks like a credential-bearing connection string
 * (e.g. `postgresql://user:pass@host/db`) from an error message before it is
 * logged, so a raw connection failure can never leak DATABASE_URL contents.
 */
export function sanitizeErrorMessage(message: string): string {
  return message.replace(/[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s]*@[^\s]*/g, "[CONNECTION_STRING_REDACTED]");
}

function printReport(report: OrphanedTransactionsReport): void {
  logger.info("Orphaned transaction integrity check summary", {
    ledgerBlocksTableAvailable: report.ledgerBlocksTableAvailable,
    completedTransactionsMissingLedgerBlockCount: report.completedTransactionsMissingLedgerBlock.length,
    settlementLedgerBlocksMissingTransactionCount: report.settlementLedgerBlocksMissingTransaction.length,
    unregisteredRecipientsCount: report.unregisteredRecipients.count,
  });

  for (const warning of report.warnings) {
    logger.warn(warning);
  }

  if (report.completedTransactionsMissingLedgerBlock.length > 0) {
    logger.warn(
      `Found ${report.completedTransactionsMissingLedgerBlock.length} completed transaction(s) with no matching ledger_blocks settlement record:`
    );
    for (const tx of report.completedTransactionsMissingLedgerBlock) {
      logger.warn(
        `  id=${tx.id} roundId=${tx.roundId} txHash=${tx.txHash} recipient=${tx.recipientMasked} timestamp=${tx.timestamp}`
      );
    }
  }

  if (report.settlementLedgerBlocksMissingTransaction.length > 0) {
    logger.warn(
      `Found ${report.settlementLedgerBlocksMissingTransaction.length} settlement ledger_blocks row(s) with no matching transactions row:`
    );
    for (const b of report.settlementLedgerBlocksMissingTransaction) {
      logger.warn(
        `  id=${b.id} ledgerSeq=${b.ledgerSeq} txHash=${b.txHash} projectId=${b.projectId ?? "-"} recipient=${b.recipientMasked ?? "-"}`
      );
    }
  }

  if (report.unregisteredRecipients.count > 0) {
    logger.info(
      `Informational: ${report.unregisteredRecipients.count} distinct recipient wallet(s) referenced in ` +
        `transactions/ledger_blocks have no matching users row (sample: ${report.unregisteredRecipients.sampleMasked.join(", ")}). ` +
        "This is expected — recipients are not required to be registered users in this system."
    );
  }
}

async function runCli(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  let options: OrphanedTransactionsCliOptions;
  try {
    options = parseOrphanedTransactionsCliOptions(args);
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  if (options.cleanupPreview) {
    logger.info(
      "Cleanup preview is read-only; findings require manual review and no database rows will be changed."
    );
  }

  let dataSource: DataSource;
  try {
    dataSource = await initDatabase();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Failed to connect to the database", { error: sanitizeErrorMessage(message) });
    return 1;
  }

  try {
    const report = await checkOrphanedTransactions(dataSource);
    printReport(report);
    const hasFindings =
      report.completedTransactionsMissingLedgerBlock.length > 0 ||
      report.settlementLedgerBlocksMissingTransaction.length > 0;
    return hasFindings ? 1 : 0;
  } finally {
    await closeDatabase();
  }
}

const __filename = fileURLToPath(import.meta.url);
const isDirectRun =
  process.argv[1] &&
  (process.argv[1].endsWith("check-orphaned-transactions.ts") ||
    process.argv[1].endsWith("check-orphaned-transactions.js") ||
    process.argv[1] === __filename);

if (isDirectRun) {
  runCli()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Unexpected error running orphaned transaction check", {
        error: sanitizeErrorMessage(message),
      });
      process.exitCode = 1;
    });
}
