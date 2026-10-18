/**
 * Issue #1493: bounded health policy for configured Soroban RPC endpoints.
 *
 * A provider is temporarily quarantined after consecutive transport failures.
 * Successful requests reset its failure streak. Validation errors must not be
 * reported as provider-health failures: malformed data is not evidence that a
 * different provider's response is safe to trust.
 */
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
  private cursor = 0;

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
    this.failureThreshold = Math.max(1, Math.floor(options.failureThreshold ?? 2));
    this.cooldownMs = Math.max(1, Math.floor(options.cooldownMs ?? 30_000));
    this.now = options.now ?? Date.now;
  }

  /** Select the next eligible provider in stable round-robin order. */
  next(): string {
    const now = this.now();
    for (let offset = 0; offset < this.providers.length; offset += 1) {
      const index = (this.cursor + offset) % this.providers.length;
      const provider = this.providers[index]!;
      if (provider.unhealthyUntil <= now) {
        this.cursor = (index + 1) % this.providers.length;
        return provider.url;
      }
    }

    // Fail closed but permit a single half-open probe after the earliest
    // quarantine expires; never silently invent a provider or report success.
    const earliest = this.providers.reduce((best, provider) =>
      provider.unhealthyUntil < best.unhealthyUntil ? provider : best,
    );
    this.cursor = (this.providers.indexOf(earliest) + 1) % this.providers.length;
    return earliest.url;
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
  const urls = [primary, ...(backups ?? "").split(",")]
    .map((url) => url.trim())
    .filter(Boolean);
  const unique = [...new Set(urls)];
  if (unique.length === 0) {
    throw new Error("SOROBAN_RPC_URL must configure at least one provider");
  }
  return unique;
}
