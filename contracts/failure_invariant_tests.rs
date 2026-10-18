#![cfg(test)]

//! Invariant tests for failed contract calls (issue #1486).
//!
//! Every representative failure path must leave storage and token balances
//! exactly as they were: a rejected operation may not advance rounds, move
//! funds, mutate collaborator shares, or corrupt claim ledgers. Each test
//! captures a full `Snapshot` of the observable state, triggers a failure, and
//! requires the snapshot to compare equal afterwards.
//!
//! Failure classes covered:
//! - `claim`: duplicate (same epoch), non-collaborator, paused, missing project;
//! - `deposit`: zero / negative amount, missing project;
//! - `create_project`: disallowed token (allowlist enabled), invalid split totals;
//! - `distribute`: empty pool, dust pool (balance < collaborator count), paused,
//!   missing project;
//! - project edits: invalid / undersized splits, wrong owner, locked project,
//!   double lock;
//! - admin recovery (`withdraw_unallocated`): zero / negative amount, overdraw,
//!   contract-address recipient, wrong admin.
//!
//! Paths where the *token host function itself* fails (e.g. a `transfer` from
//! an account with insufficient funds) trap the test VM non-unwindingly and
//! are therefore verified at the token layer, not in-process (see
//! docs/failure_invariant_tests.md).

use crate::{errors::SplitError, Collaborator, SplitNairaContract, SplitNairaContractClient};
use soroban_sdk::{testutils::Address as _, token, Address, Env, String, Symbol, Vec};

const DEPOSIT: i128 = 10_000_000;

struct Fixture<'a> {
    env: Env,
    client: SplitNairaContractClient<'a>,
    contract_id: Address,
    admin: Address,
    owner: Address,
    funder: Address,
    token: Address,
    alice: Address,
    bob: Address,
    project_id: Symbol,
}

fn fixture<'a>(env: &'a Env) -> Fixture<'a> {
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
        basis_points: 6000,
    });
    collabs.push_back(Collaborator {
        address: bob.clone(),
        alias: String::from_str(env, "Bob"),
        basis_points: 4000,
    });

    let project_id = Symbol::new(env, "invariant_main");
    client.create_project(
        &owner,
        &project_id,
        &String::from_str(env, "Invariant Main"),
        &String::from_str(env, "music"),
        &token,
        &collabs,
    );

    Fixture {
        env: env.clone(),
        client,
        contract_id,
        admin,
        owner,
        funder,
        token,
        alice,
        bob,
        project_id,
    }
}

/// Full observable state of the funded project and its token flows. Two
/// consecutive snapshots taken around a rejected operation must be equal.
#[derive(Debug, PartialEq)]
struct Snapshot {
    project_balance: i128,
    total_distributed: i128,
    distribution_round: u32,
    locked: bool,
    owner: Address,
    title: String,
    collab_bps: Vec<u32>,
    claimed_alice: i128,
    claimed_bob: i128,
    last_claim_alice: i128,
    last_claim_bob: i128,
    alice_token: i128,
    bob_token: i128,
    funder_token: i128,
    unallocated: i128,
    project_count: u32,
    paused: bool,
}

fn bps_of(env: &Env, collaborators: &Vec<Collaborator>) -> Vec<u32> {
    let mut out: Vec<u32> = Vec::new(env);
    for collaborator in collaborators.iter() {
        out.push_back(collaborator.basis_points);
    }
    out
}

fn snapshot(f: &Fixture) -> Snapshot {
    let project = f.client.get_project(&f.project_id).expect("project exists");
    Snapshot {
        project_balance: f.client.get_balance(&f.project_id),
        total_distributed: project.total_distributed,
        distribution_round: project.distribution_round,
        locked: project.locked,
        owner: project.owner,
        title: project.title,
        collab_bps: bps_of(&f.env, &project.collaborators),
        claimed_alice: f.client.get_claimed(&f.project_id, &f.alice),
        claimed_bob: f.client.get_claimed(&f.project_id, &f.bob),
        last_claim_alice: f
            .client
            .get_claimable(&f.project_id, &f.alice)
            .last_claim_amount,
        last_claim_bob: f
            .client
            .get_claimable(&f.project_id, &f.bob)
            .last_claim_amount,
        alice_token: token::Client::new(&f.env, &f.token).balance(&f.alice),
        bob_token: token::Client::new(&f.env, &f.token).balance(&f.bob),
        funder_token: token::Client::new(&f.env, &f.token).balance(&f.funder),
        unallocated: f.client.get_unallocated_balance(&f.token),
        project_count: f.client.get_project_count(),
        paused: f.client.is_distributions_paused(),
    }
}

fn fund(f: &Fixture, amount: i128) {
    token::StellarAssetClient::new(&f.env, &f.token).mint(&f.funder, &amount);
    f.client.deposit(&f.project_id, &f.funder, &amount);
}

// -----------------------------------------------------------------------------
// Failed claims
// -----------------------------------------------------------------------------

/// Duplicate, unauthorized, paused and missing-project claims must each leave
/// the claim ledger, payout balances and token flows untouched.
#[test]
fn failed_claims_leave_ledger_balances_and_epochs_unchanged() {
    let env = Env::default();
    let f = fixture(&env);

    fund(&f, DEPOSIT);
    assert_eq!(f.client.claim(&f.project_id, &f.alice), 6_000_000);

    let before = snapshot(&f);

    // Duplicate claim within the same funding epoch.
    assert_eq!(
        f.client.try_claim(&f.project_id, &f.alice),
        Err(Ok(SplitError::AlreadyClaimed))
    );
    assert_eq!(snapshot(&f), before);

    // Claim by someone who is not a collaborator.
    let outsider = Address::generate(&f.env);
    assert_eq!(
        f.client.try_claim(&f.project_id, &outsider),
        Err(Ok(SplitError::NotACollaborator))
    );
    assert_eq!(snapshot(&f), before);

    // Claim against a project that does not exist.
    let missing = Symbol::new(&f.env, "missing_claim");
    assert_eq!(
        f.client.try_claim(&missing, &f.bob),
        Err(Ok(SplitError::NotFound))
    );
    assert_eq!(snapshot(&f), before);

    // Claim while distributions are paused.
    f.client.pause_distributions(&f.admin);
    let paused_before = snapshot(&f);
    assert_eq!(
        f.client.try_claim(&f.project_id, &f.bob),
        Err(Ok(SplitError::DistributionsPaused))
    );
    assert_eq!(snapshot(&f), paused_before);
}

// -----------------------------------------------------------------------------
// Failed funding
// -----------------------------------------------------------------------------

/// Zero- and negative-amount deposits are rejected before the token transfer,
/// and deposits into a missing project are rejected before anything is
/// written; neither may disturb an already-funded project.
#[test]
fn failed_deposits_leave_balances_and_accounting_unchanged() {
    let env = Env::default();
    let f = fixture(&env);
    fund(&f, DEPOSIT);

    let before = snapshot(&f);

    // Zero and negative amounts (boundaries).
    assert_eq!(
        f.client.try_deposit(&f.project_id, &f.funder, &0i128),
        Err(Ok(SplitError::InvalidAmount))
    );
    assert_eq!(
        f.client.try_deposit(&f.project_id, &f.funder, &(-1i128)),
        Err(Ok(SplitError::InvalidAmount))
    );

    // Missing project.
    let missing = Symbol::new(&f.env, "missing_deposit");
    assert_eq!(
        f.client.try_deposit(&missing, &f.funder, &1i128),
        Err(Ok(SplitError::NotFound))
    );

    assert_eq!(snapshot(&f), before);
}

// -----------------------------------------------------------------------------
// Failed project creation
// -----------------------------------------------------------------------------

/// Rejected creations must not consume the project counter or leave a partial
/// project record behind, even when other projects already exist.
#[test]
fn failed_create_project_leaves_project_counter_and_registry_unchanged() {
    let env = Env::default();
    let f = fixture(&env);
    fund(&f, DEPOSIT);

    let before = snapshot(&f);

    // Invalid split total (basis points must sum to exactly 10_000).
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);
    let mut bad_split: Vec<Collaborator> = Vec::new(&env);
    bad_split.push_back(Collaborator {
        address: alice.clone(),
        alias: String::from_str(&env, "Alice"),
        basis_points: 6000,
    });
    bad_split.push_back(Collaborator {
        address: bob,
        alias: String::from_str(&env, "Bob"),
        basis_points: 3000,
    });
    let bad_id = Symbol::new(&env, "create_invalid_split");
    assert_eq!(
        f.client.try_create_project(
            &f.owner,
            &bad_id,
            &String::from_str(&env, "Bad Split"),
            &String::from_str(&env, "music"),
            &f.token,
            &bad_split,
        ),
        Err(Ok(SplitError::InvalidSplit))
    );

    // Token allowlist enabled -> a project for an unlisted token is refused
    // even when its splits are otherwise valid.
    f.client.allow_token(&f.admin, &f.token);
    let other_token_admin = Address::generate(&env);
    let other_token = env.register_stellar_asset_contract(other_token_admin);
    let mut good_split: Vec<Collaborator> = Vec::new(&env);
    good_split.push_back(Collaborator {
        address: Address::generate(&env),
        alias: String::from_str(&env, "A"),
        basis_points: 5000,
    });
    good_split.push_back(Collaborator {
        address: Address::generate(&env),
        alias: String::from_str(&env, "B"),
        basis_points: 5000,
    });
    let listed_id = Symbol::new(&env, "create_disallowed_token");
    assert_eq!(
        f.client.try_create_project(
            &f.owner,
            &listed_id,
            &String::from_str(&env, "Unlisted Token"),
            &String::from_str(&env, "music"),
            &other_token,
            &good_split,
        ),
        Err(Ok(SplitError::TokenNotAllowed))
    );

    // The counter did not advance and neither id exists.
    assert_eq!(f.client.get_project_count(), before.project_count);
    assert!(f.client.get_project(&bad_id).is_none());
    assert!(f.client.get_project(&listed_id).is_none());
    assert_eq!(snapshot(&f), before);
}

// -----------------------------------------------------------------------------
// Failed distributions
// -----------------------------------------------------------------------------

/// Empty-pool, dust-pool, paused and missing-project distributions must not
/// advance the round counter, the totals, or any balances.
#[test]
fn failed_distributions_leave_round_totals_and_balances_unchanged() {
    let env = Env::default();
    let f = fixture(&env);

    // Empty pool (boundary: zero balance).
    let before = snapshot(&f);
    assert_eq!(
        f.client.try_distribute(&f.project_id),
        Err(Ok(SplitError::NoBalance))
    );
    assert_eq!(snapshot(&f), before);

    // Dust pool (boundary: balance smaller than the collaborator count, so a
    // single collaborator would absorb the entire remainder).
    fund(&f, 1);
    let dusted = snapshot(&f);
    assert_eq!(
        f.client.try_distribute(&f.project_id),
        Err(Ok(SplitError::NoBalance))
    );
    assert_eq!(snapshot(&f), dusted);

    // Missing project.
    let missing = Symbol::new(&env, "missing_distribute");
    assert_eq!(
        f.client.try_distribute(&missing),
        Err(Ok(SplitError::NotFound))
    );
    assert_eq!(snapshot(&f), dusted);

    // Paused.
    f.client.pause_distributions(&f.admin);
    let paused = snapshot(&f);
    assert_eq!(
        f.client.try_distribute(&f.project_id),
        Err(Ok(SplitError::DistributionsPaused))
    );
    assert_eq!(snapshot(&f), paused);
}

// -----------------------------------------------------------------------------
// Failed project edits
// -----------------------------------------------------------------------------

/// Invalid split updates, wrong-owner mutations, locked-project edits and
/// double locks must leave shares, ownership, lock state and metadata intact.
#[test]
fn failed_project_edits_leave_splits_ownership_and_lock_state_unchanged() {
    let env = Env::default();
    let f = fixture(&env);
    fund(&f, DEPOSIT);

    let before = snapshot(&f);

    // Invalid split totals on update (6000 + 3500 != 10000).
    let mut bad_split: Vec<Collaborator> = Vec::new(&env);
    bad_split.push_back(Collaborator {
        address: Address::generate(&env),
        alias: String::from_str(&env, "A"),
        basis_points: 6000,
    });
    bad_split.push_back(Collaborator {
        address: Address::generate(&env),
        alias: String::from_str(&env, "B"),
        basis_points: 3500,
    });
    assert_eq!(
        f.client
            .try_update_collaborators(&f.project_id, &f.owner, &bad_split),
        Err(Ok(SplitError::InvalidSplit))
    );
    assert_eq!(snapshot(&f), before);

    // Too few collaborators.
    let mut too_few: Vec<Collaborator> = Vec::new(&env);
    too_few.push_back(Collaborator {
        address: Address::generate(&env),
        alias: String::from_str(&env, "Solo"),
        basis_points: 10000,
    });
    assert_eq!(
        f.client
            .try_update_collaborators(&f.project_id, &f.owner, &too_few),
        Err(Ok(SplitError::TooFewCollaborators))
    );
    assert_eq!(snapshot(&f), before);

    // Wrong-owner mutations.
    let attacker = Address::generate(&env);
    assert_eq!(
        f.client.try_update_project_metadata(
            &f.project_id,
            &attacker,
            &String::from_str(&env, "Hijacked"),
            &String::from_str(&env, "film"),
        ),
        Err(Ok(SplitError::Unauthorized))
    );
    let new_owner = Address::generate(&env);
    assert_eq!(
        f.client
            .try_transfer_project_ownership(&f.project_id, &attacker, &new_owner),
        Err(Ok(SplitError::Unauthorized))
    );
    assert_eq!(snapshot(&f), before);

    // Locked project: edits are frozen for everyone, including the owner.
    f.client.lock_project(&f.project_id, &f.owner);
    let locked = snapshot(&f);
    assert!(f.client.get_project(&f.project_id).unwrap().locked);

    let mut valid_split: Vec<Collaborator> = Vec::new(&env);
    valid_split.push_back(Collaborator {
        address: Address::generate(&env),
        alias: String::from_str(&env, "C"),
        basis_points: 5000,
    });
    valid_split.push_back(Collaborator {
        address: Address::generate(&env),
        alias: String::from_str(&env, "D"),
        basis_points: 5000,
    });
    assert_eq!(
        f.client
            .try_update_collaborators(&f.project_id, &f.owner, &valid_split),
        Err(Ok(SplitError::ProjectLocked))
    );
    assert_eq!(
        f.client.try_update_project_metadata(
            &f.project_id,
            &f.owner,
            &String::from_str(&env, "Renamed"),
            &String::from_str(&env, "film"),
        ),
        Err(Ok(SplitError::ProjectLocked))
    );

    // Double lock.
    assert_eq!(
        f.client.try_lock_project(&f.project_id, &f.owner),
        Err(Ok(SplitError::AlreadyLocked))
    );

    assert_eq!(snapshot(&f), locked);
    assert_eq!(
        f.client.get_project(&f.project_id).unwrap().title,
        String::from_str(&env, "Invariant Main"),
        "title untouched after failed metadata edits"
    );
}

// -----------------------------------------------------------------------------
// Failed admin recovery (withdraw_unallocated)
// -----------------------------------------------------------------------------

/// The admin recovery path may only touch *unallocated* funds (direct token
/// transfers into the contract address). Zero/negative amounts, overdraws,
/// contract-address recipients and impostor admins must all be rejected
/// without moving a single stroop.
#[test]
fn failed_admin_withdrawals_leave_contract_and_project_balances_unchanged() {
    let env = Env::default();
    let f = fixture(&env);
    fund(&f, DEPOSIT); // fully accounted project balance
    let before = snapshot(&f);
    assert_eq!(before.unallocated, 0, "deposits are fully accounted");

    // Create unallocated funds: a direct transfer into the contract address.
    token::StellarAssetClient::new(&env, &f.token).mint(&f.funder, &1_000_000);
    token::Client::new(&env, &f.token).transfer(&f.funder, &f.contract_id, &1_000_000);
    let funded = snapshot(&f);
    assert_eq!(funded.unallocated, 1_000_000);

    // Successful recovery for contrast (also the baseline for failures).
    let recipient = Address::generate(&env);
    f.client
        .withdraw_unallocated(&f.admin, &f.token, &recipient, &400_000i128);
    let recovered = snapshot(&f);
    assert_eq!(recovered.unallocated, 600_000);
    assert_eq!(
        token::Client::new(&env, &f.token).balance(&recipient),
        400_000
    );
    assert_eq!(
        recovered.project_balance, DEPOSIT,
        "project pool untouched by recovery"
    );

    // Zero and negative amounts (boundaries).
    assert_eq!(
        f.client
            .try_withdraw_unallocated(&f.admin, &f.token, &recipient, &0i128),
        Err(Ok(SplitError::InvalidAmount))
    );
    assert_eq!(
        f.client
            .try_withdraw_unallocated(&f.admin, &f.token, &recipient, &(-1i128)),
        Err(Ok(SplitError::InvalidAmount))
    );
    assert_eq!(snapshot(&f), recovered);

    // Overdraw: only 600_000 unallocated remain.
    assert_eq!(
        f.client
            .try_withdraw_unallocated(&f.admin, &f.token, &recipient, &600_001i128),
        Err(Ok(SplitError::InsufficientUnallocated))
    );
    assert_eq!(snapshot(&f), recovered);

    // Contract-address recipient (would trap the funds forever).
    assert_eq!(
        f.client
            .try_withdraw_unallocated(&f.admin, &f.token, &f.contract_id, &100i128),
        Err(Ok(SplitError::InvalidRecipient))
    );
    assert_eq!(snapshot(&f), recovered);

    // Impostor admin.
    let attacker = Address::generate(&env);
    assert_eq!(
        f.client
            .try_withdraw_unallocated(&attacker, &f.token, &recipient, &100i128),
        Err(Ok(SplitError::Unauthorized))
    );
    assert_eq!(snapshot(&f), recovered);

    // The project pool is still fully intact after every rejection.
    assert_eq!(f.client.get_balance(&f.project_id), DEPOSIT);
}
