# Auth Email Flows: Verification Resend and Password Reset

Covers the email verification resend cooldown (#1443) and session invalidation after a password reset (#1446). All endpoints are under `/auth` and share the IP-based `authLimiter` (10 requests per 5 minutes by default). The protections below are in addition to that limit, not a replacement for it.

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

## Tests

- `backend/src/__tests__/email-verification-resend.test.ts`
- `backend/src/__tests__/session-revocation.test.ts`

These tests replace the database with mocks. The conditional `UPDATE` in `services/session-revocation.ts` needs a real Postgres to be exercised.
