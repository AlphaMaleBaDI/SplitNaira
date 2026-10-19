# Authorization Coverage Tests (issue #1483)

`contracts/authorization_coverage_tests.rs` inventories every public contract
entry point and proves that unauthorized callers fail for each protected
operation. Run it with:

```bash
cargo test --manifest-path contracts/Cargo.toml --features testutils \
    authorization_coverage
```

## Entry-point inventory (34 public functions)

| Class          | Count | Entry points                                                                                                                                                                                                                                                                                                                                                  | Gate                                                                                                               |
| -------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Admin-gated    | 7     | `set_max_collaborators`, `allow_token`, `disallow_token`, `pause_distributions`, `unpause_distributions`, `withdraw_unallocated`, `migrate_flat_to_buckets`                                                                                                                                                                                                   | `require_contract_admin`: stored-admin identity check (rejects impostors with `Unauthorized`), then `require_auth` |
| Owner-gated    | 4     | `update_collaborators`, `lock_project`, `update_project_metadata`, `transfer_project_ownership`                                                                                                                                                                                                                                                               | project-owner identity check (rejects impostors with `Unauthorized`), then `require_auth`                          |
| Signer-gated   | 4     | `set_admin`, `create_project`, `deposit`, `claim`                                                                                                                                                                                                                                                                                                             | `Address::require_auth` only — no contract-level identity check                                                    |
| Permissionless | 2     | `distribute`, `batch_distribute`                                                                                                                                                                                                                                                                                                                              | none by design (the math is trustless; see `authorization_tests::test_distribute_is_permissionless`)               |
| Read-only      | 17    | `get_max_collaborators`, `get_project`, `project_exists`, `get_claimed`, `refresh_project_storage`, `get_project_count`, `list_projects`, `list_project_summaries`, `get_balance`, `get_unallocated_balance`, `is_token_allowed`, `is_distributions_paused`, `get_allowed_token_count`, `get_allowed_tokens`, `get_admin`, `get_project_ids`, `get_claimable` | none — must execute with no authorization at all                                                                   |

## How "unauthorized callers fail" is asserted

- **Identity-gated operations (11).** The suite drives an impostor address
  through each call and asserts the exact contract error (`Unauthorized`, or
  `AdminNotSet` before an admin is configured), then verifies no state
  changed (pause flag, allowlist, admin, project owner/shares/metadata).
- **Signer-gated operations (4).** `require_auth` is the entire gate; a
  withheld or mismatched authorization is a _host trap_. In this `no_std`
  test build a host trap is a non-unwinding panic (SIGABRT) that kills the
  whole test binary — verified empirically — so the negative direction cannot
  be caught in-process with `try_` calls. Instead the suite asserts the
  positive requirement recorded by the recording auth environment
  (`env.auths()`): each entry point demands an authorization entry for
  exactly the documented signer, and `set_admin` rotation demands the
  _stored_ administrator rather than the address being nominated.
- **Read-only operations (17).** Proven to execute on a fully
  auth-enforcing environment (no `mock_all_auths` at all): if any read path
  secretly called `require_auth`, the test process would abort.

## Related suites

- `authorization_tests.rs` — deep owner/admin boundary tests and the
  permissionless-distribution guarantee (issue #865).
- `failure_invariant_tests.rs` — rejected operations leave storage and
  balances untouched (issue #1486).
