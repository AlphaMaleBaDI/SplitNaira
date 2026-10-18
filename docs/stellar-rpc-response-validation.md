# Stellar RPC Response Validation

SplitNaira validates every response it receives from Soroban RPC before using
it (issue #1494). A malformed, incomplete or unexpected payload is rejected
with a typed error. It is never treated as success, never replaced with a
default value, and never recorded as a payment.

## How it works

Validation happens in two layers.

1. **Wire layer (every JSON-RPC response).** `installRpcResponseValidation`
   adds a response interceptor to the Stellar SDK's HTTP client
   (`rpc.Server.httpClient`). It checks the raw JSON-RPC body before the SDK
   parses it. That includes calls the SDK makes internally:
   `getAccount` calls `getLedgerEntries`, and `prepareTransaction` calls
   `simulateTransaction`.
2. **Call-site layer (data the app interprets).** Where the code reads an
   SDK-parsed response or decodes a contract value, it validates it with a
   schema first: simulation return values, stroop amounts, booleans, counts
   and contract event payloads.

The backend (`getStellarRpcServer()`) and the frontend
(`createSorobanRpcServer()`) both install the interceptor on the servers they
create, so new code that uses those factories is covered automatically.

### Envelope checks (all methods)

| Response                                         | Result                                |
| ------------------------------------------------ | ------------------------------------- |
| Empty body, `null`, non-JSON (e.g. an HTML page) | `RpcResponseValidationError`          |
| `jsonrpc` is not `"2.0"`                         | `RpcResponseValidationError`          |
| `id` does not echo the request `id`              | `RpcResponseValidationError`          |
| Both `result` and `error`, or neither            | `RpcResponseValidationError`          |
| `result` is `null`                               | `RpcResponseValidationError`          |
| Well-formed `error: { code, message }`           | `RpcJsonRpcError` (code + first line) |
| Malformed `error` object                         | `RpcResponseValidationError`          |
| `result` fails the method's wire schema          | `RpcResponseValidationError`          |
| Requests that are not JSON-RPC (e.g. Friendbot)  | Passed through unchanged              |

### What is validated, per call

Only the fields the code (or the SDK parser it relies on) reads are
validated. They are strict on type and format. Unknown extra fields are
accepted, so additive upstream changes don't break anything. Fields the code
already treated as optional stay optional.

| RPC method / value                                                              | Used by                                                   | Checks                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `getEvents`                                                                     | Event listener, `GET /splits/:projectId/history`          | `events` array required (a page with a `cursor` but no `events` is rejected); per event: non-empty `id`, 64-hex `txHash`, ISO `ledgerClosedAt`, u32 `ledger` (optional), base64 XDR `topic` / `value`, `C...` or empty `contractId`; optional u32 `latestLedger`, string `cursor` |
| `payment_sent` / `collaborator_claimed` event data                              | Event listener, history                                   | `(recipient, amount)`: recipient is a valid `G...` or `C...` address, amount is an i128 `bigint` > 0. The listener also requires the event's contract ID to match `CONTRACT_ID` and the project topic to be a valid symbol                                                        |
| `distribution_complete` event data                                              | History                                                   | `(round: u32, total: i128 >= 0)`                                                                                                                                                                                                                                                  |
| `getLatestLedger`                                                               | Event listener start-up                                   | u32 `sequence`                                                                                                                                                                                                                                                                    |
| `simulateTransaction`                                                           | All contract reads, `prepareTransaction`, readiness probe | `error` variant: non-empty string. Success: base64 `transactionData`, integer-string `minResourceFee`, at most one `results` entry with base64 `xdr`. A contract read must return `result.retval`                                                                                 |
| Contract reads: `get_balance`, `get_unallocated_balance`, `get_claimable`       | Project detail, admin, claimable routes                   | Amounts decoded as exact `bigint`, `0 <= amount <= i128 max`; floats, NaN, strings and negatives are rejected                                                                                                                                                                     |
| Contract reads: `is_distributions_paused`, `is_token_allowed`, `project_exists` | Distribute, admin, create                                 | Strict boolean (no `Boolean(...)` coercion)                                                                                                                                                                                                                                       |
| Contract reads: `get_project_count`, `get_allowed_token_count`                  | Project list, admin                                       | u32                                                                                                                                                                                                                                                                               |
| `getLedgerEntries`                                                              | `getAccount` (SDK internal)                               | `entries` items need base64 `key` and `xdr`; `entries: null` is accepted (account not found)                                                                                                                                                                                      |
| `sendTransaction` (frontend)                                                    | All wallet submissions                                    | `status` is one of `PENDING`, `DUPLICATE`, `TRY_AGAIN_LATER`, `ERROR`; `PENDING` / `DUPLICATE` need a 64-hex `hash`                                                                                                                                                               |
| `getTransaction` / `pollTransaction` (frontend)                                 | Submission polling, unconfirmed-submission guard          | `status` is exactly `SUCCESS`, `FAILED` or `NOT_FOUND`                                                                                                                                                                                                                            |

There are no Horizon calls in the application today. `HORIZON_URL` is loaded
into config but no code path requests Horizon, and the frontend's
`getHorizonUrl()` only builds URLs. Any Horizon client added later must
follow the same pattern (see [Adding a schema](#adding-a-schema-for-a-new-rpc-call)).

## Where the code lives

| Workspace | Schemas                                      | Validation helpers and interceptor                |
| --------- | -------------------------------------------- | ------------------------------------------------- |
| Backend   | `backend/src/schemas/stellar-rpc.schemas.ts` | `backend/src/services/rpc-response-validation.ts` |
| Frontend  | `frontend/src/lib/stellar-rpc-validation.ts` | same file                                         |

Backend error classes are in `backend/src/lib/errors.ts`.

## Errors and how they surface

### Backend

| Error                        | HTTP | `code`                 | `details`                               |
| ---------------------------- | ---- | ---------------------- | --------------------------------------- |
| `RpcResponseValidationError` | 502  | `RPC_RESPONSE_INVALID` | `{ method, fields: [<failing paths>] }` |
| `RpcJsonRpcError`            | 502  | `RPC_UPSTREAM_ERROR`   | `{ method, rpcCode }`                   |

Both extend `AppError`, so the global error handler returns the standard
error envelope (`error`, `code`, `message`, `requestId`, `details`).
`translateSorobanError` passes them through unchanged.

`method` names the RPC method, or the method plus contract function for
decoded values (for example `simulateTransaction:get_balance` or
`getEvents:payment_sent`). `fields` are paths such as
`result.events.0.txHash`.

Every validation failure logs one structured warning:

```text
Stellar RPC response failed validation {"method":"getEvents","issues":[{"path":"result.events.0.txHash","message":"must be a 64-character hex transaction hash"}]}
```

Errors and logs never include payload values, XDR, keys or the RPC URL (which
can carry provider API keys). Upstream JSON-RPC error messages are cut to
their first line, capped at 512 characters, and long base64 runs are
replaced with `[REDACTED_XDR]`.

### Frontend

- `RpcResponseValidationError` (message tells the user to check the explorer
  before retrying) and `RpcJsonRpcError`, both in `stellar-rpc-validation.ts`.
- Malformed responses are reported to Sentry with tags
  `section=soroban-transaction`, `action`, `method`, and the failing field
  paths only.

## Fail-closed behaviour

- **Simulations.** A well-formed simulation `error` keeps its existing meaning
  (for example "project not found"). A "success" without `result.retval` is
  rejected, instead of letting callers fall back to defaults like
  `isPaused = false` or `balance = "0"`.
- **Event listener (payment indexing).** The whole batch is validated before
  anything is written. If the response, or any single payout event, is
  malformed:
  - no transaction rows are written and no SSE / event-bus notifications go out;
  - the persisted cursor and last processed ledger do not move, so the same
    page is fetched again on the next poll;
  - the poll counts as a failure. After 3 consecutive failures the listener
    backs off to 30s and reports `degraded` on the readiness endpoint.

  Skipping only the bad event would advance the cursor past a payment that
  was never recorded. A batch that keeps failing (for example after a
  contract upgrade changed an event shape) stalls the listener visibly
  instead of losing or corrupting payments. Investigate the logged `method`
  and `fields`.

- **Wallet submissions (frontend).** Only `PENDING` / `DUPLICATE` with a
  valid hash count as accepted. `TRY_AGAIN_LATER` used to be reported as
  success by several admin and owner actions; it is now an error. Only an
  exact `SUCCESS` from polling is success.
- **Unknown outcome after submission (frontend).** A malformed
  `sendTransaction` or `pollTransaction` response means the transaction may
  have reached the network. It is reported as an unconfirmed submission (same
  as a poll timeout): the action stays blocked and is tracked by its hash
  (computed locally if the RPC did not return a usable one) until
  `getTransaction` returns `SUCCESS`, `FAILED`, or `NOT_FOUND` past the
  validity window. An unknown or malformed status never marks a transaction
  as expired, so it can never unblock a retry.

### Retries

Retry behaviour is unchanged. A wire-layer failure is raised inside the SDK
call, so `executeWithRetry` retries it like any other upstream error (a bad
node behind a load balancer may answer correctly next time). Call-site
decoding failures happen after the call returns and are not retried.

## Adding a schema for a new RPC call

1. **Wire schema.** Add a zod schema for the raw `result` to
   `rawRpcResultSchemas` in `backend/src/schemas/stellar-rpc.schemas.ts`
   (frontend: `rawRpcResultSchemas` in `stellar-rpc-validation.ts`), keyed by
   the JSON-RPC method name. Include only the fields the code or the SDK
   parser reads. Use `z.object` (unknown keys are stripped, not rejected) and
   keep fields optional only when the code handles their absence.
2. **Call site.** Get the server from `getStellarRpcServer()` (backend) or
   `createSorobanRpcServer()` (frontend). Never construct `rpc.Server`
   directly, or the interceptor will not be installed.
3. **Interpreted values.** Validate the parsed response with
   `parseRpcResponse(method, schema, response)`. Decode contract values with
   `decodeContractValue(method, schema, scVal)`. For contract reads, get the
   value with `readSimulationRetval(contractMethod, simulated)`. Reuse
   `stroopAmountSchema`, `positiveStroopAmountSchema`, `contractU32Schema`,
   `contractBoolSchema` and `payoutAddressSchema`. Never use `Number(...)`,
   `Boolean(...)` or `String(...)` on RPC data.
4. **Tests.** Cover a realistic valid response (with an extra unknown field),
   each required field missing or of the wrong type, boundary values (zero,
   max i128, empty arrays) and, for anything that changes state, that a
   malformed "success" changes nothing. See
   `backend/src/__tests__/rpc-response-validation.test.ts`,
   `event-listener-rpc-validation.test.ts`, `rpc-response-routes.test.ts`, and
   `frontend/src/lib/stellar-rpc-validation.test.ts`.

## Environment

No new environment variables. Validation applies to whatever endpoints are
configured:

| Variable                      | Purpose                                         |
| ----------------------------- | ----------------------------------------------- |
| `SOROBAN_RPC_URL`             | Backend Soroban RPC endpoint                    |
| `SOROBAN_NETWORK_PASSPHRASE`  | Backend network passphrase                      |
| `CONTRACT_ID`                 | Contract the event listener accepts events from |
| `NEXT_PUBLIC_SOROBAN_RPC_URL` | Frontend Soroban RPC endpoint                   |

The validation tests need no network access or testnet RPC. RPC responses are
stubbed, either as server test doubles or through a stub HTTP adapter on a
real `rpc.Server`:

```bash
npm run test -w backend -- src/__tests__/rpc-response-validation.test.ts \
  src/__tests__/event-listener-rpc-validation.test.ts src/__tests__/rpc-response-routes.test.ts
npm run test -w frontend -- src/lib/stellar-rpc-validation.test.ts \
  src/lib/soroban-transaction.test.ts src/lib/submission-guard.test.ts
```

The only part that depends on the environment is the live testnet suite
(`npm run test:integration -w backend`), which needs a reachable testnet RPC
and funded accounts as before.

## Related

- [Diagnosing Soroban RPC Simulation Failures](./soroban-rpc-simulation-failures.md)
- [Backend API Response Validation](./backend-api-response-validation.md) (outbound responses)
- [Stuck Payouts Incident Response Runbook](./runbooks/stuck-payouts.md)
