import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface AdminTenantsFilter {
  page?: number;
  limit?: number;
  search?: string;
  plan?: string;
  isActive?: boolean;
}

@Injectable()
export class AdminTenantsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(filter: AdminTenantsFilter) {
    const page = Math.max(1, filter.page ?? 1);
    const limit = Math.min(filter.limit ?? 20, 100);
    const skip = (page - 1) * limit;

    const where: any = {};
    if (filter.search) {
      where.OR = [
        { name: { contains: filter.search, mode: 'insensitive' } },
        { email: { contains: filter.search, mode: 'insensitive' } },
      ];
    }
    if (filter.plan) where.plan = filter.plan;
    if (filter.isActive !== undefined) where.isActive = filter.isActive;

    const [items, total] = await Promise.all([
      this.prisma.tenant.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          email: true,
          plan: true,
          isActive: true,
          createdAt: true,
          updatedAt: true,
          _count: {
            select: { companies: true, apiKeys: true },
          },
        },
      }),
      this.prisma.tenant.count({ where }),
    ]);

    // Attach invoice count per tenant
    const tenantIds = items.map((t) => t.id);
    const invoiceCounts = tenantIds.length
      ? await this.prisma.invoice.groupBy({
          by: ['tenantId'],
          where: { tenantId: { in: tenantIds } },
          _count: { tenantId: true },
        })
      : [];

    const invoiceCountMap = new Map(invoiceCounts.map((r) => [r.tenantId, r._count.tenantId]));

    const enriched = items.map((t) => ({
      ...t,
      _count: { ...t._count, invoices: invoiceCountMap.get(t.id) ?? 0 },
    }));

    return {
      items: enriched,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findOne(id: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id },
      include: {
        companies: {
          include: {
            certificates: {
              select: {
                id: true, isActive: true, validFrom: true, validTo: true,
                fingerprint: true, signerName: true, createdAt: true,
              },
              orderBy: { createdAt: 'desc' },
            },
            sequences: { select: { id: true, ecfType: true, currentNumber: true, endNumber: true, isActive: true } },
          },
          orderBy: { createdAt: 'desc' },
        },
        apiKeys: {
          select: {
            id: true, name: true, keyPrefix: true, scopes: true,
            isLive: true, isActive: true, lastUsedAt: true, createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
        },
        webhooks: {
          select: {
            id: true, url: true, events: true, isActive: true, createdAt: true,
            _count: { select: { deliveries: true } },
          },
        },
      },
    });

    if (!tenant) throw new NotFoundException(`Tenant ${id} no encontrado`);

    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const [invoiceTotal, invoiceThisMonth] = await Promise.all([
      this.prisma.invoice.count({ where: { tenantId: id } }),
      this.prisma.invoice.count({ where: { tenantId: id, createdAt: { gte: startOfMonth } } }),
    ]);

    const { passwordHash, ...tenantSafe } = tenant as any;
    void passwordHash;

    return { ...tenantSafe, metrics: { invoiceTotal, invoiceThisMonth } };
  }
}
