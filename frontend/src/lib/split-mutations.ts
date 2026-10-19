import type { QueryClient, QueryKey } from "@tanstack/react-query";

import { accountKeys, normalizeAccount, splitKeys } from "./query-keys";

/**
 * Mutation → dependent view map for split flows.
 *
 * Every write action lists the cached views it can make stale. After a
 * confirmed success the caller invalidates exactly these keys, so dashboards,
 * project detail, history and claimable balances refresh without a reload and
 * without blanket `invalidateQueries()` calls.
 *
 * Cross-account rule: account-scoped keys are only ever built for the account
 * that started the mutation, and are skipped entirely when the connected
 * wallet changed while the transaction was in flight.
 */

export type SplitMutationAction =
  | "create"
  | "deposit"
  | "distribute"
  | "claim"
  | "lock"
  | "update_metadata"
  | "update_collaborators"
  | "allow_token"
  | "disallow_token"
  | "pause_distributions"
  | "unpause_distributions"
  | "withdraw_unallocated";

export interface SplitMutationContext {
  projectId?: string;
  token?: string;
  /** Wallet that signed the mutation. */
  account?: string | null;
}

export interface InvalidationPlan {
  shared: QueryKey[];
  /** Keys inside the signer's account scope. */
  account: QueryKey[];
}

export function getInvalidationPlan(
  action: SplitMutationAction,
  ctx: SplitMutationContext = {},
): InvalidationPlan {
  const { projectId, token, account } = ctx;
  const shared: QueryKey[] = [];
  const own: QueryKey[] = [];
  const project = () => {
    if (!projectId) return;
    shared.push(splitKeys.detail(projectId), splitKeys.history(projectId));
  };

  switch (action) {
    case "create":
      shared.push(splitKeys.list());
      project();
      break;
    case "deposit":
    case "distribute":
    case "claim":
      shared.push(splitKeys.list());
      project();
      // Balances moved, so the signer's claimable view is stale. Other
      // collaborators' views are refreshed when *they* load, never from here.
      if (account && projectId) own.push(accountKeys.claimable(account, projectId));
      break;
    case "lock":
    case "update_metadata":
    case "update_collaborators":
      shared.push(splitKeys.list());
      project();
      if (action === "update_collaborators" && account) own.push(accountKeys.claimableAll(account));
      break;
    case "allow_token":
    case "disallow_token":
      shared.push(splitKeys.allowlistAll());
      break;
    case "pause_distributions":
    case "unpause_distributions":
      shared.push(splitKeys.adminStatus());
      break;
    case "withdraw_unallocated":
      shared.push(token ? splitKeys.unallocated(token) : splitKeys.unallocatedAll());
      break;
  }

  return { shared, account: own };
}

/**
 * Invalidates the dependent views of a confirmed mutation.
 *
 * `currentAccount` is the wallet connected *now*. If it differs from the
 * signer, the signer's account-scoped keys are skipped: that cache was already
 * dropped by the account switch and must not be refilled for a wallet that is
 * no longer connected. Returns the keys that were invalidated.
 */
export async function invalidateAfterMutation(
  queryClient: QueryClient | undefined,
  action: SplitMutationAction,
  ctx: SplitMutationContext,
  currentAccount: string | null,
): Promise<QueryKey[]> {
  if (!queryClient) return [];
  const plan = getInvalidationPlan(action, ctx);
  const sameAccount =
    Boolean(ctx.account) &&
    Boolean(currentAccount) &&
    normalizeAccount(ctx.account as string) === normalizeAccount(currentAccount as string);
  const keys = sameAccount ? [...plan.shared, ...plan.account] : plan.shared;
  await Promise.all(keys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
  return keys;
}
