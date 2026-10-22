# Stellar RPC Compatibility Matrix

Defines which Horizon and Soroban RPC providers and versions SplitNaira is tested against, and how to run the bounded smoke suite.

## Supported providers and minimum versions

| Kind | Provider | Network | Endpoint | Minimum version |
| ---- | -------- | ------- | -------- | --------------- |
| Soroban RPC | Stellar Development Foundation | testnet | https://soroban-testnet.stellar.org | 21.0.0 |
| Horizon | Stellar Development Foundation | testnet | https://horizon-testnet.stellar.org | 2.28.0 |

The source of truth is `COMPATIBILITY_MATRIX` in `backend/src/rpcCompat.ts`. Update the code and this table together.

## What the smoke suite checks

- Soroban RPC: `getHealth` returns `healthy`, and `getVersionInfo` reports a version at or above the minimum.
- Horizon: the root endpoint reports `horizon_version` at or above the minimum.

## Guardrails

- Read-only: no keys, signing, or transaction submission.
- Https endpoints only; anything else is rejected before any request is made.
- Bounded: a per-request timeout (default 5000 ms) and a maximum of 10 endpoints per run.
- Endpoints are checked one at a time.

## Running

Offline unit tests (no network, safe for CI):

```
npm run test:rpc-compat -w backend
```

Live smoke against the public endpoints (environment-dependent; needs outbound HTTPS):

```
RPC_COMPAT_LIVE=1 npm run test:rpc-compat -w backend
```

On Windows PowerShell:

```
$env:RPC_COMPAT_LIVE="1"; npm run test:rpc-compat -w backend
```

## Adding a provider

1. Add an entry to `COMPATIBILITY_MATRIX`.
2. Run the live smoke and confirm it passes.
3. Add a row to the table above.