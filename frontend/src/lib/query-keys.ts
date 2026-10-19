/**
 * React Query keys, split by who may see the data.
 *
 * - `splitKeys`   shared on-chain/project data, the same for every viewer.
 * - `accountKeys` data that depends on the connected wallet. Everything lives
 *                 under `["account", <address>]`, so a wallet switch or
 *                 disconnect can drop exactly one account's cache and nothing
 *                 from another account can be served to the new one.
 *
 * Never put a wallet address inside a `splitKeys` entry: it would survive an
 * account switch. See docs/frontend-state-architecture.md.
 */

export const splitKeys = {
  all: ["splits"] as const,
  list: () => [...splitKeys.all, "list"] as const,
  detail: (projectId: string) => [...splitKeys.all, "detail", projectId] as const,
  history: (projectId: string) => [...splitKeys.all, "history", projectId] as const,
  allowlist: (start: number, limit: number) =>
    [...splitKeys.all, "allowlist", start, limit] as const,
  allowlistAll: () => [...splitKeys.all, "allowlist"] as const,
  adminStatus: () => [...splitKeys.all, "adminStatus"] as const,
  unallocated: (token: string) => [...splitKeys.all, "unallocated", token] as const,
  unallocatedAll: () => [...splitKeys.all, "unallocated"] as const,
};

export const ACCOUNT_SCOPE = "account" as const;

/** Stellar G-addresses are case-insensitive base32; normalise for stable keys. */
export function normalizeAccount(address: string): string {
  return address.trim().toUpperCase();
}

export const accountKeys = {
  all: () => [ACCOUNT_SCOPE] as const,
  scope: (address: string) => [ACCOUNT_SCOPE, normalizeAccount(address)] as const,
  claimable: (address: string, projectId: string) =>
    [...accountKeys.scope(address), "claimable", projectId] as const,
  claimableAll: (address: string) => [...accountKeys.scope(address), "claimable"] as const,
};

/** True when `queryKey` belongs to some account scope other than `current`. */
export function isForeignAccountKey(queryKey: readonly unknown[], current: string | null): boolean {
  if (queryKey[0] !== ACCOUNT_SCOPE) return false;
  if (!current) return true;
  return queryKey[1] !== normalizeAccount(current);
}
