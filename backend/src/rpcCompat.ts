export type RpcKind = "soroban-rpc" | "horizon";

export interface CompatEntry {
  kind: RpcKind;
  provider: string;
  network: "testnet" | "mainnet";
  url: string;
  /** Minimum version covered by the smoke suite (major.minor.patch). */
  minVersion: string;
}

export interface SmokeResult {
  provider: string;
  kind: RpcKind;
  network: string;
  url: string;
  ok: boolean;
  version: string | null;
  error: string | null;
}

export interface SmokeOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxEndpoints?: number;
}

export const DEFAULT_TIMEOUT_MS = 5000;
export const DEFAULT_MAX_ENDPOINTS = 10;

export const COMPATIBILITY_MATRIX: readonly CompatEntry[] = [
  {
    kind: "soroban-rpc",
    provider: "Stellar Development Foundation",
    network: "testnet",
    url: "https://soroban-testnet.stellar.org",
    minVersion: "21.0.0",
  },
  {
    kind: "horizon",
    provider: "Stellar Development Foundation",
    network: "testnet",
    url: "https://horizon-testnet.stellar.org",
    minVersion: "2.28.0",
  },
];

export function parseVersion(value: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(value).trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isVersionSupported(actual: string, minimum: string): boolean {
  const a = parseVersion(actual);
  const m = parseVersion(minimum);
  if (!a || !m) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] > m[i]) return true;
    if (a[i] < m[i]) return false;
  }
  return true;
}

async function request(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function rpcCall(
  fetchImpl: typeof fetch,
  url: string,
  method: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const body = (await request(
    fetchImpl,
    url,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method }),
    },
    timeoutMs,
  )) as { result?: Record<string, unknown>; error?: { code?: number } };
  if (body.error) throw new Error(`RPC error ${body.error.code ?? "unknown"}`);
  if (!body.result) throw new Error("Missing RPC result");
  return body.result;
}

async function checkEntry(
  entry: CompatEntry,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<SmokeResult> {
  const base: SmokeResult = {
    provider: entry.provider,
    kind: entry.kind,
    network: entry.network,
    url: entry.url,
    ok: false,
    version: null,
    error: null,
  };
  try {
    if (!entry.url.startsWith("https://")) {
      throw new Error("Only https endpoints are allowed");
    }
    let version: string | null = null;
    if (entry.kind === "soroban-rpc") {
      const health = await rpcCall(fetchImpl, entry.url, "getHealth", timeoutMs);
      if (health.status !== "healthy") throw new Error("Unhealthy");
      const info = await rpcCall(fetchImpl, entry.url, "getVersionInfo", timeoutMs);
      version = typeof info.version === "string" ? info.version : null;
    } else {
      const root = (await request(fetchImpl, entry.url, { method: "GET" }, timeoutMs)) as {
        horizon_version?: string;
      };
      version = typeof root.horizon_version === "string" ? root.horizon_version : null;
    }
    if (!version) throw new Error("Version not reported");
    if (!isVersionSupported(version, entry.minVersion)) {
      throw new Error(`Version ${version} is below minimum ${entry.minVersion}`);
    }
    return { ...base, ok: true, version };
  } catch (err) {
    const e = err as Error;
    return { ...base, error: e.name === "AbortError" ? "timeout" : e.message };
  }
}

/** Read-only, sequential, bounded. Never signs or submits transactions. */
export async function runSmoke(
  entries: readonly CompatEntry[],
  options: SmokeOptions = {},
): Promise<SmokeResult[]> {
  const max = options.maxEndpoints ?? DEFAULT_MAX_ENDPOINTS;
  if (entries.length > max) {
    throw new RangeError(`Too many endpoints: ${entries.length} > ${max}`);
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const results: SmokeResult[] = [];
  for (const entry of entries) {
    results.push(await checkEntry(entry, fetchImpl, timeoutMs));
  }
  return results;
}