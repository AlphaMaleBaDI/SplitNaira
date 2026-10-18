import { beforeEach, describe, expect, it, vi } from "vitest";
import { LoginAttemptStore, LOGIN_FAILURE_WINDOW_MS, LOGIN_LOCKOUT_MS } from "./login-attempts.js";

describe("login attempt policy", () => {
  let now: number;
  let store: LoginAttemptStore;
  beforeEach(() => {
    now = 0;
    store = new LoginAttemptStore(() => now);
  });

  async function fail(count: number, wallet = "wallet") {
    for (let i = 0; i < count; i++) await store.attempt(wallet, async () => null);
  }

  it("allows success before the threshold and resets failures", async () => {
    await fail(4);
    expect(await store.attempt("wallet", async () => "ok")).toBe("ok");
    await fail(4);
    expect(await store.attempt("wallet", async () => "ok")).toBe("ok");
  });

  it("locks on the fifth failure, without extending the lock, and recovers at expiry", async () => {
    await fail(5);
    const authenticate = vi.fn(async () => "ok");
    now = LOGIN_LOCKOUT_MS - 1;
    expect(await store.attempt("wallet", authenticate)).toBeNull();
    expect(authenticate).not.toHaveBeenCalled();
    now = LOGIN_LOCKOUT_MS;
    expect(await store.attempt("wallet", authenticate)).toBe("ok");
  });

  it("counts the observation-window boundary from the first failure", async () => {
    await fail(4);
    now = LOGIN_FAILURE_WINDOW_MS;
    await fail(4);
    expect(await store.attempt("wallet", async () => "ok")).toBe("ok");
  });

  it("locks for a full cooldown when the fifth failure occurs near window expiry", async () => {
    await fail(4);
    now = LOGIN_FAILURE_WINDOW_MS - 1;
    await fail(1);
    now = LOGIN_FAILURE_WINDOW_MS;
    const authenticate = vi.fn(async () => "ok");
    expect(await store.attempt("wallet", authenticate)).toBeNull();
    now = LOGIN_FAILURE_WINDOW_MS - 1 + LOGIN_LOCKOUT_MS;
    expect(await store.attempt("wallet", authenticate)).toBe("ok");
  });

  it("isolates wallets", async () => {
    await fail(5);
    expect(await store.attempt("other", async () => "ok")).toBe("ok");
  });

  it("does not count operational errors or erase earlier failures", async () => {
    await fail(4);
    await expect(
      store.attempt("wallet", async () => {
        throw new Error("DB down");
      })
    ).rejects.toThrow("DB down");
    await fail(1);
    const authenticate = vi.fn(async () => "ok");
    expect(await store.attempt("wallet", authenticate)).toBeNull();
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("reserves pending attempts so concurrent requests cannot pass the limit", async () => {
    const finish: Array<(value: null) => void> = [];
    const requests = Array.from({ length: 5 }, () =>
      store.attempt("wallet", () => new Promise<null>((resolve) => finish.push(resolve)))
    );
    const extra = vi.fn(async () => "ok");
    expect(await store.attempt("wallet", extra)).toBeNull();
    expect(extra).not.toHaveBeenCalled();
    finish.forEach((resolve) => resolve(null));
    await Promise.all(requests);
    expect(await store.attempt("wallet", extra)).toBeNull();
    now = LOGIN_LOCKOUT_MS;
    expect(await store.attempt("wallet", extra)).toBe("ok");
  });

  it("bounds storage without evicting locks and reclaims expired entries", async () => {
    store = new LoginAttemptStore(() => now, 1);
    await fail(5);
    const authenticate = vi.fn(async () => "ok");
    expect(await store.attempt("new-wallet", authenticate)).toBeNull();
    expect(await store.attempt("wallet", authenticate)).toBeNull();
    expect(authenticate).not.toHaveBeenCalled();
    now = LOGIN_LOCKOUT_MS;
    expect(await store.attempt("new-wallet", authenticate)).toBe("ok");
  });

  it("releases storage after successful attempts and operational errors", async () => {
    store = new LoginAttemptStore(() => now, 1);
    await expect(
      store.attempt("wallet", async () => {
        throw new Error("DB down");
      })
    ).rejects.toThrow();
    expect(await store.attempt("other", async () => "ok")).toBe("ok");
    expect(await store.attempt("third", async () => "ok")).toBe("ok");
  });
});
