import { createHash } from "node:crypto";

export const LOGIN_FAILURE_LIMIT = 5;
export const LOGIN_FAILURE_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;

interface AttemptState {
  failures: number;
  windowStartedAt: number;
  lockedUntil: number;
  pending: number;
}

/** Per-process guardrail, matching the deployment scope of the existing IP limiter. */
export class LoginAttemptStore {
  private readonly entries = new Map<string, AttemptState>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly capacity = 10_000
  ) {}

  private expired(entry: AttemptState, now: number): boolean {
    return (
      entry.pending === 0 &&
      (entry.lockedUntil > 0
        ? now >= entry.lockedUntil
        : now >= entry.windowStartedAt + LOGIN_FAILURE_WINDOW_MS)
    );
  }

  /** Null means a rejected sign-in; exceptions are operational failures, not bad credentials. */
  async attempt<T>(wallet: string, authenticate: () => Promise<T | null>): Promise<T | null> {
    const key = createHash("sha256").update(wallet).digest("hex");
    const now = this.now();
    let entry = this.entries.get(key);
    if (entry && this.expired(entry, now)) {
      this.entries.delete(key);
      entry = undefined;
    }
    if (!entry) {
      if (this.entries.size >= this.capacity) {
        for (const [storedKey, stored] of this.entries) {
          if (this.expired(stored, now)) this.entries.delete(storedKey);
        }
        // Never evict an active lock to make room for attacker-controlled identities.
        if (this.entries.size >= this.capacity) return null;
      }
      entry = { failures: 0, windowStartedAt: now, lockedUntil: 0, pending: 0 };
      this.entries.set(key, entry);
    }
    if (entry.lockedUntil > now || entry.failures + entry.pending >= LOGIN_FAILURE_LIMIT) {
      return null;
    }

    // Reserve before awaiting I/O so parallel requests cannot bypass the threshold.
    entry.pending += 1;
    try {
      const result = await authenticate();
      const completedAt = this.now();
      if (result !== null) {
        entry.failures = 0;
        entry.windowStartedAt = completedAt;
      } else {
        if (completedAt >= entry.windowStartedAt + LOGIN_FAILURE_WINDOW_MS) {
          entry.failures = 0;
          entry.windowStartedAt = completedAt;
        }
        entry.failures += 1;
        if (entry.failures >= LOGIN_FAILURE_LIMIT) {
          entry.lockedUntil = completedAt + LOGIN_LOCKOUT_MS;
        }
      }
      return result;
    } finally {
      entry.pending -= 1;
      if (entry.pending === 0 && entry.failures === 0) this.entries.delete(key);
    }
  }
}

export const loginAttemptStore = new LoginAttemptStore();
