import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Issue #1260: add a partial unique index on `users.email` to prevent
 * duplicate email addresses at the database level.
 *
 * The index is partial (WHERE email IS NOT NULL) so that existing rows
 * with a null email are not affected — users without an email address can
 * still coexist, but no two verified emails can be identical, eliminating
 * the race between application-level existence checks and the INSERT.
 */
export class AddEmailUniquenessConstraint1760000000015 implements MigrationInterface {
  name = "AddEmailUniquenessConstraint1760000000015";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_users_email_notnull"
       ON "users" ("email")
       WHERE "email" IS NOT NULL`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."UQ_users_email_notnull"`);
  }
}
