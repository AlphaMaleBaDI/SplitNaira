# Soroban RPC provider failover (Issue #1493)

The backend uses `SOROBAN_RPC_URL` as its primary Soroban RPC endpoint. Operators
may configure comma-separated fallback endpoints in
`SOROBAN_RPC_BACKUP_URLS`. All configured endpoints must use HTTP or HTTPS and
should target the **same Stellar network**. Keep provider credentials in the
deployment secret store; do not commit credential-bearing URLs.

## Selection and health policy

- The primary endpoint is preferred while it is healthy.
- A transport error, request timeout, HTTP 429, or HTTP 5xx response quarantines
  that endpoint immediately (one failure by default) for 30 seconds. The next
  request uses the next eligible configured endpoint.
- A successful, validated response clears that endpoint's failure streak and
  quarantine.
- If all endpoints are quarantined, the policy permits a bounded retry against
  the endpoint whose cooldown expires first. Normal response validation still
  applies; this is not permission to accept cached or stale data.
- Provider health is process-local. Each backend instance tracks its own
  provider state; no external health database is required.
- The existing RPC retry budget remains in force. Failover does not increase
  the number of retries or bypass operation-level retry limits.

## Stale and malformed responses

The SDK response-validation interceptor is installed **before** the health
interceptor. A response must pass JSON-RPC envelope, request-ID, and method
schema checks before it is recorded as a provider success. A mismatched request
ID or malformed result is rejected and never returned as successful data.
JSON-RPC application errors and schema-validation errors do not count as
transport-health failures; changing providers does not make untrusted response
data safe.

The failover interceptor updates each request's own `baseURL`, rather than
mutating a shared Axios default. Concurrent requests can therefore use
different providers without one request changing another request's destination.

## Configuration example

```dotenv
SOROBAN_RPC_URL=https://soroban-testnet.stellar.org
SOROBAN_RPC_BACKUP_URLS=https://backup-rpc.example,https://second-backup-rpc.example
```

Leave `SOROBAN_RPC_BACKUP_URLS` unset to preserve single-provider operation.
Restart the backend after changing provider configuration.

## Validation

Run from the repository root:

```sh
npm --prefix backend test -- src/services/rpc-provider-health.test.ts
npm --prefix backend run build
npm --prefix backend run lint
```

For an environment-dependent smoke test, configure a deliberately unreachable
primary and a healthy backup on the same network, call a read-only Soroban
operation, and verify it succeeds via the backup. Then restore the primary and
verify it is selected again after the cooldown. Do not use a write/payment
operation for this test.
