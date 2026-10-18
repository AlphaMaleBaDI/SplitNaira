# Auth Email Flows: Verification, Password Reset, Logout and Email Change

Covers the email verification resend cooldown (#1443), session invalidation after a password reset (#1446), logout across tabs (#1451), correlation IDs in auth logs and responses (#1450), email enumeration guarantees (#1449) and the confirmed email change workflow (#1448). All endpoints are under `/auth` and share the IP-based `authLimiter` (10 requests per 5 minutes by default). The protections below are in addition to that limit, not a replacement for it.

## Email verification

### `POST /auth/email-verification/resend`

Request: `{ "email": "user@example.com", "verifyUrlBase"?: "https://..." }`

| Situation | Response |
|---|---|
| Allowed | `202 { "success": true, "retryAfterSeconds": 60 }` |
| Within the cooldown | `429` with a `Retry-After: <seconds>` header and `{ "error": "resend_cooldown", "code": "RESEND_COOLDOWN", "message": "...", "retryAfterSeconds": 42, "requestId": "...", "details": { "retryAfterSeconds": 42 } }` |
| Invalid body | `400 validation_error`. Does not start a cooldown. |

- **Cooldown key:** the email, lowercased and trimmed, so `User@Example.com` and `user@example.com` share one cooldown. Length comes from `EMAIL_VERIFICATION_RESEND_COOLDOWN_MS` (default 60s).
- **Remaining wait:** `retryAfterSeconds` is rounded up, so clients that wait that long are always allowed. On a `202`, it tells the client when the next resend will be allowed. Use it to drive a countdown on the "Resend" button.
- **No enumeration:** unknown emails and already-verified emails get the same `202` and the same cooldown, but no email is sent.
- **Concurrency:** the cooldown slot is claimed before any database or email work, so concurrent requests for the same email result in exactly one send. The rest get `429`.
- **Send failures:** if the lookup or the send fails, the slot is released and the user can retry right away.
- **Multiple instances:** the cooldown is in memory on each instance, like the idempotency store. With N instances, a client can get at most N sends per window.

### `POST /auth/email-verification/confirm`

Request: `{ "token": "..." }`. On success, sets `emailVerifiedAt` on every account with that email that isn't already verified, and returns `200 { "success": true, "email": "..." }`. An invalid, expired, or wrong-purpose token returns `400 invalid_or_expired_token`. Links last `EMAIL_VERIFICATION_TOKEN_TTL` (default 24h).

## Password reset and session invalidation

Wallet JWTs carry an `sv` (session version) claim. `authJwtMiddleware` rejects any token whose `sv` doesn't match the user's current `users.sessionVersion`:

```json
401 { "error": "unauthorized", "code": "SESSION_REVOKED", "message": "Session has been revoked. Please log in again.", "requestId": "...", "details": {} }
```

Clients should treat `SESSION_REVOKED` like an expired token: clear it and send the user back to sign in.

### `POST /auth/password-reset/confirm`

Request: `{ "token": "...", "newPassword": "..." }`

On success (`200 { "success": true, "email": "...", "sessionsRevoked": true }`):

- **Every account registered with the token's email** has its `sessionVersion` bumped, so every wallet JWT issued to those accounts stops working on every instance immediately.
- **No new session is issued.** The reset flow only proves control of the email, not the wallet, so the user has to log in again.
- **The reset token is single-use.** It is bound to the session version at issue time. Once a confirm bumps the version, replaying the same token, confirming it concurrently, or using an older reset link all return `400 invalid_or_expired_token`. The bump is a single conditional `UPDATE`, so two concurrent confirms can't both succeed.

**Intentionally retained:**

| Kept | Why |
|---|---|
| Sessions for accounts registered under a different email | They aren't tied to the email whose reset was confirmed. |
| Invitation and email verification tokens | They are single-purpose links, not sessions, and don't grant API access. |
| Tokens for wallets with no `users` row | There is no session version to compare against. This matches the behavior before #1446. |

**Note:** wallet login (`POST /users/login`) doesn't use a password, so the reset doesn't store `newPassword` anywhere. The value is still validated (minimum 8 characters) so the API contract is stable for when password credentials are added.

### Rollout

- **Migration:** `1760000000012-AddUserSessionVersionAndEmailVerification` adds `sessionVersion INTEGER NOT NULL DEFAULT 0` and `emailVerifiedAt TIMESTAMPTZ` to `users`.
- **Existing tokens:** wallet JWTs and reset tokens issued before the deploy have no `sv` claim and are treated as version 0. Nobody is logged out by the deploy itself; old tokens stop working only after that account's first password reset.
- **Cost:** every authenticated request now does one indexed lookup on `users.walletAddress`. If that lookup fails, the request fails with `500` rather than skipping the check.

## Logout and other tabs (#1451)

### `POST /auth/logout`

Requires `Authorization: Bearer <token>`. Response: `200 { "success": true, "sessionsRevoked": true, "requestId": "..." }`.

Wallet JWTs are stateless, so every tab holds its own copy of the same token and there is no single "current session" to delete. Logout therefore bumps the account's `sessionVersion` (the #1446 mechanism). The effect is the same in every tab and device at once:

| Who | What they see next |
|---|---|
| The tab that logged out | The token no longer works. |
| Every other tab or device holding a token for this wallet | `401 SESSION_REVOKED` on its next request, the same response a password reset produces. Clients need one "signed out" code path: clear the token and go to sign in. |
| A fresh `POST /users/login` afterwards | A token for the new session version; it works. |
| Other wallets | Unaffected. |

- **Race safety:** the bump is conditional on the `sv` in the token that asked to log out. Two tabs logging out at once bump it once, and a logout with an old token can't revoke a session created after it. If another tab got there first, the response is `200` with `"sessionsRevoked": false`.
- **Stale tokens:** logging out with an already-revoked token is rejected by the auth middleware with `401 SESSION_REVOKED`, like any other request.
- **No account row:** a token for a wallet with no `users` row has no version to compare against (see the table above), so there is nothing to revoke: `200` with `"sessionsRevoked": false`.
- **Scope:** logout signs the wallet out everywhere, not just in one tab. Per-tab logout would need server-side session records, which wallet JWTs deliberately don't have.

## Correlation IDs (#1450)

Every response carries `x-request-id` and `x-correlation-id` headers. Error bodies and the bodies of `/auth/logout` and `/auth/email-change/*` also carry `requestId`, the same value. The success bodies of the older endpoints (password reset, verification) are unchanged, so read the header there. Quote the id when reporting a problem; every auth log line for that request carries it too.

**Inbound ids.** A client may send its own `x-request-id` or `x-correlation-id`. It is used only if it is 1 to 64 characters of `A-Za-z0-9._:-` and is not shaped like a JWT. Anything else (spaces, newlines, quotes, over-long values, a pasted token) is dropped and a UUID is generated instead, so a client can't inject log lines or get a credential written to logs and echoed back. If `x-request-id` is unusable, `x-correlation-id` is tried before generating one.

**Auth events.** Each outcome writes one structured `auth_event` log line (warn level for failures):

```json
{ "message": "auth_event", "event": "logout", "outcome": "success", "requestId": "...", "userId": "...", "emailHash": "9f2c...", "reason": "SESSION_REVOKED", "sessionsRevoked": true }
```

Events: `login`, `logout`, `session_rejected`, `password_reset_requested`, `password_reset_confirmed`, `email_verification_resent`, `email_verified`, `email_change_requested`, `email_change_confirmed`. The fields are a closed list (`services/auth-events.ts`), so credentials can't be added by accident:

- `userId` is the internal id, never the wallet address.
- Emails appear only as a 16-character SHA-256 hash (`emailHash`), so events about one address can be correlated without storing it.
- `reason` is a short code; anything else is dropped.
- Tokens, passwords, `Authorization` headers and reset/confirmation links are never logged. The console email provider logs links as origin and path only (`https://app.example.com/reset`), without the `?token=` part.

## Email enumeration (#1449)

No sign-in or recovery response reveals whether an address has an account. These guarantees are covered by `auth-enumeration.test.ts`:

| Endpoint | Guarantee |
|---|---|
| `POST /auth/password-reset/request` | Same `202` body and headers for registered (verified or not) and unregistered addresses. |
| `POST /auth/email-verification/resend` | Same `202`, and the same `429` cooldown shape, for unverified, verified and unregistered addresses. |
| `POST /auth/email-change/request` | Same `202` whether or not the new address already belongs to another account. The address is never looked up. |
| `POST /users/login` | Signs in by wallet only; an `email` in the body is ignored and never reflected. |
| Validation errors | Do not echo the submitted address. |

Timing is not equalized: for a registered address the server also builds a token and hands an email to the provider. Keep the provider call asynchronous (queue it) in production so that work doesn't show up in latency.

## Changing the email address (#1448)

An address change takes effect only after the owner of the **new** address confirms it. `PATCH /users/me` no longer changes the address: sending a different `email` returns `400` pointing at this workflow (re-sending the current address is accepted as a no-op).

### `POST /auth/email-change/request`

Requires a bearer token. Request: `{ "newEmail": "new@example.com" }`.

| Situation | Response |
|---|---|
| Accepted | `202 { "success": true, "requestId": "..." }`. Nothing has changed yet. |
| Same as the current address (ignoring case and spaces) | `400 { "code": "EMAIL_UNCHANGED" }` |
| Invalid or over-long address | `400 validation_error` |
| No token or revoked session | `401` |
| Account deleted | `404` |

On success:

1. A confirmation link goes to the **new** address. Links last `EMAIL_CHANGE_TOKEN_TTL` (default 24h) and point at `EMAIL_CHANGE_URL_BASE`. The base is not accepted from the request, so a caller can't send a victim a link to a site of their choosing.
2. If the account has a **prior** address, it gets a notice that a change was requested, naming the new address only in masked form (`n***@example.com`). This is best effort: a failed notice does not block the user's own change.
3. The request is written to the audit log as `email_change_requested` with the user id and hashes of both addresses.

### `POST /auth/email-change/confirm`

Request: `{ "token": "..." }`. No bearer token is needed; the link itself proves control of the new address. `200 { "success": true, "email": "new@example.com", "requestId": "..." }`, otherwise `400 invalid_or_expired_token`.

The link is bound to the account, the address it had when the link was issued, and its session version. It is rejected unless all three still match, which means:

- **Single use.** Once the address changes, the same link matches nothing. Concurrent confirms apply once (the update is conditional on the same values).
- **Superseded by newer changes.** Confirming a newer link kills older ones.
- **Dead after a logout or password reset**, and for deleted accounts.

On success the new address is stored and marked verified, the prior address (if any) gets a "your email was changed" notice, and `email_changed` is written to the audit log. Sessions are not revoked: the user proved control of the new address and keeps working. Use `POST /auth/logout` if you want to sign everything out.

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `EMAIL_CHANGE_TOKEN_TTL` | `24h` | Lifetime of the confirmation link |
| `EMAIL_CHANGE_URL_BASE` | `https://app.splitnaira.com/confirm-email-change` | Page the link opens; it receives `?token=...` |

## Tests

- `backend/src/__tests__/email-verification-resend.test.ts`
- `backend/src/__tests__/session-revocation.test.ts`
- `backend/src/__tests__/auth-logout.test.ts` (#1451)
- `backend/src/__tests__/auth-correlation.test.ts` (#1450)
- `backend/src/__tests__/auth-enumeration.test.ts` (#1449)
- `backend/src/__tests__/email-change.test.ts` (#1448)

These tests replace the database with mocks. The conditional `UPDATE` statements in `services/session-revocation.ts` need a real Postgres to be exercised.
