#![cfg(test)]

//! Contract resource-budget regression checks (issue #1489).
//!
//! `cost_benchmark_tests` *measures and prints* costs for the hot paths. This
//! suite turns those measurements into hard CI gates: every critical entry
//! point runs against an explicit CPU-instruction and memory ceiling, and a
//! breach fails the test run ("unexplained regression").
//!
//! Soroban budget accounting is deterministic (host-spec-defined, not
//! wall-clock), so the measured values are identical across platforms and CI
//! machines — a ceiling breach therefore always means the contract's resource
//! profile changed.
//!
//! ## Re-baselining policy
//!
//! Ceilings sit at ~1.5x of the observed cost at the time of writing (see
//! `docs/contract-cost-benchmarks.md` for the observed numbers). Raising a
//! ceiling requires justification in the PR that changes the hot path — the
//! assertion messages print the observed value to make that diff explicit.
//!
//! ```text
//! cargo test --manifest-path contracts/Cargo.toml --features testutils \
//!     budget_regression -- --nocapture
//! ```

extern crate std;

use crate::{Collaborator, SplitNairaContract, SplitNairaContractClient};
use soroban_sdk::{testutils::Address as _, token, Address, Env, String, Symbol, Vec};
use std::println;
use std::string::ToString;

/// Hard ceiling for one entry point's resource profile.
struct BudgetCeiling {
    cpu_instructions: u64,
    memory_bytes: u64,
}

/// Observed ~390k CPU / ~55k mem when the ceilings below were baselined.
const CREATE_PROJECT_CEILING: BudgetCeiling = BudgetCeiling {
    cpu_instructions: 600_000,
    memory_bytes: 100_000,
};
/// Observed ~330k CPU / ~50k mem (2 collaborators, 10M stroops).
const DEPOSIT_CEILING: BudgetCeiling = BudgetCeiling {
    cpu_instructions: 600_000,
    memory_bytes: 100_000,
};
/// Observed ~485k CPU / ~80k mem (2 collaborators).
const CLAIM_CEILING: BudgetCeiling = BudgetCeiling {
    cpu_instructions: 800_000,
    memory_bytes: 140_000,
};
/// Observed ~683k CPU / ~103k mem (2 collaborators).
const DISTRIBUTE_SMALL_CEILING: BudgetCeiling = BudgetCeiling {
    cpu_instructions: 1_100_000,
    memory_bytes: 200_000,
};
/// Observed ~37.6M CPU / ~9.9M mem (50 collaborators, the default cap;
/// scaling is linear in N — see docs/contract-cost-benchmarks.md).
const DISTRIBUTE_DEFAULT_CAP_CEILING: BudgetCeiling = BudgetCeiling {
    cpu_instructions: 57_000_000,
    memory_bytes: 15_000_000,
};

impl BudgetCeiling {
    fn assert_within(&self, label: &str, cpu: u64, mem: u64) {
        println!("budget[{label}]: cpu={cpu} mem={mem}");
        assert!(
            cpu <= self.cpu_instructions,
            "CPU instruction budget regression in {label}: measured {cpu}, ceiling {} \
             (see docs/contract-cost-benchmarks.md for the re-baselining policy)",
            self.cpu_instructions
        );
        assert!(
            mem <= self.memory_bytes,
            "memory byte budget regression in {label}: measured {mem}, ceiling {} \
             (see docs/contract-cost-benchmarks.md for the re-baselining policy)",
            self.memory_bytes
        );
    }
}

/// Resets the budget, runs `op`, and returns the (cpu, mem) cost profile.
fn measure(env: &Env, op: impl FnOnce()) -> (u64, u64) {
    env.budget().reset_default();
    op();
    (
        env.budget().cpu_instruction_cost(),
        env.budget().memory_bytes_cost(),
    )
}

fn collaborator_list(env: &Env, count: u32, bps_each: u32) -> Vec<Collaborator> {
    let mut collabs: Vec<Collaborator> = Vec::new(env);
    for index in 0..count {
        collabs.push_back(Collaborator {
            address: Address::generate(env),
            alias: String::from_str(env, &index.to_string()),
            basis_points: bps_each,
        });
    }
    collabs
}

struct FundedProject<'a> {
    client: SplitNairaContractClient<'a>,
    token: Address,
    funder: Address,
    project_id: Symbol,
}

/// Registers a fresh contract, token and funded project with `count`
/// collaborators (equal shares), so a measured entry point starts from a
/// realistic state.
fn funded_project<'a>(env: &'a Env, name: &str, count: u32, deposit: i128) -> FundedProject<'a> {
    env.mock_all_auths();
    let contract_id = env.register_contract(None, SplitNairaContract);
    let client = SplitNairaContractClient::new(env, &contract_id);

    let token_admin = Address::generate(env);
    let token = env.register_stellar_asset_contract(token_admin);
    let funder = Address::generate(env);
    let owner = Address::generate(env);

    let project_id = Symbol::new(env, name);
    let bps_each = 10_000 / count;
    client.create_project(
        &owner,
        &project_id,
        &String::from_str(env, "Budget Project"),
        &String::from_str(env, "music"),
        &token,
        &collaborator_list(env, count, bps_each),
    );

    token::StellarAssetClient::new(env, &token).mint(&funder, &deposit);
    client.deposit(&project_id, &funder, &deposit);

    FundedProject {
        client,
        token,
        funder,
        project_id,
    }
}

// -----------------------------------------------------------------------------
// Regression gates
// -----------------------------------------------------------------------------

#[test]
fn create_project_stays_within_budget() {
    let env = Env::default();
    env.mock_all_auths();
    let contract_id = env.register_contract(None, SplitNairaContract);
    let client = SplitNairaContractClient::new(&env, &contract_id);

    let token_admin = Address::generate(&env);
    let token = env.register_stellar_asset_contract(token_admin);
    let owner = Address::generate(&env);
    let project_id = Symbol::new(&env, "budget_create");
    let collabs = collaborator_list(&env, 2, 5000);

    let (cpu, mem) = measure(&env, || {
        client.create_project(
            &owner,
            &project_id,
            &String::from_str(&env, "Budget Create"),
            &String::from_str(&env, "music"),
            &token,
            &collabs,
        );
    });
    CREATE_PROJECT_CEILING.assert_within("create_project", cpu, mem);
}

#[test]
fn deposit_stays_within_budget() {
    let env = Env::default();
    let f = funded_project(&env, "budget_deposit", 2, 1_000_000);

    // Top the funder up so the measured deposit has funds to move.
    token::StellarAssetClient::new(&env, &f.token).mint(&f.funder, &1_000_000);

    let (cpu, mem) = measure(&env, || {
        f.client.deposit(&f.project_id, &f.funder, &1_000_000i128);
    });
    DEPOSIT_CEILING.assert_within("deposit", cpu, mem);
}

#[test]
fn claim_stays_within_budget() {
    let env = Env::default();
    let f = funded_project(&env, "budget_claim", 2, 10_000_000);
    let claimer = f
        .client
        .get_project(&f.project_id)
        .unwrap()
        .collaborators
        .get(0)
        .unwrap()
        .address;

    let (cpu, mem) = measure(&env, || {
        f.client.claim(&f.project_id, &claimer);
    });
    CLAIM_CEILING.assert_within("claim", cpu, mem);
}

#[test]
fn distribute_two_collaborators_stays_within_budget() {
    let env = Env::default();
    let f = funded_project(&env, "budget_dist_two", 2, 10_000_000);

    let (cpu, mem) = measure(&env, || {
        f.client.distribute(&f.project_id);
    });
    DISTRIBUTE_SMALL_CEILING.assert_within("distribute(2)", cpu, mem);
}

#[test]
fn distribute_default_cap_collaborators_stays_within_budget() {
    // 50 collaborators is the compiled-in default cap and the documented
    // worst case for the O(N) push distribution path.
    let env = Env::default();
    let f = funded_project(&env, "budget_dist_fifty", 50, 100_000_000);

    let (cpu, mem) = measure(&env, || {
        f.client.distribute(&f.project_id);
    });
    DISTRIBUTE_DEFAULT_CAP_CEILING.assert_within("distribute(50)", cpu, mem);
}
