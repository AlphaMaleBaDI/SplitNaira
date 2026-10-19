/**
 * Issue #1493: bounded health policy for configured Soroban RPC endpoints.
 *
 * A provider is temporarily quarantined after consecutive transport failures.
 * Successful requests reset its failure streak. Validation errors must not be
 * reported as provider-health failures: malformed data is not evidence that a
 * different provider's response is safe to trust.
 */
import type { rpc } from "@stellar/stellar-sdk";

export interface RpcProviderHealthOptions {
  failureThreshold?: number;
  cooldownMs?: number;
  now?: () => number;
}

export interface RpcProviderStatus {
  url: string;
  consecutiveFailures: number;
  unhealthyUntil: number;
}

export class RpcProviderHealthPolicy {
  private readonly providers: RpcProviderStatus[];
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;

  constructor(urls: readonly string[], options: RpcProviderHealthOptions = {}) {
    const uniqueUrls = [...new Set(urls.map((url) => url.trim()).filter(Boolean))];
    if (uniqueUrls.length === 0) {
      throw new Error("At least one Soroban RPC provider URL is required");
    }
    for (const url of uniqueUrls) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new Error("Soroban RPC provider URLs must be valid URLs");
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new Error("Soroban RPC provider URLs must use HTTP or HTTPS");
      }
    }

    this.providers = uniqueUrls.map((url) => ({
      url,
      consecutiveFailures: 0,
      unhealthyUntil: 0,
    }));
    this.failureThreshold = Math.max(1, Math.floor(options.failureThreshold ?? 1));
    this.cooldownMs = Math.max(1, Math.floor(options.cooldownMs ?? 30_000));
    this.now = options.now ?? Date.now;
  }

  /**
   * Prefer the primary endpoint; use backups only while earlier providers
   * are quarantined.
   */
  next(): string {
    const now = this.now();
    const eligible = this.providers.find((provider) => provider.unhealthyUntil <= now);
    if (eligible) return eligible.url;

    // Do not probe a quarantined endpoint early. Let the caller's existing
    // retry budget elapse until at least one cooldown has expired.
    throw new Error("All Soroban RPC providers are temporarily unavailable");
  }

  recordSuccess(url: string): void {
    const provider = this.find(url);
    provider.consecutiveFailures = 0;
    provider.unhealthyUntil = 0;
  }

  recordFailure(url: string): void {
    const provider = this.find(url);
    provider.consecutiveFailures += 1;
    if (provider.consecutiveFailures >= this.failureThreshold) {
      provider.unhealthyUntil = this.now() + this.cooldownMs;
    }
  }

  snapshot(): ReadonlyArray<Readonly<RpcProviderStatus>> {
    return this.providers.map((provider) => ({ ...provider }));
  }

  private find(url: string): RpcProviderStatus {
    const provider = this.providers.find((candidate) => candidate.url === url);
    if (!provider) {
      throw new Error("Unknown Soroban RPC provider");
    }
    return provider;
  }
}

/** Parse a comma-separated endpoint list without exposing URL values in errors. */
export function parseRpcProviderUrls(primary: string, backups?: string): string[] {
  const urls = [primary, ...(backups ?? "").split(",")].map((url) => url.trim()).filter(Boolean);
  const unique = [...new Set(urls)];
  if (unique.length === 0) {
    throw new Error("SOROBAN_RPC_URL must configure at least one provider");
  }
  return unique;
}


const failoverInstalledClients = new WeakSet<object>();
type RpcRequestConfig = { baseURL?: string; __rpcProviderUrl?: string };
type RpcResponseLike = { config?: RpcRequestConfig };
type RpcTransportError = {
  config?: RpcRequestConfig;
  code?: string;
  response?: { status?: number };
};

/**
 * Routes SDK HTTP requests through the provider health policy. Register this
 * AFTER response validation so malformed/stale payloads cannot mark a provider
 * healthy. Only transport failures, timeouts, rate limits and upstream 5xx
 * responses affect provider health; JSON-RPC and schema errors do not.
 */
export function installRpcProviderFailover(
  server: Pick<rpc.Server, "httpClient">,
  policy: RpcProviderHealthPolicy,
): boolean {
  const client = server.httpClient;
  if (!client?.interceptors?.request || !client?.interceptors?.response) return false;
  if (failoverInstalledClients.has(client)) return true;

  client.interceptors.request.use((config) => {
    const providerUrl = policy.next();
    config.baseURL = providerUrl;
    (config as typeof config & { __rpcProviderUrl?: string }).__rpcProviderUrl = providerUrl;
    return config;
  });

  client.interceptors.response.use(
    (response) => {
      const providerUrl = (response as typeof response & RpcResponseLike).config?.__rpcProviderUrl;
      if (providerUrl) policy.recordSuccess(providerUrl);
      return response;
    },
    (error: unknown) => {
      if (typeof error === "object" && error !== null) {
        const transportError = error as RpcTransportError;
        const providerUrl = transportError.config?.__rpcProviderUrl;
        const status = transportError.response?.status;
        const transportFailure = status === undefined || status === 429 || status >= 500;
        if (providerUrl && transportFailure) policy.recordFailure(providerUrl);
      }
      return Promise.reject(error);
    },
  );

  failoverInstalledClients.add(client);
  return true;
}
