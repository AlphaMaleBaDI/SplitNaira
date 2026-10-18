# Failure Invariant Tests (issue #1486)

`contracts/failure_invariant_tests.rs` verifies that failed operations leave
storage and balances unchanged across representative failure paths. Run it
with:

```bash
cargo test --manifest-path contracts/Cargo.toml --features testutils \
    failure_invariant
```

## Method

Each test captures a full `Snapshot` of the observable state — project
balance, `total_distributed`, `distribution_round`, lock flag, owner, title,
collaborator basis points, per-collaborator `Claimed` / `LastClaimAmount`
ledgers, collaborator and funder token balances, unallocated balance, project
count and the pause flag — triggers one failure, and requires the snapshot to
compare equal afterwards. A single test walks several failure paths in
sequence, proving failures compose without side effects.

## Covered failure classes

| Entry point                                                                                        | Failure paths                                                                                |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `claim`                                                                                            | duplicate claim (same epoch), non-collaborator, paused, missing project                      |
| `deposit`                                                                                          | zero amount, negative amount, missing project                                                |
| `create_project`                                                                                   | invalid split total, disallowed token (allowlist enabled) — project counter must not advance |
| `distribute`                                                                                       | empty pool, dust pool (balance < collaborator count), paused, missing project                |
| `update_collaborators` / `update_project_metadata` / `transfer_project_ownership` / `lock_project` | invalid split totals, too few collaborators, wrong owner, locked project, double lock        |
| `withdraw_unallocated`                                                                             | zero/negative amount, overdraw, contract-address recipient, impostor admin                   |

## Known limitation

Paths where the _token host function itself_ fails (for example a `transfer`
from an account with insufficient funds) trap the test VM non-unwindingly
and cannot be asserted in-process; those boundaries are enforced and tested
at the token layer instead.

## Bug found by this suite

`withdraw_unallocated` used to call `extend_ttl` on the
`DataKey::AccountedTokenBalance` entry unconditionally. When no project had
ever recorded an accounted balance for the token — the documented
"recovery of direct transfers into the contract" scenario — that key does
not exist and `extend_ttl` traps the invocation, bricking the recovery path.
The contract now guards the renewal with a `has` check (see
`contracts/lib.rs`); `tests::test_withdraw_unallocated_*` and the snapshot
tests above pin the behaviour.
