# Local Postgres Migration Dry-Run

This runbook verifies that the complete TypeORM migration history applies to a
new, disposable Postgres database. It is intended for contributors before a
migration PR and for CI; it is not a deployment command.

## Ownership and behaviour

| Concern | Owner | Current behaviour |
|---------|-------|-------------------|
| Migration source and dry-run script | Backend Engineering | `backend/scripts/run-migration-dry-run.mjs` recreates a dedicated database, then runs `typeorm migration:run`. |
| Local Postgres service | Contributor / Backend Engineering | The `postgres` service in `docker-compose.yml` provides a local Postgres 16 instance. |
| CI service and check | Platform Engineering | `.github/workflows/migration-check.yml` runs the same command against an isolated GitHub Actions service database. |

The command deliberately drops and recreates the database named in
`MIGRATION_DRY_RUN_DATABASE_URL` with `DROP DATABASE ... WITH (FORCE)`. It
never uses a regular `DATABASE_URL` as a fallback. This prevents an existing
development or deployment connection string from becoming the reset target.

> **Safety boundary:** only use a database reserved for this check. Do not
> set either migration dry-run URL to a shared, staging, or production
> database. The admin user must have permission to drop and create the target
> database.

## Prerequisites

- Node.js 18+ and npm 8+.
- Root dependencies installed with `npm ci` (or `npm install` only when you
  are intentionally changing dependencies).
- A local Postgres server reachable on `localhost:5432`. The Compose service
  is the supported quick-start option.

Start only Postgres from the repository root:

```bash
docker compose up -d postgres
docker compose ps postgres
```

The default Compose credentials are `splitnaira` / `splitnaira`. That role is
created as the Postgres superuser by the local image and can create the
disposable database below.

## Run the check

Set explicit, isolated target and admin connections. These examples use the
default Compose credentials and a database named `splitnaira_ci` that is safe
for the command to recreate.

```bash
export MIGRATION_DRY_RUN_DATABASE_URL='postgresql://splitnaira:splitnaira@localhost:5432/splitnaira_ci'
export MIGRATION_DRY_RUN_ADMIN_DATABASE_URL='postgresql://splitnaira:splitnaira@localhost:5432/postgres'
npm run migration:dry-run
```

In PowerShell, use the equivalent session-scoped variables:

```powershell
$env:MIGRATION_DRY_RUN_DATABASE_URL = 'postgresql://splitnaira:splitnaira@localhost:5432/splitnaira_ci'
$env:MIGRATION_DRY_RUN_ADMIN_DATABASE_URL = 'postgresql://splitnaira:splitnaira@localhost:5432/postgres'
npm run migration:dry-run
```

Successful output ends with:

```text
[migration:dry-run] Completed successfully.
```

The root command delegates to the backend workspace. It may also be run as
`npm run migration:dry-run -w backend` from the repository root.

### Configuration reference

| Variable | Required | Purpose |
|----------|----------|---------|
| `MIGRATION_DRY_RUN_DATABASE_URL` | Recommended | Connection URL for the database that will be dropped, recreated, and migrated. Defaults only to the local `splitnaira_ci` URL shown above. |
| `MIGRATION_DRY_RUN_ADMIN_DATABASE_URL` | Recommended | Connection URL to an existing administrative database, normally `postgres`, using a role permitted to create and drop the target database. |
| `MIGRATION_DRY_RUN_DATABASE_NAME` | Optional | Extra guard: when set, it must exactly match the database name in `MIGRATION_DRY_RUN_DATABASE_URL`. |
| `MIGRATION_DRY_RUN_ADMIN_DATABASE` | Optional | Administrative database name when an admin URL is not supplied; defaults to `postgres`. |

`MIGRATION_ADMIN_DATABASE_URL` and `MIGRATION_ADMIN_DATABASE` remain accepted
as legacy aliases, but new local and CI configuration should use the
`MIGRATION_DRY_RUN_*` names. The dry-run target cannot be `postgres`,
`template0`, or `template1`.

## Troubleshooting

| Symptom | Likely cause | Resolution |
|---------|--------------|------------|
| Connection refused on port 5432 | Postgres is not running or the port is already in use. | Run `docker compose up -d postgres`, then inspect `docker compose logs postgres`. Use URLs with the actual local port if it differs. |
| `permission denied to create database` | The admin role is not a database creator. | Use an admin URL with a role that has `CREATEDB` (the Compose `splitnaira` role does), or ask the database owner to provide a disposable target. |
| `MIGRATION_DRY_RUN_DATABASE_NAME must match` | The explicit name and target URL point at different databases. | Correct one of the values so they name the same disposable database. |
| Migration error after the reset completes | A migration cannot be applied cleanly from an empty schema. | Treat this as a migration defect: keep the failed output, fix the migration, and re-run the command. Do not mark the migration as applied manually. |

## Operational impact

The check temporarily creates schema, tables, extensions, and a `migrations`
history table in its target database, then leaves that database in place for
inspection. It does not change application data outside that target. To stop
the local service after the check, run `docker compose down`; do not add `-v`
unless you also intend to remove the Compose database volume.

## Migration timing benchmarks

Before a release, run the full migration chain against a pre-seeded database
and confirm each step completes within its published time budget.

### Enable timing output

Set `MIGRATION_TIMING=1` before the dry-run command. The script then emits a
structured JSON line on stdout after `migration:run` completes:

```bash
export MIGRATION_DRY_RUN_DATABASE_URL='postgresql://splitnaira:splitnaira@localhost:5432/splitnaira_ci'
export MIGRATION_DRY_RUN_ADMIN_DATABASE_URL='postgresql://splitnaira:splitnaira@localhost:5432/postgres'
MIGRATION_TIMING=1 npm run migration:dry-run 2>&1 | tee migration-dry-run.log
```

The timing line has this shape:

```json
{"event":"migration_timing","step":"migration:run","durationMs":1234,"timestamp":"2026-01-01T00:00:00.000Z"}
```

You can extract it with:

```bash
grep '"event":"migration_timing"' migration-dry-run.log
```

### Published time budgets

These limits are enforced by the automated benchmarks in
`backend/src/__tests__/migration-timing.test.ts`:

| Operation | Budget |
|-----------|--------|
| Single migration (one table / column / index) | 2 000 ms |
| Full sequential migration chain from blank schema | 30 000 ms |
| `pg_try_advisory_lock` (non-blocking check) | 500 ms |
| Concurrent runner lock contention check | 200 ms |

A migration that consistently approaches the single-migration budget on a
lightly loaded local Postgres instance should be reviewed for a large table
scan or missing `IF NOT EXISTS` guard before it ships.

### Running the benchmark suite locally

The benchmark suite (`migration-timing.test.ts`) requires a pre-migrated
Postgres. Run the dry-run first to apply all migrations, then point
`DATABASE_URL` at the same database:

```bash
# 1. Apply all migrations to the isolated target
export MIGRATION_DRY_RUN_DATABASE_URL='postgresql://splitnaira:splitnaira@localhost:5432/splitnaira_ci'
export MIGRATION_DRY_RUN_ADMIN_DATABASE_URL='postgresql://splitnaira:splitnaira@localhost:5432/postgres'
npm run migration:dry-run

# 2. Run the benchmark suite against the migrated database
DATABASE_URL='postgresql://splitnaira:splitnaira@localhost:5432/splitnaira_ci' \
  npm run test -w backend -- src/__tests__/migration-timing.test.ts
```

Without `DATABASE_URL` the suite skips all database-backed tests locally and
will not fail. In CI (`CI=true`) a missing `DATABASE_URL` or failed connection
causes the suite to fail immediately so the benchmark can never silently pass
by skipping.

### Advisory lock behaviour

`migration:run` acquires a PostgreSQL advisory lock before applying any
migrations to prevent two concurrent runners from applying the same migration
twice. The benchmark suite verifies:

- `pg_try_advisory_lock` returns within 500 ms (fast path, no wait).
- A second concurrent runner's non-blocking attempt returns `false` within
  200 ms while the first holds the lock.
- The lock is re-acquirable after the first session releases it.

If `pg_try_advisory_lock` takes longer than expected on a shared CI runner,
check whether another process is holding an advisory lock with the same key or
whether the Postgres server is under heavy load.

### Financial invariants verified by the suite

The benchmarks also assert that the two financial-safety guardrails installed
by the migration chain remain in place on the migrated database:

| Guardrail | Migration | What is checked |
|-----------|-----------|----------------|
| `CHK_transactions_amount_valid` | `AddFinancialAmountCheckConstraints1760000000010` | Constraint present; boundary valid amounts accepted; boundary invalid amounts rejected with `23514`. |
| `trg_transactions_immutable` | `AddImmutableTransactionRecords1760000000008` | Trigger present; UPDATE of financial fields rejected with `23000`; UPDATE of `status` accepted; DELETE rejected. |

These checks run inside rolled-back transactions so no data persists after the
suite completes.

## Related

- [Backend deployment](../backend-deploy.md)
- [Postgres backup and restore](./postgres-backup-restore.md)
- [Workspace command reference](../../README.md#workspace-specific-command-reference)
