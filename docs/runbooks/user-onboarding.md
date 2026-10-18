# User Onboarding Runbook

> **Scope:** CI/CD pipeline and operational guidance for the user onboarding
> workstream — wallet registration, login, and profile lookup.
> Covers pipeline design, deploy safety, and rollback procedures.

---

## Overview

User onboarding in SplitNaira is wallet-first: a Stellar public key is the
primary identity. The backend exposes three endpoints:

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/users/register` | Create a new user account linked to a wallet |
| `POST` | `/users/login` | Authenticate an existing user by wallet address |
| `GET` | `/users/:walletAddress` | Retrieve a user profile |

All three are covered by the `user-onboarding-ci.yml` workflow.

---

## CI/CD Pipeline — `user-onboarding-ci.yml`

The workflow runs on every push or PR that touches onboarding-related files:

```
backend-onboarding   ─── lint + build + migration + unit tests (with Postgres)
frontend-onboarding  ─── lint + build + frontend tests
schema-contract      ─── user schema stability assertion + unit tests
```

### Trigger Paths

The workflow is path-filtered to avoid unnecessary runs. It triggers when any
of the following files change:

- `backend/src/routes/users.ts`
- `backend/src/schemas/user.schemas.ts`
- `backend/src/entities/User.ts`
- `backend/src/services/auth.ts`
- `backend/src/migrations/**`
- `frontend/src/hooks/useWallet.ts`
- `frontend/src/lib/wallet.ts`
- `frontend/src/components/wallet-provider.tsx`

### Manual Trigger

```bash
# Via GitHub CLI
gh workflow run user-onboarding-ci.yml
```

---

## Deploy Safety

### Pre-deploy Checklist

- [ ] `user-onboarding-ci.yml` is green on the target branch.
- [ ] Database migrations applied: `npm run migration:run -w backend`
- [ ] `GET /users/:walletAddress` returns 200 for a known test wallet on staging.
- [ ] `POST /users/register` returns 201 for a fresh wallet on staging.
- [ ] `POST /users/login` returns 200 for the registered wallet on staging.

### Schema Compatibility

The `userRegistrationSchema` (Zod) is the source of truth for the registration
payload. Any change to required fields is a **breaking change** and must be
coordinated with the frontend.

Current required fields:

```typescript
{ walletAddress: string }   // G[A-Z2-7]{55}
```

Optional fields:

```typescript
{ email?: string, alias?: string }
```

---

## Rollback

### Fast Rollback (< 5 minutes)

If a deploy breaks the onboarding flow:

1. Revert the backend deploy in Render (Services → splitnaira-backend → Deploys → Rollback).
2. Verify:
   ```bash
   curl -X POST https://api.splitnaira.com/users/login \
     -H "Content-Type: application/json" \
     -d '{"walletAddress":"<KNOWN_WALLET>"}'
   # Expect: 200 OK
   ```

### Database Migration Rollback

If a migration to the `users` table caused the failure:

```bash
npm run migration:revert -w backend
```

Then redeploy the previous backend version.

### Operational Impact

| Step | Downtime | Data Risk |
|------|----------|-----------|
| Backend redeploy | Brief restart (~30s) | None |
| `users` table migration | None (online) | Low — test on staging first |
| Rollback migration | None | Low — `down` script must be safe |

---

## Monitoring

- **Registration errors:** Filter backend logs for `level: "error"` and `route: "/users/register"`.
- **Login 401 rate:** Unknown, inactive, deleted, and temporarily locked wallets share a generic 401 response. See [lockout and recovery](../auth-lockout-policy.md) before investigating; do not infer account existence from a failure.
- **Sentry:** Monitor the `production` environment for `AppError` events tagged with `section: "users"`.

---

## Related

- [Backend Deploy Runbook](../backend-deploy.md)
- [Ops Deployment & Rollback](./ops-deployment-rollback.md)
- [Mainnet Launch Runbook](./mainnet-launch.md)
