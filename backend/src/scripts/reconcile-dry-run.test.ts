import { describe, expect, it, vi } from "vitest";
import type { DataSource } from "typeorm";
import {
  exitCodeForReport,
  invariantFindings,
  orphanFindings,
  runReconciliationDryRun,
  type ReconciliationDryRunReport,
} from "./reconcile-dry-run.js";
import { evaluateLedgerBalance } from "../services/ledger-invariants.js";
import type { OrphanedTransactionsReport } from "./check-orphaned-transactions.js";
import { LEDGER_BLOCKS_MISSING_WARNING } from "./check-orphaned-transactions.js";
import { TransactionRecord } from "../entities/Transaction.js";
import { LedgerBlock } from "../entities/LedgerBlock.js";
import { User } from "../entities/User.js";

/**
 * Reconciliation dry-run (#1477).
 *
 * Verifies the three contractual promises of the command:
 *   1. non-mutating — repositories exposed to the implementation only ever
 *      provide `find()`; any insert/update/delete attempt would throw;
 *   2. consolidated output — both engines' findings appear in one report;
 *   3. exit semantics — 0 when clean (or warnings only), 1 when any
 *      critical inconsistency exists.
 *
 * Same mocked-DataSource style as check-orphaned-transactions.test.ts: no
 * live Postgres needed, so these always run (locally and in CI).
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

function mockDataSource(options: {
  transactions?: TransactionRecord[];
  ledgerBlocks?: LedgerBlock[] | (() => Promise<LedgerBlock[]>);
  users?: Array<{ walletAddress: string }>;
}): DataSource {
  const transactionFind = vi.fn().mockResolvedValue(options.transactions ?? []);
  const ledgerBlockFind =
    typeof options.ledgerBlocks === "function"
      ? vi.fn().mockImplementation(options.ledgerBlocks)
      : vi.fn().mockResolvedValue(options.ledgerBlocks ?? []);
  const userFind = vi.fn().mockResolvedValue(options.users ?? []);

  return {
    getRepository: vi.fn().mockImplementation((entity: unknown) => {
      // NOTE: only `find` exists on these mocks — deliberately. The dry-run
      // is contractually read-only; if it ever called save/insert/update/
      // delete/query, these tests would fail with a TypeError.
      if (entity === TransactionRecord) return { find: transactionFind };
      if (entity === LedgerBlock) return { find: ledgerBlockFind };
      if (entity === User) return { find: userFind };
      throw new Error("Unexpected entity requested from mock DataSource");
    }),
  } as unknown as DataSource;
}

function emptyOrphanReport(overrides: Partial<OrphanedTransactionsReport> = {}): OrphanedTransactionsReport {
  return {
    ledgerBlocksTableAvailable: true,
    completedTransactionsMissingLedgerBlock: [],
    settlementLedgerBlocksMissingTransaction: [],
    unregisteredRecipients: { count: 0, sampleMasked: [] },
    warnings: [],
    ...overrides,
  };
}

describe("runReconciliationDryRun — success case", () => {
  it("reports ok with zero findings when the ledger is fully reconciled", async () => {
    const dataSource = mockDataSource({
      transactions: [tx({ amount: "100" })],
      ledgerBlocks: [block({ amount: "100" })],
      users: [{ walletAddress: RECIPIENT_A }],
    });

    const report = await runReconciliationDryRun(dataSource);

    expect(report.mode).toBe("dry-run");
    expect(report.ok).toBe(true);
    expect(report.findings.filter((f) => f.severity === "critical")).toEqual([]);
    expect(report.checksRun).toEqual(["ledger-balancing-invariants", "transaction-ledger-reconciliation"]);
    expect(exitCodeForReport(report)).toBe(0);
  });

  it("performs only read operations (non-mutating guarantee)", async () => {
    const dataSource = mockDataSource({
      transactions: [tx()],
      ledgerBlocks: [block()],
    });
    await runReconciliationDryRun(dataSource);
    // If the implementation had attempted any write, getRepository mocks
    // (which expose ONLY `find`) would have thrown. Reaching a report at all
    // is the proof; additionally assert the reads were plain find() calls.
    const repos = (dataSource.getRepository as ReturnType<typeof vi.fn>).mock.results.map(
      (r) => r.value
    );
    for (const repo of repos) {
      expect(Object.keys(repo)).toEqual(["find"]);
    }
  });
});

describe("runReconciliationDryRun — critical inconsistencies", () => {
  it("flags a completed transaction with no settlement and exits 1", async () => {
    const dataSource = mockDataSource({
      transactions: [tx({ txHash: "hash-orphan" })],
      ledgerBlocks: [], // no settlement rows at all
      users: [],
    });

    const report = await runReconciliationDryRun(dataSource);

    expect(report.ok).toBe(false);
    const finding = report.findings.find((f) => f.checkId === "completed-missing-settlement");
    expect(finding).toBeDefined();
    expect(finding?.severity).toBe("critical");
    expect(finding?.count).toBe(1);
    expect(exitCodeForReport(report)).toBe(1);
  });

  it("flags an amount mismatch via the invariant engine and exits 1", async () => {
    const dataSource = mockDataSource({
      transactions: [tx({ amount: "100" })],
      ledgerBlocks: [block({ amount: "90" })],
      users: [{ walletAddress: RECIPIENT_A }],
    });

    const report = await runReconciliationDryRun(dataSource);

    expect(report.ok).toBe(false);
    expect(report.findings.some((f) => f.checkId === "INV-3-amount-match")).toBe(true);
    expect(exitCodeForReport(report)).toBe(1);
  });

  it("flags a failed payout that has a settlement entry", async () => {
    const dataSource = mockDataSource({
      transactions: [tx({ status: "failed" })],
      ledgerBlocks: [block()],
      users: [{ walletAddress: RECIPIENT_A }],
    });

    const report = await runReconciliationDryRun(dataSource);
    expect(report.findings.some((f) => f.checkId === "INV-4-failed-not-settled")).toBe(true);
  });
});

describe("runReconciliationDryRun — degraded environments", () => {
  it("tolerates a missing ledger_blocks table: warns, skips orphan checks, still exits 0", async () => {
    const dataSource = mockDataSource({
      transactions: [tx({ status: "pending" })],
      ledgerBlocks: async () => {
        const error = new Error('relation "ledger_blocks" does not exist') as Error & { code: string };
        error.code = "42P01";
        throw error;
      },
      users: [],
    });

    const report = await runReconciliationDryRun(dataSource);

    expect(report.checksRun).toEqual(["ledger-balancing-invariants"]);
    const warning = report.findings.find((f) => f.checkId === "ledger-blocks-unavailable");
    expect(warning?.severity).toBe("warning");
    expect(warning?.message).toBe(LEDGER_BLOCKS_MISSING_WARNING);
    // Warnings alone never flip the exit code.
    expect(report.ok).toBe(true);
    expect(exitCodeForReport(report)).toBe(0);
  });

  it("re-throws unexpected (non-42P01) ledger_blocks errors", async () => {
    const dataSource = mockDataSource({
      transactions: [],
      ledgerBlocks: async () => {
        throw new Error("connection terminated unexpectedly");
      },
      users: [],
    });

    await expect(runReconciliationDryRun(dataSource)).rejects.toThrow(
      "connection terminated unexpectedly"
    );
  });
});

describe("exitCodeForReport", () => {
  const base: ReconciliationDryRunReport = {
    generatedAt: "2026-01-10T00:00:00.000Z",
    mode: "dry-run",
    checksRun: [],
    findings: [],
    ok: true,
  };

  it("returns 0 for a clean report and for warning-only reports", () => {
    expect(exitCodeForReport(base)).toBe(0);
    expect(
      exitCodeForReport({
        ...base,
        ok: true,
        findings: [{ checkId: "x", severity: "warning", message: "heads up" }],
      })
    ).toBe(0);
  });

  it("returns 1 when ok is false", () => {
    expect(
      exitCodeForReport({
        ...base,
        ok: false,
        findings: [{ checkId: "x", severity: "critical", message: "broken" }],
      })
    ).toBe(1);
  });
});

describe("orphanFindings / invariantFindings — report translation", () => {
  it("translates every hard-orphan list into a critical finding with masked samples", () => {
    const findings = orphanFindings(
      emptyOrphanReport({
        completedTransactionsMissingLedgerBlock: [
          { id: "t1", roundId: "r1", txHash: "h1", recipientMasked: "GA1111...AAAA", timestamp: 1 },
        ],
        settlementLedgerBlocksMissingTransaction: [
          {
            id: "b1",
            ledgerSeq: 1,
            txHash: "h2",
            ledgerClosedAt: new Date("2026-01-01T00:00:00Z"),
          },
        ],
        unregisteredRecipients: { count: 2, sampleMasked: ["GA1111...AAAA"] },
      })
    );

    const critical = findings.filter((f) => f.severity === "critical");
    expect(critical.map((f) => f.checkId)).toEqual([
      "completed-missing-settlement",
      "settlement-missing-transaction",
    ]);
    // Samples must never contain a full wallet address.
    for (const f of findings) {
      for (const sample of f.sampleIds ?? []) {
        expect(sample).not.toMatch(/^G[A-Z2-7]{55}$/);
      }
    }
    // Informational recipient drift is a warning, not a critical.
    expect(findings.find((f) => f.checkId === "unregistered-recipients")?.severity).toBe("warning");
  });

  it("groups invariant violations by invariant id with correct severity", () => {
    const balance = evaluateLedgerBalance(
      [tx({ amount: "0" })], // INV-2 violation (zero completed payout)
      []
    );
    const findings = invariantFindings(balance);
    expect(findings).toHaveLength(1);
    expect(findings[0].checkId).toBe("INV-2-nonzero-completed-amount");
    expect(findings[0].severity).toBe("critical");
    expect(findings[0].count).toBe(1);
  });
});
