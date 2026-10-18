# Pending Transaction Aging Report (#1476)

> **Issue:** #1476
> **Area:** Backend operator diagnostics
> **Script:** `backend/src/scripts/pending-transaction-aging-report.ts`
> **Tests:** `backend/src/scripts/pending-transaction-aging-report.test.ts`

## Purpose

Identifies `pending` transactions stuck beyond configurable thresholds and
exposes the result as safe operator diagnostics — safe meaning: masked
recipients, exact amount arithmetic, read-only access.

## Usage

```bash
cd backend

# Human-readable report
npm run report:pending-aging

# Machine-readable (CI / cron consumption)
npx tsx src/scripts/pending-transaction-aging-report.ts --json
```

npm script: `report:pending-aging`. Exit code is **1** when any transaction
falls in the critical bucket, **0** otherwise — so it can gate a cron alert
directly.

## Configurable thresholds

| Env var                              | Default | Meaning                                  |
|--------------------------------------|---------|------------------------------------------|
| `PENDING_TX_AGING_WARNING_HOURS`     | `24`    | pending longer than this is "stuck"      |
| `PENDING_TX_AGING_CRITICAL_HOURS`    | `72`    | pending longer than this is critical     |

Thresholds are hours (fractional values allowed). Configuration is
**fail-loud**: a non-numeric, zero, or negative value, or a critical
threshold that is not strictly above the warning threshold, raises
`ThresholdConfigurationError` instead of silently repairing itself — an
operator reading a silently-adjusted report would misread the risk.

Age is `now − timestamp`; `transactions.timestamp` is epoch **seconds**
(see `routes/transactions.ts`).

## Buckets and boundaries

Transactions are classified `fresh` / `warning` / `critical`. Boundary
convention: an age **exactly at** a threshold lands in that threshold's
bucket (24h old → warning; 72h old → critical).

## Safety properties

- **Recipients are always masked** (first 6 + last 4 chars, same
  convention as `check-orphaned-transactions.ts`). The report is designed
  to be pasted into tickets and incidents; raw wallet addresses never
  appear in it (asserted by test).
- **Amounts are summed exactly** via `lib/decimal-amounts.ts` (bigint
  fixed-point, 7 decimals) — `0.1 + 0.2` is `0.3`, never
  `0.30000000000000004`. Invalid amounts (which the DB constraint would
  reject) are excluded from bucket totals with a warning rather than
  corrupting them.
- **Read-only**: the implementation only ever calls `repo.find()`. The
  unit tests serve repositories exposing *only* `find`, so any write
  attempt would fail the suite.
- **Clock skew is reported, not hidden**: a future-dated timestamp is
  clamped to age 0 and emitted as a warning.

## Report shape

```ts
interface PendingTransactionAgingReport {
  generatedAt: string;
  thresholds: { warningHours: number; criticalHours: number };
  totalPending: number;
  buckets: Record<"fresh" | "warning" | "critical", {
    bucket: string;
    count: number;
    oldestAgeHours: number;
    totalAmount: string;          // exact fixed-point sum
    sampleRecipientsMasked: string[]; // max 5
  }>;
  criticalTransactions: Array<{  // every critical row, for alerting
    id: string; txHash: string; roundId: string;
    recipientMasked: string; ageHours: number; amount?: string;
  }>;
  warnings: string[];
}
```

## Validation

```bash
cd backend
npx vitest run src/scripts/pending-transaction-aging-report.test.ts
```

21 mocked-DataSource unit tests: threshold resolution (success, invalid,
boundary), bucket classification at both boundaries, masking, exact sums,
future timestamps, invalid amounts, empty sets, exit codes, and the
read-only guarantee. No live Postgres required.
