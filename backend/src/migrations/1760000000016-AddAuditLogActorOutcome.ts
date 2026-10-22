import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Issue #1262: Add `actor` and `outcome` columns to `audit_log`.
 *
 * `actor`   — the wallet address (or service identity) that performed the
 *             privileged action. Nullable for backward compatibility with
 *             rows recorded before this migration.
 * `outcome` — stable category: `success`, `failure`, or `blocked`.
 *             Nullable for the same backward-compatibility reason.
 *
 * An index on `actor` is added so audit queries can filter by principal
 * without a full table scan.
 */
export class AddAuditLogActorOutcome1760000000016 implements MigrationInterface {
  name = "AddAuditLogActorOutcome1760000000016";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "audit_log" ADD COLUMN IF NOT EXISTS "actor" varchar(128) DEFAULT NULL`
    );
    await queryRunner.query(
      `ALTER TABLE "audit_log" ADD COLUMN IF NOT EXISTS "outcome" varchar(32) DEFAULT NULL`
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_audit_log_actor" ON "audit_log" ("actor")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_audit_log_actor"`);
    await queryRunner.query(`ALTER TABLE "audit_log" DROP COLUMN IF EXISTS "outcome"`);
    await queryRunner.query(`ALTER TABLE "audit_log" DROP COLUMN IF EXISTS "actor"`);
  }
}
