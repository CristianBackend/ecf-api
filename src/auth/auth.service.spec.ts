/**
 * AuthService.getMe — Tarea 17.3
 */
import { UnauthorizedException } from '@nestjs/common';
import { ApiKeyScope } from '@prisma/client';
import { AuthService } from './auth.service';

const S = ApiKeyScope;

function makeService(tenantRow: any) {
  const prisma = {
    tenant: { findUnique: jest.fn().mockResolvedValue(tenantRow) },
  } as any;
  const config = { get: jest.fn((k: string, d: any) => d) } as any;
  const logger = { info: jest.fn(), warn: jest.fn() } as any;
  // JWT_SECRET is required by constructor
  config.get = jest.fn((k: string) => (k === 'JWT_SECRET' ? 'test-secret' : undefined));
  return new AuthService(prisma, config, logger);
}

describe('AuthService.getMe()', () => {
  it('17.3-1: no ADMIN key → isSuperAdmin false', async () => {
    const svc = makeService({
      id: 'tid', name: 'T', email: 'e@x.com', plan: 'STARTER', isActive: true,
      apiKeys: [{ scopes: [S.FULL_ACCESS] }],
    });
    const result = await svc.getMe('tid');
    expect(result.isSuperAdmin).toBe(false);
    expect(result.scopes).toContain(S.FULL_ACCESS);
    expect(result.scopes).not.toContain(S.ADMIN);
  });

  it('17.3-2: ADMIN key → isSuperAdmin true', async () => {
    const svc = makeService({
      id: 'tid', name: 'T', email: 'e@x.com', plan: 'STARTER', isActive: true,
      apiKeys: [{ scopes: [S.ADMIN, S.FULL_ACCESS] }],
    });
    const result = await svc.getMe('tid');
    expect(result.isSuperAdmin).toBe(true);
    expect(result.scopes).toContain(S.ADMIN);
  });

  it('17.3-3: multiple keys → scope union returned', async () => {
    const svc = makeService({
      id: 'tid', name: 'T', email: 'e@x.com', plan: 'STARTER', isActive: true,
      apiKeys: [
        { scopes: [S.INVOICES_READ, S.INVOICES_WRITE] },
        { scopes: [S.COMPANIES_READ] },
      ],
    });
    const result = await svc.getMe('tid');
    expect(result.scopes).toContain(S.INVOICES_READ);
    expect(result.scopes).toContain(S.INVOICES_WRITE);
    expect(result.scopes).toContain(S.COMPANIES_READ);
  });

  it('17.3-4: no active keys → scopes empty, isSuperAdmin false', async () => {
    const svc = makeService({
      id: 'tid', name: 'T', email: 'e@x.com', plan: 'STARTER', isActive: true,
      apiKeys: [],
    });
    const result = await svc.getMe('tid');
    expect(result.scopes).toHaveLength(0);
    expect(result.isSuperAdmin).toBe(false);
  });

  it('17.3-5: tenant not found → UnauthorizedException', async () => {
    const svc = makeService(null);
    await expect(svc.getMe('tid')).rejects.toThrow(UnauthorizedException);
  });

  it('17.3-6: mustChangePassword defaults to false (pre-17.4)', async () => {
    const svc = makeService({
      id: 'tid', name: 'T', email: 'e@x.com', plan: 'STARTER', isActive: true,
      apiKeys: [],
    });
    const result = await svc.getMe('tid');
    expect(result.mustChangePassword).toBe(false);
  });
});
