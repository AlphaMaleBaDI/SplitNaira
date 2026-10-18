import { describe, expect, it, vi } from "vitest";
import type { DataSource } from "typeorm";
import {
  checkOrphanedTransactions,
  maskWalletAddress,
  sanitizeErrorMessage,
  LEDGER_BLOCKS_MISSING_WARNING,
  parseOrphanedTransactionsCliOptions,
} from "./check-orphaned-transactions.js";
import { TransactionRecord } from "../entities/Transaction.js";
import { LedgerBlock } from "../entities/LedgerBlock.js";
import { User } from "../entities/User.js";

// This is a mocked-repository unit test, not a live-DB integration test.
// Rationale: checkOrphanedTransactions() only ever calls repo.find(), so a
// plain object with a mocked `find` per entity fully exercises the real
// query/detection logic without needing a live Postgres connection on every
// CI run (see backend/src/services/database.test.ts for the same style of
// DataSource-internals mocking used elsewhere in this codebase). The repo has
// no sqlite/in-memory TypeORM driver installed, and a real Postgres
// connection is only available in CI via `DATABASE_URL` + `CI=true`
// (see health.ready.integration.test.ts) — this test intentionally avoids
// that dependency so it always runs.

const RECIPIENT_A = "GA111111111111111111111111111111111111111111111111AAAA";
const RECIPIENT_B = "GB222222222222222222222222222222222222222222222222BBBB";
const RECIPIENT_C = "GC333333333333333333333333333333333333333333333333CCCC";

function makeTransaction(overrides: Partial<TransactionRecord>): TransactionRecord {
  return {
    id: "tx-id-1",
    roundId: "round-1",
    recipient: RECIPIENT_A,
    amount: "1000",
    token: "native",
    timestamp: 1732012800,
    txHash: "hash-1",
    status: "completed",
    ...overrides,
  } as TransactionRecord;
}

function makeLedgerBlock(overrides: Partial<LedgerBlock>): LedgerBlock {
  return {
    id: "block-id-1",
    ledgerSeq: 100,
    txHash: "hash-1",
    type: "settlement",
    projectId: "project-1",
    recipient: RECIPIENT_A,
    amount: "1000",
    ledgerClosedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  } as LedgerBlock;
}

interface MockRepos {
  dataSource: DataSource;
  transactionFind: ReturnType<typeof vi.fn>;
  ledgerBlockFind: ReturnType<typeof vi.fn>;
  userFind: ReturnType<typeof vi.fn>;
}

function buildMockDataSource(options: {
  transactions?: TransactionRecord[];
  ledgerBlocks?: LedgerBlock[] | (() => Promise<LedgerBlock[]>);
  users?: Array<{ walletAddress: string }>;
}): MockRepos {
  const transactionFind = vi.fn().mockResolvedValue(options.transactions ?? []);
  const ledgerBlockFind =
    typeof options.ledgerBlocks === "function"
      ? vi.fn().mockImplementation(options.ledgerBlocks)
      : vi.fn().mockResolvedValue(options.ledgerBlocks ?? []);
  const userFind = vi.fn().mockImplementation(async (query: { where?: { walletAddress?: { value?: string[] } } }) => {
    const allUsers = options.users ?? [];
    // typeorm's In() operator wraps values in a FindOperator whose `.value`
    // getter returns the underlying array — use it directly.
    const requested: string[] | undefined = query?.where?.walletAddress?.value;
    if (!requested) return allUsers;
    return allUsers.filter((u) => requested.includes(u.walletAddress));
  });

  const dataSource = {
    getRepository: vi.fn().mockImplementation((entity: unknown) => {
      if (entity === TransactionRecord) return { find: transactionFind };
      if (entity === LedgerBlock) return { find: ledgerBlockFind };
      if (entity === User) return { find: userFind };
      throw new Error("Unexpected entity requested from mock DataSource");
    }),
  } as unknown as DataSource;

  return { dataSource, transactionFind, ledgerBlockFind, userFind };
}

describe("maskWalletAddress", () => {
  it("shows first 6 and last 4 characters, masking the middle", () => {
    expect(maskWalletAddress(RECIPIENT_A)).toBe("GA1111...AAAA");
  });

  it("returns short/empty input unchanged rather than over-masking", () => {
    expect(maskWalletAddress("")).toBe("(none)");
    expect(maskWalletAddress("short")).toBe("short");
  });
});

describe("sanitizeErrorMessage", () => {
  it("redacts credential-bearing connection strings", () => {
    const message = 'connect ECONNREFUSED to postgresql://user:secret@localhost:5432/splitnaira';
    expect(sanitizeErrorMessage(message)).toBe(
      "connect ECONNREFUSED to [CONNECTION_STRING_REDACTED]"
    );
    expect(sanitizeErrorMessage(message)).not.toContain("secret");
  });

  it("leaves ordinary error messages untouched", () => {
    expect(sanitizeErrorMessage("relation \"ledger_blocks\" does not exist")).toBe(
      "relation \"ledger_blocks\" does not exist"
    );
  });
});

describe("parseOrphanedTransactionsCliOptions", () => {
  it("preserves the default read-only check mode", () => {
    expect(parseOrphanedTransactionsCliOptions([])).toEqual({ cleanupPreview: false });
  });

  it("accepts the explicit cleanup preview as a read-only mode", () => {
    expect(parseOrphanedTransactionsCliOptions(["--cleanup-preview"])).toEqual({
      cleanupPreview: true,
    });
  });

  it.each(["--apply", "--cleanup", "--delete"])(
    "rejects the destructive %s option",
    (flag) => {
      expect(() => parseOrphanedTransactionsCliOptions([flag])).toThrow(
        "Destructive orphan cleanup is not supported"
      );
    }
  );

  it("rejects unknown and combined options rather than silently proceeding", () => {
    expect(() => parseOrphanedTransactionsCliOptions(["--preview"])).toThrow(
      "Unsupported orphan-check option(s)"
    );
    expect(() =>
      parseOrphanedTransactionsCliOptions(["--cleanup-preview", "--delete"])
    ).toThrow("Destructive orphan cleanup is not supported");
  });
});

describe("checkOrphanedTransactions", () => {
  it("does not flag a completed transaction that has a matching ledger_blocks row", async () => {
    const { dataSource } = buildMockDataSource({
      transactions: [makeTransaction({ txHash: "hash-1", status: "completed" })],
      ledgerBlocks: [makeLedgerBlock({ txHash: "hash-1", type: "settlement" })],
      users: [{ walletAddress: RECIPIENT_A }],
    });

    const report = await checkOrphanedTransactions(dataSource);

    expect(report.ledgerBlocksTableAvailable).toBe(true);
    expect(report.completedTransactionsMissingLedgerBlock).toHaveLength(0);
    expect(report.settlementLedgerBlocksMissingTransaction).toHaveLength(0);
  });

  it("flags a completed transaction with NO matching ledger_blocks row", async () => {
    const { dataSource } = buildMockDataSource({
      transactions: [
        makeTransaction({ id: "tx-orphan", txHash: "hash-missing", status: "completed", recipient: RECIPIENT_B }),
      ],
      // An unrelated milestone block (not settlement) so this fixture only
      // exercises condition 1, not the reverse condition 2 as well.
      ledgerBlocks: [makeLedgerBlock({ txHash: "hash-other", type: "milestone" })],
      users: [],
    });

    const report = await checkOrphanedTransactions(dataSource);

    expect(report.completedTransactionsMissingLedgerBlock).toHaveLength(1);
    expect(report.completedTransactionsMissingLedgerBlock[0]).toMatchObject({
      id: "tx-orphan",
      txHash: "hash-missing",
      recipientMasked: maskWalletAddress(RECIPIENT_B),
    });
    expect(report.settlementLedgerBlocksMissingTransaction).toHaveLength(0);
  });

  it("does not flag pending/failed transactions missing a ledger_blocks row", async () => {
    const { dataSource } = buildMockDataSource({
      transactions: [
        makeTransaction({ id: "tx-pending", txHash: "hash-pending", status: "pending" }),
        makeTransaction({ id: "tx-failed", txHash: "hash-failed", status: "failed" }),
      ],
      ledgerBlocks: [],
      users: [],
    });

    const report = await checkOrphanedTransactions(dataSource);

    expect(report.completedTransactionsMissingLedgerBlock).toHaveLength(0);
  });

  it("flags a settlement ledger_blocks row with no matching transactions row", async () => {
    const { dataSource } = buildMockDataSource({
      transactions: [makeTransaction({ txHash: "hash-known", status: "completed" })],
      ledgerBlocks: [
        makeLedgerBlock({ id: "block-orphan", txHash: "hash-unmatched", type: "settlement", recipient: RECIPIENT_C }),
      ],
      users: [],
    });

    const report = await checkOrphanedTransactions(dataSource);

    expect(report.settlementLedgerBlocksMissingTransaction).toHaveLength(1);
    expect(report.settlementLedgerBlocksMissingTransaction[0]).toMatchObject({
      id: "block-orphan",
      txHash: "hash-unmatched",
      recipientMasked: maskWalletAddress(RECIPIENT_C),
    });
  });

  it("does not flag a milestone-type ledger_blocks row missing a transaction (only settlement type counts)", async () => {
    const { dataSource } = buildMockDataSource({
      transactions: [],
      ledgerBlocks: [makeLedgerBlock({ txHash: "hash-milestone", type: "milestone" })],
      users: [],
    });

    const report = await checkOrphanedTransactions(dataSource);

    expect(report.settlementLedgerBlocksMissingTransaction).toHaveLength(0);
  });

  it("reports ledgerBlocksTableAvailable=false and adds a warning instead of crashing when ledger_blocks doesn't exist", async () => {
    const { dataSource } = buildMockDataSource({
      transactions: [makeTransaction({ txHash: "hash-1", status: "completed" })],
      ledgerBlocks: async () => {
        const error = new Error('relation "ledger_blocks" does not exist') as Error & { code: string };
        error.code = "42P01";
        throw error;
      },
      users: [],
    });

    const report = await checkOrphanedTransactions(dataSource);

    expect(report.ledgerBlocksTableAvailable).toBe(false);
    expect(report.warnings).toContain(LEDGER_BLOCKS_MISSING_WARNING);
    // With the table unavailable, neither hard-orphan list should be
    // populated (no false positives from a missing cross-check source).
    expect(report.completedTransactionsMissingLedgerBlock).toHaveLength(0);
    expect(report.settlementLedgerBlocksMissingTransaction).toHaveLength(0);
  });

  it("re-throws unexpected (non-42P01) ledger_blocks query errors", async () => {
    const { dataSource } = buildMockDataSource({
      transactions: [],
      ledgerBlocks: async () => {
        throw new Error("connection terminated unexpectedly");
      },
      users: [],
    });

    await expect(checkOrphanedTransactions(dataSource)).rejects.toThrow(
      "connection terminated unexpectedly"
    );
  });

  it("reports unregistered recipients as an informational, masked count/sample (not a hard orphan)", async () => {
    const { dataSource } = buildMockDataSource({
      transactions: [
        makeTransaction({ id: "tx-1", txHash: "hash-1", recipient: RECIPIENT_A, status: "completed" }),
        makeTransaction({ id: "tx-2", txHash: "hash-2", recipient: RECIPIENT_B, status: "completed" }),
      ],
      ledgerBlocks: [
        makeLedgerBlock({ txHash: "hash-1", recipient: RECIPIENT_A, type: "settlement" }),
        makeLedgerBlock({ id: "block-2", txHash: "hash-2", recipient: RECIPIENT_B, type: "settlement" }),
      ],
      users: [{ walletAddress: RECIPIENT_A }], // RECIPIENT_B is not a registered user
    });

    const report = await checkOrphanedTransactions(dataSource);

    expect(report.unregisteredRecipients.count).toBe(1);
    expect(report.unregisteredRecipients.sampleMasked).toEqual([maskWalletAddress(RECIPIENT_B)]);
    // Sample must never contain the full, unmasked wallet address.
    expect(report.unregisteredRecipients.sampleMasked[0]).not.toBe(RECIPIENT_B);
    // A registered recipient's transaction is still fully reconciled.
    expect(report.completedTransactionsMissingLedgerBlock).toHaveLength(0);
  });
});
