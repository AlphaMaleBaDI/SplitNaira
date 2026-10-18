# Client Rate-Limiting Guidance

The backend applies a named rate-limit **policy** to each route group. The
limits are declared once in `backend/src/middleware/rate-limit.ts`
(`RATE_LIMIT_POLICIES`) so the behaviour is the same everywhere, is documented
here, and can be changed per environment without a code deploy.

## Per-route policies

| Policy   | Applies to                                                                 | Default window | Default limit | Override env vars                              |
| :------- | :------------------------------------------------------------------------- | :------------- | :------------ | :--------------------------------------------- |
| `global` | Every request (volumetric safety net; health checks skipped)               | 15 min         | 500           | `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_GLOBAL_MAX` |
| `auth`   | `/users/register`, `/users/login`, `/auth/*`                               | 5 min          | 10            | `RATE_LIMIT_AUTH_WINDOW_MS`, `RATE_LIMIT_AUTH_MAX` |
| `admin`  | `/splits/admin/*` (payments admin)                                         | 15 min         | 20            | `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_ADMIN_MAX`  |
| `read`   | `GET /splits`, `GET /users`, `GET /transactions`, `/notifications`, `/api/ledger` | 15 min  | 100           | `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX`        |
| `write`  | Non-GET requests to `/splits` and `/users`                                 | 15 min         | 30            | `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_WRITE_MAX`  |
| `sse`    | `/events` (Server-Sent Events connection rate)                             | 15 min         | 20            | `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_SSE_MAX`    |

Invalid or non-positive override values are ignored and the default is used —
a misconfigured environment variable can never disable rate limiting.

The effective configuration is available at runtime through
`listRateLimitPolicies()`, which the contract tests assert against.

## HTTP headers

Every response from a rate-limited route includes the standard headers set by
`express-rate-limit`:

| Header Name           | Type           | Description                                                        |
| :-------------------- | :------------- | :----------------------------------------------------------------- |
| `RateLimit-Policy`    | String         | The applied policy, e.g. `100;w=900` (limit and window seconds).   |
| `RateLimit-Limit`     | Integer        | Total request capacity in the current window.                      |
| `RateLimit-Remaining` | Integer        | Remaining requests in the current window.                          |
| `RateLimit-Reset`     | Integer        | Seconds until the current window resets.                           |
| `Retry-After`         | Integer        | Seconds to wait before retrying (sent on `429`).                   |

## Handling `429 Too Many Requests`

When a client exceeds the permitted quota the API responds with HTTP `429` and
the same machine-readable envelope used by every other error
(see `backend/src/middleware/rate-limit.ts`):

```json
{
  "error": "rate_limited",
  "code": "RATE_LIMITED",
  "message": "Too many requests. Please try again later.",
  "retryAfter": 42,
  "requestId": "b6f1a2d4-8c3e-4a1b-9f2e-6d5c7a8b9c0d"
}
```

Clients should branch on `code` (`RATE_LIMITED`) and back off for `Retry-After`
seconds rather than parsing `message`. The frontend `ApiClient` already retries
`429` responses with backoff.
