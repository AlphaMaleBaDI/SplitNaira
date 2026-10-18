import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * AddTransactionKeysetPaginationIndexes1760000000013
 *
 * Supports the `(timestamp DESC, id DESC)` keyset order used by
 * GET /transactions/history and GET /transactions/recipient/:walletAddress
 * (#1259). The pre-existing single-column indexes still serve count/filter
 * queries; these composites let the planner satisfy the order and the
 * cursor predicate from one index.
 */
export class AddTransactionKeysetPaginationIndexes1760000000013 implements MigrationInterface {
  name = "AddTransactionKeysetPaginationIndexes1760000000013";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "IDX_transactions_timestamp_id" ON "transactions" ("timestamp" DESC, "id" DESC)`
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_transactions_recipient_timestamp_id" ON "transactions" ("recipient", "timestamp" DESC, "id" DESC)`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_transactions_recipient_timestamp_id"`
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_transactions_timestamp_id"`);
  }
}
