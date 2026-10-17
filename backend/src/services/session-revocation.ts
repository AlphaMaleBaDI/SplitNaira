import { getDataSource } from "./database.js";
import { User } from "../entities/User.js";

/**
 * Session revocation for wallet JWTs (#1446).
 *
 * Wallet JWTs are stateless, so revocation works through a per-user
 * `sessionVersion` counter. `signToken` embeds the current value as the `sv`
 * claim, and `authJwtMiddleware` rejects any token whose `sv` no longer
 * matches. Bumping the counter therefore invalidates every token issued
 * before the bump, on every instance, without a token denylist.
 */

/**
 * Current session version for a wallet, or null when no user row exists
 * (including soft-deleted rows, which still carry a version).
 */
export async function getSessionVersion(walletAddress: string): Promise<number | null> {
  const user = await getDataSource()
    .getRepository(User)
    .findOne({ where: { walletAddress }, select: { id: true, sessionVersion: true } });
  return user ? (user.sessionVersion ?? 0) : null;
}

/** Highest session version among accounts registered with `email`, or null if there are none. */
export async function getMaxSessionVersionForEmail(email: string): Promise<number | null> {
  const row = await getDataSource()
    .getRepository(User)
    .createQueryBuilder("user")
    .select("MAX(user.sessionVersion)", "max")
    .where("user.email = :email", { email })
    .getRawOne<{ max: number | string | null }>();
  return row?.max === null || row?.max === undefined ? null : Number(row.max);
}

/**
 * Bumps `sessionVersion` for every account registered with `email`, but only
 * when none of them has moved past `expectedVersion`. This makes a password
 * reset token single-use: the first confirm bumps every row past the token's
 * version, so a replayed (or concurrent) confirm matches zero rows.
 *
 * Returns the number of accounts whose sessions were revoked.
 */
export async function revokeSessionsForEmail(email: string, expectedVersion: number): Promise<number> {
  const result = await getDataSource()
    .getRepository(User)
    .createQueryBuilder()
    .update(User)
    .set({ sessionVersion: () => `"sessionVersion" + 1` })
    .where(`email = :email AND "sessionVersion" <= :expectedVersion`, { email, expectedVersion })
    .andWhere(
      `NOT EXISTS (SELECT 1 FROM "users" newer WHERE newer.email = :email AND newer."sessionVersion" > :expectedVersion)`
    )
    .execute();
  return result.affected ?? 0;
}
