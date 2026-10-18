import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { getDataSource } from "./database.js";
import { EmailVerificationToken } from "../entities/EmailVerificationToken.js";
import { signEmailFlowToken } from "./email-provider.js";

/**
 * Persisted email verification tokens (#1444).
 *
 * The JWT remains the carrier, but its authority now comes from the database
 * row keyed by the recipient's email:
 *
 * - **Rotation.** Re-sending replaces the row's hash (`upsert` on `email`), so
 *   every link issued before the resend stops verifying. There is only ever
 *   one live hash per address.
 * - **Single use.** Confirming flips `consumedAt` with a conditional
 *   `UPDATE ... WHERE "consumedAt" IS NULL`. Exactly one of any concurrent
 *   confirms matches a row, so a replay is rejected.
 * - **Expiry.** The row's `expiresAt` mirrors the JWT's own `exp`, and the
 *   update also requires `"expiresAt" > now`, so expiry is enforced on both
 *   sides.
 */

export function hashEmailVerificationToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export interface IssuedEmailVerificationToken {
  token: string;
  tokenHash: string;
  expiresAt: Date;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Sign a fresh tracked token. Does not touch the database. */
export function issueEmailVerificationToken(email: string): IssuedEmailVerificationToken {
  const token = signEmailFlowToken(email, "email_verification", { jti: crypto.randomUUID() });
  const decoded = jwt.decode(token) as { exp?: number } | null;
  if (!decoded?.exp) {
    throw new Error("Email verification token is missing its expiry claim.");
  }

  return {
    token,
    tokenHash: hashEmailVerificationToken(token),
    expiresAt: new Date(decoded.exp * 1000),
  };
}

/**
 * Make `issued` the only live verification token for the address.
 *
 * `upsert` on the unique `email` index is a single `INSERT ... ON CONFLICT DO
 * UPDATE`, so concurrent resends serialize instead of racing a
 * read-then-write: whichever commits last is the live token, and the other is
 * invalid. `consumedAt` is reset so a resend after an expired-but-unconsumed
 * token still produces a usable link.
 */
export async function rotateEmailVerificationToken(
  email: string,
  issued: IssuedEmailVerificationToken
): Promise<void> {
  await getDataSource()
    .getRepository(EmailVerificationToken)
    .upsert(
      {
        email: normalizeEmail(email),
        tokenHash: issued.tokenHash,
        expiresAt: issued.expiresAt,
        consumedAt: null,
      },
      ["email"]
    );
}

/**
 * Consume a token for `email`, returning true only for the caller that wins
 * the atomic update. Reused, superseded, expired, and never-issued tokens all
 * return false.
 */
export async function consumeEmailVerificationToken(
  email: string,
  tokenHash: string,
  now: Date = new Date()
): Promise<boolean> {
  const result = await getDataSource()
    .getRepository(EmailVerificationToken)
    .createQueryBuilder()
    .update(EmailVerificationToken)
    .set({ consumedAt: now })
    .where("email = :email", { email: normalizeEmail(email) })
    .andWhere("tokenHash = :tokenHash", { tokenHash })
    .andWhere('"consumedAt" IS NULL')
    .andWhere('"expiresAt" > :now', { now })
    .execute();

  return (result.affected ?? 0) > 0;
}

/**
 * Mark a just-issued token unusable without consuming it. Used when the
 * verification email fails to send, so the address is left with no live token
 * rather than one nobody received.
 */
export async function invalidateEmailVerificationToken(
  email: string,
  tokenHash: string
): Promise<void> {
  await getDataSource()
    .getRepository(EmailVerificationToken)
    .createQueryBuilder()
    .update(EmailVerificationToken)
    .set({ consumedAt: new Date() })
    .where("email = :email", { email: normalizeEmail(email) })
    .andWhere("tokenHash = :tokenHash", { tokenHash })
    .andWhere('"consumedAt" IS NULL')
    .execute();
}
