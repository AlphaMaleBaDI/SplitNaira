# Reconciliation Dry-Run Command (#1477)

> **Issue:** #1477
> **Area:** Backend reconciliation / operations
> **Script:** `backend/src/scripts/reconcile-dry-run.ts`
> **Tests:** `backend/src/scripts/reconcile-dry-run.test.ts`

## Purpose

A single, **non-mutating** reconciliation command over `transactions` and
`ledger_blocks` that exits non-zero when critical inconsistencies exist.
It is the "do I have a problem, and how bad is it?" half of the workflow;
remediation is a separate, explicitly human-reviewed step (see
`docs/orphaned-transaction-remediation.md`).

## Usage

```bash
cd backend

# Human-readable report
npm run reconcile:dry-run

# Machine-readable (CI / cron consumption)
npx tsx src/scripts/reconcile-dry-run.ts --json
```

npm script: `reconcile:dry-run`.

**Exit codes**

| code | meaning                                              |
|------|------------------------------------------------------|
| `0`  | no critical findings (warnings may exist)            |
| `1`  | at least one critical inconsistency, or the run failed |

## What it checks

The command composes — it does not reimplement — the two existing check
engines:

1. **`checkOrphanedTransactions()` (#937)** — row-level cross-table
   reconciliation:
   - `completed-missing-settlement` (critical): a completed payout with no
     settlement ledger row;
   - `settlement-missing-transaction` (critical): a settlement ledger row
     with no payout record;
   - `unregistered-recipients` (warning): informational; recipients are
     not required to be registered users.
2. **`evaluateLedgerBalance()` (#1475)** — the accounting invariants:
   `INV-1` amount format, `INV-2` positive settled amounts, `INV-3`
   per-payout amount match, `INV-4` failed-must-not-settle, `INV-5`
   uniqueness and aggregate conservation (see
   `docs/ledger-entry-balancing-invariants.md`).

Findings from both engines are merged into one report with a shared shape:

```ts
interface ReconciliationFinding {
  checkId: string;                 // e.g. "completed-missing-settlement", "INV-3-amount-match"
  severity: "critical" | "warning";
  message: string;
  count?: number;
  sampleIds?: string[];            // max 5, masked — safe to paste anywhere
}
```

## Dry-run guarantees

- The command only ever executes `repo.find()`. There is no insert, update,
  delete, transaction, lock, or schema change anywhere on its path — the
  unit tests serve repositories exposing **only** `find`, so any write
  attempt would fail the suite with a `TypeError`.
- `mode: "dry-run"` is stamped into every report (including `--json`), so a
  stored report is self-describing about how it was produced.
- **Degrades safely**: if `ledger_blocks` does not exist on the database
  (no migration currently creates it — documented in
  `check-orphaned-transactions.ts`), the run does not crash. The invariant
  engine evaluates transactions alone, the orphan checks are skipped (to
  avoid false "missing settlement" findings against a table that isn't
  there), a `ledger-blocks-unavailable` warning is emitted, and the exit
  code stays `0`. Any other database error is re-thrown and surfaces as
  exit `1`.

## Relationship to `audit:db-consistency` (#1338)

`audit:db-consistency` is the broad relational audit (uniqueness
invariants, notification-preference rules, plus the #937 checks).
`reconcile:dry-run` is the ledger-focused command: it adds the #1475
accounting invariants on top of the #937 reconciliation and is the
recommended entry point for payout/ledger health checks.

## Validation

```bash
cd backend
npx vitest run src/scripts/reconcile-dry-run.test.ts
```

11 mocked-DataSource unit tests: clean-ledger success, the read-only
guarantee (repos expose only `find`), critical inconsistencies from both
engines, the missing-`ledger_blocks` degradation path, non-42P01 error
propagation, exit-code semantics, and finding translation with masked
samples. No live Postgres required.
