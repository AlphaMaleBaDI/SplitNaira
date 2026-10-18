import { describe, expect, it } from "vitest";
import { parseRpcProviderUrls, RpcProviderHealthPolicy } from "./rpc-provider-health.js";

const PRIMARY = "https://rpc-a.example";
const BACKUP = "https://rpc-b.example";

describe("RpcProviderHealthPolicy", () => {
  it("prefers the primary endpoint until it fails", () => {
    const policy = new RpcProviderHealthPolicy([PRIMARY, BACKUP]);
    expect(policy.next()).toBe(PRIMARY);
    expect(policy.next()).toBe(PRIMARY);

    policy.recordFailure(PRIMARY);
    expect(policy.next()).toBe(BACKUP);
    expect(policy.next()).toBe(BACKUP);
  });

  it("quarantines a failed provider and retries it after cooldown", () => {
    let now = 100;
    const policy = new RpcProviderHealthPolicy([PRIMARY, BACKUP], {
      failureThreshold: 2,
      cooldownMs: 500,
      now: () => now,
    });

    policy.recordFailure(PRIMARY);
    expect(policy.next()).toBe(PRIMARY);
    policy.recordFailure(PRIMARY);
    expect(policy.next()).toBe(BACKUP);
    expect(policy.snapshot()[0]).toMatchObject({
      consecutiveFailures: 2,
      unhealthyUntil: 600,
    });

    now = 599;
    expect(policy.next()).toBe(BACKUP);
    now = 600;
    expect(policy.next()).toBe(PRIMARY);
  });

  it("resets the failure streak and quarantine after a successful response", () => {
    const policy = new RpcProviderHealthPolicy([PRIMARY], {
      failureThreshold: 1,
      cooldownMs: 500,
    });
    policy.recordFailure(PRIMARY);
    expect(policy.next()).toBe(PRIMARY); // all providers quarantined: bounded probe
    policy.recordSuccess(PRIMARY);
    expect(policy.snapshot()[0]).toMatchObject({
      consecutiveFailures: 0,
      unhealthyUntil: 0,
    });
  });

  it("deduplicates URLs and rejects invalid or unsupported URLs", () => {
    expect(parseRpcProviderUrls(PRIMARY, `${BACKUP}, ${PRIMARY}`)).toEqual([PRIMARY, BACKUP]);
    expect(() => new RpcProviderHealthPolicy(["not-a-url"])).toThrow(
      "Soroban RPC provider URLs must be valid URLs",
    );
    expect(() => new RpcProviderHealthPolicy(["ftp://rpc.example"])).toThrow(
      "Soroban RPC provider URLs must use HTTP or HTTPS",
    );
    expect(() => new RpcProviderHealthPolicy([])).toThrow(
      "At least one Soroban RPC provider URL is required",
    );
  });

  it("rejects recording health for an unconfigured provider", () => {
    const policy = new RpcProviderHealthPolicy([PRIMARY]);
    expect(() => policy.recordFailure("https://rpc-unknown.example")).toThrow(
      "Unknown Soroban RPC provider",
    );
  });
});
