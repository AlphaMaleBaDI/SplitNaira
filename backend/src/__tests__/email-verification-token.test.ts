/**
 * Persisted email verification token service (#1444).
 *
 * The SQL is not executed here (it needs Postgres); these tests pin the
 * contract the routes rely on: the upsert is keyed by normalized email, the
 * consume/invalidate updates are conditional on the live hash, and an issued
 * token's stored expiry matches its JWT `exp`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  interface UpdateState {
    sets: Array<Record<string, unknown>>;
    conditions: Array<{ sql: string; params: unknown }>;
    affected: number;
  }

  class FakeQueryBuilder {
    state: UpdateState = { sets: [], conditions: [], affected: 1 };

    update(): this {
      return this;
    }

    set(values: Record<string, unknown>): this {
      this.state.sets.push(values);
      return this;
    }

    where(sql: string, params: unknown): this {
      this.state.conditions.push({ sql, params });
      return this;
    }

    andWhere(sql: string, params: unknown): this {
      this.state.conditions.push({ sql, params });
      return this;
    }

    async execute(): Promise<{ affected: number }> {
      return { affected: this.state.affected };
    }
  }

  return {
    upserts: [] as Array<{ values: Record<string, unknown>; conflict: unknown }>,
    builders: [] as FakeQueryBuilder[],
    affectedQueue: [] as number[],
    FakeQueryBuilder,
  };
});

vi.mock("../services/database.js", () => ({
  getDataSource: () => ({
    getRepository: () => ({
      upsert: async (values: Record<string, unknown>, conflict: unknown) => {
        h.upserts.push({ values, conflict });
      },
      createQueryBuilder: () => {
        const builder = new h.FakeQueryBuilder();
        builder.state.affected = h.affectedQueue.shift() ?? 1;
        h.builders.push(builder);
        return builder;
      },
    }),
  }),
}));

import {
  consumeEmailVerificationToken,
  hashEmailVerificationToken,
  invalidateEmailVerificationToken,
  issueEmailVerificationToken,
  rotateEmailVerificationToken,
} from "../services/email-verification-token.js";
import { verifyEmailFlowToken } from "../services/email-provider.js";

const EMAIL = "Artist@Example.com";

beforeEach(() => {
  h.upserts.length = 0;
  h.builders.length = 0;
  h.affectedQueue.length = 0;
});

describe("issueEmailVerificationToken", () => {
  it("issues a verifiable token with a jti and a stored expiry matching exp", () => {
    const issued = issueEmailVerificationToken(EMAIL);
    const payload = verifyEmailFlowToken(issued.token, "email_verification");

    expect(payload).toMatchObject({ email: EMAIL });
    expect(payload?.jti).toBeTruthy();
    expect(issued.tokenHash).toBe(hashEmailVerificationToken(issued.token));
    expect(issued.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Math.abs(issued.expiresAt.getTime() - Date.now() - 24 * 60 * 60 * 1000)).toBeLessThan(
      5_000
    );
  });

  it("issues a different jti and hash on every call", () => {
    const first = issueEmailVerificationToken(EMAIL);
    const second = issueEmailVerificationToken(EMAIL);

    expect(first.token).not.toBe(second.token);
    expect(first.tokenHash).not.toBe(second.tokenHash);
  });
});

describe("rotateEmailVerificationToken", () => {
  it("upserts the normalized email with the new hash and clears consumption", async () => {
    const issued = issueEmailVerificationToken(EMAIL);
    await rotateEmailVerificationToken("  Artist@Example.com ", issued);

    expect(h.upserts).toHaveLength(1);
    expect(h.upserts[0].conflict).toEqual(["email"]);
    expect(h.upserts[0].values).toEqual({
      email: "artist@example.com",
      tokenHash: issued.tokenHash,
      expiresAt: issued.expiresAt,
      consumedAt: null,
    });
  });
});

describe("consumeEmailVerificationToken", () => {
  it("updates only the live, unexpired hash and reports a win", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const hash = "a".repeat(64);

    await expect(consumeEmailVerificationToken("Artist@Example.com", hash, now)).resolves.toBe(
      true
    );

    const [builder] = h.builders;
    expect(builder.state.sets).toEqual([{ consumedAt: now }]);
    const sql = builder.state.conditions.map((c) => c.sql).join(" AND ");
    expect(sql).toContain("email = :email");
    expect(sql).toContain("tokenHash = :tokenHash");
    expect(sql).toContain('"consumedAt" IS NULL');
    expect(sql).toContain('"expiresAt" > :now');
    expect(builder.state.conditions[0].params).toEqual({ email: "artist@example.com" });
    expect(builder.state.conditions[1].params).toEqual({ tokenHash: hash });
  });

  it("reports a loss when no row matched", async () => {
    h.affectedQueue.push(0);
    await expect(consumeEmailVerificationToken(EMAIL, "b".repeat(64))).resolves.toBe(false);
  });
});

describe("invalidateEmailVerificationToken", () => {
  it("consumes the matching live hash so a failed send leaves no usable link", async () => {
    const hash = "c".repeat(64);
    await invalidateEmailVerificationToken("Artist@Example.com", hash);

    const [builder] = h.builders;
    expect(builder.state.sets[0].consumedAt).toBeInstanceOf(Date);
    const sql = builder.state.conditions.map((c) => c.sql).join(" AND ");
    expect(sql).toContain("email = :email");
    expect(sql).toContain("tokenHash = :tokenHash");
    expect(sql).toContain('"consumedAt" IS NULL');
  });
});
