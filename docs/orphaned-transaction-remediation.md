# Orphaned Transaction Record Remediation (#937)

> **Issue:** #937
> **Area:** Backend database integrity
> **Script:** `backend/src/scripts/check-orphaned-transactions.ts`

## Purpose

This document explains the backend data integrity check for orphaned transaction
records, what each condition it reports actually means, plausible root causes,
and how to remediate each one. It also documents why the check does not
attempt to enforce a hard foreign-key constraint, and confirms what indexing
is (and isn't) missing.

## Why "orphaned" doesn't mean what it usually means here

`transactions` (`TransactionRecord` in `backend/src/entities/Transaction.ts`)
has no real foreign keys. `roundId` and `recipient` are plain `varchar`
columns — `roundId` refers to on-chain Soroban project/round state, and
`recipient` is a Stellar wallet address. Neither points at a row in another
Postgres table, and grepping `backend/src/entities/` confirms there is no
`@ManyToOne`/`@JoinColumn` anywhere in this codebase. So the classic "child
row whose parent was deleted" definition of orphan does not apply to this
schema — there is no local parent row to lose.

What *can* legitimately drift is reconciliation between the two places a
completed distribution might be recorded:

- **`transactions`** — written by this app (see `PayoutHistoryService`,
  `EventListenerService`) when it observes a payout.
- **`ledger_blocks`** (`LedgerBlock` entity) — read-only from this
  repo's point of view. `backend/src/services/ledger.service.ts` and
  `backend/src/routes/ledger.ts` only ever query it; nothing in `backend/src`
  writes to it. **Importantly, no migration in `backend/src/migrations`
  creates the `ledger_blocks` table at all.** On a database migrated purely
  from this repo's migration set, `ledger_blocks` will not exist. It is
  presumably intended to be populated by an out-of-repo ingestion process
  reading confirmed on-chain settlements — but as shipped today, in a typical
  local/dev database, **this table simply does not exist, so the
  transactions↔ledger_blocks cross-check will not find anything to compare
  against.** The script detects this and reports it explicitly rather than
  crashing or silently producing misleading results (see "Running the
  check" below).

Given that, this check redefines "orphan" pragmatically as a **cross-source
reconciliation** between these two tables, plus one informational-only
signal.

## What the check reports

Run via `check-orphaned-transactions.ts` → `checkOrphanedTransactions()`
(the exported, independently-testable core function). Three conditions:

### 1. Completed transaction with no matching `ledger_blocks` row

A `transactions` row with `status = 'completed'` whose `txHash` has no
corresponding row in `ledger_blocks`.

**Meaning:** the app believes a payout settled, but there is no independent
on-chain settlement record on file to confirm it.

**Plausible root causes:**
- The `ledger_blocks` ingestion process (external to this repo) hasn't
  caught up yet, or has a gap in its ledger range.
- The `ledger_blocks` table is simply unpopulated in this environment (see
  above — true for most local/dev databases today).
- A transaction's status was set to `completed` incorrectly (application bug,
  or a manual DB edit) without the payout actually settling on-chain.

**Remediation:**
1. First rule out the environment-level explanation: check whether
   `ledger_blocks` is populated at all (`SELECT count(*) FROM ledger_blocks;`).
   If it's empty or the table doesn't exist, this condition is expected noise
   in this environment and not an actionable signal — see "Running the
   check" for how the script itself reports this.
2. If `ledger_blocks` is genuinely populated elsewhere (e.g. production, if
   the external ingestion process is running there), independently verify the
   transaction against the real Stellar ledger before trusting either source:
   ```bash
   stellar tx --network <NETWORK> --id <TX_HASH>
   # or query Horizon directly:
   curl -s "https://horizon-testnet.stellar.org/transactions/<TX_HASH>"
   ```
3. If the transaction did settle on-chain: this is a ledger-ingestion gap.
   Re-run/extend the external ingestion process's catch-up window to cover
   the missing ledger sequence range (see `EventListenerService`'s own
   catch-up pattern in `docs/runbooks/stuck-payouts.md` for the equivalent
   idea applied to this repo's event listener).
4. If the transaction did **not** settle on-chain: this is an application bug
   or bad manual edit. Correct `transactions.status` back to `pending` or
   `failed` as appropriate — only after on-chain verification, never based on
   the DB state alone.

### 2. Settlement `ledger_blocks` row with no matching `transactions` row

A `ledger_blocks` row with `type = 'settlement'` whose `txHash` has no
corresponding row in `transactions` (any status).

**Meaning:** the reverse drift signal — an on-chain settlement was recorded
by whatever populates `ledger_blocks`, but this app never created a
`transactions` row for it.

**Plausible root causes:**
- `EventListenerService` (or whatever normally inserts `transactions` rows)
  had downtime and missed the event.
- A migration or manual data change deleted the `transactions` row.
- The settlement was initiated by a path this backend doesn't observe (e.g.
  submitted directly on-chain, bypassing this API).

**Remediation:**
1. Confirm the transaction hash on-chain (same `stellar`/Horizon lookup as
   above) to be sure it's a real settlement and not bad data in
   `ledger_blocks` itself.
2. If confirmed and the corresponding round/recipient/amount data is known,
   backfill the missing `transactions` row (via the same insertion path the
   app normally uses, not a raw manual `INSERT`, so any downstream
   side-effects — e.g. SSE `transaction:confirmed` events — stay consistent).
3. If this happens repeatedly, treat it as an event-listener reliability
   issue: check `GET /ops/status` for listener health/lag and extend its
   catch-up range, per `docs/runbooks/stuck-payouts.md`.

### 3. Unregistered recipients (informational only — not a hard orphan)

Distinct recipient wallet addresses appearing in `transactions`/
`ledger_blocks` with no matching `users.walletAddress` row.

**This is intentionally informational, not a flagged orphan.** Verified
against `backend/src/routes/transactions.ts` and the rest of the routes: a
`recipient` is never required to correspond to a registered `User` — payouts
can go to any Stellar wallet address, registered or not. A high count here is
expected and not itself a bug; it's reported only as a count + a masked
sample, for situational awareness (e.g. spotting a bulk anomaly like every
recent transaction going to unregistered wallets, which might indicate a
recipient-address bug elsewhere, independent of orphan status).

## Wallet address masking

All wallet addresses in this check's output are masked to first 6 + last 4
characters (e.g. `GA1111...AAAA`), mirroring the existing truncation
convention in `frontend/src/components/projects/ProjectsList.tsx`
(`item.recipient?.slice(0, 8)`). Structural identifiers — `id`, `roundId`,
`txHash`, `ledgerSeq`, `projectId` — are printed in full since they aren't
secrets. `DATABASE_URL`/connection credentials are never printed; the script
also sanitizes any connection-failure error message (stripping anything that
looks like a credential-bearing `scheme://user:pass@host` string) before
logging it, as defense-in-depth in case a future driver error ever embedded
one.

## On database constraints

**No new database constraint is being added, deliberately.** A hard foreign
key between `transactions` and `ledger_blocks` would be actively wrong here:
the two tables are written by independently-timed subsystems (this app for
`transactions`; a separate/external process — when it exists — for
`ledger_blocks`), so a `transactions` row can legitimately exist before its
`ledger_blocks` counterpart arrives, and vice versa. Enforcing an FK at
insert time would reject perfectly valid eventual-consistency writes on
either side.

**Existing indexes were checked and nothing is missing** for this check's own
query performance:
- `TransactionRecord.txHash` already has a unique index
  (`IDX_transactions_tx_hash`, from
  `1760000000005-AddUniqueIndexTransactionHash.ts` — see the migration-bug
  note below for a caveat on this specific migration).
- `LedgerBlock.txHash` already has a plain index (`IDX_ledger_blocks_tx_hash`).

Both join keys used by this check are already indexed. No new migration is
proposed.

## A pre-existing, unrelated migration bug found during validation

While validating this check against a freshly migrated local database
(`npm run migration:run` against a brand-new Postgres instance), migration
`1760000000005-AddUniqueIndexTransactionHash` failed with `relation
"IDX_transactions_tx_hash" already exists` (Postgres error `42P07`). This is
because the *initial* migration, `1760000000000-InitialUserAndTransactionRecord`,
already creates that exact index inline (see its `up()` method). Migration
`1760000000005` redundantly tries to create it again.

TypeORM runs a pending migration batch in a single transaction, so this
failure rolled back **all** pending migrations, leaving a freshly migrated
database with zero application tables (only the `migrations` bookkeeping
table survives). In other words: **`npm run migration:run` against a
genuinely empty database currently fails outright** for reasons unrelated to
this issue.

This is out of scope for #937 to fix (it's a pre-existing migration-history
bug, not an orphaned-transaction concern), but is recorded here since it
directly affects anyone trying to follow this document's "Running the check"
steps from a truly empty database. Until it's fixed, standing up a fresh
local database requires either applying migrations 1-4 and then marking
migration 5 as already-applied (its effect is already present), or fixing the
duplicate `CREATE UNIQUE INDEX` in migration 5 itself. Any environment that
was migrated before this bug was introduced, or that already has these
tables from an earlier migration run, is unaffected.

## Running the check

```bash
cd backend
DATABASE_URL=postgresql://user:password@localhost:5432/splitnaira \
  HORIZON_URL=https://horizon-testnet.stellar.org \
  SOROBAN_RPC_URL=https://soroban-testnet.stellar.org \
  SOROBAN_NETWORK_PASSPHRASE="Test SDF Network ; September 2015" \
  CONTRACT_ID=<your-contract-id> \
  SIMULATOR_ACCOUNT=<your-simulator-account> \
  npx tsx src/scripts/check-orphaned-transactions.ts
```

(Or rely on a `.env` file already populated per `backend/.env.example`, which
covers the required env vars.)

The script exits `0` if no hard-orphan conditions (1 or 2) were found, and
`1` if either was found — suitable for wiring into a cron job or CI step that
alerts on nonzero exit. If `ledger_blocks` doesn't exist in the target
database, the script logs a warning explaining that the cross-check was
skipped, rather than crashing or reporting misleading false positives.

### Read-only cleanup preview

To make the intent explicit before investigating cleanup, run:

```bash
cd backend
npm run preview:orphaned-cleanup
```

This produces the same masked, read-only reconciliation report as the normal
check. It does not modify or delete rows. The checker deliberately rejects
`--apply`, `--cleanup`, and `--delete`; there is no automatic deletion mode.
An unmatched completed transaction may be payout history without a matching
ledger ingest, while an unmatched settlement ledger row may be the only
independent evidence of an on-chain payout. Neither class is safe to discard
based only on the mismatch. Verify findings against the Stellar ledger and
use the remediation steps above; retain the transaction and audit evidence.
Do not pass unrecognized flags, as the CLI rejects them instead of silently
falling back to another mode.

### Automated test coverage

`backend/src/scripts/check-orphaned-transactions.test.ts` exercises the core
`checkOrphanedTransactions()` function against a **mocked** `DataSource` (a
plain object whose `getRepository()` returns objects with a mocked `find`
method per entity), not a live Postgres connection. This mirrors the mocking
style already used in `backend/src/services/database.test.ts` and means the
test always runs in normal `npm run test` / CI, without depending on a
provisioned database (unlike `health.ready.integration.test.ts`, which is
gated behind `CI=true` + a real `DATABASE_URL`). It covers: a completed
transaction with a matching ledger block (not flagged), a completed
transaction with none (flagged), pending/failed transactions with none (not
flagged), a settlement ledger block with no matching transaction (flagged), a
milestone-type block with no matching transaction (not flagged — only
`settlement` counts), the `ledger_blocks`-table-missing path (graceful
warning, no false positives, non-42P01 errors still propagate), and the
wallet-masking behavior for both hard findings and the informational
recipient summary.
It also covers the cleanup-preview CLI option, its backward-compatible
read-only default, rejection of destructive flags, and rejection of unknown
or conflicting arguments.

This was additionally validated end-to-end against a real local Postgres
instance (via this repo's `docker-compose.yml`) with seeded data reproducing
both hard-orphan conditions and the missing-`ledger_blocks`-table case; see
the PR/commit description for the captured output.

## Related

- [Stuck/Delayed Payouts Incident Response](./runbooks/stuck-payouts.md) —
  event listener catch-up and on-chain verification procedures referenced
  above.
- [Audit Log Retention](./audit-log-retention.md) — sibling data-lifecycle
  doc for another Postgres table in this backend.
