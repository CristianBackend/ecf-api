import { Test, TestingModule } from '@nestjs/testing';
import { AdminInvoicesService } from './admin-invoices.service';
import { PrismaService } from '../prisma/prisma.service';

const INVOICE = {
  id: 'inv-1', tenantId: 't-1', companyId: 'c-1', ecfType: 'E31',
  encf: 'E310000000001', status: 'ACCEPTED', buyerRnc: '131793916',
  buyerName: 'Empresa SRL', totalAmount: 11800, totalItbis: 1800,
  subtotal: 10000, totalDiscount: 0, currency: 'DOP', exchangeRate: null,
  trackId: null, createdAt: new Date(), updatedAt: new Date(),
  company: { businessName: 'Mi Empresa SRL', rnc: '130000001' },
};

describe('AdminInvoicesService', () => {
  let service: AdminInvoicesService;
  let prisma: any;

  beforeEach(async () => {
    prisma = {
      invoice: {
        findMany: jest.fn().mockResolvedValue([INVOICE]),
        count: jest.fn().mockResolvedValue(1),
        aggregate: jest.fn().mockResolvedValue({ _sum: { totalAmount: 11800, totalItbis: 1800 }, _count: { status: 1 } }),
        groupBy: jest.fn().mockResolvedValue([{ status: 'ACCEPTED', _count: { status: 1 } }]),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminInvoicesService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get<AdminInvoicesService>(AdminInvoicesService);
  });

  it('returns paginated items with aggregations', async () => {
    const result = await service.findAll({});
    expect(result.items).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.aggregations.totalAmount).toBe(11800);
    expect(result.aggregations.countByStatus).toEqual({ ACCEPTED: 1 });
  });

  it('applies tenantId filter', async () => {
    await service.findAll({ tenantId: 't-1' });
    expect(prisma.invoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: 't-1' }) }),
    );
  });

  it('applies status filter', async () => {
    await service.findAll({ status: 'ACCEPTED' });
    expect(prisma.invoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: 'ACCEPTED' }) }),
    );
  });

  it('applies encf prefix filter', async () => {
    await service.findAll({ encf: 'E31' });
    expect(prisma.invoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ encf: { startsWith: 'E31' } }) }),
    );
  });

  it('applies date range filter', async () => {
    await service.findAll({ dateFrom: '2026-01-01', dateTo: '2026-12-31' });
    const call = prisma.invoice.findMany.mock.calls[0][0];
    expect(call.where.createdAt.gte).toBeInstanceOf(Date);
    expect(call.where.createdAt.lte).toBeInstanceOf(Date);
  });

  it('applies amount range filter', async () => {
    await service.findAll({ amountMin: 1000, amountMax: 50000 });
    const call = prisma.invoice.findMany.mock.calls[0][0];
    expect(call.where.totalAmount).toEqual({ gte: 1000, lte: 50000 });
  });

  it('defaults to sortBy=createdAt desc', async () => {
    await service.findAll({});
    expect(prisma.invoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: 'desc' } }),
    );
  });

  it('respects custom sortBy', async () => {
    await service.findAll({ sortBy: 'totalAmount', sortOrder: 'asc' });
    expect(prisma.invoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { totalAmount: 'asc' } }),
    );
  });
});
