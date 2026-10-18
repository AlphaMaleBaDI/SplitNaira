# Login lockout and recovery

`POST /users/login` has an account-level guardrail in addition to the existing
global and per-IP limits. No existing limiter, JWT validation, or soft-delete
filter is removed.

## Policy

| Setting                  | Value                                                         |
| ------------------------ | ------------------------------------------------------------- |
| Failed-attempt threshold | 5 per wallet                                                  |
| Observation window       | 15 minutes from the first attempt in the window               |
| Lock duration            | 15 minutes from the fifth failure                             |
| Recovery                 | Automatic at expiry; a successful login clears prior failures |

Unknown, inactive, and soft-deleted wallets count as failures. Unknown wallets
are tracked too, so reaching a lock does not establish that an account exists.
All these failures, and attempts during lockout, return the same HTTP 401 body:

```json
{
  "error": "unauthorized",
  "code": "UNAUTHORIZED",
  "message": "Unable to sign in. Check your details or try again later.",
  "details": {}
}
```

The normal request ID is also included by the central error handler.
No wallet, remaining-attempt count, account status, or lock expiry is returned.
Login's former unknown-wallet 404 response is intentionally replaced by 401;
clients must not use login failures to decide whether an account exists.
Other profile routes retain their existing behavior.

Attempts during a lock neither query the user repository nor extend the lock.
Pending attempts reserve threshold slots before database I/O, so concurrent
requests cannot start unlimited checks before earlier failures finish.
Malformed wallet input still receives validation errors and is subject to the
existing IP limiter. Database and token-signing errors remain server errors;
they do not increase or clear prior failed-attempt counts.

The IP limiter can independently return 429 with its existing retry headers.
This response reflects traffic from an IP, not whether a wallet exists.

## Recovery and operations

Wait 15 minutes after the last accepted failed attempt, then retry. Blocked
requests do not postpone recovery. The account must still be active and not
deleted after expiry; a timeout never reactivates an account. Successful login
before the threshold resets the failure window.

There is no unauthenticated unlock endpoint. The existing email reset flow does
not clear lockouts: it does not currently prove ownership of a Stellar wallet.
Do not treat a reset request, registration request, or client-provided address
as authorization to unlock an account.

The store is bounded to 10,000 wallet hashes per process. Expired idle entries
are reclaimed when capacity is needed; active locks are never evicted to make
space. At capacity, new identities receive the same generic denial without a
database query. Successful attempts and operational failures with no prior
failures release their entries. Investigate sustained denial rates alongside
IP-limit activity and infrastructure errors; avoid logging raw wallet inputs
or tokens when doing so.

## Deployment scope and authentication limitations

Like the current IP limiter, this store is in memory. Restarts clear its state,
and replicas do not share counters. Do not rely on it as a durable or global
lockout policy. A multi-instance deployment requires an atomic shared store
and equivalent concurrency/expiry tests before claiming that guarantee.

The current login API accepts a public wallet address without a server-verified
signature challenge. This change limits failed lookups and denies inactive
accounts; it does **not** add proof of wallet ownership or make the existing
login protocol suitable as strong authentication. Successful lookups and other
existing profile/registration endpoints still reveal account existence. A
verified challenge flow is a separate prerequisite for end-to-end login
security; generic failure responses cannot fix that protocol limitation.

The policy separates threshold, observation window, and lock duration and uses
uniform failure responses, following the considerations in the
[OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html#account-lockout).
The numeric thresholds above are project choices, not OWASP-mandated values.

## Validation

Run `npm test -w backend -- src/services/login-attempts.test.ts src/__tests__/login-lockout.test.ts`.
Tests cover success, threshold and expiry boundaries, independent wallets,
generic failures, inactive users, concurrent requests, storage capacity, and
operational errors. Existing user and onboarding tests verify the updated 401
contract and unchanged successful response shape.
