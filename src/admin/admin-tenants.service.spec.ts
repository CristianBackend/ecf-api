import { Test, TestingModule } from '@nestjs/testing';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { getLoggerToken } from 'nestjs-pino';
import { ApiKeyScope } from '@prisma/client';
import { AdminTenantsService } from './admin-tenants.service';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';

jest.mock('bcrypt', () => ({ hash: jest.fn().mockResolvedValue('hashed'), compare: jest.fn() }));

const TENANT = {
  id: 'tenant-1', name: 'Acme Corp', email: 'admin@acme.com',
  plan: 'STARTER', isActive: true, mustChangePassword: false,
  createdAt: new Date(), updatedAt: new Date(),
  _count: { companies: 2, apiKeys: 1 },
};

const MOCK_LOGGER = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

describe('AdminTenantsService', () => {
  let service: AdminTenantsService;
  let prisma: any;
  let authService: any;

  beforeEach(async () => {
    prisma = {
      tenant: {
        findMany: jest.fn().mockResolvedValue([TENANT]),
        findUnique: jest.fn().mockResolvedValue({ ...TENANT, companies: [], apiKeys: [], webhooks: [] }),
        count: jest.fn().mockResolvedValue(1),
        create: jest.fn().mockImplementation(({ data }: { data: any }) =>
          Promise.resolve({
            id: 'new-id', name: data.name, email: data.email,
            plan: data.plan ?? 'STARTER', isActive: true,
            mustChangePassword: data.mustChangePassword ?? false,
            createdAt: new Date(),
          }),
        ),
      },
      invoice: {
        groupBy: jest.fn().mockResolvedValue([{ tenantId: 'tenant-1', _count: { tenantId: 5 } }]),
        count: jest.fn().mockResolvedValue(5),
      },
    };

    authService = {
      generateApiKey: jest.fn().mockImplementation(async (_tid, name, isLive, scopes) => ({
        id: 'kid', name, key: `frd_${isLive ? 'live' : 'test'}_xxx`, keyPrefix: 'frd_test_xxxx',
        scopes, isLive, createdAt: new Date(),
      })),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminTenantsService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuthService, useValue: authService },
        { provide: getLoggerToken(AdminTenantsService.name), useValue: MOCK_LOGGER },
      ],
    }).compile();

    service = module.get<AdminTenantsService>(AdminTenantsService);
  });

  // ── existing tests ──────────────────────────────────────────────────────────

  it('findAll returns paginated list with invoice counts', async () => {
    const result = await service.findAll({ page: 1, limit: 20 });
    expect(result.items).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.items[0]._count.invoices).toBe(5);
  });

  it('findAll applies search filter', async () => {
    await service.findAll({ search: 'Acme' });
    expect(prisma.tenant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ OR: expect.any(Array) }),
      }),
    );
  });

  it('findAll applies plan filter', async () => {
    await service.findAll({ plan: 'STARTER' });
    expect(prisma.tenant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ plan: 'STARTER' }) }),
    );
  });

  it('findOne returns tenant with metrics', async () => {
    const result = await service.findOne('tenant-1') as any;
    expect(result.metrics.invoiceTotal).toBe(5);
    expect(result.passwordHash).toBeUndefined();
  });

  it('findOne throws NotFoundException when not found', async () => {
    prisma.tenant.findUnique.mockResolvedValue(null);
    await expect(service.findOne('missing')).rejects.toThrow(NotFoundException);
  });

  it('findAll paginates correctly', async () => {
    const result = await service.findAll({ page: 2, limit: 10 });
    expect(result.page).toBe(2);
    expect(result.limit).toBe(10);
  });

  // ── 17.6 — createTenant ────────────────────────────────────────────────────

  it('17.6-1: creates tenant → 201 with credentials + two API keys', async () => {
    prisma.tenant.findUnique.mockResolvedValueOnce(null); // email not taken
    const result = await service.createTenant({ name: 'New Co', email: 'new@co.com', plan: 'STARTER' as any });

    expect(result.tenant.mustChangePassword).toBe(true);
    expect(result.credentials.email).toBe('new@co.com');
    expect(typeof result.credentials.temporaryPassword).toBe('string');
    expect(result.credentials.temporaryPassword.length).toBe(12);
    expect(result.apiKeys.test).toBeDefined();
    expect(result.apiKeys.live).toBeDefined();
  });

  it('17.6-2: temporary password contains only unambiguous chars', async () => {
    // Always return null (email not taken) for all 10 iterations
    prisma.tenant.findUnique.mockResolvedValue(null);
    for (let i = 0; i < 10; i++) {
      const result = await service.createTenant({ name: 'Co', email: `co${i}@x.com`, plan: 'STARTER' as any });
      expect(result.credentials.temporaryPassword).not.toMatch(/[0OlI1]/);
    }
    // Restore default for subsequent tests
    prisma.tenant.findUnique.mockResolvedValue({ ...TENANT, companies: [], apiKeys: [], webhooks: [] });
  });

  it('17.6-3: API keys do NOT include ADMIN scope', async () => {
    prisma.tenant.findUnique.mockResolvedValueOnce(null);
    const result = await service.createTenant({ name: 'Co', email: 'co@x.com', plan: 'STARTER' as any });
    const allScopes = [...result.apiKeys.test.scopes, ...result.apiKeys.live.scopes];
    expect(allScopes).not.toContain(ApiKeyScope.ADMIN);
    expect(allScopes).toContain(ApiKeyScope.FULL_ACCESS);
  });

  it('17.6-4: email duplicate → ConflictException', async () => {
    prisma.tenant.findUnique.mockResolvedValueOnce({ id: 'existing' }); // email taken
    await expect(
      service.createTenant({ name: 'Co', email: 'dup@x.com', plan: 'STARTER' as any }),
    ).rejects.toThrow(ConflictException);
  });
});
