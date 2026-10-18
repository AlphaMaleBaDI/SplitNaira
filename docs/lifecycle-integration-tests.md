# Lifecycle Integration Tests (issue #1490)

`contracts/lifecycle_integration_tests.rs` exercises complete multi-transaction
sequences on the controlled Soroban test environment and asserts state after
every transaction. Run it with:

```bash
cargo test --manifest-path contracts/Cargo.toml --features testutils \
    lifecycle_integration
```

## Covered sequences

1. **Full lifecycle** (`full_lifecycle_create_fund_claim_pause_resume_completes_with_conserved_accounting`)
   create → fund → claim → duplicate-claim rejected → pause → payouts blocked
   while funding still works → resume → claims on the new epoch → lock →
   completion distribute → terminal-state checks.
2. **Claim epochs** (`successive_deposits_open_new_claim_epochs_and_converge_on_total_deposits`)
   two deposits, claims and duplicate-claim rejections per epoch, final
   settlement converging `total_distributed` on the sum of all deposits.
3. **Batch lifecycle** (`batch_distribute_lifecycle_settles_multiple_projects_and_reports_no_balance_on_reuse`)
   `batch_distribute` settles several projects in one transaction; a reuse
   pass reports per-project `NoBalance` without advancing any round.
4. **Missing-project boundaries** (`missing_project_operations_mid_lifecycle_leave_existing_projects_untouched`)
   `NotFound` answers for claim/deposit/distribute/balance reads on a
   non-existent project without touching a funded sibling.

## Invariants asserted at the end of every sequence

- **Conservation:** every deposited stroop is either still project balance or
  has been paid out — `sum(collaborator token balances) == sum(deposits) ==
total_distributed + balance`.
- **Round accounting:** `distribution_round` increments exactly once per
  successful push distribution; claims never increment it.
- **Claim epochs:** one claim per collaborator per funding epoch; a new
  deposit (even while paused) re-opens the epoch for everyone.
- **Pause semantics:** pause blocks `claim`/`distribute` only; `deposit`
  keeps working and the resumed state is exactly where the sequence left it.
- **Lock semantics:** a locked project rejects split/metadata edits but still
  completes its final distribution.

Note on `get_claimable`: `last_claim_amount` tracks the most recent _pull_
`claim`; push payouts from `distribute` update `claimed` but never
`last_claim_amount`.
