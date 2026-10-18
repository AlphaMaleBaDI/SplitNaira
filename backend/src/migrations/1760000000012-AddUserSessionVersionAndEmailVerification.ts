import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * AddUserSessionVersionAndEmailVerification1760000000012
 *
 * - `sessionVersion` (#1446): embedded in every wallet JWT as `sv`. Bumping it
 *   invalidates every token issued before the bump. A successful password
 *   reset bumps it for each account registered with that email. Existing rows
 *   start at 0, and tokens without an `sv` claim are treated as version 0,
 *   so tokens issued before this migration stay valid until the first reset.
 * - `emailVerifiedAt` (#1443): set when an email verification token is
 *   confirmed. Null means unverified.
 */
export class AddUserSessionVersionAndEmailVerification1760000000012 implements MigrationInterface {
  name = "AddUserSessionVersionAndEmailVerification1760000000012";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users" ADD "sessionVersion" INTEGER NOT NULL DEFAULT 0
    `);
    await queryRunner.query(`
      ALTER TABLE "users" ADD "emailVerifiedAt" TIMESTAMPTZ
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "emailVerifiedAt"`);
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "sessionVersion"`);
  }
}
