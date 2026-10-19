# SplitNaira Contract Event Reference

This document is the authoritative reference for every event emitted by the
SplitNaira Soroban contract. Backend services and indexers **must** consume
events through this schema. Do not infer event shape from test snapshots alone.

---

## Versioning & Breaking Changes

Event schemas follow a conservative stability contract:

- **Topic strings and payload field order are part of the public API.**
  Indexers that decode raw XDR rely on positional tuple ordering.
- Additive changes (new optional events) are non-breaking.
- Any change to a topic string, payload field type, or positional order is a
  **breaking change** and requires a new event name (e.g. `project_created_v2`)
  with the old event kept for one deprecation window.
- Breaking changes are announced in `CHANGELOG.md` and the
  [contract release checklist](./CONTRACT_INTERFACE_RELEASE_CHECKLIST.md).

## Compatibility policy

CI enforces this contract. The machine-readable version is
[`contracts/interface/events.contract.json`](../contracts/interface/events.contract.json),
a versioned snapshot of every event's topics and data shape.
`contracts/scripts/check-event-contract.mjs` extracts the same shape from
`contracts/events.rs` and compares the two.

On the wire, only **position, kind and type** count. Rust struct and field
names never reach the wire, so renaming them is not a breaking change.

| Change | Level | Snapshot bump |
|---|---|---|
| Event removed, or its `topic[0]` name changed | **breaking** | MAJOR |
| Topic added, removed, retyped or reordered (topic filters are positional) | **breaking** | MAJOR |
| Data shape changed (`unit` ↔ `single` ↔ `tuple`) | **breaking** | MAJOR |
| Data field removed, retyped or reordered | **breaking** | MAJOR |
| New event | additive | MINOR |
| New field appended to the *end* of tuple data | additive | MINOR |
| Rust struct or field renamed, wire shape unchanged | informational | PATCH |

Appending a trailing field counts as additive only because every consumer
must **ignore extra trailing tuple elements**. The backend's
`payoutEventValueSchema` and `distributionCompleteEventValueSchema` do this
with a `z.unknown()` rest element. New decoders must do the same.

### What CI checks

1. `npm run check:events` fails if `events.rs` no longer matches the committed
   snapshot, if any `publish` call uses an expression the extractor can't
   model, or if `lib.rs` publishes an event directly instead of through
   `events.rs`.
2. On pull requests, the committed snapshot is compared with the snapshot on
   the base branch. The job fails if the version bump is smaller than the
   change level, for example a breaking change with only a MINOR bump.

### Changing an event

```bash
# After editing contracts/events.rs:
npm run events:update                    # additive / informational: bumps MINOR / PATCH
npm run events:update -- --allow-breaking # breaking: bumps MAJOR (coordinate consumers first)
```

Commit the updated snapshot together with the contract change. For a
breaking change, also do all of the following before merging:

- Update the backend decoders (`backend/src/schemas/stellar-rpc.schemas.ts`,
  `EventListenerService`) and this catalogue.
- Add a `CHANGELOG.md` entry under **Changed**.
- Follow the [release checklist](./CONTRACT_INTERFACE_RELEASE_CHECKLIST.md).
  The preferred path is still a new `_v2` event, with the old one kept for a
  deprecation window.

Tests: `backend/src/__tests__/event-contract.test.ts` checks the snapshot
against the source and that the backend decoders line up with it. It also
covers every classification rule above and the CLI exit codes.

---

## Event Catalogue

### `project_created`

Emitted once when a new royalty-split project is successfully created.

| Field | Value |
|---|---|
| Topics | `["project_created", project_id: Symbol]` |
| Data | `owner: Address` |

**Example (decoded)**

```
topics: ["project_created", "afrobeats_vol3"]
data:   GABC...XYZ
```

**Notes**
- Emitted by `create_project`.
- `project_id` in topics matches the caller-supplied ID.
- Indexers can use this event to build a project registry without polling.

---

### `project_locked`

Emitted when a project's splits are permanently locked and can no longer be
modified.

| Field | Value |
|---|---|
| Topics | `["project_locked", project_id: Symbol]` |
| Data | `project_id: Symbol` |

**Example (decoded)**

```
topics: ["project_locked", "afrobeats_vol3"]
data:   "afrobeats_vol3"
```

**Notes**
- Emitted by `lock_project`.
- After this event, `update_collaborators` will return `SplitError::ProjectLocked (9)`.

---

### `deposit_received`

Emitted on every successful deposit into a project escrow.

| Field | Value |
|---|---|
| Topics | `["deposit_received", project_id: Symbol]` |
| Data | `(from: Address, amount: i128, project_balance: i128)` |

**Example (decoded)**

```
topics: ["deposit_received", "afrobeats_vol3"]
data:   (GABC...XYZ, 5000000, 12000000)
```

**Notes**
- `amount` and `project_balance` are in **stroops** (1 XLM = 10,000,000 stroops).
- `project_balance` is the total held in escrow after this deposit.
- Emitted by `deposit`.

---

### `payment_sent`

Emitted once **per collaborator** during a distribution round, immediately
before `distribution_complete`.

| Field | Value |
|---|---|
| Topics | `["payment_sent", project_id: Symbol]` |
| Data | `(recipient: Address, amount: i128)` |

**Example (decoded)**

```
topics: ["payment_sent", "afrobeats_vol3"]
data:   (GDEF...UVW, 3000000)
```

**Notes**
- `amount` is the collaborator's share for this round, in stroops.
- One event per collaborator — indexers summing `payment_sent` amounts within
  a round should match the `total` field in the corresponding
  `distribution_complete` event.

---

### `distribution_complete`

Emitted once per distribution round, after all `payment_sent` events for
that round have been emitted.

| Field | Value |
|---|---|
| Topics | `["distribution_complete", project_id: Symbol]` |
| Data | `(round: u32, total: i128)` |

**Example (decoded)**

```
topics: ["distribution_complete", "afrobeats_vol3"]
data:   (1, 5000000)
```

**Notes**
- `round` starts at 1 and increments with each successful distribute call.
- `total` is the sum of all `payment_sent` amounts in this round, in stroops.
- Indexers can use `(project_id, round)` as a stable idempotency key.

---

### `metadata_updated`

Emitted when a project's title or type is changed.

| Field | Value |
|---|---|
| Topics | `["metadata_updated", project_id: Symbol]` |
| Data | `project_id: Symbol` |

**Example (decoded)**

```
topics: ["metadata_updated", "afrobeats_vol3"]
data:   "afrobeats_vol3"
```

**Notes**
- Emitted by `update_metadata`.
- Indexers that cache project title/type should re-fetch on this event.

---

### `ownership_transferred`

Emitted when a project owner transfers ownership to a new address.

| Field | Value |
|---|---|
| Topics | `["ownership_transferred", project_id: Symbol]` |
| Data | `(previous_owner: Address, new_owner: Address)` |

**Example (decoded)**

```
topics: ["ownership_transferred", "afrobeats_vol3"]
data:   (GABC...XYZ, GHIJ...MNO)
```

**Notes**
- Emitted by `transfer_ownership`.
- Authorization gates (e.g. `update_collaborators`) check the new owner
  immediately after this event.

---

### `unallocated_withdrawn`

Emitted when the contract admin withdraws tokens that were not allocated to
any project (i.e. deposited directly to the contract address).

| Field | Value |
|---|---|
| Topics | `["unallocated_withdrawn", token: Address]` |
| Data | `(admin: Address, to: Address, amount: i128, remaining_unallocated: i128)` |

**Example (decoded)**

```
topics: ["unallocated_withdrawn", CUSDC...CONTRACT]
data:   (GADMIN...XYZ, GDEST...ABC, 1000000, 500000)
```

**Notes**
- `remaining_unallocated` is the contract-level unallocated balance
  **after** the withdrawal.
- Amounts in stroops.

---

## Indexer Quick-Reference

| Event | Trigger | Key fields for indexing |
|---|---|---|
| `project_created` | `create_project` | `project_id`, `owner` |
| `project_locked` | `lock_project` | `project_id` |
| `deposit_received` | `deposit` | `project_id`, `from`, `amount`, `project_balance` |
| `payment_sent` | `distribute` (per collaborator) | `project_id`, `recipient`, `amount` |
| `distribution_complete` | `distribute` (once per round) | `project_id`, `round`, `total` |
| `metadata_updated` | `update_metadata` | `project_id` |
| `ownership_transferred` | `transfer_ownership` | `project_id`, `previous_owner`, `new_owner` |
| `unallocated_withdrawn` | `withdraw_unallocated` | `token`, `admin`, `to`, `amount` |

---

## Related Documents

- [Contract Interface Release Checklist](./CONTRACT_INTERFACE_RELEASE_CHECKLIST.md)
- [Contract Release and Upgrade Runbook](./contract-release-and-upgrade-runbook.md)
- [API Evolution / Breaking-Change Policy](./adr/)
- Source of truth: [`contracts/events.rs`](../contracts/events.rs)
