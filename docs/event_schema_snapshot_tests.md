# Event Schema Snapshot Tests

Snapshot testing to prevent accidental breaking changes to contract event topics.

- **Rust:** the `event_snapshot_tests` module in `contracts/events.rs` checks the topics and data each event actually emits.
- **Integration contract:** `contracts/interface/events.contract.json` is the versioned wire-shape snapshot for all events. `npm run check:events` checks it in CI against `events.rs` and against the base branch. See [contract-events.md § Compatibility policy](contract-events.md#compatibility-policy).
