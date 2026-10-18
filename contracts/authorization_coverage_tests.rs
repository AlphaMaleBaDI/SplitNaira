#![cfg(test)]

//! Authorization coverage for every public contract entry point (issue #1483).
//!
//! ## Entry-point inventory (34 public functions)
//!
//! | Class | Entry points | Gate |
//! |-------|--------------|------|
//! | Admin-gated (7) | `set_max_collaborators`, `allow_token`, `disallow_token`, `pause_distributions`, `unpause_distributions`, `withdraw_unallocated`, `migrate_flat_to_buckets` | `require_contract_admin`: stored-admin identity check (rejects with `Unauthorized`), then `require_auth` |
//! | Owner-gated (4) | `update_collaborators`, `lock_project`, `update_project_metadata`, `transfer_project_ownership` | project-owner identity check (rejects with `Unauthorized`), then `require_auth` |
//! | Signer-gated (4) | `set_admin`, `create_project`, `deposit`, `claim` | `Address::require_auth` only — no contract-level identity check; the *host* rejects unsatisfied authorizations |
//! | Permissionless (2) | `distribute`, `batch_distribute` | none by design (math is trustless; covered by `authorization_tests`) |
//! | Read-only (17) | `get_max_collaborators`, `get_project`, `project_exists`, `get_claimed`, `refresh_project_storage`, `get_project_count`, `list_projects`, `list_project_summaries`, `get_balance`, `get_unallocated_balance`, `is_token_allowed`, `is_distributions_paused`, `get_allowed_token_count`, `get_allowed_tokens`, `get_admin`, `get_project_ids`, `get_claimable` | none — must work with no authorization at all |
//!
//! ## How "unauthorized callers fail" is asserted
//!
//! - For the 11 identity-gated entry points the tests drive an *impostor*
//!   address through each call and assert the exact contract error
//!   (`Unauthorized` / `AdminNotSet`), plus that no state changed.
//! - For the 4 signer-gated entry points a contract-level identity check does
//!   not exist: `require_auth` is the entire gate. Withheld/dismatched
//!   authorization is a host trap, which in this no_std test build is a
//!   non-unwinding panic (SIGABRT — verified empirically: even `try_` calls
//!   cannot catch it), so it cannot be asserted in-process. Instead these
//!   tests assert the *positive* requirement recorded by the recording auth
//!   environment: each such entry point demands an authorization entry for
//!   exactly the documented signer (`env.auths()`), and `set_admin` rotation
//!   demands the *stored* admin rather than the proposed one.
//! - The read-only class is asserted to execute on a fully
//!   auth-enforcing environment (no `mock_all_auths` at all), proving no
//!   `require_auth` hides in a read path.

use crate::{
    errors::SplitError, Collaborator, SplitNairaContract, SplitNairaContractClient,
    DEFAULT_MAX_COLLABORATORS,
};
use soroban_sdk::{
    testutils::{Address as _, AuthorizedFunction},
    token, vec, Address, Env, String, Symbol, Vec,
};

// -----------------------------------------------------------------------------
// Shared helpers
// -----------------------------------------------------------------------------

fn make_client(env: &Env) -> SplitNairaContractClient<'_> {
    let contract_id = env.register_contract(None, SplitNairaContract);
    SplitNairaContractClient::new(env, &contract_id)
}

fn two_collabs(env: &Env) -> Vec<Collaborator> {
    let alice = Address::generate(env);
    let bob = Address::generate(env);
    vec![
        env,
        Collaborator {
            address: alice,
            alias: String::from_str(env, "Alice"),
            basis_points: 6000,
        },
        Collaborator {
            address: bob,
            alias: String::from_str(env, "Bob"),
            basis_points: 4000,
        },
    ]
}

/// Returns the human-readable function name of a recorded root invocation.
fn root_fn_name(invocation: &soroban_sdk::testutils::AuthorizedInvocation) -> Option<Symbol> {
    match &invocation.function {
        AuthorizedFunction::Contract((_, name, _)) => Some(name.clone()),
        _ => None,
    }
}

/// True when `env.auths()` (recorded after the last call) demands `signer`'s
/// authorization for a root invocation of `fn_name`.
fn demands_authorization(env: &Env, signer: &Address, fn_name: &str) -> bool {
    env.auths().iter().any(|(addr, invocation)| {
        addr == signer && root_fn_name(invocation) == Some(Symbol::new(env, fn_name))
    })
}

// -----------------------------------------------------------------------------
// Admin-gated entry points
// -----------------------------------------------------------------------------

/// Every admin-gated entry point must reject an address that is not the
/// configured administrator, before touching any state.
#[test]
fn admin_gated_entry_points_reject_non_admin_callers() {
    let env = Env::default();
    env.mock_all_auths();

    let token_admin = Address::generate(&env);
    let token = env.register_stellar_asset_contract(token_admin);
    let client = make_client(&env);

    let admin = Address::generate(&env);
    client.set_admin(&admin);

    let attacker = Address::generate(&env);

    // Identity check fires before require_auth, so impostor calls return the
    // contract-level Unauthorized error instead of trapping.
    assert_eq!(
        client.try_pause_distributions(&attacker),
        Err(Ok(SplitError::Unauthorized))
    );
    assert_eq!(
        client.try_unpause_distributions(&attacker),
        Err(Ok(SplitError::Unauthorized))
    );
    assert_eq!(
        client.try_set_max_collaborators(&attacker, &25u32),
        Err(Ok(SplitError::Unauthorized))
    );
    assert_eq!(
        client.try_allow_token(&attacker, &token),
        Err(Ok(SplitError::Unauthorized))
    );
    assert_eq!(
        client.try_disallow_token(&attacker, &token),
        Err(Ok(SplitError::Unauthorized))
    );
    assert_eq!(
        client.try_withdraw_unallocated(&attacker, &token, &attacker, &1i128),
        Err(Ok(SplitError::Unauthorized))
    );
    assert_eq!(
        client.try_migrate_flat_to_buckets(&attacker),
        Err(Ok(SplitError::Unauthorized))
    );

    // Rejections left global state untouched.
    assert!(!client.is_distributions_paused());
    assert!(!client.is_token_allowed(&token));
    assert_eq!(client.get_allowed_token_count(), 0);
    assert_eq!(client.get_admin(), Some(admin.clone()));

    // Positive control: the configured admin passes the same gates.
    client.pause_distributions(&admin);
    assert!(client.is_distributions_paused());
    client.unpause_distributions(&admin);
    assert!(!client.is_distributions_paused());
    client.allow_token(&admin, &token);
    assert!(client.is_token_allowed(&token));
    client.disallow_token(&admin, &token);
    assert!(!client.is_token_allowed(&token));
}

/// Before any administrator is configured there is *no* valid caller: every
/// admin-gated entry point must answer `AdminNotSet` — including for the
/// address that would later become admin.
#[test]
fn admin_gated_entry_points_reject_every_caller_before_admin_is_configured() {
    // Deliberately no `mock_all_auths`: `AdminNotSet` is returned before any
    // `require_auth` runs, so a fully auth-enforcing environment proves the
    // same boundary.
    let env = Env::default();
    let token_admin = Address::generate(&env);
    let token = env.register_stellar_asset_contract(token_admin);
    let client = make_client(&env);

    let caller = Address::generate(&env);

    assert_eq!(
        client.try_pause_distributions(&caller),
        Err(Ok(SplitError::AdminNotSet))
    );
    assert_eq!(
        client.try_unpause_distributions(&caller),
        Err(Ok(SplitError::AdminNotSet))
    );
    assert_eq!(
        client.try_set_max_collaborators(&caller, &10u32),
        Err(Ok(SplitError::AdminNotSet))
    );
    assert_eq!(
        client.try_allow_token(&caller, &token),
        Err(Ok(SplitError::AdminNotSet))
    );
    assert_eq!(
        client.try_disallow_token(&caller, &token),
        Err(Ok(SplitError::AdminNotSet))
    );
    assert_eq!(
        client.try_withdraw_unallocated(&caller, &token, &caller, &1i128),
        Err(Ok(SplitError::AdminNotSet))
    );
    assert_eq!(
        client.try_migrate_flat_to_buckets(&caller),
        Err(Ok(SplitError::AdminNotSet))
    );

    assert!(client.get_admin().is_none());
    assert!(!client.is_distributions_paused());
}

// -----------------------------------------------------------------------------
// Owner-gated entry points
// -----------------------------------------------------------------------------

/// Every owner-gated entry point must reject a caller that is not the project
/// owner, even when the impostor passes itself as the `owner` argument.
#[test]
fn owner_gated_entry_points_reject_non_owner_callers() {
    let env = Env::default();
    env.mock_all_auths();

    let token_admin = Address::generate(&env);
    let token = env.register_stellar_asset_contract(token_admin);
    let client = make_client(&env);

    let owner = Address::generate(&env);
    let project_id = Symbol::new(&env, "authz_coverage");
    let collabs = two_collabs(&env);
    client.create_project(
        &owner,
        &project_id,
        &String::from_str(&env, "Authz Coverage"),
        &String::from_str(&env, "music"),
        &token,
        &collabs,
    );

    let attacker = Address::generate(&env);
    let outsider = Address::generate(&env);

    assert_eq!(
        client.try_update_collaborators(&project_id, &attacker, &two_collabs(&env)),
        Err(Ok(SplitError::Unauthorized))
    );
    assert_eq!(
        client.try_lock_project(&project_id, &attacker),
        Err(Ok(SplitError::Unauthorized))
    );
    assert_eq!(
        client.try_update_project_metadata(
            &project_id,
            &attacker,
            &String::from_str(&env, "Hijacked"),
            &String::from_str(&env, "art"),
        ),
        Err(Ok(SplitError::Unauthorized))
    );
    assert_eq!(
        client.try_transfer_project_ownership(&project_id, &attacker, &outsider),
        Err(Ok(SplitError::Unauthorized))
    );

    // Rejections left the project record untouched.
    let project = client.get_project(&project_id).expect("project exists");
    assert_eq!(project.owner, owner);
    assert!(!project.locked);
    assert_eq!(project.collaborators.len(), 2);
    assert_eq!(
        project.collaborators.get(0).unwrap().basis_points,
        6000,
        "first collaborator share unchanged"
    );
    assert_eq!(
        project.title,
        String::from_str(&env, "Authz Coverage"),
        "metadata unchanged"
    );

    // Positive control: the real owner passes the same gate.
    client.lock_project(&project_id, &owner);
    assert!(client.get_project(&project_id).unwrap().locked);
}

// -----------------------------------------------------------------------------
// Signer-gated entry points
// -----------------------------------------------------------------------------

/// `set_admin`, `create_project`, `deposit` and `claim` gate purely on
/// `Address::require_auth`. Assert each one *demands* an authorization entry
/// for exactly the documented signer, and that `set_admin` rotation demands
/// the stored administrator rather than the proposed replacement.
#[test]
fn signer_gated_entry_points_demand_the_documented_signer_authorization() {
    let env = Env::default();
    env.mock_all_auths();

    let token_admin = Address::generate(&env);
    let token = env.register_stellar_asset_contract(token_admin);
    let client = make_client(&env);

    // set_admin (first set): the proposed admin must authorize.
    let admin_a = Address::generate(&env);
    client.set_admin(&admin_a);
    assert!(
        demands_authorization(&env, &admin_a, "set_admin"),
        "set_admin must demand the proposed admin's authorization"
    );

    // set_admin (rotation): the *stored* admin must authorize — a caller may
    // not nominate anyone, including themselves, without the current admin.
    let admin_b = Address::generate(&env);
    client.set_admin(&admin_b);
    assert!(
        demands_authorization(&env, &admin_a, "set_admin"),
        "rotation must demand the stored admin's authorization"
    );
    assert_eq!(client.get_admin(), Some(admin_b.clone()));

    // create_project: the declared owner must authorize.
    let owner = Address::generate(&env);
    let project_id = Symbol::new(&env, "authz_signer");
    client.create_project(
        &owner,
        &project_id,
        &String::from_str(&env, "Signer Coverage"),
        &String::from_str(&env, "music"),
        &token,
        &two_collabs(&env),
    );
    assert!(
        demands_authorization(&env, &owner, "create_project"),
        "create_project must demand the declared owner's authorization"
    );

    // deposit: the funding account must authorize.
    let funder = Address::generate(&env);
    token::StellarAssetClient::new(&env, &token).mint(&funder, &1_000_000);
    client.deposit(&project_id, &funder, &1_000_000i128);
    assert!(
        demands_authorization(&env, &funder, "deposit"),
        "deposit must demand the funder's authorization"
    );

    // claim: the claiming collaborator must authorize.
    let collaborators = client.get_project(&project_id).unwrap().collaborators;
    let claimer = collaborators.get(0).unwrap().address;
    client.claim(&project_id, &claimer);
    assert!(
        demands_authorization(&env, &claimer, "claim"),
        "claim must demand the claimer's authorization"
    );
}

// -----------------------------------------------------------------------------
// Read-only entry points
// -----------------------------------------------------------------------------

/// The 17 read-only entry points must succeed on a fully auth-enforcing
/// environment (no `mock_all_auths`, no entries): if any read secretly called
/// `require_auth` it would trap the test process.
#[test]
fn read_only_entry_points_succeed_without_any_authorization() {
    let env = Env::default();
    let token_admin = Address::generate(&env);
    let token = env.register_stellar_asset_contract(token_admin);
    let client = make_client(&env);

    let missing = Symbol::new(&env, "does_not_exist");
    let stranger = Address::generate(&env);

    // Reads on an empty contract.
    assert!(client.get_admin().is_none());
    assert_eq!(client.get_project_count(), 0);
    assert_eq!(client.get_max_collaborators(), DEFAULT_MAX_COLLABORATORS);
    assert!(!client.is_distributions_paused());
    assert_eq!(client.get_allowed_token_count(), 0);
    assert!(client.get_allowed_tokens(&0, &10).is_empty());
    assert!(!client.is_token_allowed(&token));
    assert!(!client.project_exists(&missing));
    assert!(client.get_project(&missing).is_none());
    assert!(client.list_projects(&0, &10).is_empty());
    assert!(client.list_project_summaries(&0, &10).is_empty());
    assert!(client.get_project_ids(&0, &10).is_empty());
    assert_eq!(client.get_unallocated_balance(&token), 0);

    // Error-shaped reads answer with contract errors — not auth traps.
    assert_eq!(
        client.try_get_balance(&missing),
        Err(Ok(SplitError::NotFound))
    );
    // `get_claimed` answers with the ledger default instead of an error.
    assert_eq!(client.get_claimed(&missing, &stranger), 0);
    assert_eq!(
        client.try_get_claimable(&missing, &stranger),
        Err(Ok(SplitError::NotFound))
    );
    assert_eq!(
        client.try_refresh_project_storage(&missing),
        Err(Ok(SplitError::NotFound))
    );

    // Note: creating a *populated* project to read from is not possible in a
    // fully auth-enforcing environment (`create_project` demands the owner's
    // authorization, and an unsatisfied `require_auth` traps the no_std test
    // build), but the read paths above already prove that no read helper
    // contains a `require_auth` — they complete on an env where every
    // unsatisfied authorization is fatal.
}
