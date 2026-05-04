/**
 * ApiKeyGuard scope enforcement — Tarea 17.2
 *
 * Two layers of coverage:
 *   A) checkScopes() — pure scope logic, no mocks needed.
 *   B) canActivate()  — integration path, bcrypt / Prisma mocked.
 */
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ApiKeyScope } from '@prisma/client';
import { checkScopes, ApiKeyGuard } from './api-key.guard';

jest.mock('bcrypt', () => ({ compare: jest.fn() }));
const bcrypt = require('bcrypt') as { compare: jest.Mock };

const S = ApiKeyScope;

// ── A) checkScopes — pure logic ──────────────────────────────────────────────

describe('checkScopes()', () => {
  it('17.2-1: FULL_ACCESS does NOT grant ADMIN', () => {
    expect(() => checkScopes([S.FULL_ACCESS], [S.ADMIN])).toThrow(ForbiddenException);
  });

  it('17.2-2: ADMIN explicit → passes ADMIN-required endpoint', () => {
    expect(() => checkScopes([S.ADMIN], [S.ADMIN])).not.toThrow();
  });

  it('17.2-3: FULL_ACCESS grants INVOICES_READ', () => {
    expect(() => checkScopes([S.FULL_ACCESS], [S.INVOICES_READ])).not.toThrow();
  });

  it('17.2-4: FULL_ACCESS grants COMPANIES_WRITE', () => {
    expect(() => checkScopes([S.FULL_ACCESS], [S.COMPANIES_WRITE])).not.toThrow();
  });

  it('17.2-5: narrow key missing required scope → ForbiddenException', () => {
    expect(() => checkScopes([S.INVOICES_READ], [S.INVOICES_WRITE])).toThrow(ForbiddenException);
  });

  it('17.2-6: narrow key has exact required scope → passes', () => {
    expect(() => checkScopes([S.INVOICES_WRITE], [S.INVOICES_WRITE])).not.toThrow();
  });

  it('17.2-7: ADMIN + FULL_ACCESS can reach both admin and regular endpoints', () => {
    const scopes = [S.ADMIN, S.FULL_ACCESS];
    expect(() => checkScopes(scopes, [S.ADMIN])).not.toThrow();
    expect(() => checkScopes(scopes, [S.INVOICES_READ])).not.toThrow();
  });

  it('17.2-8: empty requiredScopes → always passes', () => {
    expect(() => checkScopes([], [])).not.toThrow();
    expect(() => checkScopes([S.INVOICES_READ], [])).not.toThrow();
  });
});

// ── B) canActivate — integration (Prisma + bcrypt mocked) ───────────────────

function makeCtx(headers: Record<string, string>, requiredScopes: ApiKeyScope[] = []) {
  const request = { headers, tenant: undefined as any };
  return {
    request,
    ctx: {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as any,
    reflector: {
      getAllAndOverride: jest.fn().mockReturnValue(requiredScopes),
    } as any,
  };
}

function makeGuard(opts: {
  reflector: any;
  jwtPayload?: any;
  tenantRow?: any;
  apiKeyRow?: any;
}) {
  const prisma = {
    tenant: { findUnique: jest.fn().mockResolvedValue(opts.tenantRow ?? null) },
    apiKey: {
      findFirst: jest.fn().mockResolvedValue(opts.apiKeyRow ?? null),
      update: jest.fn().mockResolvedValue({}),
    },
  } as any;
  const authService = {
    verifyJwt: jest.fn().mockReturnValue(
      opts.jwtPayload ?? { sub: 'tid', email: 'x@x.com', name: 'X', type: 'dashboard' },
    ),
  } as any;
  const logger = { warn: jest.fn(), info: jest.fn() } as any;
  return new ApiKeyGuard(prisma, opts.reflector, authService, logger);
}

const JWT = 'hdr.pay.sig'; // 3 parts → detected as JWT
const API_KEY = 'frd_live_abcdefghXXXXXXXX'; // not JWT

const baseKeyRow = (scopes: ApiKeyScope[]) => ({
  id: 'kid',
  tenantId: 'tid',
  keyPrefix: 'frd_live_abcdefgh',
  keyHash: 'hashed',
  scopes,
  expiresAt: null,
  isActive: true,
  tenant: { id: 'tid', plan: 'STARTER', isActive: true },
});

describe('ApiKeyGuard canActivate — JWT path', () => {
  beforeEach(() => jest.clearAllMocks());

  it('17.2-9: JWT + no ADMIN key → ForbiddenException on ADMIN endpoint', async () => {
    const { ctx, reflector } = makeCtx({ authorization: `Bearer ${JWT}` }, [S.ADMIN]);
    const guard = makeGuard({
      reflector,
      tenantRow: { id: 'tid', plan: 'STARTER', isActive: true, apiKeys: [] },
    });
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  it('17.2-10: JWT + ADMIN key → passes ADMIN endpoint', async () => {
    const { ctx, reflector } = makeCtx({ authorization: `Bearer ${JWT}` }, [S.ADMIN]);
    const guard = makeGuard({
      reflector,
      tenantRow: {
        id: 'tid',
        plan: 'STARTER',
        isActive: true,
        apiKeys: [{ scopes: [S.ADMIN, S.FULL_ACCESS] }],
      },
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('17.2-11: JWT baseline (no keys) → can access COMPANIES_READ', async () => {
    const { ctx, reflector } = makeCtx({ authorization: `Bearer ${JWT}` }, [S.COMPANIES_READ]);
    const guard = makeGuard({
      reflector,
      tenantRow: { id: 'tid', plan: 'STARTER', isActive: true, apiKeys: [] },
    });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('17.2-12: inactive tenant JWT → UnauthorizedException', async () => {
    const { ctx, reflector } = makeCtx({ authorization: `Bearer ${JWT}` });
    const guard = makeGuard({
      reflector,
      tenantRow: { id: 'tid', plan: 'STARTER', isActive: false, apiKeys: [] },
    });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });
});

describe('ApiKeyGuard canActivate — API key path', () => {
  beforeEach(() => jest.clearAllMocks());

  it('17.2-13: FULL_ACCESS key → ForbiddenException on ADMIN endpoint', async () => {
    bcrypt.compare.mockResolvedValue(true);
    const { ctx, reflector } = makeCtx({ 'x-api-key': API_KEY }, [S.ADMIN]);
    const guard = makeGuard({ reflector, apiKeyRow: baseKeyRow([S.FULL_ACCESS]) });
    await expect(guard.canActivate(ctx)).rejects.toThrow(ForbiddenException);
  });

  it('17.2-14: ADMIN key → passes ADMIN endpoint', async () => {
    bcrypt.compare.mockResolvedValue(true);
    const { ctx, reflector, request } = makeCtx({ 'x-api-key': API_KEY }, [S.ADMIN]);
    const guard = makeGuard({ reflector, apiKeyRow: baseKeyRow([S.ADMIN]) });
    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(request.tenant.scopes).toContain(S.ADMIN);
  });

  it('17.2-15: wrong bcrypt hash → UnauthorizedException', async () => {
    bcrypt.compare.mockResolvedValue(false);
    const { ctx, reflector } = makeCtx({ 'x-api-key': API_KEY });
    const guard = makeGuard({ reflector, apiKeyRow: baseKeyRow([S.FULL_ACCESS]) });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });
});
