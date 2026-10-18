## Reliability Improvements (Wave 5)

### Changes
- Added `reliability_tests.rs` with edge-case tests:
  - `distribute` on missing project returns `NotFound`
  - `get_balance` on missing project returns `NotFound`
  - Collaborator with zero basis points returns `ZeroShare`

### Running
```
cargo test --locked
```

### Rollback
Delete `contracts/reliability_tests.rs`.

## Property Tests: Repeated Deposits Before Distribution

`deposit_property_tests.rs` checks the deposit → distribute path against 48
randomly generated cases per property: 2–5 collaborators with random
basis-point splits, 1–16 deposits, and amounts up to 1,000 tokens. The PRNG is
seeded, so runs are deterministic and need no extra crates.

Properties checked:
- Repeated deposits add up exactly in the project balance, the contract token
  balance and the accounted balance. `get_unallocated_balance` stays `0`, and
  the round, total distributed and claimed amounts stay at zero until
  `distribute` is called.
- Distributing after N deposits pays each collaborator the same amount as one
  deposit of the same total. The last collaborator gets the rounding
  remainder, and the balance ends at zero.
- When deposits into two projects that share a token are interleaved, funds
  never move between the projects.
- If the balance is smaller than the number of collaborators, `distribute`
  returns `NoBalance`. Deposits still add up until distribution becomes
  possible.

### Running
```
cargo test --features testutils deposit_property_tests
# explore new cases; failures print the case seed
SPLITNAIRA_PROPTEST_SEED=42 cargo test --features testutils deposit_property_tests
```

### Rollback
Delete `contracts/deposit_property_tests.rs` and its `mod` line in `lib.rs`.

## Property tests: collaborator split-percentage sums

`split_sum_property_tests.rs` generates collaborator allocations and checks the
basis-point validation and payout-conservation invariants. Valid allocations are
2..=5 members with every share >= 1 bp summing to exactly `10_000`; invalid
allocations are generated the same way but with a sum in `[n, 20_000]` other
than `10_000`, so the failure is isolated to the sum. As with the deposit
property tests, cases are deterministic (seeded xorshift PRNG, no extra crates)
and every assertion message prints the failing case seed.

Properties covered:

- Valid allocations are accepted by `create_project`, stored verbatim, and
  distribute the full deposit to collaborators. Payouts sum to the deposited
  amount; the project balance, contract token balance and unallocated balance
  all end at zero.
- Allocations whose shares do not sum to `10_000` are rejected with
  `InvalidSplit` by `create_project`, and rejection creates no project.
- An invalid `update_collaborators` is rejected with `InvalidSplit` and leaves
  the stored splits and the pending balance untouched; the original split still
  governs distribution exactly.
- A valid `update_collaborators` replaces the splits, and the new splits govern
  the pending balance while conserving the deposited total.
- Boundary sums (exactly 10_000 accepted; 9_999 and 10_001 rejected) and `u32`
  overflow sums (`ArithmeticOverflow`) behave as documented.

### Running
```
cargo test --features testutils split_sum_property_tests
# explore new cases; failures print the case seed
SPLITNAIRA_PROPTEST_SEED=1484 cargo test --features testutils split_sum_property_tests
```

### Rollback
Delete `contracts/split_sum_property_tests.rs` and its `mod` line in `lib.rs`.
