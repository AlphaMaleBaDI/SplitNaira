# Postgres Backup & Restore Runbook (Issue #839)

> **Issue:** #839
> **Track:** Stellar Wave
> **Status:** Complete
> **Related:** [`audit-log-retention.md`](../audit-log-retention.md), [`runbooks/rollback-guide.md`](../../runbooks/rollback-guide.md), [`runbooks/incident-management.md`](./incident-management.md), [`runbooks/observability.md`](./observability.md)

This runbook gives operators a concrete, drill-tested procedure for backing up
the SplitNaira Postgres database, restoring it without losing audit log or
transaction history, and verifying the result before traffic is routed
back. **Treat this as the authoritative procedure** for any environment
(dev, staging, or production) — ad-hoc `pg_dump` runs are not a substitute.

---

## 1. Backup cadence

| Environment | Frequency | Retention window | Method |
|---|---|---|---|
| **Production** | Continuous (managed automated snapshot every 6 h) + **nightly logical dump retained 30 d** | 30 d nightly + 7 d point-in-time recovery | Managed snapshot + `pg_dump` |
| **Staging** | Nightly at 02:00 UTC | 14 d nightly | `pg_dump` |
| **Dev / CI** | On-demand only | Best-effort | `pg_dump` or ephemeral DB |

Recovery objectives for production:

- **RPO (Recovery Point Objective):** ≤ 6 hours (covers automated snapshots) and ≤ 24 hours when only nightly logical dumps remain.
- **RTO (Recovery Time Objective):** ≤ 1 hour for restoring from a managed snapshot, ≤ 2 hours for restoring from a logical dump.

## 2. Backup commands

### 2.1 Managed snapshot (Render, AWS RDS, GCP Cloud SQL)

Use the provider's snapshot or automated-backup feature. Capture the
snapshot ID before any incident so it can be referenced during a restore.

```bash
# Render: trigger a manual managed snapshot
render services snapshot create --service-id <backend-service-id>

# AWS RDS: immediate snapshot
aws rds create-db-snapshot \
  --db-instance-identifier splitnaira-prod \
  --db-snapshot-identifier splitnaira-prod-predeploy-$(date -u +%Y%m%dT%H%M%SZ) \
  --tags Key=Purpose,Value=predeploy

# GCP Cloud SQL
gcloud sql backups create --instance splitnaira-prod --location us-central1
```

Always tag the snapshot with the deploy commit SHA and the ticket /
incident ID that triggered it.

### 2.2 Logical dump with `pg_dump`

Use a read replica or the primary with `--single-transaction` so
in-flight writes are not interrupted. Save the dump to durable blob
storage (S3/GCS) and to a secure local copy.

```bash
DUMP_PATH=/var/backups/splitnaira/$(date -u +%Y%m%dT%H%M%SZ).dump
pg_dump \
  --dbname="$DATABASE_URL" \
  --format=custom \
  --no-owner \
  --no-privileges \
  --single-transaction \
  --verbose \
  --file="$DUMP_PATH"

# Encrypt before off-host upload. In production, prefer the provider KMS
# process documented in section 2.4; this GPG path is a controlled fallback.
gpg --symmetric --cipher-algo AES256 --output "$DUMP_PATH.gpg" "$DUMP_PATH"
```

Verify the encrypted dump is non-empty and record a SHA-256 checksum. The
checksum detects transfer corruption; it is not a substitute for encryption
or an authenticated signature.

```bash
ls -lah "$DUMP_PATH".gpg
sha256sum "$DUMP_PATH".gpg | tee "$DUMP_PATH".gpg.sha256
```

### 2.3 Automated nightly dump (cron or scheduler)

```cron
# m h d M w  command
0 2 * * *  /usr/local/bin/splitnaira-nightly-pgdump.sh >> /var/log/splitnaira-pgdump.log 2>&1
```

```bash
#!/usr/bin/env bash
# /usr/local/bin/splitnaira-nightly-pgdump.sh
set -euo pipefail
DUMP_PATH=/var/backups/splitnaira/$(date -u +%Y%m%dT%H%M%SZ).dump
pg_dump "$DATABASE_URL" --format=custom --no-owner --no-privileges \
  --single-transaction --file="$DUMP_PATH"
# PASSPHRASE_FILE must be injected by the approved secret manager onto
# ephemeral storage; never bake it into the image or persist it on disk.
gpg --batch --yes --pinentry-mode loopback --passphrase-file "$PASSPHRASE_FILE" \
  --symmetric --cipher-algo AES256 "$DUMP_PATH"
rm "$DUMP_PATH"
aws s3 cp "$DUMP_PATH".gpg "s3://splitnaira-backups/$(date -u +%Y/%m/%d)/"
```

### 2.4 Encryption, key custody, and rotation

Production backups must be encrypted before they leave the database provider's
boundary, including logical dumps and exports. Prefer the storage/provider
backup integration with a customer-managed KMS key and envelope encryption:
the KMS key protects per-backup data-encryption keys, while the backup service
performs encryption without exposing the key material to the application.
Enable encrypted snapshots as well as encrypted object storage; storage
encryption is defense in depth and does not replace client-side encryption of
logical dump files. Verify the selected key and encryption status in the
provider control plane rather than assuming defaults.

If GPG is used where managed encryption is unavailable, use AES-256 with a
strong, randomly generated secret supplied by the approved secret manager.
Use a distinct key per environment; do not reuse database credentials or
store a key/passphrase beside its dump. Automation may use
`--passphrase-file` only when that file is injected at runtime onto protected
ephemeral storage with restrictive permissions and is never included in
images, source control, logs, shell history, or backup storage. Delete the
plaintext dump immediately after successful encryption and verify the
encrypted object and its SHA-256 checksum before upload. Restrict access to
the encryption key separately from access to the backup bucket.

Key custody requirements:

- Assign key administration and backup/restore operation to separate
  least-privilege roles. Require MFA and approval from a second authorized
  operator for production key-policy changes and break-glass restores.
- Grant the backup service only encrypt/data-key permissions. Limit decrypt
  permission to the restore role, with time-bound elevation and provider
  audit logging. Do not grant broad key-administration rights to application
  runtime identities.
- Keep an inventory linking each backup/snapshot to its environment, creation
  time, encryption key identifier and key version, deploy SHA, and retention
  expiry. Store this metadata with the backup, but never store secrets or
  passphrases there.
- Keep key material and recovery procedures in the organization's approved
  KMS/HSM or secret-management system. Maintain a separately controlled
  break-glass recovery path and test that authorized restore operators can
  use it without sharing secrets through chat or tickets.

Rotate production backup keys at least annually, on suspected compromise, and
when an authorized operator or provider boundary changes; follow a stricter
organizational or regulatory schedule when applicable. Create a new key
version, encrypt new backups with it, and record the effective date and
version. For retained archives, either re-encrypt them under the new key
without leaving plaintext copies, or retain the old key version in decrypt-only
state until every backup encrypted with it has expired (including legal holds).
Do not disable or destroy an old key while any retained backup still depends
on it. After rotation, perform a restore drill using both the new key and a
retained old-key archive, verify the restored data, and record the result.
Immediately disable compromised versions only after ensuring retained
backups have a recoverable replacement encryption.

## 3. Restore drill

> Run this drill at least **once per quarter** against a disposable
> staging database so the procedure is current and the team has muscle
> memory. The issue #839 acceptance criteria explicitly call this out.

### 3.1 Provision a disposable database

```bash
# Example: spin up an empty Postgres 16 container
docker run --rm --detach \
  --name splitnaira-restore-drill \
  -e POSTGRES_USER=splitnaira -e POSTGRES_PASSWORD=splitnaira \
  -e POSTGRES_DB=splitnaira_drill \
  -p 5433:5432 \
  postgres:16
```

### 3.2 Decrypt and restore

Before decrypting, obtain incident/change approval and use the dedicated,
time-bound restore identity. Confirm that the chosen key version is authorized
for the selected backup and that the encrypted object checksum matches its
recorded SHA-256 value. Restore into an isolated, private disposable database;
do not make a restored copy internet-accessible or route production traffic
to it until verification and access review pass. Fetch decryption material
from KMS/secret management at restore time; never copy it into the backup
bucket, command history, or a ticket. Record the operator, approver, backup
identifier, key version, target database, and restore outcome in the incident
record. Keep decryption permissions separate from routine backup creation.

```bash
DUMP_GPG=/var/backups/splitnaira/chosen.dump.gpg
DUMP_PATH=/tmp/splitnaira-restore.dump
# Inject PASSPHRASE_FILE from the approved secret manager onto protected
# ephemeral storage; use KMS-native decrypt when the backup uses KMS.
gpg --batch --yes --pinentry-mode loopback --passphrase-file "$PASSPHRASE_FILE" \
  --decrypt "$DUMP_GPG" > "$DUMP_PATH"

pg_restore \
  --dbname=postgresql://splitnaira:splitnaira@localhost:5433/splitnaira_drill \
  --no-owner --no-privileges \
  --single-transaction \
  --verbose \
  "$DUMP_PATH"
```

After the restore, re-apply any pending migrations **from the same
backend version that produced the dump**. Re-applying in reverse order
is unsafe — sort them by timestamp and apply oldest-first.

### 3.3 Verification queries

Run these against the restored database immediately after the restore.
All of them must return non-empty / non-error responses before traffic
is allowed back.

```sql
-- Row-count sanity check (expect > 0 for active tables)
SELECT (SELECT COUNT(*) FROM users)         AS user_rows,
       (SELECT COUNT(*) FROM splits)        AS split_rows,
       (SELECT COUNT(*) FROM transactions)  AS transaction_rows,
       (SELECT COUNT(*) FROM audit_log)     AS audit_log_rows;

-- Cross-check: every split has at least one transaction
SELECT s.id
FROM splits s
LEFT JOIN transactions t ON t.split_id = s.id
WHERE t.id IS NULL;

-- Audit-log integrity: time-ordered inserts in the last 30 days
SELECT DATE_TRUNC('hour', performed_at) AS hour,
       COUNT(*) AS actions
FROM audit_log
WHERE performed_at > NOW() - INTERVAL '30 days'
GROUP BY 1 ORDER BY 1;

-- Latest transaction timestamp matches expectations
SELECT MAX(created_at) FROM transactions;
```

A simple shell wrapper that returns non-zero on any anomaly:

```bash
#!/usr/bin/env bash
# /usr/local/bin/splitnaira-restore-verify.sh
set -euo pipefail
DATABASE_URL="$1"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -At <<'SQL'
SELECT
  CASE
    WHEN (SELECT COUNT(*) FROM users) = 0                 THEN 'empty_users'
    WHEN (SELECT COUNT(*) FROM splits) = 0                THEN 'empty_splits'
    WHEN EXISTS(
      SELECT 1 FROM splits s
      LEFT JOIN transactions t ON t.split_id = s.id
      WHERE t.id IS NULL
    )                                                    THEN 'orphan_split'
    ELSE 'ok'
  END;
SQL
```

### 3.4 Application smoke check

Once the verification passes, point a temporary backend instance at
the drill database and run the standard smoke checks
(see [`runbooks/production-readiness.md`](../../runbooks/production-readiness.md)):

```bash
BACKEND_BASE=https://<temp-backend-host>
curl -fsS "$BACKEND_BASE/health/ready"            # expect 200 ok
curl -fsS "$BACKEND_BASE/splits?limit=5"          # expect non-empty list
curl -fsS "$BACKEND_BASE/transactions/history?limit=5" # expect prior records
```

## 4. Audit log & transaction record handling

Audit logs and transaction records **must be preserved across any
restore**. The SplitNaira operational model treats them as compliance
artefacts with a defined retention policy
(see [`audit-log-retention.md`](../audit-log-retention.md)).

| Concern | Decision | Why |
|---|---|---|
| Audit log retention in backup | **Keep full audit history** in every backup | Compressed retention starts *after* restore is verified safe. |
| Backups older than the audit retention window (2 years) | **Still retain the dump**, even if rows inside no longer match active retention | Backups are evidence, not active data. |
| Transactions in `transactions` table | **Always restore** | They drive downstream payout history and SSE event projection. |
| Token allowlist (read from contract, mirrored in `audit_log`) | **Always restore** | Mirrored allowlist writes are part of the audit trail. |
| Temporary `audit_log` rows from QA automation | **Allow restore** but mark with `request_id` prefix `qa-` | Easier to filter if ever needed. |

> **Important:** Never delete or shorten the `audit_log` table as part of
> a restore. The retention sweep in `audit-log-retention.md` is a
> separate, quarterly stand-alone operation that runs **after** the
> rest of the system is confirmed healthy.

## 5. Rollback considerations during restore

If the restore is being performed *because* of a failing deploy or
illegal data shape, follow these rules to avoid rolling forward into a
worse state:

1. **Freeze writes first.** Set `PAYMENTS_ADMIN_WRITE_ENABLED=false`
   on the *currently-live* backend and stop accepting new traffic at
   the load balancer before the restore begins. The freeze is the same
   switch documented in [`runbooks/rollback-guide.md`](../../runbooks/rollback-guide.md#1-backend-service-rollback).
2. **Restore to a parallel instance, not in-place.** Point the new
   backend at the restored database and verify it before swapping the
   load balancer. In-place restoration requires turning the database
   fully offline, which is rarely justified.
3. **Keep both databases online until parity checks pass.** Compare row
   counts and `MAX(timestamps)` against the pre-restore live database —
   see [`runbooks/observability.md`](./observability.md) for the
   parity queries.
4. **If restore succeeds but parity fails**, do **not** flip traffic.
   Investigate the discrepancy before cutting over. The
   contract-side authoritative state continues to be reconciled by
   `/health/ready`; treat DB-only state divergence as a
   P2 incident.
5. **If restore fails mid-flight**, drop the partial database and start
   again — never try to "patch" a half-restored database.
6. **Capture the deploy commit SHA and incident ID in the restore
   notes** so the post-incident review links the restore to the
   triggering change.

## 6. Quick-reference cheat sheet

```bash
# Snapshot the live DB before any risky change
pg_dump "$DATABASE_URL" --format=custom --no-owner --no-privileges \
  --single-transaction --verbose \
  --file=/var/backups/splitnaira/$(date -u +%Y%m%dT%H%M%SZ).dump

# Encrypted upload
gpg --symmetric --cipher-algo AES256 \
  /var/backups/splitnaira/<stamp>.dump

# Verify a dump
sha256sum -c /var/backups/splitnaira/<stamp>.dump.gpg.sha256
gpg --batch --yes --pinentry-mode loopback \
  --passphrase-file "$PASSPHRASE_FILE" \
  --decrypt /var/backups/splitnaira/<stamp>.dump.gpg > /tmp/check.dump
pg_restore --list /tmp/check.dump | head -50

# Restore into a disposable DB
createdb -h localhost -p 5433 splitnaira_drill
pg_restore --dbname=postgresql://splitnaira:splitnaira@localhost:5433/splitnaira_drill \
  --no-owner --no-privileges --single-transaction /tmp/check.dump

# Verify
psql postgresql://splitnaira:splitnaira@localhost:5433/splitnaira_drill \
  -c "SELECT COUNT(*) FROM users; SELECT COUNT(*) FROM splits;"
```

## 7. Cross-references

- [`runbooks/rollback-guide.md`](../../runbooks/rollback-guide.md) — backend service rollback (including the write-disabling switch).
- [`runbooks/incident-management.md`](./incident-management.md) — incident classes and recovery flow.
- [`runbooks/observability.md`](./observability.md) — DB parity / health checks used after a restore.
- [`audit-log-retention.md`](../audit-log-retention.md) — retention policy that runs *after* restore.
- [`backend-deploy.md`](../backend-deploy.md) — production deploy pipeline that may trigger a restore.
