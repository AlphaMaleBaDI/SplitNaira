# Contract Execution Cost Benchmarks & Scalability Guide

This document defines the resource cost models, benchmark measurement suite, and regression detection procedures for SplitNaira smart contracts on Soroban.

---

## 1. Overview

SplitNaira smart contracts execute royalty splits with support for up to:

- **50 Collaborators** (Default capacity, `DEFAULT_MAX_COLLABORATORS`)
- **200 Collaborators** (Configurable hard cap, `MAX_MAX_COLLABORATORS`)

To guarantee transaction reliability on Stellar mainnet and testnet, all execution paths must remain strictly within Soroban network resource limits (~100M CPU instructions, ~40MB memory per transaction budget).

---

## 2. Execution Path Complexity & Cost Models

| Path             | Complexity                                          | Description                                                                                                                               | Resource Consumption                                                                                    |
| :--------------- | :-------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------ |
| **`deposit`**    | $\mathcal{O}(1)$                                    | Transfers tokens into the contract and updates the internal project balance.                                                              | Constant (~200k CPU instructions, ~30k RAM bytes), independent of collaborator count.                   |
| **`distribute`** | $\mathcal{O}(N)$                                    | Push payout: iterates over all $N$ collaborators, calculates basis point allocations, transfers tokens, updates storage and emits events. | Scales linearly with collaborator count $N$.                                                            |
| **`claim`**      | $\mathcal{O}(N)$ lookup / $\mathcal{O}(1)$ transfer | Pull payout: a single collaborator withdraws their individual allocation.                                                                 | Low constant execution footprint (~350k–500k CPU instructions), independent of batch distribution size. |

---

## 3. Benchmark Measurement Suite

The automated benchmark suite is located in [`contracts/cost_benchmark_tests.rs`](file:///contracts/cost_benchmark_tests.rs).

### Running Benchmarks Locally

Maintainers can measure and print real-time budget usage using `cargo test`:

```bash
# Run cost benchmark suite with console output
cargo test --manifest-path contracts/Cargo.toml --features testutils cost_benchmark_tests -- --nocapture
```

### Benchmark Metrics Summary (measured, soroban-sdk 20.5.0)

| Execution Path        | Collaborator Count | CPU Instructions (measured)                                                           | Memory Bytes (measured) | Soroban Budget Headroom |
| :-------------------- | :----------------- | :------------------------------------------------------------------------------------ | :---------------------- | :---------------------- |
| `deposit`             | 2                  | ~330,000                                                                              | ~50,000                 | > 99% Headroom          |
| `deposit`             | 50                 | ~547,000                                                                              | ~93,000                 | > 99% Headroom          |
| `deposit`             | 200                | ~1,130,000                                                                            | ~179,000                | > 98% Headroom          |
| `claim` (1 recipient) | 2                  | ~485,000                                                                              | ~80,000                 | > 99% Headroom          |
| `claim` (1 recipient) | 50                 | ~981,000                                                                              | ~192,000                | > 99% Headroom          |
| `claim` (1 recipient) | 200                | ~2,357,000                                                                            | ~458,000                | > 97% Headroom          |
| `distribute`          | 2                  | ~683,000                                                                              | ~103,000                | > 99% Headroom          |
| `distribute`          | 10                 | ~3,756,000                                                                            | ~819,000                | > 96% Headroom          |
| `distribute`          | 50 (Default Max)   | ~37,581,000                                                                           | ~9,890,000              | > 62% Headroom          |
| `distribute`          | 200 (Hard Cap Max) | **not measurable** — exceeds the ~100M per-transaction instruction budget (see below) | —                       | —                       |

> Costs are measured by `cargo test … cost_benchmark_tests -- --nocapture`.
> Note that `deposit` is _not_ O(1): each call loads and re-stores the full
> `SplitProject`, including its collaborator vector, so cost grows with the
> collaborator count (though far slower than `distribute`).

---

## 4. Regression Ceilings & Automated Invariants

Regression ceilings are enforced in two suites (see
[`contract-budget-regression-checks.md`](contract-budget-regression-checks.md)
for the policy):

1. **`budget_regression_tests`** gates `create_project`, `deposit`, `claim`
   and `distribute` (2 and 50 collaborators) against ~1.5x-of-measured
   ceilings and prints the observed values for re-baselining.
2. **`cost_benchmark_tests`** additionally asserts monotonic scaling and
   guards `claim(200)` (< 3.6M instructions / < 700KB) and `distribute(50)`
   (< 57M instructions / < 15MB).

**Known finding.** Push `distribute` at the 200-collaborator hard cap does
not fit the per-transaction execution budget (~100M instructions;
extrapolated ~150M from the measured linear scaling), so the host aborts the
call and it cannot be measured or shipped as-is. Large projects should use
the self-service `claim` path until the push path is optimized or the cap is
reconsidered.

---

## 5. Architectural Recommendations for Large Splits

- For splits with $\le 50$ collaborators, the push `distribute` path is fast, cost-effective, and settles all recipients simultaneously in one ledger transaction.
- For extremely large splits ($\ge 100$ collaborators) or high-frequency distribution environments, users and dApps should favor the self-service **pull `claim`** path to minimize transaction footprint per operation.
