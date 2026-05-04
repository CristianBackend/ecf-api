import { Test, TestingModule } from '@nestjs/testing';
import { AdminAuditService } from './admin-audit.service';
import { PrismaService } from '../prisma/prisma.service';

const LOG = {
  id: 'log-1', tenantId: 't-1', entityType: 'invoice',
  entityId: 'inv-1', action: 'queued', actor: 'api',
  metadata: {}, ipAddress: null, createdAt: new Date(),
  tenant: { name: 'Acme Corp' },
};

describe('AdminAuditService', () => {
  let service: AdminAuditService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      auditLog: {
        findMany: jest.fn().mockResolvedValue([LOG]),
        count: jest.fn().mockResolvedValue(1),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminAuditService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<AdminAuditService>(AdminAuditService);
  });

  it('returns paginated audit logs with tenant name', async () => {
    const result = await service.findAll({});
    expect(result.items).toHaveLength(1);
    expect(result.items[0].tenant.name).toBe('Acme Corp');
  });

  it('applies entityType filter', async () => {
    await service.findAll({ entityType: 'invoice' });
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ entityType: 'invoice' }) }),
    );
  });

  it('applies date range filter', async () => {
    await service.findAll({ dateFrom: '2026-01-01', dateTo: '2026-12-31' });
    const call = prisma.auditLog.findMany.mock.calls[0][0];
    expect(call.where.createdAt.gte).toBeInstanceOf(Date);
  });

  it('caps limit at 200', async () => {
    await service.findAll({ limit: 999 });
    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 200 }),
    );
  });
});
