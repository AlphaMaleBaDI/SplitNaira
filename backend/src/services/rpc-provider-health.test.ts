import { describe, expect, it } from "vitest";
import {
  installRpcProviderFailover,
  parseRpcProviderUrls,
  RpcProviderHealthPolicy,
} from "./rpc-provider-health.js";

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
    let now = 100;
    const policy = new RpcProviderHealthPolicy([PRIMARY], {
      failureThreshold: 1,
      cooldownMs: 500,
      now: () => now,
    });
    policy.recordFailure(PRIMARY);
    expect(() => policy.next()).toThrow(
      "All Soroban RPC providers are temporarily unavailable",
    );
    now = 600;
    expect(policy.next()).toBe(PRIMARY);
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


describe("installRpcProviderFailover", () => {
  type TestConfig = { baseURL?: string; __rpcProviderUrl?: string };
  let requestHandler: ((config: TestConfig) => TestConfig) | undefined;
  let rejectHandler: ((error: unknown) => unknown) | undefined;

  function install(policy: RpcProviderHealthPolicy): void {
    const fakeClient = {
      interceptors: {
        request: {
          use: (fulfilled: (config: TestConfig) => TestConfig) => {
            requestHandler = fulfilled;
          },
        },
        response: {
          use: (
            _fulfilled: (response: { config: TestConfig }) => unknown,
            rejected: (error: unknown) => unknown,
          ) => {
            rejectHandler = rejected;
          },
        },
      },
    };
    installRpcProviderFailover(
      { httpClient: fakeClient } as unknown as Parameters<typeof installRpcProviderFailover>[0],
      policy,
    );
  }

  it("quarantines a provider on a request timeout and routes the next request to backup", () => {
    const policy = new RpcProviderHealthPolicy([PRIMARY, BACKUP]);
    install(policy);

    const config = requestHandler!({ baseURL: PRIMARY });
    expect(config.baseURL).toBe(PRIMARY);
    rejectHandler!({ code: "ECONNABORTED", config });
    expect(requestHandler!({ baseURL: PRIMARY }).baseURL).toBe(BACKUP);
  });

  it("does not mark a provider unhealthy for a stale/schema-invalid response", () => {
    const policy = new RpcProviderHealthPolicy([PRIMARY]);
    install(policy);

    requestHandler!({ baseURL: PRIMARY });
    rejectHandler!(new Error("RPC response request ID did not match"));
    expect(policy.next()).toBe(PRIMARY);
  });
});
