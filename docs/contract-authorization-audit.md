# Contract Authorization Audit

Covers issue #1250: *Audit every contract authorization path*.

This document enumerates every state-changing method exposed by
`SplitNairaContract` (`contracts/lib.rs`), records the required signer for
each, maps the existing unauthorized-call test coverage, and documents
findings and remediation.

Read-only queries (`get_project`, `get_claimed`, `get_balance`,
`get_claimable`, `list_projects`, `list_project_summaries`,
`get_project_ids`, `get_project_count`, `project_exists`,
`is_token_allowed`, `is_distributions_paused`, `get_allowed_token_count`,
`get_allowed_tokens`, `get_admin`, `get_max_collaborators`,
`get_unallocated_balance`, `refresh_project_storage`) are intentionally
excluded: they perform no state mutation beyond TTL extension and require no
authorization.

## Authorization model

- **Project owner** gates owner-scoped project mutations.
- **Contract admin** gates global administration (allowlist, pause,
  capacity, recovery, migration, admin rotation).
- **Collaborator** gates self-service `claim`.
- **Funding address** gates `deposit`.
- **Permissionless**: `distribute` and `batch_distribute` require no caller
  authorization because funds are settled according to already-recorded
  collaborator shares.

## State-changing methods and required signers

| Method | Required signer | Notes |
| --- | --- | --- |
| `set_admin` | Current admin, or the proposed admin when none is set | Host-level `require_auth`; rotation is atomic |
| `pause_distributions` | Contract admin | Emits `DistributionsPaused` |
| `unpause_distributions` | Contract admin | Emits `DistributionsUnpaused` |
| `set_max_collaborators` | Contract admin | Value bounded to `[2, 200]` |
| `allow_token` | Contract admin | Appends to allowlist index |
| `disallow_token` | Contract admin | Removes from allowlist index |
| `migrate_flat_to_buckets` | Contract admin | One-time index migration |
| `withdraw_unallocated` | Contract admin | Cannot send to the contract itself |
| `create_project` | Project owner | Host-level `require_auth` |
| `update_collaborators` | Project owner | Rejected once locked |
| `lock_project` | Project owner | Permanent; no unlock |
| `update_project_metadata` | Project owner | Rejected once locked |
| `transfer_project_ownership` | Current owner | Works on locked projects |
| `deposit` | Funding address (`from`) | Token transfer pulled from `from` |
| `claim` | Claiming collaborator | One claim per claim epoch |
| `distribute` | None (permissionless) | Bounded by global pause flag |
| `batch_distribute` | None (permissionless) | Bounded by global pause flag |

## Test coverage map

Unauthorized-call coverage lives in `contracts/authorization_tests.rs`
(owner/admin/claim boundaries, permissionless distribution, admin rotation)
and `contracts/tests.rs` (functional coverage for `withdraw_unallocated`,
`set_max_collaborators`, `batch_distribute` pause behavior, allowlist
enforcement).

| Method | Unauthorized-call test |
| --- | --- |
| `update_collaborators` | `test_owner_gated_operations_reject_non_owner` |
| `lock_project` | `test_owner_gated_operations_reject_non_owner` |
| `update_project_metadata` | `test_owner_gated_operations_reject_non_owner` |
| `transfer_project_ownership` | `test_owner_gated_operations_reject_non_owner` |
| `pause_distributions` | `test_admin_gated_operations_reject_unauthorized_callers` |
| `unpause_distributions` | `test_admin_gated_operations_reject_unauthorized_callers` |
| `allow_token` | `test_allow_token_rejects_unauthorized_callers` |
| `disallow_token` | `test_admin_gated_operations_reject_unauthorized_callers` |
| `migrate_flat_to_buckets` | `test_admin_gated_operations_reject_unauthorized_callers` |
| `set_max_collaborators` | `test_set_max_collaborators_rejects_unauthorized_callers` |
| `withdraw_unallocated` | `test_withdraw_unallocated_rejects_unauthorized_callers` |
| `set_admin` | `test_set_admin_rejects_unauthorized_rotation` |
| `create_project` | `test_create_project_requires_owner_authorization` |
| `deposit` | `test_deposit_requires_funder_authorization` |
| `claim` | `test_claim_rejects_non_collaborator_and_preserves_state` |
| `distribute` | `test_distribute_is_permissionless` |
| `batch_distribute` | `test_batch_distribute_is_permissionless` |

## Findings and remediation

| # | Finding | Severity | Status |
| --- | --- | --- | --- |
| 1 | `allow_token` had no dedicated unauthorized-call test; coverage was only incidental via the `set_admin` rotation test. | Low | Remediated: `test_allow_token_rejects_unauthorized_callers` covers both the no-admin-set and configured-admin-rejects-attacker paths. |
| 2 | `set_max_collaborators` had no unauthorized-call test. | Low | Remediated: `test_set_max_collaborators_rejects_unauthorized_callers` verifies the effective cap is unchanged after rejection. |
| 3 | `withdraw_unallocated` had no unauthorized-call test asserting token balances are preserved. | Medium | Remediated: `test_withdraw_unallocated_rejects_unauthorized_callers` asserts the contract token balance is unchanged after rejection. |
| 4 | `create_project` and `deposit` rely on host-level `require_auth` rather than a `SplitError`; no test asserted that removing authorization entries blocks the call. | Medium | Remediated: `test_create_project_requires_owner_authorization` and `test_deposit_requires_funder_authorization` clear mocked auth entries and assert the call fails with no state change. |
| 5 | `batch_distribute` had no explicit permissionless regression test (only `distribute` did). | Low | Remediated: `test_batch_distribute_is_permissionless` mirrors the `distribute` test. |

No authorization bypasses were found. Every state-changing method either
enforces a `require_auth` boundary at the host level or validates the
supplied signer against stored contract state before mutating anything.
