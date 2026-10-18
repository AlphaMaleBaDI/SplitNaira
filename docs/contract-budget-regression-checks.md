# Contract Budget Regression Checks (issue #1489)

`contracts/budget_regression_tests.rs` turns the measurements from
[`contract-cost-benchmarks.md`](contract-cost-benchmarks.md) into hard CI
gates: every critical entry point runs against an explicit CPU-instruction
and memory ceiling, and a breach fails the test run.

```bash
cargo test --manifest-path contracts/Cargo.toml --features testutils \
    budget_regression -- --nocapture
```

Each gate prints its observed value (`budget[<entry point>]: cpu=… mem=…`),
so a failing CI job shows the new measurement in its log.

## Why ceilings are trustworthy

Soroban budget accounting is deterministic — it is specified by the host, not
measured as wall-clock time — so a run on a laptop and a run on CI report the
identical cost for the same call. A ceiling breach therefore always means the
contract's resource profile changed, never machine noise.

## Gated entry points

| Gate                                                       | Entry point                            | Ceiling (CPU / memory)  | Baseline       |
| ---------------------------------------------------------- | -------------------------------------- | ----------------------- | -------------- |
| `create_project_stays_within_budget`                       | `create_project` (2 collabs)           | 600,000 / 100,000       | ~390k / ~55k   |
| `deposit_stays_within_budget`                              | `deposit` (2 collabs)                  | 600,000 / 100,000       | ~330k / ~50k   |
| `claim_stays_within_budget`                                | `claim` (2 collabs)                    | 800,000 / 140,000       | ~485k / ~80k   |
| `distribute_two_collaborators_stays_within_budget`         | `distribute` (2 collabs)               | 1,100,000 / 200,000     | ~683k / ~103k  |
| `distribute_default_cap_collaborators_stays_within_budget` | `distribute` (50 collabs, default cap) | 57,000,000 / 15,000,000 | ~37.6M / ~9.9M |

The `cost_benchmark_tests` suite additionally guards `claim(200)` and
`distribute(50)` with baselined ceilings (see
[`contract-cost-benchmarks.md`](contract-cost-benchmarks.md)).

## Re-baselining policy

Ceilings sit at roughly 1.5x of the observed cost at the time of writing.
**Raising a ceiling requires justification in the PR that changes the hot
path** — quote the new baseline from the test output and update
`contract-cost-benchmarks.md` in the same PR.

## Known finding: `distribute` at the 200-collaborator hard cap

Push `distribute` at the configured hard cap of 200 collaborators does not
fit in the Soroban per-transaction execution budget (~100M CPU
instructions): the host aborts the call when the budget is exhausted
(extrapolated ~150M instructions from the measured scaling). It therefore
cannot be measured in-process, and the benchmark matrix measures
{2, 10, 50} instead. Until the distribution path is made cheaper (or the cap
is lowered), very large projects should use the self-service **pull
`claim`** path — `claim(200)` measures ~2.36M instructions, comfortably
inside budget.
