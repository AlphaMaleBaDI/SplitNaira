import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * AddEmailVerificationTokens1760000000014
 *
 * Persists email verification links so re-sending rotates the token and
 * confirming consumes it (#1444). Keyed by email: the unique index means a
 * rotation is a single atomic upsert, so two concurrent resends cannot leave
 * two live tokens for the same address.
 *
 * Additive: creates a new table, touches no existing rows. Tokens issued
 * before this migration have no row and therefore cannot be confirmed — the
 * resend endpoint issues a tracked one on the next request, so no backfill is
 * required.
 */
export class AddEmailVerificationTokens1760000000014 implements MigrationInterface {
  name = "AddEmailVerificationTokens1760000000014";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "email_verification_tokens" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "email" character varying(128) NOT NULL,
        "tokenHash" character varying(64) NOT NULL,
        "expiresAt" TIMESTAMPTZ NOT NULL,
        "consumedAt" TIMESTAMPTZ,
        "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_email_verification_tokens" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_email_verification_tokens_email" ON "email_verification_tokens" ("email")`
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "IDX_email_verification_tokens_token_hash" ON "email_verification_tokens" ("tokenHash")`
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "public"."IDX_email_verification_tokens_token_hash"`
    );
    await queryRunner.query(`DROP INDEX IF EXISTS "public"."IDX_email_verification_tokens_email"`);
    await queryRunner.query(`DROP TABLE "email_verification_tokens"`);
  }
}
