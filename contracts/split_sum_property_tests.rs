#![cfg(test)]
//! Property tests: collaborator split-percentage sums.
//!
//! Each property is checked against many randomly generated allocations
//! (member count and basis-point shares) drawn from a small seeded xorshift
//! PRNG so runs are deterministic and need no extra crates. Override the base
//! seed with `SPLITNAIRA_PROPTEST_SEED=<u64>` to explore new cases; every
//! assertion message includes the failing case seed for reproduction.
//!
//! Invariants covered:
//! 1. Valid allocations (2..=5 members, every share >= 1 bp, unique addresses,
//!    sum == 10_000) are accepted and stored verbatim by `create_project`.
//! 2. Distribution conserves funds: the payouts sum to the deposited balance,
//!    the project balance and the contract token balance drain to zero, and no
//!    unallocated drift is left behind.
//! 3. Invalid allocations (sum != 10_000, every share >= 1 bp so the failure is
//!    deterministic and isolated to the sum) are rejected with `InvalidSplit`
//!    by both `create_project` and `update_collaborators`.
//! 4. Rejected `create_project`/`update_collaborators` calls leave state
//!    untouched: no project is created and the stored splits are unchanged.
//! 5. A valid `update_collaborators` replaces the splits and the *new* splits
//!    govern the pending balance, conserving the deposited total.
//! 6. Boundary sums (exactly 10_000, 9_999, 10_001) and arithmetic overflow
//!    (`ArithmeticOverflow`) behave exactly as documented.

extern crate std;

use crate::{errors::SplitError, Collaborator, SplitNairaContract, SplitNairaContractClient};
use soroban_sdk::{testutils::Address as _, token, Address, Env, String, Symbol, Vec};

const CASES: u64 = 64;
const TOTAL_BP: u32 = 10_000;
const MAX_MEMBERS: u64 = 5;
const MAX_DEPOSIT: i128 = 1_000_0000000; // 1,000 whole tokens in stroops

// ─────────────────────────────────────────────────────────────────────────────
// Deterministic PRNG
// ─────────────────────────────────────────────────────────────────────────────

struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        // Avoid the all-zero state, which xorshift cannot leave.
        Rng(seed ^ 0x9E37_79B9_7F4A_7C15 | 1)
    }

    fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }

    /// Uniform-ish value in `lo..=hi`.
    fn range(&mut self, lo: u64, hi: u64) -> u64 {
        lo + self.next_u64() % (hi - lo + 1)
    }

    /// A deposit amount guaranteed to exceed any generated member count, so
    /// `distribute`'s "balance >= member count" guard never interferes.
    fn amount(&mut self) -> i128 {
        self.range(1, MAX_DEPOSIT as u64) as i128 + MAX_MEMBERS as i128
    }
}

fn base_seed() -> u64 {
    std::env::var("SPLITNAIRA_PROPTEST_SEED")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0x5EED_1484)
}

fn for_each_case(mut property: impl FnMut(u64, &mut Rng)) {
    let base = base_seed();
    for case in 0..CASES {
        let seed = base.wrapping_add(case);
        property(seed, &mut Rng::new(seed));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Allocation generators
// ─────────────────────────────────────────────────────────────────────────────

/// Splits `total` across `n` members, each receiving at least `1` bp.
/// The last member absorbs whatever is left, so the shares always sum to
/// exactly `total`.
fn split_total(rng: &mut Rng, total: u32, n: u32) -> std::vec::Vec<u32> {
    let mut remaining = total;
    let mut shares = std::vec::Vec::new();
    for i in 0..n {
        let left_after = n - i - 1;
        let bp = if left_after == 0 {
            remaining
        } else {
            rng.range(1, (remaining - left_after) as u64) as u32
        };
        remaining -= bp;
        shares.push(bp);
    }
    shares
}

/// A valid allocation: 2..=5 members whose shares sum to exactly 10_000.
fn random_valid_bps(rng: &mut Rng) -> std::vec::Vec<u32> {
    let n = rng.range(2, MAX_MEMBERS) as u32;
    split_total(rng, TOTAL_BP, n)
}

/// An invalid-by-sum allocation: 2..=5 members, every share >= 1 bp, whose sum
/// is a value in `[n, 20_000]` other than 10_000. Keeping every share non-zero
/// isolates the failure to the sum (`InvalidSplit`) rather than `ZeroShare`.
fn random_invalid_bps(rng: &mut Rng) -> std::vec::Vec<u32> {
    let n = rng.range(2, MAX_MEMBERS) as u32;
    let target = loop {
        let t = rng.range(n as u64, 20_000) as u32;
        if t != TOTAL_BP {
            break t;
        }
    };
    split_total(rng, target, n)
}

/// Materializes basis points into collaborators with fresh, unique addresses.
fn to_collaborators(env: &Env, bps: &[u32]) -> Vec<Collaborator> {
    let mut collaborators = Vec::new(env);
    for bp in bps {
        collaborators.push_back(Collaborator {
            address: Address::generate(env),
            alias: String::from_str(env, "collab"),
            basis_points: *bp,
        });
    }
    collaborators
}

/// Mirrors the contract's documented payout rule: floor share per member,
/// rounding remainder to the last one.
fn expected_payouts(total: i128, bps: &[u32]) -> std::vec::Vec<i128> {
    let last = bps.len() - 1;
    let mut sent = 0i128;
    let mut out = std::vec::Vec::new();
    for (i, bp) in bps.iter().enumerate() {
        let amount = if i == last {
            total - sent
        } else {
            total * (*bp as i128) / 10_000
        };
        sent += amount;
        out.push(amount);
    }
    out
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario harness
// ─────────────────────────────────────────────────────────────────────────────

struct Scenario<'a> {
    env: &'a Env,
    client: SplitNairaContractClient<'a>,
    contract_id: Address,
    token: Address,
    owner: Address,
}

impl<'a> Scenario<'a> {
    fn new(env: &'a Env) -> Self {
        env.mock_all_auths();
        env.budget().reset_unlimited();
        let token_admin = Address::generate(env);
        let token = env.register_stellar_asset_contract(token_admin);
        let contract_id = env.register_contract(None, SplitNairaContract);
        let client = SplitNairaContractClient::new(env, &contract_id);
        Scenario {
            env,
            client,
            contract_id,
            token,
            owner: Address::generate(env),
        }
    }

    fn try_create(
        &self,
        project_id: &Symbol,
        collaborators: &Vec<Collaborator>,
    ) -> Result<(), Result<SplitError, soroban_sdk::Error>> {
        self.client.try_create_project(
            &self.owner,
            project_id,
            &String::from_str(self.env, "Property Project"),
            &String::from_str(self.env, "music"),
            &self.token,
            collaborators,
        )
    }

    fn create(&self, id: &str, collaborators: &Vec<Collaborator>) -> Symbol {
        let project_id = Symbol::new(self.env, id);
        assert_eq!(
            self.try_create(&project_id, collaborators),
            Ok(()),
            "valid allocation must be accepted"
        );
        project_id
    }

    fn deposit(&self, project_id: &Symbol, from: &Address, amount: i128) {
        token::StellarAssetClient::new(self.env, &self.token).mint(from, &amount);
        self.client.deposit(project_id, from, &amount);
    }

    fn token_balance(&self, who: &Address) -> i128 {
        token::Client::new(self.env, &self.token).balance(who)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Properties
// ─────────────────────────────────────────────────────────────────────────────

/// Valid allocations are accepted, stored verbatim, and distribute the full
/// deposit to collaborators without losing or creating a single stroop.
#[test]
fn prop_valid_allocations_are_accepted_and_conserved() {
    for_each_case(|seed, rng| {
        let env = Env::default();
        let s = Scenario::new(&env);
        let bps = random_valid_bps(rng);
        let collaborators = to_collaborators(&env, &bps);
        let project_id = s.create("prop_valid", &collaborators);

        // The stored allocation is exactly what was requested.
        let stored = s.client.get_project(&project_id).unwrap().collaborators;
        assert_eq!(stored.len(), bps.len() as u32, "seed={seed}");
        let stored_total: u32 = stored.iter().map(|c| c.basis_points).sum();
        assert_eq!(stored_total, TOTAL_BP, "seed={seed}");

        let funder = Address::generate(&env);
        let amount = rng.amount();
        s.deposit(&project_id, &funder, amount);
        assert_eq!(s.client.get_balance(&project_id), amount, "seed={seed}");

        s.client.distribute(&project_id);

        let payouts = expected_payouts(amount, &bps);
        let mut paid = 0i128;
        for (c, expected) in collaborators.iter().zip(payouts.iter()) {
            assert_eq!(s.token_balance(&c.address), *expected, "seed={seed}");
            assert_eq!(
                s.client.get_claimed(&project_id, &c.address),
                *expected,
                "seed={seed}"
            );
            paid += *expected;
        }

        // Conservation: everything deposited is paid out exactly once.
        assert_eq!(paid, amount, "seed={seed}");
        assert_eq!(s.client.get_balance(&project_id), 0, "seed={seed}");
        assert_eq!(s.token_balance(&s.contract_id), 0, "seed={seed}");
        assert_eq!(
            s.client.get_unallocated_balance(&s.token),
            0,
            "distribution must leave no unallocated drift, seed={seed}"
        );

        let project = s.client.get_project(&project_id).unwrap();
        assert_eq!(project.total_distributed, amount, "seed={seed}");
        assert_eq!(project.distribution_round, 1, "seed={seed}");
    });
}

/// Allocations whose shares do not sum to 10_000 are rejected by
/// `create_project` with `InvalidSplit`, and rejection creates no project.
#[test]
fn prop_invalid_allocation_sums_are_rejected_without_state_change() {
    for_each_case(|seed, rng| {
        let env = Env::default();
        let s = Scenario::new(&env);

        let bps = random_invalid_bps(rng);
        let sum: u32 = bps.iter().sum();
        assert_ne!(sum, TOTAL_BP, "generator must produce a non-10_000 sum, seed={seed}");
        let collaborators = to_collaborators(&env, &bps);

        let before_count = s.client.get_project_count();
        let project_id = Symbol::new(&env, "prop_invalid");
        let result = s.try_create(&project_id, &collaborators);

        assert_eq!(result, Err(Ok(SplitError::InvalidSplit)), "seed={seed}");
        assert_eq!(
            s.client.get_project_count(),
            before_count,
            "rejected allocation must not create a project, seed={seed}"
        );
        assert!(
            !s.client.project_exists(&project_id),
            "invalid sum must not create the project, seed={seed}"
        );
    });
}

/// An invalid `update_collaborators` is rejected with `InvalidSplit` and leaves
/// both the stored splits and the pending balance untouched.
#[test]
fn prop_invalid_update_is_rejected_and_preserves_original_splits() {
    for_each_case(|seed, rng| {
        let env = Env::default();
        let s = Scenario::new(&env);

        let original_bps = random_valid_bps(rng);
        let original = to_collaborators(&env, &original_bps);
        let project_id = s.create("prop_update_bad", &original);

        let funder = Address::generate(&env);
        let amount = rng.amount();
        s.deposit(&project_id, &funder, amount);

        let bad_bps = random_invalid_bps(rng);
        let bad = to_collaborators(&env, &bad_bps);
        let result = s.client.try_update_collaborators(&project_id, &s.owner, &bad);

        assert_eq!(result, Err(Ok(SplitError::InvalidSplit)), "seed={seed}");

        // State is unchanged: same members, same shares, same balance.
        let stored = s.client.get_project(&project_id).unwrap().collaborators;
        assert_eq!(stored.len(), original.len(), "seed={seed}");
        for (i, c) in original.iter().enumerate() {
            let persisted = stored.get(i as u32).unwrap();
            assert_eq!(persisted.address, c.address, "seed={seed}");
            assert_eq!(persisted.basis_points, c.basis_points, "seed={seed}");
        }
        assert_eq!(s.client.get_balance(&project_id), amount, "seed={seed}");

        // The original split still governs distribution exactly.
        s.client.distribute(&project_id);
        let payouts = expected_payouts(amount, &original_bps);
        let mut paid = 0i128;
        for (c, expected) in original.iter().zip(payouts.iter()) {
            assert_eq!(s.token_balance(&c.address), *expected, "seed={seed}");
            paid += *expected;
        }
        assert_eq!(paid, amount, "seed={seed}");
        assert_eq!(s.client.get_balance(&project_id), 0, "seed={seed}");
        assert_eq!(s.token_balance(&s.contract_id), 0, "seed={seed}");
    });
}

/// A valid `update_collaborators` replaces the splits, and the new splits
/// govern the pending balance while conserving the deposited total.
#[test]
fn prop_valid_update_applies_and_conserves_pending_balance() {
    for_each_case(|seed, rng| {
        let env = Env::default();
        let s = Scenario::new(&env);

        let first = to_collaborators(&env, &random_valid_bps(rng));
        let project_id = s.create("prop_update_ok", &first);

        let funder = Address::generate(&env);
        let amount = rng.amount();
        s.deposit(&project_id, &funder, amount);

        let new_bps = random_valid_bps(rng);
        let new_collabs = to_collaborators(&env, &new_bps);
        s.client
            .update_collaborators(&project_id, &s.owner, &new_collabs);

        // The new allocation is persisted, including its member count.
        let stored = s.client.get_project(&project_id).unwrap().collaborators;
        assert_eq!(stored.len(), new_collabs.len(), "seed={seed}");
        for (i, c) in new_collabs.iter().enumerate() {
            assert_eq!(
                stored.get(i as u32).unwrap().basis_points,
                c.basis_points,
                "seed={seed}"
            );
        }

        s.client.distribute(&project_id);

        let payouts = expected_payouts(amount, &new_bps);
        let mut paid = 0i128;
        for (c, expected) in new_collabs.iter().zip(payouts.iter()) {
            assert_eq!(s.token_balance(&c.address), *expected, "seed={seed}");
            paid += *expected;
        }

        assert_eq!(paid, amount, "seed={seed}");
        assert_eq!(s.client.get_balance(&project_id), 0, "seed={seed}");
        assert_eq!(s.token_balance(&s.contract_id), 0, "seed={seed}");
        assert_eq!(
            s.client.get_unallocated_balance(&s.token),
            0,
            "seed={seed}"
        );
    });
}

/// Boundary sums: exactly 10_000 is accepted; 9_999 and 10_001 are rejected.
#[test]
fn test_split_sum_boundaries() {
    let env = Env::default();
    let s = Scenario::new(&env);

    let accepted: &[&[u32]] = &[
        &[5000, 5000],
        &[1, 9999],
        &[9999, 1],
        &[4999, 5001],
        &[1, 1, 9998],
    ];
    for (i, bps) in accepted.iter().enumerate() {
        let collaborators = to_collaborators(&env, *bps);
        let id_str = std::format!("bound_ok_{i}");
        let project_id = Symbol::new(&env, &id_str);
        assert_eq!(s.try_create(&project_id, &collaborators), Ok(()), "bps={bps:?}");
        assert!(s.client.project_exists(&project_id), "bps={bps:?}");
    }

    let rejected: &[&[u32]] = &[
        &[4999, 5000], // 9_999
        &[5000, 4999], // 9_999
        &[5000, 5001], // 10_001
        &[5001, 5000], // 10_001
        &[1, 9998],    // 9_999
    ];
    for (i, bps) in rejected.iter().enumerate() {
        let collaborators = to_collaborators(&env, *bps);
        let id_str = std::format!("bound_bad_{i}");
        let project_id = Symbol::new(&env, &id_str);
        assert_eq!(
            s.try_create(&project_id, &collaborators),
            Err(Ok(SplitError::InvalidSplit)),
            "bps={bps:?}"
        );
        assert!(!s.client.project_exists(&project_id), "bps={bps:?}");
    }
}

/// Sums that overflow `u32` are rejected with `ArithmeticOverflow` rather than
/// silently wrapping to a value that happens to equal 10_000.
#[test]
fn test_split_sum_overflow_is_rejected() {
    let env = Env::default();
    let s = Scenario::new(&env);

    let overflow: &[&[u32]] = &[&[u32::MAX, 1], &[u32::MAX, u32::MAX]];
    for (i, bps) in overflow.iter().enumerate() {
        let collaborators = to_collaborators(&env, *bps);
        let id_str = std::format!("overflow_{i}");
        let project_id = Symbol::new(&env, &id_str);
        assert_eq!(
            s.try_create(&project_id, &collaborators),
            Err(Ok(SplitError::ArithmeticOverflow)),
            "bps={bps:?}"
        );
        assert!(!s.client.project_exists(&project_id), "bps={bps:?}");
    }
}
