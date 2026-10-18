import { describe, expect, it, vi } from "vitest";
import { parseRpcProviderUrls, RpcProviderHealthPolicy } from "./rpc-provider-health.js";

describe("RpcProviderHealthPolicy", () => {
  it("selects configured providers in round-robin order", () => {
    const policy = new RpcProviderHealthPolicy(["https://rpc-a.example", "https://rpc-b.example"]);
    expect(policy.next()).toBe("https://rpc-a.example");
    expect(policy.next()).toBe("https://rpc-b.example");
    expect(policy.next()).toBe("https://rpc-a.example");
  });

  it("quarantines a failing provider after the configured threshold", () => {
    let now = 100;
    const policy = new RpcProviderHealthPolicy(
      ["https://rpc-a.example", "https://rpc-b.example"],
      { failureThreshold: 2, cooldownMs: 500, now: () => now },
    );

    policy.recordFailure("https://rpc-a.example");
    expect(policy.next()).toBe("https://rpc-a.example");
    policy.recordFailure("https://rpc-a.example");
    expect(policy.next()).toBe("https://rpc-b.example");
    expect(policy.snapshot()[0]).toMatchObject({
      consecutiveFailures: 2,
      unhealthyUntil: 600,
    });

    now = 601;
    expect(policy.next()).toBe("https://rpc-a.example");
  });

  it("resets the failure streak after success", () => {
    const policy = new RpcProviderHealthPolicy(["https://rpc-a.example"], {
      failureThreshold: 2,
    });
    policy.recordFailure("https://rpc-a.example");
    policy.recordSuccess("https://rpc-a.example");
    policy.recordFailure("https://rpc-a.example");
    expect(policy.snapshot()[0]?.unhealthyUntil).toBe(0);
  });

  it("deduplicates configured URLs and rejects invalid URLs", () => {
    expect(parseRpcProviderUrls("https://rpc-a.example", "https://rpc-b.example, https://rpc-a.example"))
      .toEqual(["https://rpc-a.example", "https://rpc-b.example"]);
    expect(() => new RpcProviderHealthPolicy(["not-a-url"])).toThrow(
      "Soroban RPC provider URLs must be valid URLs",
    );
    expect(() => new RpcProviderHealthPolicy([])).toThrow(
      "At least one Soroban RPC provider URL is required",
    );
  });

  it("rejects recording a provider that was not configured", () => {
    const policy = new RpcProviderHealthPolicy(["https://rpc-a.example"]);
    expect(() => policy.recordFailure("https://rpc-unknown.example")).toThrow(
      "Unknown Soroban RPC provider",
    );
  });
});
