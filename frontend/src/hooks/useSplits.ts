import { useContext, useEffect, useRef } from "react";
import { QueryClientContext, useMutation, useQuery, type QueryClient } from "@tanstack/react-query";
import {
  getAllSplits,
  getSplit,
  getProjectHistory,
  getClaimable,
  getTokenAllowlist,
  getAdminStatus,
  getUnallocatedBalance,
} from "@/lib/api";
import { accountKeys, isForeignAccountKey, splitKeys } from "@/lib/query-keys";
import {
  invalidateAfterMutation,
  type SplitMutationAction,
  type SplitMutationContext,
} from "@/lib/split-mutations";

export { accountKeys, splitKeys } from "@/lib/query-keys";

/** The provider's QueryClient, or undefined when rendered without one (tests, storybook). */
export function useOptionalQueryClient(): QueryClient | undefined {
  return useContext(QueryClientContext);
}

export function useAllSplits() {
  return useQuery({
    queryKey: splitKeys.list(),
    queryFn: getAllSplits,
  });
}

export function useSplit(projectId: string) {
  return useQuery({
    queryKey: splitKeys.detail(projectId),
    queryFn: () => getSplit(projectId),
    enabled: Boolean(projectId),
  });
}

export function useProjectHistory(projectId: string) {
  return useQuery({
    queryKey: splitKeys.history(projectId),
    queryFn: () => getProjectHistory(projectId),
    enabled: Boolean(projectId),
  });
}

/** Account-scoped: cached under the wallet's own scope, dropped on account switch. */
export function useClaimable(projectId: string, address: string) {
  return useQuery({
    queryKey: accountKeys.claimable(address, projectId),
    queryFn: () => getClaimable(projectId, address),
    enabled: Boolean(projectId) && Boolean(address),
  });
}

export function useTokenAllowlist(start = 0, limit = 100) {
  return useQuery({
    queryKey: splitKeys.allowlist(start, limit),
    queryFn: () => getTokenAllowlist(start, limit),
  });
}

export function useAdminStatus() {
  return useQuery({
    queryKey: splitKeys.adminStatus(),
    queryFn: getAdminStatus,
  });
}

export function useUnallocatedBalance(token: string) {
  return useQuery({
    queryKey: splitKeys.unallocated(token),
    queryFn: () => getUnallocatedBalance(token),
    enabled: Boolean(token),
  });
}

/**
 * Drops every account-scoped query that does not belong to `address`, and all
 * of them on disconnect. In-flight fetches for the old account are cancelled
 * first so a late response can't repopulate its cache.
 */
export function useAccountScopedCache(address: string | null) {
  const queryClient = useOptionalQueryClient();
  const previous = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (!queryClient) return;
    if (previous.current === address) return;
    previous.current = address;
    const predicate = (query: { queryKey: readonly unknown[] }) =>
      isForeignAccountKey(query.queryKey, address);
    void queryClient.cancelQueries({ predicate });
    queryClient.removeQueries({ predicate });
  }, [address, queryClient]);
}

/**
 * Split write action with dependent-view invalidation.
 *
 * Mutations are never retried automatically (they are not idempotent). The
 * signer is captured when the mutation starts; on success only the shared
 * views plus that signer's own account scope are invalidated, and the latter
 * is skipped if the wallet changed mid-flight.
 */
export function useSplitMutation<TVars extends SplitMutationContext, TResult>(
  action: SplitMutationAction,
  mutationFn: (vars: TVars) => Promise<TResult>,
  currentAccount: string | null,
) {
  const queryClient = useOptionalQueryClient();
  const accountRef = useRef(currentAccount);
  accountRef.current = currentAccount;

  return useMutation({
    mutationKey: ["split-mutation", action],
    mutationFn,
    retry: 0,
    onSuccess: (_result, vars) =>
      invalidateAfterMutation(queryClient, action, vars, accountRef.current),
  });
}
