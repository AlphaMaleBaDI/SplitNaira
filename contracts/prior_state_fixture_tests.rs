#![cfg(test)]
//! Prior-state fixture tests: upgrades and data-shape changes.
//!
//! A WASM upgrade keeps the existing storage. Each fixture here rebuilds a
//! storage layout that an earlier contract version left behind, then runs
//! today's code against it. Every fixture starts from real calls, then
//! rewrites raw storage inside `env.as_contract` to match the older layout:
//!
//! | Fixture | Represents | Older layout |
//! |---|---|---|
//! | `v1_flat_index` | before bucketed index, accounting cache, claim epochs | flat `ProjectIds`; no `ProjectIdsBucket*`, `AccountedTokenBalance`, `ClaimEpoch`, `LastClaimEpoch`, `LastClaimAmount`, `MaxCollaborators` |
//! | `v2_pre_accounting` | buckets shipped, accounting cache not yet | bucketed index; no `AccountedTokenBalance` or claim-epoch keys |
//! | `v3_mixed_index` | a project created on v1 storage before this fix | bucket 0 holds only the newest ID; legacy IDs only in flat `ProjectIds` |
//!
//! Invariants that must hold on every fixture:
//! - Funds in a project are never reported as unallocated, so
//!   `withdraw_unallocated` can't drain them.
//! - `deposit`, `distribute` and `claim` keep balance, `total_distributed`,
//!   `distribution_round` and claimed ledgers consistent.
//! - Index migration never drops or reorders a project ID.
//! - Only the admin can run migrations.
//!
//! See docs/contract-storage-layout-and-migrations.md § 5.

extern crate std;

use super::*;
use soroban_sdk::{testutils::Address as _, token, Address, Env, String, Symbol, Vec};

const FUNDED: i128 = 1_000_0000000; // per-project balance in each fixture

struct Fixture<'a> {
    env: &'a Env,
    client: SplitNairaContractClient<'a>,
    contract_id: Address,
    token: Address,
    admin: Address,
    collabs: std::vec::Vec<Address>,
    projects: std::vec::Vec<Symbol>,
}

impl<'a> Fixture<'a> {
    /// Creates `n` funded projects (60/40 split) on current code, ready to be
    /// rewritten into a prior layout.
    fn modern(env: &'a Env, n: u32) -> Self {
        env.mock_all_auths();
        env.budget().reset_unlimited();
        let token = env.register_stellar_asset_contract(Address::generate(env));
        let contract_id = env.register_contract(None, SplitNairaContract);
        let client = SplitNairaContractClient::new(env, &contract_id);
        let admin = Address::generate(env);
        client.set_admin(&admin);

        let collabs = std::vec![Address::generate(env), Address::generate(env)];
        let mut members = Vec::new(env);
        for (addr, bps) in collabs.iter().zip([6000u32, 4000u32]) {
            members.push_back(Collaborator {
                address: addr.clone(),
                alias: String::from_str(env, "collab"),
                basis_points: bps,
            });
        }

        let funder = Address::generate(env);
        let mut projects = std::vec::Vec::new();
        for i in 0..n {
            let id = Symbol::new(env, &std::format!("legacy_{i}"));
            client.create_project(
                &Address::generate(env),
                &id,
                &String::from_str(env, "Legacy"),
                &String::from_str(env, "music"),
                &token,
                &members,
            );
            token::StellarAssetClient::new(env, &token).mint(&funder, &FUNDED);
            client.deposit(&id, &funder, &FUNDED);
            projects.push(id);
        }

        Fixture { env, client, contract_id, token, admin, collabs, projects }
    }

    fn storage<R>(&self, f: impl FnOnce() -> R) -> R {
        self.env.as_contract(&self.contract_id, f)
    }

    /// Removes keys introduced after the given layout.
    fn strip_post_v2_keys(&self) {
        self.storage(|| {
            let s = self.env.storage().persistent();
            s.remove(&DataKey::AccountedTokenBalance(self.token.clone()));
            for id in &self.projects {
                s.remove(&DataKey::ClaimEpoch(id.clone()));
                for c in &self.collabs {
                    s.remove(&DataKey::LastClaimEpoch(id.clone(), c.clone()));
                    s.remove(&DataKey::LastClaimAmount(id.clone(), c.clone()));
                }
            }
        });
    }

    fn bucketed_to_flat(&self) {
        self.storage(|| {
            let s = self.env.storage().persistent();
            let count: u32 = s.get(&DataKey::ProjectIdsBucketCount).unwrap_or(0);
            for b in 0..count {
                s.remove(&DataKey::ProjectIdsBucket(b));
            }
            s.remove(&DataKey::ProjectIdsBucketCount);
            s.remove(&DataKey::MaxCollaborators);
            s.set(&DataKey::ProjectIds, &self.id_vec(&self.projects));
        });
    }

    fn id_vec(&self, ids: &[Symbol]) -> Vec<Symbol> {
        let mut v = Vec::new(self.env);
        for id in ids {
            v.push_back(id.clone());
        }
        v
    }

    fn v1_flat_index(env: &'a Env, n: u32) -> Self {
        let fx = Self::modern(env, n);
        fx.strip_post_v2_keys();
        fx.bucketed_to_flat();
        fx
    }

    fn v2_pre_accounting(env: &'a Env, n: u32) -> Self {
        let fx = Self::modern(env, n);
        fx.strip_post_v2_keys();
        fx
    }

    /// v1 layout, plus one project whose ID went into a fresh bucket 0 while
    /// the legacy IDs stayed in the flat index (the pre-fix `create_project`
    /// behaviour).
    fn v3_mixed_index(env: &'a Env, n: u32) -> Self {
        let mut fx = Self::modern(env, n + 1);
        fx.strip_post_v2_keys();
        let newest = fx.projects.pop().unwrap();
        fx.storage(|| {
            let s = env.storage().persistent();
            let count: u32 = s.get(&DataKey::ProjectIdsBucketCount).unwrap_or(0);
            for b in 0..count {
                s.remove(&DataKey::ProjectIdsBucket(b));
            }
            let mut bucket = Vec::new(env);
            bucket.push_back(newest.clone());
            s.set(&DataKey::ProjectIdsBucket(0), &bucket);
            s.set(&DataKey::ProjectIdsBucketCount, &1u32);
            s.set(&DataKey::ProjectIds, &fx.id_vec(&fx.projects));
        });
        fx.projects.push(newest);
        fx
    }

    fn has_flat_index(&self) -> bool {
        self.storage(|| self.env.storage().persistent().has(&DataKey::ProjectIds))
    }

    fn has_accounting_cache(&self) -> bool {
        self.storage(|| {
            self.env
                .storage()
                .persistent()
                .has(&DataKey::AccountedTokenBalance(self.token.clone()))
        })
    }

    fn all_ids(&self) -> std::vec::Vec<Symbol> {
        self.client.get_project_ids(&0, &1_000).iter().collect()
    }

    fn contract_token_balance(&self) -> i128 {
        token::Client::new(self.env, &self.token).balance(&self.contract_id)
    }

    fn total_project_balances(&self) -> i128 {
        self.projects.iter().map(|id| self.client.get_balance(id)).sum()
    }

    fn deposit(&self, id: &Symbol, amount: i128) {
        let funder = Address::generate(self.env);
        token::StellarAssetClient::new(self.env, &self.token).mint(&funder, &amount);
        self.client.deposit(id, &funder, &amount);
    }

    /// Tokens sent straight to the contract, outside any project: the only
    /// funds `withdraw_unallocated` is allowed to recover.
    fn stray_transfer(&self, amount: i128) {
        token::StellarAssetClient::new(self.env, &self.token).mint(&self.contract_id, &amount);
    }

    fn create_project(&self, name: &str) -> Symbol {
        let id = Symbol::new(self.env, name);
        let mut members = Vec::new(self.env);
        for (addr, bps) in self.collabs.iter().zip([5000u32, 5000u32]) {
            members.push_back(Collaborator {
                address: addr.clone(),
                alias: String::from_str(self.env, "c"),
                basis_points: bps,
            });
        }
        self.client.create_project(
            &Address::generate(self.env),
            &id,
            &String::from_str(self.env, "New"),
            &String::from_str(self.env, "music"),
            &self.token,
            &members,
        );
        id
    }

    fn assert_no_project_funds_unallocated(&self, stray: i128) {
        assert_eq!(
            self.contract_token_balance(),
            self.total_project_balances() + stray,
            "contract holdings must equal project balances plus stray tokens"
        );
        assert_eq!(self.client.get_unallocated_balance(&self.token), stray);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reads on prior state (no migration run)
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn v1_reads_work_before_any_migration() {
    let env = Env::default();
    let fx = Fixture::v1_flat_index(&env, 3);

    assert_eq!(fx.all_ids(), fx.projects, "flat index fallback keeps creation order");
    assert_eq!(fx.client.list_projects(&0, &10).len(), 3);
    assert_eq!(fx.client.get_project_count(), 3);
    assert_eq!(fx.client.get_max_collaborators(), DEFAULT_MAX_COLLABORATORS);
    for id in &fx.projects {
        assert_eq!(fx.client.get_balance(id), FUNDED);
        let info = fx.client.get_claimable(id, &fx.collabs[0]);
        assert_eq!(info.claimed, 0);
        assert_eq!(info.last_claim_amount, 0, "missing LastClaimAmount reads as 0");
        assert_eq!(info.distribution_round, 0);
    }
    assert!(!fx.has_accounting_cache());
    fx.assert_no_project_funds_unallocated(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Financial invariants after the upgrade
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn first_deposit_after_upgrade_seeds_accounting_from_all_projects() {
    for build in [Fixture::v1_flat_index, Fixture::v2_pre_accounting] {
        let env = Env::default();
        let fx = build(&env, 3);
        fx.deposit(&fx.projects[0], 5_0000000);

        assert!(fx.has_accounting_cache());
        // Regression: seeding the cache from 0 reported the 3 × FUNDED legacy
        // balance as unallocated and let the admin withdraw it.
        fx.assert_no_project_funds_unallocated(0);
        assert_eq!(
            fx.client.try_withdraw_unallocated(&fx.admin, &fx.token, &fx.admin, &1),
            Err(Ok(SplitError::InsufficientUnallocated))
        );
    }
}

#[test]
fn first_distribute_or_claim_after_upgrade_keeps_accounting_exact() {
    let env = Env::default();
    let fx = Fixture::v2_pre_accounting(&env, 2);
    fx.client.distribute(&fx.projects[0]);
    fx.assert_no_project_funds_unallocated(0);

    let env = Env::default();
    let fx = Fixture::v2_pre_accounting(&env, 2);
    fx.client.claim(&fx.projects[1], &fx.collabs[0]);
    fx.assert_no_project_funds_unallocated(0);
}

#[test]
fn withdraw_unallocated_recovers_only_stray_tokens_on_prior_state() {
    let env = Env::default();
    let fx = Fixture::v1_flat_index(&env, 2);
    let stray = 7_0000000;
    fx.stray_transfer(stray);
    fx.deposit(&fx.projects[1], 3_0000000); // seeds the cache post-upgrade

    fx.assert_no_project_funds_unallocated(stray);
    assert_eq!(
        fx.client.try_withdraw_unallocated(&fx.admin, &fx.token, &fx.admin, &(stray + 1)),
        Err(Ok(SplitError::InsufficientUnallocated)),
        "must not dip into project funds"
    );

    let balances_before = fx.total_project_balances();
    fx.client.withdraw_unallocated(&fx.admin, &fx.token, &fx.admin, &stray);
    assert_eq!(fx.total_project_balances(), balances_before);
    fx.assert_no_project_funds_unallocated(0);
}

#[test]
fn distribute_on_prior_state_matches_fresh_deployment() {
    let fresh_env = Env::default();
    let fresh = Fixture::modern(&fresh_env, 1);
    let legacy_env = Env::default();
    let legacy = Fixture::v1_flat_index(&legacy_env, 1);

    for fx in [&fresh, &legacy] {
        fx.deposit(&fx.projects[0], 333);
        fx.client.distribute(&fx.projects[0]);
    }

    let total = FUNDED + 333;
    for fx in [&fresh, &legacy] {
        let id = &fx.projects[0];
        let project = fx.client.get_project(id).unwrap();
        assert_eq!(project.distribution_round, 1);
        assert_eq!(project.total_distributed, total);
        assert_eq!(fx.client.get_balance(id), 0);
        let claimed: i128 = fx.collabs.iter().map(|c| fx.client.get_claimed(id, c)).sum();
        assert_eq!(claimed, total);
    }
    for i in 0..2 {
        let paid = |fx: &Fixture| fx.client.get_claimed(&fx.projects[0], &fx.collabs[i]);
        assert_eq!(paid(&legacy), paid(&fresh), "collaborator {i} payout differs after upgrade");
    }
    legacy.assert_no_project_funds_unallocated(0);
}

#[test]
fn claim_on_state_without_claim_epochs_allows_one_claim_per_epoch() {
    let env = Env::default();
    let fx = Fixture::v1_flat_index(&env, 1);
    let id = &fx.projects[0];

    let paid = fx.client.claim(id, &fx.collabs[0]);
    assert_eq!(paid, FUNDED * 6000 / 10_000);
    assert_eq!(
        fx.client.try_claim(id, &fx.collabs[0]),
        Err(Ok(SplitError::AlreadyClaimed)),
        "missing ClaimEpoch must still block a duplicate claim"
    );
    assert_eq!(fx.client.get_claimable(id, &fx.collabs[0]).last_claim_amount, paid);
    fx.deposit(id, 10_0000000);
    assert!(fx.client.try_claim(id, &fx.collabs[0]).is_ok(), "a deposit opens a new epoch");
}

// ─────────────────────────────────────────────────────────────────────────────
// Index migration
// ─────────────────────────────────────────────────────────────────────────────

#[test]
fn create_project_on_flat_index_migrates_inline_without_hiding_legacy_ids() {
    let env = Env::default();
    let fx = Fixture::v1_flat_index(&env, 3);
    let new_id = fx.create_project("post_upgrade");

    let mut expected = fx.projects.clone();
    expected.push(new_id.clone());
    assert_eq!(fx.all_ids(), expected);
    assert!(!fx.has_flat_index());
    assert_eq!(fx.client.get_project_count(), 4);
    assert_eq!(fx.client.get_project_ids(&3, &1).get(0).unwrap(), new_id, "index position matches ProjectCount");
}

#[test]
fn migrate_is_idempotent_and_preserves_order() {
    let env = Env::default();
    let fx = Fixture::v1_flat_index(&env, 4);
    fx.client.migrate_flat_to_buckets(&fx.admin);
    fx.client.migrate_flat_to_buckets(&fx.admin);

    assert_eq!(fx.all_ids(), fx.projects);
    assert!(!fx.has_flat_index());
    fx.assert_no_project_funds_unallocated(0);
}

#[test]
fn migrate_merges_a_mixed_index_instead_of_dropping_legacy_ids() {
    let env = Env::default();
    let fx = Fixture::v3_mixed_index(&env, 3);
    let newest = fx.projects.last().unwrap().clone();

    // Before migration, accounting must still see the flat-only legacy projects.
    fx.deposit(&newest, 1);
    fx.assert_no_project_funds_unallocated(0);

    fx.client.migrate_flat_to_buckets(&fx.admin);
    let ids = fx.all_ids();
    assert_eq!(ids.len(), fx.projects.len(), "no project ID may be lost");
    for id in &fx.projects {
        assert!(ids.contains(id), "missing {id:?} after migration");
    }
    assert_eq!(ids[0], newest, "already-bucketed IDs keep their position");
    assert!(!fx.has_flat_index());
    fx.assert_no_project_funds_unallocated(0);
}

#[test]
fn migration_fills_bucket_boundaries_exactly() {
    for legacy_len in [99u32, 100, 101] {
        let env = Env::default();
        let fx = Fixture::v1_flat_index(&env, 1);
        // Index-only IDs (no project records) are enough to exercise bucketing.
        let mut ids = fx.projects.clone();
        for i in 1..legacy_len {
            ids.push(Symbol::new(&env, &std::format!("idx_{i}")));
        }
        fx.storage(|| env.storage().persistent().set(&DataKey::ProjectIds, &fx.id_vec(&ids)));

        fx.client.migrate_flat_to_buckets(&fx.admin);

        let buckets: u32 = fx.storage(|| {
            env.storage().persistent().get(&DataKey::ProjectIdsBucketCount).unwrap_or(0)
        });
        assert_eq!(buckets, (legacy_len - 1) / PROJECT_ID_BUCKET_SIZE + 1, "len={legacy_len}");
        assert_eq!(fx.all_ids(), ids, "len={legacy_len}");
    }
}

#[test]
fn empty_flat_index_migrates_to_nothing() {
    let env = Env::default();
    let fx = Fixture::v1_flat_index(&env, 1);
    fx.storage(|| env.storage().persistent().set(&DataKey::ProjectIds, &Vec::<Symbol>::new(&env)));

    fx.client.migrate_flat_to_buckets(&fx.admin);
    assert!(!fx.has_flat_index());
    assert!(fx.all_ids().is_empty());
}

#[test]
fn non_admin_cannot_migrate_prior_state() {
    let env = Env::default();
    let fx = Fixture::v1_flat_index(&env, 2);
    let attacker = Address::generate(&env);

    assert_eq!(
        fx.client.try_migrate_flat_to_buckets(&attacker),
        Err(Ok(SplitError::Unauthorized))
    );
    assert!(fx.has_flat_index(), "a rejected migration must not touch storage");
    assert_eq!(fx.all_ids(), fx.projects);
}
