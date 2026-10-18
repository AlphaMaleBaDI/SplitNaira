/**
 * Server-side cooldown for email verification resends (#1443).
 *
 * In-memory and per-instance, like `services/idempotency.ts` and the
 * express-rate-limit stores: a cooldown only needs to outlive a short window
 * (default 60s), so persisting it would add a table and a query per request
 * without much benefit. With N instances behind a load balancer, a client
 * could get at most N sends per window. The IP-based `authLimiter` on
 * `/auth` still applies on top of this.
 *
 * `tryAcquire` is synchronous, so concurrent requests for the same email
 * can't both pass: the first one claims the slot before any `await`, and the
 * rest see it as taken.
 */

export type CooldownResult = { ok: true } | { ok: false; retryAfterMs: number };

const DEFAULT_COOLDOWN_MS = 60_000;

export function resolveResendCooldownMs(raw = process.env.EMAIL_VERIFICATION_RESEND_COOLDOWN_MS): number {
  const parsed = Number(raw);
  return raw !== undefined && raw !== "" && Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_COOLDOWN_MS;
}

export class ResendCooldown {
  private readonly nextAllowedAt = new Map<string, number>();

  constructor(
    readonly cooldownMs: number = resolveResendCooldownMs(),
    private readonly now: () => number = () => Date.now()
  ) {}

  /** Normalizes an email so case and whitespace variants share one cooldown. */
  static keyFor(email: string): string {
    return email.trim().toLowerCase();
  }

  tryAcquire(email: string): CooldownResult {
    const key = ResendCooldown.keyFor(email);
    const now = this.now();
    this.prune(now);

    const allowedAt = this.nextAllowedAt.get(key);
    if (allowedAt !== undefined && allowedAt > now) {
      return { ok: false, retryAfterMs: allowedAt - now };
    }

    this.nextAllowedAt.set(key, now + this.cooldownMs);
    return { ok: true };
  }

  /** Gives the slot back, e.g. when the send itself failed and the user should be able to retry. */
  release(email: string): void {
    this.nextAllowedAt.delete(ResendCooldown.keyFor(email));
  }

  clear(): void {
    this.nextAllowedAt.clear();
  }

  private prune(now: number): void {
    for (const [key, allowedAt] of this.nextAllowedAt) {
      if (allowedAt <= now) this.nextAllowedAt.delete(key);
    }
  }
}

export const verificationResendCooldown = new ResendCooldown();
