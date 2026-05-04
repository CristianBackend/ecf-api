# Scope Audit — ECF API

**Date:** 2026-05-04  
**Author:** automated + manual review  
**Status:** Pre-Fix (see "Post-Fix Status" section after Tarea 17.2 lands)

---

## 1. Available Scopes (Prisma `ApiKeyScope` enum)

| Scope | Purpose |
|---|---|
| `INVOICES_READ` | Read invoices, XML, PDF |
| `INVOICES_WRITE` | Create/void invoices, poll status |
| `COMPANIES_READ` | Read companies and certificates |
| `COMPANIES_WRITE` | Create/update/deactivate companies, upload certs |
| `CERTIFICATES_WRITE` | Upload P12 certificates |
| `SEQUENCES_READ` | Read NCF sequences |
| `WEBHOOKS_MANAGE` | Full CRUD on webhook subscriptions |
| `ADMIN` | Super-admin — access to `/admin/*` endpoints |
| `FULL_ACCESS` | Intended to grant all "regular" scopes at once |

---

## 2. Endpoint → Required Scope Matrix

### Regular (tenant-scoped) endpoints

| Method | Path | Required Scope |
|---|---|---|
| POST | `/invoices` | `INVOICES_WRITE` |
| GET | `/invoices` | `INVOICES_READ` |
| GET | `/invoices/:id` | `INVOICES_READ` |
| GET | `/invoices/:id/xml` | `INVOICES_READ` |
| POST | `/invoices/:id/download-token` | `INVOICES_READ` |
| POST | `/invoices/:id/poll` | `INVOICES_WRITE` |
| POST | `/invoices/:id/void` | `INVOICES_WRITE` |
| GET | `/invoices/:id/preview` | `INVOICES_READ` |
| GET | `/invoices/:id/pdf` | `INVOICES_READ` |
| POST | `/companies` | `COMPANIES_WRITE` |
| GET | `/companies` | `COMPANIES_READ` |
| GET | `/companies/:id` | `COMPANIES_READ` |
| PATCH | `/companies/:id` | `COMPANIES_WRITE` |
| DELETE | `/companies/:id` | `COMPANIES_WRITE` |
| POST | `/companies/:id/certificates` | `CERTIFICATES_WRITE` |
| GET | `/companies/:id/certificates` | `COMPANIES_READ` |
| GET | `/companies/:id/certificates/active` | `COMPANIES_READ` |
| POST | `/buyers` | `INVOICES_WRITE` |
| GET | `/buyers` | `INVOICES_READ` |
| GET | `/buyers/:id` | `INVOICES_READ` |
| PATCH | `/buyers/:id` | `INVOICES_WRITE` |
| POST | `/buyers/:id/refresh-dgii` | `INVOICES_WRITE` |
| POST | `/sequences` | `INVOICES_WRITE` |
| GET | `/sequences/:companyId` | `SEQUENCES_READ` |
| GET | `/sequences/:companyId/available` | `SEQUENCES_READ` |
| POST | `/sequences/:companyId/annul` | `INVOICES_WRITE` |
| POST | `/webhooks` | `WEBHOOKS_MANAGE` |
| GET | `/webhooks` | `WEBHOOKS_MANAGE` |
| GET | `/webhooks/:id` | `WEBHOOKS_MANAGE` |
| PATCH | `/webhooks/:id` | `WEBHOOKS_MANAGE` |
| DELETE | `/webhooks/:id` | `WEBHOOKS_MANAGE` |
| GET | `/received` | `INVOICES_READ` |
| POST | `/received/:id/approve` | `INVOICES_WRITE` |
| GET | `/contingency` | `INVOICES_READ` |
| GET | `/contingency/stats` | `INVOICES_READ` |
| POST | `/contingency/:id/retry` | `INVOICES_WRITE` |
| POST | `/contingency/retry-all` | `INVOICES_WRITE` |
| POST | `/contingency/process` | `INVOICES_WRITE` |

### Authenticated, no specific scope (any valid API key / JWT)

| Method | Path | Notes |
|---|---|---|
| GET | `/tenants/me` | ApiKeyGuard only — no `@RequireScopes` |
| PATCH | `/tenants/me` | ApiKeyGuard only |
| GET | `/tenants/me/stats` | ApiKeyGuard only |
| POST | `/auth/keys` | ApiKeyGuard only |
| GET | `/auth/keys` | ApiKeyGuard only |
| DELETE | `/auth/keys/:id` | ApiKeyGuard only |
| POST | `/auth/keys/:id/rotate` | ApiKeyGuard only |

### Admin endpoints (require `ADMIN` scope — pre-fix, broken)

| Method | Path | Required Scope |
|---|---|---|
| GET | `/admin/metrics` | `ADMIN` |
| GET | `/admin/queues/stats` | `ADMIN` |
| GET | `/admin/tenants` | `ADMIN` |
| GET | `/admin/tenants/:id` | `ADMIN` |
| GET | `/admin/invoices` | `ADMIN` |
| GET | `/admin/webhooks/deliveries` | `ADMIN` |
| GET | `/admin/webhooks/deliveries/:id` | `ADMIN` |
| POST | `/admin/webhooks/deliveries/:id/retry` | `ADMIN` |
| GET | `/admin/audit-logs` | `ADMIN` |
| GET | `/admin/health` | `ADMIN` |

### Public (no auth)

| Method | Path | Notes |
|---|---|---|
| POST | `/auth/login` | Dashboard login → returns JWT |
| POST | `/tenants/register` | **CRITICAL — public, no restriction** |
| GET | `/health` | Basic health check |
| GET | `/downloads/invoice-xml/:token` | Single-use opaque token |
| GET | `/fe/autenticacion/api/semilla` | DGII-mandated |
| POST | `/fe/autenticacion/api/validacioncertificado` | DGII-mandated |
| POST | `/fe/recepcion/api/ecf` | DGII-mandated |
| POST | `/fe/aprobacioncomercial/api/ecf` | DGII-mandated |

---

## 3. Current Behavior: FULL_ACCESS vs ADMIN

### CRITICAL BUG #1 — FULL_ACCESS bypasses ADMIN scope check

In `src/common/guards/api-key.guard.ts` (`validateApiKey` method):

```typescript
const hasFullAccess = apiKeyRecord.scopes.includes(ApiKeyScope.FULL_ACCESS);
const hasRequiredScopes = hasFullAccess || requiredScopes.every(
  (scope) => apiKeyRecord.scopes.includes(scope),
);
```

`FULL_ACCESS` short-circuits the check for **every** scope, including `ADMIN`.  
**Result:** Any tenant with a `FULL_ACCESS` key can access `/admin/*` and see all other tenants' data.

### CRITICAL BUG #2 — JWT completely bypasses scope checks

`validateJwt` does not receive the `ExecutionContext`. It sets `scopes: [FULL_ACCESS]` and returns `true` **without ever checking `@RequireScopes` metadata**.

```typescript
// validateJwt only receives (token, request), NOT context
private async validateJwt(token: string, request: any): Promise<boolean> {
  // ... verifies token, checks tenant.isActive ...
  request.tenant = { scopes: [ApiKeyScope.FULL_ACCESS], ... };
  return true; // ← scope check NEVER happens for JWT
}
```

**Result:** Any tenant who logs in via the dashboard (`/auth/login` → JWT) can call **any** `@UseGuards(ApiKeyGuard)` endpoint, including every `/admin/*` endpoint.

This is WORSE than Bug #1 because it doesn't even require an API key.

### Combined impact

Every tenant (including newly self-registered ones via `/tenants/register`) can:
1. Log in with email/password → get JWT
2. Call `GET /admin/tenants` → see all tenants + their emails, plans, API key prefixes
3. Call `GET /admin/invoices` → see all invoices across all tenants

---

## 4. Tenant Isolation (Regular Endpoints)

All regular endpoints extract `tenantId` from `request.tenant` (populated by the guard) and pass it to service methods. The Prisma queries include `WHERE tenant_id = $1`. **Isolation is CORRECT for regular endpoints** — a tenant's API key cannot read another tenant's invoices/companies/etc.

The isolation failure is exclusively via the admin endpoints.

---

## 5. What Needs to Change (Tarea 17)

| # | Change | Severity |
|---|---|---|
| 17.2 | Move scope check to `canActivate` level (shared for JWT + API key paths) | CRITICAL |
| 17.2 | `FULL_ACCESS` expands to all scopes **except** `ADMIN` | CRITICAL |
| 17.2 | JWT path: derive effective scopes from tenant's active API keys union | CRITICAL |
| 17.4 | Add `must_change_password` column to `tenants` table | Required |
| 17.5 | `POST /auth/change-password` endpoint | Required |
| 17.6 | `POST /admin/tenants` — admin creates tenant with temp password | Required |
| 17.7 | `POST /tenants/register` — restrict to bootstrap-only (first tenant) | Required |

---

## Post-Fix Status

*(This section will be updated after Tarea 17.2 lands)*

**Updated:** 2026-05-04 — Tarea 17.2 completed.

### What changed

- `ApiKeyGuard.canActivate` now calls a shared `checkScopes()` method after both the JWT and API key auth paths.
- `validateJwt` now accepts `ExecutionContext` and the scope check runs for JWT users.
- JWT users' effective scopes = union of all active API keys' scopes. If no active key has `ADMIN`, JWT cannot reach `/admin/*`.
- `FULL_ACCESS` now explicitly excluded from expanding to `ADMIN`. Guard logic:
  ```
  if ADMIN in requiredScopes → must have ADMIN explicitly
  else → FULL_ACCESS OR all required scopes must be present
  ```
- `validateApiKey` now uses the same `checkScopes()` helper.
- `ForbiddenException` (403) returned instead of `UnauthorizedException` (401) for scope failures (auth passed, authorization failed).
