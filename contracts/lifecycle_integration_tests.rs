#![cfg(test)]

//! Multi-transaction lifecycle integration tests (issue #1490).
//!
//! Exercises complete create -> fund -> claim -> pause -> resume -> completion
//! sequences in a single controlled test environment, asserting state after
//! every transaction and the accounting invariants that must hold at the end
//! of the sequence:
//!
//! - every stroop deposited is either paid out or still held as project
//!   balance (conservation: `sum(paid out) + project balance == sum(deposits)`),
//! - `total_distributed` and `distribution_round` advance exactly as far as
//!   the transactions that completed,
//! - pause blocks payouts (`claim` / `distribute`) but never funding, and a
//!   failed operation mid-sequence leaves the sequence itself intact,
//! - the claim-epoch rule (one claim per collaborator per funding epoch) holds
//!   across the whole sequence.

use crate::{errors::SplitError, Collaborator, SplitNairaContract, SplitNairaContractClient};
use soroban_sdk::{testutils::Address as _, token, vec, Address, Env, String, Symbol, Vec};

const DEPOSIT: i128 = 10_000_000;
const TOP_UP: i128 = 2_000_000;
const ALICE_BPS: u32 = 6_000;
const BOB_BPS: u32 = 4_000;

struct Fixture<'a> {
    env: Env,
    client: SplitNairaContractClient<'a>,
    admin: Address,
    owner: Address,
    funder: Address,
    token: Address,
    alice: Address,
    bob: Address,
    project_id: Symbol,
}

fn fixture<'a>(env: &'a Env, project_name: &str) -> Fixture<'a> {
    env.mock_all_auths();

    let token_admin = Address::generate(env);
    let token = env.register_stellar_asset_contract(token_admin);

    let contract_id = env.register_contract(None, SplitNairaContract);
    let client = SplitNairaContractClient::new(env, &contract_id);

    let admin = Address::generate(env);
    let owner = Address::generate(env);
    let funder = Address::generate(env);
    let alice = Address::generate(env);
    let bob = Address::generate(env);

    client.set_admin(&admin);

    let mut collabs: Vec<Collaborator> = Vec::new(env);
    collabs.push_back(Collaborator {
        address: alice.clone(),
        alias: String::from_str(env, "Alice"),
        basis_points: ALICE_BPS,
    });
    collabs.push_back(Collaborator {
        address: bob.clone(),
        alias: String::from_str(env, "Bob"),
        basis_points: BOB_BPS,
    });

    let project_id = Symbol::new(env, project_name);
    client.create_project(
        &owner,
        &project_id,
        &String::from_str(env, "Lifecycle Project"),
        &String::from_str(env, "music"),
        &token,
        &collabs,
    );

    Fixture {
        env: env.clone(),
        client,
        admin,
        owner,
        funder,
        token,
        alice,
        bob,
        project_id,
    }
}

fn mint_and_deposit(f: &Fixture, amount: i128) {
    token::StellarAssetClient::new(&f.env, &f.token).mint(&f.funder, &amount);
    f.client.deposit(&f.project_id, &f.funder, &amount);
}

fn balance(f: &Fixture) -> i128 {
    f.client.get_balance(&f.project_id)
}

fn token_balance(f: &Fixture, who: &Address) -> i128 {
    token::Client::new(&f.env, &f.token).balance(who)
}

// -----------------------------------------------------------------------------
// Primary lifecycle
// -----------------------------------------------------------------------------

/// Full sequence: create -> fund -> claim -> duplicate-claim rejected -> pause
/// -> payouts blocked (funding still allowed) -> resume -> claims on the new
/// epoch -> lock -> completion distribute -> terminal-state checks.
#[test]
fn full_lifecycle_create_fund_claim_pause_resume_completes_with_conserved_accounting() {
    let env = Env::default();
    let f = fixture(&env, "lifecycle_full");

    // ---- Phase 1: created ----
    let project = f.client.get_project(&f.project_id).expect("exists");
    assert_eq!(project.owner, f.owner);
    assert!(!project.locked);
    assert_eq!(project.distribution_round, 0);
    assert_eq!(project.total_distributed, 0);
    assert_eq!(f.client.get_project_count(), 1);
    assert_eq!(balance(&f), 0);

    // ---- Phase 2: funded (epoch 1) ----
    mint_and_deposit(&f, DEPOSIT);
    assert_eq!(balance(&f), DEPOSIT);
    assert_eq!(
        token_balance(&f, &f.funder),
        0,
        "funder spent the full deposit"
    );
    assert_eq!(token_balance(&f, &f.alice), 0);

    // ---- Phase 3: first claim (epoch 1) ----
    let alice_first = f.client.claim(&f.project_id, &f.alice);
    assert_eq!(alice_first, 6_000_000, "60% of the funded pool");
    assert_eq!(balance(&f), DEPOSIT - 6_000_000);
    assert_eq!(token_balance(&f, &f.alice), 6_000_000);

    // ---- Phase 4: duplicate claim rejected (same epoch) ----
    assert_eq!(
        f.client.try_claim(&f.project_id, &f.alice),
        Err(Ok(SplitError::AlreadyClaimed))
    );
    assert_eq!(
        balance(&f),
        DEPOSIT - 6_000_000,
        "rejected claim moved nothing"
    );
    assert_eq!(token_balance(&f, &f.alice), 6_000_000);

    // ---- Phase 5: pause blocks payouts, never funding ----
    f.client.pause_distributions(&f.admin);
    assert!(f.client.is_distributions_paused());
    assert_eq!(
        f.client.try_claim(&f.project_id, &f.bob),
        Err(Ok(SplitError::DistributionsPaused))
    );
    assert_eq!(
        f.client.try_distribute(&f.project_id),
        Err(Ok(SplitError::DistributionsPaused))
    );

    mint_and_deposit(&f, TOP_UP);
    assert_eq!(
        balance(&f),
        DEPOSIT - 6_000_000 + TOP_UP,
        "funding still works while paused"
    );

    // ---- Phase 6: resume ----
    f.client.unpause_distributions(&f.admin);
    assert!(!f.client.is_distributions_paused());

    // ---- Phase 7: claims on the new epoch ----
    let bob_second = f.client.claim(&f.project_id, &f.bob);
    assert_eq!(bob_second, 2_400_000, "40% of the 6M pool");
    assert_eq!(balance(&f), 3_600_000);
    let alice_second = f.client.claim(&f.project_id, &f.alice);
    assert_eq!(alice_second, 2_160_000, "60% of the remaining 3.6M");
    assert_eq!(balance(&f), 1_440_000);

    // ---- Phase 8: lock, then completion distribute ----
    f.client.lock_project(&f.project_id, &f.owner);
    assert!(f.client.get_project(&f.project_id).unwrap().locked);
    assert_eq!(
        f.client.try_update_project_metadata(
            &f.project_id,
            &f.owner,
            &String::from_str(&f.env, "New Title"),
            &String::from_str(&f.env, "film"),
        ),
        Err(Ok(SplitError::ProjectLocked)),
        "locked projects reject edits mid-lifecycle"
    );

    f.client.distribute(&f.project_id);
    assert_eq!(balance(&f), 0, "completion drains the pool");
    let project = f.client.get_project(&f.project_id).unwrap();
    assert_eq!(project.distribution_round, 1);
    assert_eq!(project.total_distributed, 12_000_000);

    // ---- Phase 9: conservation + terminal states ----
    let alice_total = token_balance(&f, &f.alice);
    let bob_total = token_balance(&f, &f.bob);
    assert_eq!(alice_total, 6_000_000 + 2_160_000 + 864_000);
    assert_eq!(bob_total, 2_400_000 + 576_000);
    assert_eq!(
        alice_total + bob_total,
        DEPOSIT + TOP_UP,
        "conservation: every deposited stroop was paid out"
    );
    assert_eq!(alice_total + bob_total, project.total_distributed);

    let alice_info = f.client.get_claimable(&f.project_id, &f.alice);
    assert_eq!(alice_info.claimed, 9_024_000);
    // `last_claim_amount` tracks the most recent *pull* claim; push payouts
    // from `distribute` update `claimed` but never `last_claim_amount`.
    assert_eq!(alice_info.last_claim_amount, 2_160_000);
    assert_eq!(alice_info.distribution_round, 1);

    // Terminal behaviour: no further payouts without new funding.
    assert_eq!(
        f.client.try_distribute(&f.project_id),
        Err(Ok(SplitError::NoBalance))
    );
    assert_eq!(
        f.client.claim(&f.project_id, &f.alice),
        0,
        "empty pool pays nothing"
    );
    assert_eq!(balance(&f), 0);
    let project = f.client.get_project(&f.project_id).unwrap();
    assert_eq!(
        project.distribution_round, 1,
        "empty/terminal ops do not advance the round"
    );
    assert_eq!(project.total_distributed, 12_000_000);
}

// -----------------------------------------------------------------------------
// Claim epochs across successive deposits
// -----------------------------------------------------------------------------

/// A new deposit opens a fresh claim epoch for every collaborator; until then
/// re-claims are rejected and payout math always runs against the *live*
/// pool, with `total_distributed` converging on the sum of all deposits.
#[test]
fn successive_deposits_open_new_claim_epochs_and_converge_on_total_deposits() {
    let env = Env::default();
    let f = fixture(&env, "lifecycle_epochs");

    // Epoch 1: deposit, both claim once.
    mint_and_deposit(&f, 5_000_000);
    assert_eq!(f.client.claim(&f.project_id, &f.alice), 3_000_000);
    assert_eq!(f.client.claim(&f.project_id, &f.bob), 800_000);
    assert_eq!(balance(&f), 1_200_000);

    // Same epoch: re-claims rejected, nothing moves.
    assert_eq!(
        f.client.try_claim(&f.project_id, &f.alice),
        Err(Ok(SplitError::AlreadyClaimed))
    );
    assert_eq!(
        f.client.try_claim(&f.project_id, &f.bob),
        Err(Ok(SplitError::AlreadyClaimed))
    );
    assert_eq!(balance(&f), 1_200_000);

    // Epoch 2: a new deposit re-opens claims for both.
    mint_and_deposit(&f, 5_000_000);
    assert_eq!(balance(&f), 6_200_000);
    assert_eq!(f.client.claim(&f.project_id, &f.alice), 3_720_000);
    assert_eq!(f.client.claim(&f.project_id, &f.bob), 992_000);
    assert_eq!(balance(&f), 1_488_000);

    // Settling the remainder completes the lifecycle.
    f.client.distribute(&f.project_id);
    assert_eq!(balance(&f), 0);

    let project = f.client.get_project(&f.project_id).unwrap();
    assert_eq!(project.distribution_round, 1);
    assert_eq!(project.total_distributed, 10_000_000);

    let alice_info = f.client.get_claimable(&f.project_id, &f.alice);
    let bob_info = f.client.get_claimable(&f.project_id, &f.bob);
    assert_eq!(alice_info.claimed, 3_000_000 + 3_720_000 + 892_800);
    assert_eq!(bob_info.claimed, 800_000 + 992_000 + 595_200);
    assert_eq!(
        alice_info.claimed + bob_info.claimed,
        10_000_000,
        "conservation across both epochs"
    );
}

// -----------------------------------------------------------------------------
// Batch lifecycle across two projects
// -----------------------------------------------------------------------------

/// `batch_distribute` settles several projects in one transaction and reports
/// per-project outcomes; a second pass reports `NoBalance` per project without
/// changing any project's round or totals.
#[test]
fn batch_distribute_lifecycle_settles_multiple_projects_and_reports_no_balance_on_reuse() {
    let env = Env::default();
    env.mock_all_auths();

    let token_admin = Address::generate(&env);
    let token = env.register_stellar_asset_contract(token_admin);
    let contract_id = env.register_contract(None, SplitNairaContract);
    let client = SplitNairaContractClient::new(&env, &contract_id);

    let owner = Address::generate(&env);
    let funder = Address::generate(&env);
    let token_client = token::StellarAssetClient::new(&env, &token);

    let make_collab_list = |bps_a: u32, bps_b: u32| -> Vec<Collaborator> {
        let a = Address::generate(&env);
        let b = Address::generate(&env);
        vec![
            &env,
            Collaborator {
                address: a,
                alias: String::from_str(&env, "A"),
                basis_points: bps_a,
            },
            Collaborator {
                address: b,
                alias: String::from_str(&env, "B"),
                basis_points: bps_b,
            },
        ]
    };

    let pid_a = Symbol::new(&env, "batch_a");
    let pid_b = Symbol::new(&env, "batch_b");
    client.create_project(
        &owner,
        &pid_a,
        &String::from_str(&env, "Batch A"),
        &String::from_str(&env, "music"),
        &token,
        &make_collab_list(6000, 4000),
    );
    client.create_project(
        &owner,
        &pid_b,
        &String::from_str(&env, "Batch B"),
        &String::from_str(&env, "art"),
        &token,
        &make_collab_list(5000, 5000),
    );

    token_client.mint(&funder, &3_000_000);
    client.deposit(&pid_a, &funder, &2_000_000);
    client.deposit(&pid_b, &funder, &1_000_000);

    let mut batch_ids: Vec<Symbol> = Vec::new(&env);
    batch_ids.push_back(pid_a.clone());
    batch_ids.push_back(pid_b.clone());

    let results = client.batch_distribute(&batch_ids);
    let mut expected: Vec<(Symbol, Option<SplitError>)> = Vec::new(&env);
    expected.push_back((pid_a.clone(), None));
    expected.push_back((pid_b.clone(), None));
    assert_eq!(results, expected);

    assert_eq!(client.get_balance(&pid_a), 0);
    assert_eq!(client.get_balance(&pid_b), 0);
    let a = client.get_project(&pid_a).unwrap();
    let b = client.get_project(&pid_b).unwrap();
    assert_eq!(a.distribution_round, 1);
    assert_eq!(b.distribution_round, 1);
    assert_eq!(a.total_distributed, 2_000_000);
    assert_eq!(b.total_distributed, 1_000_000);

    // Reuse on settled projects: per-project NoBalance, state untouched.
    let results_again = client.batch_distribute(&batch_ids);
    let mut expected_again: Vec<(Symbol, Option<SplitError>)> = Vec::new(&env);
    expected_again.push_back((pid_a.clone(), Some(SplitError::NoBalance)));
    expected_again.push_back((pid_b.clone(), Some(SplitError::NoBalance)));
    assert_eq!(results_again, expected_again);

    let a = client.get_project(&pid_a).unwrap();
    let b = client.get_project(&pid_b).unwrap();
    assert_eq!(a.distribution_round, 1);
    assert_eq!(b.distribution_round, 1);
    assert_eq!(a.total_distributed, 2_000_000);
    assert_eq!(b.total_distributed, 1_000_000);
}

// -----------------------------------------------------------------------------
// Missing-project boundaries during a live lifecycle
// -----------------------------------------------------------------------------

/// Operations aimed at a project that does not exist answer `NotFound` and
/// leave an existing, funded sibling project completely untouched.
#[test]
fn missing_project_operations_mid_lifecycle_leave_existing_projects_untouched() {
    let env = Env::default();
    let f = fixture(&env, "lifecycle_sibling");
    mint_and_deposit(&f, DEPOSIT);

    let missing = Symbol::new(&env, "no_such_project");
    let claimer = f.alice.clone();

    assert_eq!(
        f.client.try_claim(&missing, &claimer),
        Err(Ok(SplitError::NotFound))
    );
    assert_eq!(
        f.client.try_deposit(&missing, &f.funder, &1i128),
        Err(Ok(SplitError::NotFound))
    );
    assert_eq!(
        f.client.try_distribute(&missing),
        Err(Ok(SplitError::NotFound))
    );
    assert_eq!(
        f.client.try_get_balance(&missing),
        Err(Ok(SplitError::NotFound))
    );

    // The funded project is exactly where the failed calls left it.
    assert_eq!(balance(&f), DEPOSIT);
    let project = f.client.get_project(&f.project_id).unwrap();
    assert_eq!(project.total_distributed, 0);
    assert_eq!(project.distribution_round, 0);
    assert_eq!(token_balance(&f, &f.funder), 0);
}
