### 🔄 API Casing & Field Deprecation Guidelines

To prevent breaking mobile or legacy web clients during backend refactoring, follow these contract guarantees regarding payload casing:

1. **Dual-Casing Backward Compatibility**:
   * All API response payloads for `splits`/`projects` must support dual casing mapping (`camelCase` preferred, `snake_case` fallback).
   * Key field aliases (e.g., `target_amount` and `targetAmount`) must remain supported in shared contract mappers until a major version deprecation cycle.
2. **Contract Testing Requirement**:
   * Any change to split response serialisation must pass `src/contracts/__tests__/split-response-casing.contract.spec.ts`.
   * Endpoint tests for `GET /v1/splits`, `GET /v1/splits/:id`, `POST /v1/splits`, and `PATCH /v1/splits/:id` must validate both casing contract fixtures.

---

### 🛡️ API Surface Contracts (backend)

Cross-cutting guarantees enforced by tests. Full detail in
[API Surface Contracts](../api-surface-contracts.md).

1. **Unknown-route (404) contract** — the catch-all returns a static,
   machine-readable body (`error: "not_found"`, `code: "NOT_FOUND"`) and never
   echoes the request method/path or leaks a stack trace. Changing it requires
   updating `backend/src/__tests__/api-contract.test.ts` and
   `backend/src/middleware/__tests__/unknown-route-contract.test.ts`.
2. **Deprecation / Sunset headers** — endpoints scheduled for removal advertise
   `Deprecation`, `Sunset` and `Link: <...>; rel="deprecation"`. Declarations
   live in `API_DEPRECATIONS` (`backend/src/middleware/deprecation.ts`); the
   registry is validated at boot.
3. **Per-route rate-limit policies** — auth, read, write, admin and SSE have
   distinct, env-configurable budgets (`RATE_LIMIT_POLICIES`). See
   [Rate-limiting guidance](../rate-limiting-guidance.md).
4. **API contract tests** — `backend/src/__tests__/api-contract.test.ts` runs
   the real app against the generated OpenAPI document and fails on
   undocumented runtime response fields or lost contracts.
