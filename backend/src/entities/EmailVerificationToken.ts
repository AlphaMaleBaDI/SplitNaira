import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";

/**
 * Persistent state for email verification links (#1444).
 *
 * One row per email address. Re-sending a verification email replaces the row
 * (`upsert` on `email`), which invalidates every token issued before the
 * replace in a single atomic statement; confirming sets `consumedAt`, so a
 * token is single-use. The generous `expiresAt` check is a second guard behind
 * the JWT's own `exp`, and keeps working if the token format ever changes.
 */
@Entity("email_verification_tokens")
export class EmailVerificationToken {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Index("IDX_email_verification_tokens_email", { unique: true })
  @Column({ type: "varchar", length: 128 })
  email!: string;

  @Index("IDX_email_verification_tokens_token_hash", { unique: true })
  @Column({ type: "varchar", length: 64 })
  tokenHash!: string;

  @Column({ type: "timestamptz" })
  expiresAt!: Date;

  /** Set when the token is confirmed (single use) or invalidated after a failed send. */
  @Column({ type: "timestamptz", nullable: true })
  consumedAt!: Date | null;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt!: Date;
}
