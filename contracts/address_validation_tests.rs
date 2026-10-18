#![cfg(test)]

//! Collaborator validation tests (issue #948).
//!
//! Covers collaborator validation during project creation, including:
//!
//! - valid collaborator lists;
//! - minimum collaborator requirements;
//! - zero-share collaborators;
//! - duplicate collaborator addresses;
//! - invalid basis-point totals.
//!
//! Each invalid input must return the documented `SplitError` and must not
//! create a project.

use crate::{errors::SplitError, Collaborator, SplitNairaContract, SplitNairaContractClient};
use soroban_sdk::{testutils::Address as _, vec, Address, Env, String, Symbol, Vec};

// -----------------------------------------------------------------------------
// Shared helpers
// -----------------------------------------------------------------------------

/// Creates a test environment with a registered SplitNaira contract and token.
///
/// Authentication is mocked because these tests focus on collaborator
/// validation rather than Soroban authorization.
fn setup() -> (Env, SplitNairaContractClient, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let token_admin = Address::generate(&env);
    let token = env.register_stellar_asset_contract(token_admin);

    let contract_id = env.register_contract(None, SplitNairaContract);
    let client = SplitNairaContractClient::new(&env, &contract_id);

    (env, client, token)
}

/// Creates a deterministic project ID for a test.
fn project_id(env: &Env, name: &str) -> Symbol {
    Symbol::new(env, name)
}

/// Creates a collaborator with the supplied address, alias, and share.
fn collaborator(env: &Env, address: Address, alias: &str, basis_points: i128) -> Collaborator {
    Collaborator {
        address,
        alias: String::from_str(env, alias),
        basis_points,
    }
}

/// Attempts to create a project using the supplied collaborator list.
fn try_create_project(
    env: &Env,
    client: &SplitNairaContractClient,
    token: &Address,
    id: &Symbol,
    collaborators: &Vec<Collaborator>,
) -> Result<(), Result<SplitError, soroban_sdk::Error>> {
    let owner = Address::generate(env);

    client.try_create_project(
        &owner,
        id,
        &String::from_str(env, "Test Project"),
        &String::from_str(env, "music"),
        token,
        collaborators,
    )
}

/// Asserts that an invalid collaborator list does not create a project.
fn assert_invalid_collaborators(
    env: &Env,
    client: &SplitNairaContractClient,
    token: &Address,
    id: &Symbol,
    collaborators: &Vec<Collaborator>,
    expected: SplitError,
) {
    let before_count = client.get_project_count();

    let result = try_create_project(env, client, token, id, collaborators);

    assert_eq!(result, Err(Ok(expected)));

    assert_eq!(
        client.get_project_count(),
        before_count,
        "rejected collaborator validation must not create a project"
    );

    assert!(
        !client.project_exists(id),
        "invalid collaborator input must not create the project"
    );
}

// -----------------------------------------------------------------------------
// Happy path
// -----------------------------------------------------------------------------

/// A valid two-collaborator split is accepted.
#[test]
fn create_project_with_valid_two_collaborators_succeeds() {
    let (env, client, token) = setup();

    let owner = Address::generate(&env);
    let alice = Address::generate(&env);
    let bob = Address::generate(&env);

    let collaborators = vec![
        &env,
        collaborator(&env, alice, "Alice", 6000),
        collaborator(&env, bob, "Bob", 4000),
    ];

    let id = project_id(&env, "valid_split");

    client.create_project(
        &owner,
        &id,
        &String::from_str(&env, "Valid Split Project"),
        &String::from_str(&env, "music"),
        &token,
        &collaborators,
    );

    assert_eq!(client.get_project_count(), 1);
    assert!(client.project_exists(&id));

    let project = client.get_project(&id).unwrap();

    assert_eq!(project.owner, owner);
    assert_eq!(project.collaborators.len(), 2);
}

/// A valid three-collaborator split is accepted.
#[test]
fn create_project_with_valid_three_collaborators_succeeds() {
    let (env, client, token) = setup();

    let owner = Address::generate(&env);

    let collaborators = vec![
        &env,
        collaborator(&env, Address::generate(&env), "Producer", 5000),
        collaborator(&env, Address::generate(&env), "Artist", 3000),
        collaborator(&env, Address::generate(&env), "Label", 2000),
    ];

    let id = project_id(&env, "triple_split");

    client.create_project(
        &owner,
        &id,
        &String::from_str(&env, "Triple Split"),
        &String::from_str(&env, "music"),
        &token,
        &collaborators,
    );

    assert_eq!(client.get_project_count(), 1);
    assert!(client.project_exists(&id));

    let project = client.get_project(&id).unwrap();
    assert_eq!(project.collaborators.len(), 3);
}

// -----------------------------------------------------------------------------
// TooFewCollaborators
// -----------------------------------------------------------------------------

/// A project cannot be created with only one collaborator.
#[test]
fn create_project_with_one_collaborator_returns_too_few() {
    let (env, client, token) = setup();

    let collaborators = vec![
        &env,
        collaborator(&env, Address::generate(&env), "Solo", 10000),
    ];

    let id = project_id(&env, "solo_project");

    assert_invalid_collaborators(
        &env,
        &client,
        &token,
        &id,
        &collaborators,
        SplitError::TooFewCollaborators,
    );
}

/// An empty collaborator list is rejected.
#[test]
fn create_project_with_empty_collaborators_returns_too_few() {
    let (env, client, token) = setup();

    let collaborators: Vec<Collaborator> = Vec::new(&env);
    let id = project_id(&env, "empty_project");

    assert_invalid_collaborators(
        &env,
        &client,
        &token,
        &id,
        &collaborators,
        SplitError::TooFewCollaborators,
    );
}

// -----------------------------------------------------------------------------
// ZeroShare
// -----------------------------------------------------------------------------

/// A collaborator with zero basis points is rejected.
#[test]
fn create_project_with_zero_share_returns_zero_share_error() {
    let (env, client, token) = setup();

    let collaborators = vec![
        &env,
        collaborator(&env, Address::generate(&env), "Alice", 0),
        collaborator(&env, Address::generate(&env), "Bob", 10000),
    ];

    let id = project_id(&env, "zero_share");

    assert_invalid_collaborators(
        &env,
        &client,
        &token,
        &id,
        &collaborators,
        SplitError::ZeroShare,
    );
}

/// A collaborator list containing only zero-share entries is rejected.
#[test]
fn create_project_with_all_zero_shares_returns_zero_share_error() {
    let (env, client, token) = setup();

    let collaborators = vec![
        &env,
        collaborator(&env, Address::generate(&env), "Alice", 0),
        collaborator(&env, Address::generate(&env), "Bob", 0),
    ];

    let id = project_id(&env, "all_zero");

    assert_invalid_collaborators(
        &env,
        &client,
        &token,
        &id,
        &collaborators,
        SplitError::ZeroShare,
    );
}

// -----------------------------------------------------------------------------
// DuplicateCollaborator
// -----------------------------------------------------------------------------

/// Duplicate collaborator addresses are rejected even when their aliases
/// differ.
#[test]
fn create_project_with_duplicate_address_returns_duplicate_error() {
    let (env, client, token) = setup();

    let duplicate_address = Address::generate(&env);

    let collaborators = vec![
        &env,
        collaborator(&env, duplicate_address.clone(), "Alice", 5000),
        collaborator(&env, duplicate_address, "Also Alice", 5000),
    ];

    let id = project_id(&env, "duplicate_collaborator");

    assert_invalid_collaborators(
        &env,
        &client,
        &token,
        &id,
        &collaborators,
        SplitError::DuplicateCollaborator,
    );
}

/// A duplicate address is rejected even when it appears among three
/// collaborators rather than adjacent to the first entry.
#[test]
fn create_project_with_duplicate_address_among_three_returns_duplicate_error() {
    let (env, client, token) = setup();

    let duplicate_address = Address::generate(&env);

    let collaborators = vec![
        &env,
        collaborator(&env, Address::generate(&env), "First", 4000),
        collaborator(&env, duplicate_address.clone(), "Second", 3000),
        collaborator(&env, duplicate_address, "Third", 3000),
    ];

    let id = project_id(&env, "duplicate_middle");

    assert_invalid_collaborators(
        &env,
        &client,
        &token,
        &id,
        &collaborators,
        SplitError::DuplicateCollaborator,
    );
}

// -----------------------------------------------------------------------------
// InvalidSplit
// -----------------------------------------------------------------------------

/// A collaborator split below 10,000 basis points is rejected.
#[test]
fn create_project_with_underallocated_split_returns_invalid_split() {
    let (env, client, token) = setup();

    let collaborators = vec![
        &env,
        collaborator(&env, Address::generate(&env), "Alice", 4000),
        collaborator(&env, Address::generate(&env), "Bob", 3000),
    ];

    let id = project_id(&env, "under_split");

    assert_invalid_collaborators(
        &env,
        &client,
        &token,
        &id,
        &collaborators,
        SplitError::InvalidSplit,
    );
}

/// A collaborator split above 10,000 basis points is rejected.
#[test]
fn create_project_with_overallocated_split_returns_invalid_split() {
    let (env, client, token) = setup();

    let collaborators = vec![
        &env,
        collaborator(&env, Address::generate(&env), "Alice", 7000),
        collaborator(&env, Address::generate(&env), "Bob", 6000),
    ];

    let id = project_id(&env, "over_split");

    assert_invalid_collaborators(
        &env,
        &client,
        &token,
        &id,
        &collaborators,
        SplitError::InvalidSplit,
    );
}

// -----------------------------------------------------------------------------
// TooManyCollaborators (issue #1253)
// -----------------------------------------------------------------------------

/// A project with more collaborators than the default cap is rejected and
/// no project is created.
#[test]
fn create_project_above_default_cap_returns_too_many() {
    let (env, client, token) = setup();

    // The default cap is 50 collaborators. Build 51 collaborators whose
    // basis points still total exactly 10,000 so the only failing check is
    // the cap.
    let mut bps = Vec::new(&env);
    for _ in 0..50 {
        bps.push_back(200u32); // 50 * 200 = 10,000
    }
    bps.push_back(1u32); // 51st collaborator pushes the count over the cap

    let mut collaborators = Vec::new(&env);
    for (i, bp) in bps.iter().enumerate() {
        let alias = format!("Collab{}", i);
        collaborators.push_back(Collaborator {
            address: Address::generate(&env),
            alias: String::from_str(&env, &alias),
            basis_points: bp,
        });
    }

    let id = project_id(&env, "too_many_collabs");

    assert_invalid_collaborators(
        &env,
        &client,
        &token,
        &id,
        &collaborators,
        SplitError::TooManyCollaborators,
    );
}

// -----------------------------------------------------------------------------
// ArithmeticOverflow (issue #1253)
// -----------------------------------------------------------------------------

/// Basis-point sums that overflow `u32` are rejected with
/// `ArithmeticOverflow` and no project is created.
#[test]
fn create_project_with_overflowing_basis_point_sum_returns_arithmetic_overflow() {
    let (env, client, token) = setup();

    // u32::MAX + 1 overflows u32 when summed, tripping the checked_add
    // guard before the total-equals-10_000 check is ever reached.
    let collaborators = vec![
        &env,
        collaborator(
            &env,
            Address::generate(&env),
            "Alice",
            4_294_967_295i128, // u32::MAX
        ),
        collaborator(&env, Address::generate(&env), "Bob", 1i128),
    ];

    let id = project_id(&env, "overflow_split");

    assert_invalid_collaborators(
        &env,
        &client,
        &token,
        &id,
        &collaborators,
        SplitError::ArithmeticOverflow,
    );
}

// -----------------------------------------------------------------------------
// Malformed inputs leave state unchanged (issue #1253)
// -----------------------------------------------------------------------------

/// A sweep of malformed collaborator inputs must all fail validation and
/// leave contract state untouched: no project is created, the project count
/// does not move, and no partially-written project ID becomes visible.
#[test]
fn malformed_participant_inputs_leave_contract_state_unchanged() {
    let (env, client, token) = setup();

    let cases: Vec<(Symbol, Vec<Collaborator>, SplitError)> = {
        let mut v = Vec::new(&env);

        // Too few: single collaborator.
        v.push_back((
            Symbol::new(&env, "malformed_solo"),
            vec![
                &env,
                collaborator(&env, Address::generate(&env), "Solo", 10_000),
            ],
            SplitError::TooFewCollaborators,
        ));

        // Too few: empty list.
        v.push_back((
            Symbol::new(&env, "malformed_empty"),
            Vec::new(&env),
            SplitError::TooFewCollaborators,
        ));

        // Zero share.
        v.push_back((
            Symbol::new(&env, "malformed_zero"),
            vec![
                &env,
                collaborator(&env, Address::generate(&env), "Zero", 0),
                collaborator(&env, Address::generate(&env), "Full", 10_000),
            ],
            SplitError::ZeroShare,
        ));

        // Duplicate address.
        let dup = Address::generate(&env);
        v.push_back((
            Symbol::new(&env, "malformed_duplicate"),
            vec![
                &env,
                collaborator(&env, dup.clone(), "First", 5_000),
                collaborator(&env, dup, "Second", 5_000),
            ],
            SplitError::DuplicateCollaborator,
        ));

        // Under-allocated total.
        v.push_back((
            Symbol::new(&env, "malformed_under"),
            vec![
                &env,
                collaborator(&env, Address::generate(&env), "A", 3_000),
                collaborator(&env, Address::generate(&env), "B", 3_000),
            ],
            SplitError::InvalidSplit,
        ));

        // Over-allocated total.
        v.push_back((
            Symbol::new(&env, "malformed_over"),
            vec![
                &env,
                collaborator(&env, Address::generate(&env), "A", 7_000),
                collaborator(&env, Address::generate(&env), "B", 7_000),
            ],
            SplitError::InvalidSplit,
        ));

        v
    };

    let before_count = client.get_project_count();

    for (id, collaborators, expected) in cases.iter() {
        let result = try_create_project(&env, &client, &token, &id, &collaborators);
        assert_eq!(
            result,
            Err(Ok(expected)),
            "case {:?} must fail with {:?}",
            id,
            expected
        );
        assert!(
            !client.project_exists(&id),
            "case {:?} must not create a project",
            id
        );
    }

    assert_eq!(
        client.get_project_count(),
        before_count,
        "malformed inputs must not move the project count"
    );
}
