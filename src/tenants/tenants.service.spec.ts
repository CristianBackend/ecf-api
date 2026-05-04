/**
 * TenantsService.create — Tarea 17.7 bootstrap guard
 */
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { TenantsService } from './tenants.service';

jest.mock('bcrypt', () => ({ hash: jest.fn().mockResolvedValue('hashed') }));

function makeService(tenantCount: number, existingEmail = false) {
  const prisma = {
    tenant: {
      count: jest.fn().mockResolvedValue(tenantCount),
      findUnique: jest.fn().mockResolvedValue(existingEmail ? { id: 'x' } : null),
      create: jest.fn().mockResolvedValue({
        id: 'new-id', name: 'T', email: 'e@x.com', plan: 'STARTER',
        isActive: true, createdAt: new Date(),
      }),
    },
  } as any;

  const authService = {
    generateApiKey: jest.fn().mockResolvedValue({
      key: 'frd_test_xxx', keyPrefix: 'frd_test_xxxx', scopes: [], isLive: false,
    }),
  } as any;

  const logger = { info: jest.fn() } as any;
  return new TenantsService(prisma, authService, logger);
}

const dto = { name: 'T', email: 'e@x.com', password: 'Pass123!', plan: undefined };

describe('TenantsService.create() — 17.7 bootstrap guard', () => {
  it('17.7-1: zero tenants → creates first tenant OK', async () => {
    const svc = makeService(0);
    const result = await svc.create(dto);
    expect(result.tenant.id).toBe('new-id');
    expect(result.apiKeys.test).toBeDefined();
    expect(result.apiKeys.live).toBeDefined();
  });

  it('17.7-2: one tenant exists → ForbiddenException', async () => {
    const svc = makeService(1);
    await expect(svc.create(dto)).rejects.toThrow(ForbiddenException);
  });

  it('17.7-3: many tenants → ForbiddenException', async () => {
    const svc = makeService(50);
    await expect(svc.create(dto)).rejects.toThrow(ForbiddenException);
  });

  it('17.7-4: forbidden message is descriptive', async () => {
    const svc = makeService(2);
    try {
      await svc.create(dto);
      fail('should have thrown');
    } catch (e: any) {
      expect(e.message).toContain('Public registration is disabled');
    }
  });

  it('17.7-5: zero tenants but email duplicate → ConflictException (not Forbidden)', async () => {
    const svc = makeService(0, true); // email already taken
    await expect(svc.create(dto)).rejects.toThrow(ConflictException);
  });
});
