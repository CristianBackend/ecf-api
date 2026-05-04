import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { AdminTenantsService } from './admin-tenants.service';
import { PrismaService } from '../prisma/prisma.service';

const TENANT = {
  id: 'tenant-1', name: 'Acme Corp', email: 'admin@acme.com',
  plan: 'STARTER', isActive: true, createdAt: new Date(), updatedAt: new Date(),
  _count: { companies: 2, apiKeys: 1 },
};

describe('AdminTenantsService', () => {
  let service: AdminTenantsService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      tenant: {
        findMany: jest.fn().mockResolvedValue([TENANT]),
        findUnique: jest.fn().mockResolvedValue({ ...TENANT, companies: [], apiKeys: [], webhooks: [] }),
        count: jest.fn().mockResolvedValue(1),
      },
      invoice: {
        groupBy: jest.fn().mockResolvedValue([{ tenantId: 'tenant-1', _count: { tenantId: 5 } }]),
        count: jest.fn().mockResolvedValue(5),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminTenantsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<AdminTenantsService>(AdminTenantsService);
  });

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
});
