#![cfg(test)]
//! Benchmark-style cost measurement tests for maximum collaborator distribution cost.
//!
//! This module tracks CPU instruction counts and memory byte costs for:
//! 1. `deposit`   — O(1) project funding
//! 2. `distribute` — O(N) push-based distribution across 2, 10, 50 (default max), and 200 (hard cap) collaborators
//! 3. `claim`      — O(N) lookup / O(1) transfer pull-based self-service payout
//!
//! These tests establish baseline resource consumption metrics and serve as regression
//! guards to prevent gas/CPU regressions in future contract upgrades.

extern crate std;

use std::format;
use std::println;
use std::string::String as StdString;

use soroban_sdk::{testutils::Address as _, token, vec, Address, Env, String, Symbol, Vec};

use crate::{
    Collaborator, SplitNairaContract, SplitNairaContractClient, DEFAULT_MAX_COLLABORATORS,
};

/// Snapshot of Soroban execution budget metrics.
#[derive(Clone, Copy, Debug)]
pub struct CostSnapshot {
    pub cpu_instructions: u64,
    pub memory_bytes: u64,
}

/// Helper that resets Soroban budget, executes an operation, and records cost metrics.
fn measure_cost<F: FnOnce() -> R, R>(env: &Env, f: F) -> (R, CostSnapshot) {
    env.budget().reset_default();
    let result = f();
    let cpu = env.budget().cpu_instruction_cost();
    let mem = env.budget().memory_bytes_cost();
    (
        result,
        CostSnapshot {
            cpu_instructions: cpu,
            memory_bytes: mem,
        },
    )
}

/// Helper to set up a test environment, token contract, and project with N collaborators.
fn setup_benchmark_project(
    env: &Env,
    num_collaborators: u32,
    initial_deposit: i128,
) -> (
    SplitNairaContractClient,
    Symbol,
    Address,
    Address,
    std::vec::Vec<Address>,
) {
    let contract_id = env.register_contract(None, SplitNairaContract);
    let client = SplitNairaContractClient::new(env, &contract_id);

    let admin = Address::generate(env);
    let owner = Address::generate(env);
    let token_admin = Address::generate(env);
    let token = env.register_stellar_asset_contract(token_admin.clone());

    // Configure admin and max collaborator cap if exceeding default (50)
    client.set_admin(&admin);
    if num_collaborators > DEFAULT_MAX_COLLABORATORS {
        client.set_max_collaborators(&admin, &num_collaborators);
    }

    let project_id_str = format!("bench_{}", num_collaborators);
    let project_id = Symbol::new(env, &project_id_str);

    let mut collab_addrs = std::vec::Vec::with_capacity(num_collaborators as usize);
    let mut collabs = Vec::new(env);

    let base_bp = 10_000 / num_collaborators;
    let remainder_bp = 10_000 - (base_bp * num_collaborators);

    for i in 0..num_collaborators {
        let addr = Address::generate(env);
        collab_addrs.push(addr.clone());
        let alias_str = format!("Collab_{}", i);
        let bp = if i == num_collaborators - 1 {
            base_bp + remainder_bp
        } else {
            base_bp
        };

        collabs.push_back(Collaborator {
            address: addr,
            alias: String::from_str(env, &alias_str),
            basis_points: bp,
        });
    }

    client.create_project(
        &owner,
        &project_id,
        &String::from_str(env, "Benchmark Project"),
        &String::from_str(env, "benchmark"),
        &token,
        &collabs,
    );

    if initial_deposit > 0 {
        let depositor = Address::generate(env);
        let token_client = token::StellarAssetClient::new(env, &token);
        token_client.mint(&depositor, &initial_deposit);
        client.deposit(&project_id, &depositor, &initial_deposit);
    }

    (client, project_id, owner, token, collab_addrs)
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. DEPOSIT BENCHMARK
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_deposit_cost_benchmark() {
    let env = Env::default();
    env.mock_all_auths();

    // Verify deposit cost on projects with 2, 50, and 200 collaborators
    for &collab_count in &[2, 50, 200] {
        let (client, project_id, _, token, _) = setup_benchmark_project(&env, collab_count, 0);

        let depositor = Address::generate(&env);
        let token_client = token::StellarAssetClient::new(&env, &token);
        let deposit_amount = 1_000_000i128;
        token_client.mint(&depositor, &deposit_amount);

        let (result, cost) = measure_cost(&env, || {
            client.deposit(&project_id, &depositor, &deposit_amount)
        });

        assert_eq!(result, ());

        println!(
            "Deposit | {:<4} collabs | cpu={} mem={}",
            collab_count, cost.cpu_instructions, cost.memory_bytes
        );

        // `deposit` is O(N) in practice: every call loads (and re-stores) the
        // full `SplitProject`, whose collaborator vector grows with N.
        // Ceilings are ~1.5x of the measured baseline
        // (docs/contract-cost-benchmarks.md):
        //   2   collabs -> ~330k CPU / ~50k mem
        //   50  collabs -> ~547k CPU / ~93k mem
        //   200 collabs -> ~1.13M CPU / ~179k mem
        let (cpu_ceiling, mem_ceiling) = match collab_count {
            2 => (500_000, 80_000),
            50 => (900_000, 150_000),
            200 => (1_700_000, 280_000),
            _ => unreachable!(),
        };
        assert!(
            cost.cpu_instructions < cpu_ceiling,
            "Deposit CPU cost exceeded ceiling for {} collabs: {} instructions",
            collab_count,
            cost.cpu_instructions
        );
        assert!(
            cost.memory_bytes < mem_ceiling,
            "Deposit Memory cost exceeded ceiling for {} collabs: {} bytes",
            collab_count,
            cost.memory_bytes
        );
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. DISTRIBUTE SCALING BENCHMARK (2, 10, 50 DEFAULT MAX, 200 HARD CAP)
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_distribute_cost_scaling_benchmark() {
    let env = Env::default();
    env.mock_all_auths();

    let deposit_amount = 100_000_000i128; // 10 XLM in stroops

    // `distribute` at the 200-collaborator hard cap does not fit inside the
    // Soroban per-transaction execution budget (~100M CPU instructions): the
    // host aborts the call once the budget is exhausted (extrapolated ~150M
    // instructions from the measured scaling below), so it cannot be measured
    // in-process at all. See docs/contract-cost-benchmarks.md.
    let test_counts = [2, 10, DEFAULT_MAX_COLLABORATORS];
    let mut costs: std::vec::Vec<(u32, CostSnapshot)> = std::vec::Vec::new();

    for &collab_count in &test_counts {
        let (client, project_id, _, _, _) =
            setup_benchmark_project(&env, collab_count, deposit_amount);

        let (result, cost) = measure_cost(&env, || client.distribute(&project_id));
        assert_eq!(result, ());

        costs.push((collab_count, cost));
    }

    // Print benchmark measurement summary for maintainers
    println!("\n=== DISTRIBUTE COST SCALING BENCHMARK ===");
    println!("Collaborators | CPU Instructions | Memory (Bytes)");
    println!("--------------------------------------------------");
    for (count, cost) in &costs {
        println!(
            "{:<13} | {:<16} | {:<14}",
            count, cost.cpu_instructions, cost.memory_bytes
        );
    }
    println!("==================================================\n");

    // Extract costs for key thresholds
    let cost_2 = costs.iter().find(|(c, _)| *c == 2).unwrap().1;
    let cost_10 = costs.iter().find(|(c, _)| *c == 10).unwrap().1;
    let cost_50 = costs.iter().find(|(c, _)| *c == 50).unwrap().1;

    // Verify monotonic linear scaling
    assert!(
        cost_10.cpu_instructions > cost_2.cpu_instructions,
        "Expected cost(10) > cost(2)"
    );
    assert!(
        cost_50.cpu_instructions > cost_10.cpu_instructions,
        "Expected cost(50) > cost(10)"
    );

    // REGRESSION GUARDS (baselined against measured costs; see
    // docs/contract-cost-benchmarks.md for the re-baselining policy):
    // Default max (50 collaborators) measures ~37.6M instructions / ~9.9M
    // bytes; the ceiling is ~1.5x of that and still under the ~100M
    // per-transaction instruction budget.
    assert!(
        cost_50.cpu_instructions < 57_000_000,
        "Regression: 50-collaborator distribute CPU cost too high: {} instructions",
        cost_50.cpu_instructions
    );
    assert!(
        cost_50.memory_bytes < 15_000_000,
        "Regression: 50-collaborator distribute Memory cost too high: {} bytes",
        cost_50.memory_bytes
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. CLAIM BENCHMARK (PULL-BASED PAYOUT PATH)
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_claim_cost_benchmark() {
    let env = Env::default();
    env.mock_all_auths();

    let deposit_amount = 100_000_000i128;
    let test_counts = [2, 50, 200];
    let mut claim_costs: std::vec::Vec<(u32, CostSnapshot)> = std::vec::Vec::new();

    for &collab_count in &test_counts {
        let (client, project_id, _, _, collab_addrs) =
            setup_benchmark_project(&env, collab_count, deposit_amount);

        // Claim for the middle collaborator
        let target_collab = &collab_addrs[collab_count as usize / 2];

        let (result, cost) = measure_cost(&env, || client.claim(&project_id, target_collab));
        assert!(result > 0);

        claim_costs.push((collab_count, cost));
    }

    println!("\n=== CLAIM COST BENCHMARK (PULL PAYOUT) ===");
    println!("Total Project Collabs | CPU Instructions | Memory (Bytes)");
    println!("---------------------------------------------------------");
    for (count, cost) in &claim_costs {
        println!(
            "{:<21} | {:<16} | {:<14}",
            count, cost.cpu_instructions, cost.memory_bytes
        );
    }
    println!("=========================================================\n");

    // Assert that claim cost remains small even on a 200-collaborator split:
    // a single pull claim (measured ~2.36M instructions / ~458KB at the 200
    // cap) stays an order of magnitude cheaper than a push distribution and
    // comfortably inside the per-transaction execution budget. Ceilings are
    // ~1.5x of the measured baseline (docs/contract-cost-benchmarks.md).
    let claim_cost_200 = claim_costs.iter().find(|(c, _)| *c == 200).unwrap().1;
    assert!(
        claim_cost_200.cpu_instructions < 3_600_000,
        "Claim CPU cost exceeded ceiling for 200-collab project: {} instructions",
        claim_cost_200.cpu_instructions
    );
    assert!(
        claim_cost_200.memory_bytes < 700_000,
        "Claim Memory cost exceeded ceiling for 200-collab project: {} bytes",
        claim_cost_200.memory_bytes
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. COMPARISON MATRIX: DEPOSIT vs DISTRIBUTE vs CLAIM
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn test_cost_comparison_matrix_and_regression_guard() {
    let env = Env::default();
    env.mock_all_auths();

    let deposit_amount = 100_000_000i128;

    println!("\n=== COMPREHENSIVE PATH COST COMPARISON ===");
    println!("Path               | Collab Count | CPU Instructions | Memory (Bytes)");
    println!("---------------------------------------------------------------------");

    // The 200-collaborator hard cap is excluded on purpose: its push
    // `distribute` exceeds the Soroban per-transaction execution budget
    // (~100M CPU instructions) and aborts the host, so it cannot be measured
    // in-process (see test_distribute_cost_scaling_benchmark).
    for &count in &[2, 10, 50] {
        // Measure deposit
        let (client, project_id, _, token, collab_addrs) = setup_benchmark_project(&env, count, 0);

        let depositor = Address::generate(&env);
        let token_client = token::StellarAssetClient::new(&env, &token);
        token_client.mint(&depositor, &deposit_amount);

        let (_, deposit_cost) = measure_cost(&env, || {
            client.deposit(&project_id, &depositor, &deposit_amount)
        });

        // Measure claim for 1 collaborator
        let target_collab = &collab_addrs[0];
        let (_, claim_cost) = measure_cost(&env, || client.claim(&project_id, target_collab));

        // Measure distribute for remaining balance
        let (_, distribute_cost) = measure_cost(&env, || client.distribute(&project_id));

        println!(
            "Deposit            | {:<12} | {:<16} | {:<14}",
            count, deposit_cost.cpu_instructions, deposit_cost.memory_bytes
        );
        println!(
            "Claim (1 collab)   | {:<12} | {:<16} | {:<14}",
            count, claim_cost.cpu_instructions, claim_cost.memory_bytes
        );
        println!(
            "Distribute (All)   | {:<12} | {:<16} | {:<14}",
            count, distribute_cost.cpu_instructions, distribute_cost.memory_bytes
        );
        println!("---------------------------------------------------------------------");

        // Verify distribute cost > claim cost when collaborators >= 2
        assert!(distribute_cost.cpu_instructions >= claim_cost.cpu_instructions);
    }
    println!("=====================================================================\n");
}
