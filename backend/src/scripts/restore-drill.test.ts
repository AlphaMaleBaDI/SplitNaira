import { describe, expect, it, vi } from "vitest";
import type { DataSource } from "typeorm";

import {
  DRILL_BASELINE_SCHEMA,
  DRILL_BASELINE_VERSION,
  DRILL_TABLES,
  assertRestoreTarget,
  captureBaseline,
  checksumRows,
  compareSnapshots,
  parseBaseline,
  validateRestore,
} from "./restore-drill.js";
import { User } from "../entities/User.js";
import { TransactionRecord } from "../entities/Transaction.js";
import { LedgerBlock } from "../entities/LedgerBlock.js";

// Mocked-repository test, same approach as audit-database-consistency.test.ts:
// the drill only calls repo.find(), so a per-entity mocked `find` exercises
// the real snapshot/compare logic without a live Postgres.

const WALLET = "GA111111111111111111111111111111111111111111111111AAAA";

type Rows = Record<string, unknown>[];
interface Fixture {
  users?: Rows;
  transactions?: Rows;
  ledgerBlocks?: Rows;
  /** Entities whose find() rejects (table missing). */
  missing?: unknown[];
}

const tx = (id: string, amount: string, extra: Record<string, unknown> = {}) => ({
  id,
  roundId: "round-1",
  recipient: WALLET,
  amount,
  token: "native",
  timestamp: 1732012800,
  txHash: `hash-${id}`,
  status: "completed",
  ...extra,
});
const block = (id: string, txHash: string, amount: string) => ({
  id,
  ledgerSeq: 100,
  txHash,
  type: "settlement",
  projectId: "project-1",
  recipient: WALLET,
  amount,
  ledgerClosedAt: new Date("2026-01-01T00:00:00Z"),
});
const user = (id: string, walletAddress = WALLET) => ({ id, walletAddress, role: "user", isActive: true });

function dataSource(f: Fixture): DataSource & { writes: ReturnType<typeof vi.fn> } {
  const writes = vi.fn();
  const rows = new Map<unknown, Rows>([
    [User, f.users ?? []],
    [TransactionRecord, f.transactions ?? []],
    [LedgerBlock, f.ledgerBlocks ?? []],
  ]);
  return {
    writes,
    getRepository: (entity: unknown) => ({
      find: f.missing?.includes(entity)
        ? vi.fn().mockRejectedValue(new Error('relation does not exist'))
        : vi.fn().mockResolvedValue(structuredClone(rows.get(entity) ?? [])),
      save: writes,
      delete: writes,
      insert: writes,
      update: writes,
      remove: writes,
    }),
  } as unknown as DataSource & { writes: ReturnType<typeof vi.fn> };
}

const healthy: Fixture = {
  users: [user("u1"), user("u2", "GB222222222222222222222222222222222222222222222222BBBB")],
  transactions: [tx("t1", "1000"), tx("t2", "2500")],
  ledgerBlocks: [block("b1", "hash-t1", "1000"), block("b2", "hash-t2", "2500")],
};

async function drill(source: Fixture, restored: Fixture) {
  const baseline = await captureBaseline(dataSource(source), new Date("2026-10-20T00:00:00Z"));
  return validateRestore(baseline, dataSource(restored));
}

const checkIds = (report: { findings: { checkId: string }[] }) => report.findings.map((f) => f.checkId);

describe("restore drill: success", () => {
  it("passes when the restore is identical to the baseline", async () => {
    const report = await drill(healthy, structuredClone(healthy));
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.tablesChecked).toEqual(DRILL_TABLES.map(([name]) => name));
  });

  it("is order-independent: restored rows in a different order still match", async () => {
    const shuffled = { ...structuredClone(healthy), transactions: [...healthy.transactions!].reverse() };
    expect((await drill(healthy, shuffled)).ok).toBe(true);
  });

  it("passes for an empty database restored as empty (boundary)", async () => {
    expect((await drill({}, {})).ok).toBe(true);
  });

  it("never writes to the restored database", async () => {
    const restored = dataSource(healthy);
    const baseline = await captureBaseline(dataSource(healthy));
    await validateRestore(baseline, restored);
    expect(restored.writes).not.toHaveBeenCalled();
  });
});

describe("restore drill: failure", () => {
  it("flags a lost row by count and checksum", async () => {
    const restored = { ...structuredClone(healthy), users: [user("u1")] };
    const report = await drill(healthy, restored);
    expect(report.ok).toBe(false);
    expect(checkIds(report)).toEqual(expect.arrayContaining(["row-count-mismatch", "checksum-mismatch"]));
    expect(report.findings.find((f) => f.checkId === "row-count-mismatch")?.message).toMatch(/\(-1\)/);
  });

  it("flags an extra row", async () => {
    const restored = { ...structuredClone(healthy), users: [...healthy.users!, user("u3")] };
    const report = await drill(healthy, restored);
    expect(report.findings.find((f) => f.checkId === "row-count-mismatch")?.message).toMatch(/\(\+1\)/);
  });

  it("flags a silently altered amount even when row counts match", async () => {
    const restored = structuredClone(healthy);
    restored.transactions![1] = tx("t2", "2501");
    const report = await drill(healthy, restored);
    expect(report.ok).toBe(false);
    expect(checkIds(report)).not.toContain("row-count-mismatch");
    const financial = report.findings.filter((f) => f.checkId === "financial-total-mismatch");
    expect(financial).toHaveLength(1);
    expect(financial[0].message).toMatch(/native\|completed.*restored total 3501, baseline 3500/);
  });

  it("flags a status change that moves funds between buckets", async () => {
    const restored = structuredClone(healthy);
    restored.transactions![0] = tx("t1", "1000", { status: "pending" });
    const report = await drill(healthy, restored);
    const keys = report.findings.filter((f) => f.checkId === "financial-total-mismatch").map((f) => f.message);
    expect(keys.join("\n")).toMatch(/native\|completed/);
    expect(keys.join("\n")).toMatch(/native\|pending/);
  });

  it("flags a table missing from the restore", async () => {
    const report = await drill(healthy, { ...structuredClone(healthy), missing: [LedgerBlock] });
    expect(report.ok).toBe(false);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ checkId: "table-missing", table: "ledger_blocks", severity: "critical" }),
    );
  });

  it("flags non-integer amounts instead of summing them", async () => {
    const corrupted = { ...structuredClone(healthy), transactions: [tx("t1", "1000"), tx("t2", "25.00")] };
    const report = await drill(corrupted, corrupted);
    expect(report.ok).toBe(false);
    expect(checkIds(report)).toContain("invalid-amount");
  });

  it("fails when the restored data breaks a relational invariant (reuses the consistency audit)", async () => {
    // A settlement block with no matching transaction: identical in source and
    // restore, so only the audit can catch it.
    const broken = { ...structuredClone(healthy), ledgerBlocks: [...healthy.ledgerBlocks!, block("b3", "hash-ghost", "5")] };
    const report = await drill(broken, structuredClone(broken));
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(false);
    expect(report.consistencyFindings.some((f) => f.severity === "critical")).toBe(true);
  });
});

describe("restore drill: boundaries and guards", () => {
  it("only warns for a table that was already unavailable at capture", async () => {
    const report = await drill({ ...healthy, missing: [LedgerBlock] }, { ...healthy, missing: [LedgerBlock] });
    const finding = report.findings.find((f) => f.table === "ledger_blocks");
    expect(finding).toMatchObject({ checkId: "table-unavailable-at-capture", severity: "warning" });
  });

  it("warns about tables present in the restore but not in the baseline", () => {
    const findings = compareSnapshots({}, { extra_table: { available: true, rowCount: 1, checksum: "x" } });
    expect(findings).toEqual([expect.objectContaining({ checkId: "table-not-in-baseline", severity: "warning" })]);
  });

  it("checksums are deterministic and key-order independent", () => {
    expect(checksumRows([{ id: "a", x: 1, y: 2 }])).toBe(checksumRows([{ y: 2, id: "a", x: 1 }]));
    expect(checksumRows([{ id: "a", at: new Date(0) }])).toBe(checksumRows([{ id: "a", at: new Date(0) }]));
    expect(checksumRows([{ id: "a", x: 1 }])).not.toBe(checksumRows([{ id: "a", x: 2 }]));
  });

  it("sums large amounts exactly (beyond Number.MAX_SAFE_INTEGER)", async () => {
    const big = { transactions: [tx("t1", "9007199254740993"), tx("t2", "9007199254740993")] };
    const baseline = await captureBaseline(dataSource(big));
    expect(baseline.tables.transactions.amountTotals).toEqual({ "native|completed": "18014398509481986" });
  });

  it("baseline contains no row contents or wallet addresses", async () => {
    const baseline = await captureBaseline(dataSource(healthy));
    const serialized = JSON.stringify(baseline);
    expect(serialized).not.toContain(WALLET);
    expect(serialized).not.toContain("hash-t1");
  });

  it.each([
    ["wrong schema", { schema: "other", version: DRILL_BASELINE_VERSION, capturedAt: "x", tables: {} }, /Not a restore-drill baseline/],
    ["old version", { schema: DRILL_BASELINE_SCHEMA, version: 0, capturedAt: "x", tables: {} }, /Unsupported baseline version/],
    ["missing tables", { schema: DRILL_BASELINE_SCHEMA, version: DRILL_BASELINE_VERSION, capturedAt: "x" }, /Malformed/],
  ])("parseBaseline rejects %s", (_label, value, error) => {
    expect(() => parseBaseline(JSON.stringify(value))).toThrow(error);
  });

  it("round-trips a captured baseline through parseBaseline", async () => {
    const baseline = await captureBaseline(dataSource(healthy));
    expect(parseBaseline(JSON.stringify(baseline))).toEqual(baseline);
  });

  it.each([
    [{}, true],
    [{ RESTORE_DRILL_TARGET: "production" }, true],
    [{ RESTORE_DRILL_TARGET: "restore" }, false],
  ])("assertRestoreTarget(%j) throws=%s", (env, throws) => {
    const run = () => assertRestoreTarget(env as NodeJS.ProcessEnv);
    if (throws) expect(run).toThrow(/RESTORE_DRILL_TARGET=restore/);
    else expect(run).not.toThrow();
  });
});
