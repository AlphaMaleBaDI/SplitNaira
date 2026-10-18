# Ledger Entry Balancing Invariants (#1475)

> **Issue:** #1475
> **Area:** Backend ledger accounting
> **Module:** `backend/src/services/ledger-invariants.ts`
> **Tests:** `backend/src/services/ledger-invariants.test.ts`

## Purpose

Defines and tests the accounting invariants that must hold across the
supported split/payout transitions, so drift between the two places a payout
can be recorded — `transactions` (written by this app when it observes a
payout) and `ledger_blocks` (the independent on-chain settlement mirror) —
is caught as a *balancing* violation, not just as a missing row.

## The transitions being pinned down

A payout moves through:

```
(recorded `pending`) ──▶ (`completed` | `failed`)
```

When the app observes an on-chain settlement, a `settlement`-type
`ledger_blocks` row exists for the same `txHash`. The invariants below say
what "balanced" means at every point of that lifecycle.

## The invariant table

| id         | invariant                                                                 | severity |
|------------|---------------------------------------------------------------------------|----------|
| `INV-1`    | every transaction amount and settlement amount is a valid, non-negative decimal string with ≤ 7 fraction digits and value ≤ 2^127−1 (the `CHK_transactions_amount_valid` contract, re-verified in-process) | critical |
| `INV-2`    | a `completed` transaction (a payout that settled) has amount **> 0**      | critical |
| `INV-3`    | a `settlement` ledger entry matched to a completed transaction carries **exactly** the same amount (canonical decimal equality) | critical |
| `INV-4`    | a `failed` transaction has **no** matching `settlement` ledger entry (a payout that failed must not appear settled on-chain) | critical |
| `INV-5`    | settlement entries are unique per `txHash` (a payout settles at most once) **and** aggregate conservation holds: total settled amount == total completed payout amount | critical |

`INV-5`'s aggregate half exists to catch drift `INV-3` cannot see — e.g. a
settlement row whose transaction record is missing. That row is separately
the #937 orphan case; the dry-run command (#1477) runs both engines so
either path reports it.

Amount comparisons use the exact fixed-point helpers in
`backend/src/lib/decimal-amounts.ts`. `Number()` is never used on an amount.

## What is deliberately *not* a violation

- **`pending` with a settlement entry.** The app has observed the on-chain
  settle but has not yet flipped the row to `completed`. That lag is an
  operational signal handled by the aging report (#1476), not a balancing
  error.
- **Missing counterparts** (completed without settlement, settlement without
  transaction). That is `checkOrphanedTransactions()` (#937) territory; the
  invariant engine does not duplicate it.
- **Milestone-type ledger entries.** Only `settlement` entries represent
  payouts; `milestone` rows are ignored by every payout invariant.

## API

```ts
import { evaluateLedgerBalance } from "./services/ledger-invariants.js";

const report = evaluateLedgerBalance(transactions, ledgerBlocks);
report.balanced;        // true iff no violations at all
report.violations;      // InvariantViolation[] (invariantId, severity, message, txHash?, rowId?)
report.rounds;          // per-round conservation summary (diagnostic)
report.totals;          // { transactionCount, settlementCount, completedTotal, settledTotal }
```

`evaluateLedgerBalance()` is **pure**: no database access, no clock, no I/O.
The same inputs always produce the same report, and no input is mutated.
That is what makes the exhaustive unit-test matrix in
`ledger-invariants.test.ts` possible (success, failure and boundary cases
for each invariant, including the minimum amount `0.0000001` and the i128
maximum).

## Where this is consumed

The reconciliation dry-run command (#1477,
`backend/src/scripts/reconcile-dry-run.ts`) runs these invariants alongside
the #937 orphan checks and exits non-zero on any critical finding. Nothing
in the request path invokes them — they are operator tooling, evaluated
against rows already loaded from the database.

## Validation

```bash
cd backend
npx vitest run src/services/ledger-invariants.test.ts
```

All tests are mocked-row unit tests (same style as
`scripts/check-orphaned-transactions.test.ts`) — no live Postgres required.
