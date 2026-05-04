import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface AdminInvoicesFilter {
  page?: number;
  limit?: number;
  tenantId?: string;
  companyId?: string;
  status?: string;
  ecfType?: string;
  buyerRnc?: string;
  encf?: string;
  trackId?: string;
  dateFrom?: string;
  dateTo?: string;
  amountMin?: number;
  amountMax?: number;
  sortBy?: 'createdAt' | 'totalAmount' | 'encf';
  sortOrder?: 'asc' | 'desc';
}

@Injectable()
export class AdminInvoicesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(filter: AdminInvoicesFilter) {
    const page = Math.max(1, filter.page ?? 1);
    const limit = Math.min(filter.limit ?? 20, 100);
    const skip = (page - 1) * limit;
    const sortBy = filter.sortBy ?? 'createdAt';
    const sortOrder = filter.sortOrder ?? 'desc';

    const where: any = {};
    if (filter.tenantId)  where.tenantId  = filter.tenantId;
    if (filter.companyId) where.companyId = filter.companyId;
    if (filter.status)    where.status    = filter.status;
    if (filter.ecfType)   where.ecfType   = filter.ecfType;
    if (filter.buyerRnc)  where.buyerRnc  = filter.buyerRnc;
    if (filter.trackId)   where.trackId   = filter.trackId;
    if (filter.encf)      where.encf      = { startsWith: filter.encf };
    if (filter.dateFrom || filter.dateTo) {
      where.createdAt = {};
      if (filter.dateFrom) where.createdAt.gte = new Date(filter.dateFrom);
      if (filter.dateTo)   where.createdAt.lte = new Date(filter.dateTo);
    }
    if (filter.amountMin !== undefined || filter.amountMax !== undefined) {
      where.totalAmount = {};
      if (filter.amountMin !== undefined) where.totalAmount.gte = filter.amountMin;
      if (filter.amountMax !== undefined) where.totalAmount.lte = filter.amountMax;
    }

    const [items, total, agg] = await Promise.all([
      this.prisma.invoice.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
        select: {
          id: true, tenantId: true, companyId: true, ecfType: true,
          encf: true, status: true, trackId: true,
          buyerRnc: true, buyerName: true,
          subtotal: true, totalDiscount: true, totalItbis: true, totalAmount: true,
          currency: true, exchangeRate: true,
          createdAt: true, updatedAt: true,
          company: { select: { businessName: true, rnc: true } },
        },
      }),
      this.prisma.invoice.count({ where }),
      this.prisma.invoice.aggregate({
        where,
        _sum: { totalAmount: true, totalItbis: true },
        _count: { status: true },
      }),
    ]);

    const countByStatus = items.length
      ? await this.prisma.invoice.groupBy({
          by: ['status'],
          where,
          _count: { status: true },
        })
      : [];

    const statusMap: Record<string, number> = {};
    for (const row of countByStatus) statusMap[row.status] = row._count.status;

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      aggregations: {
        totalAmount: Number(agg._sum.totalAmount ?? 0),
        totalItbis:  Number(agg._sum.totalItbis  ?? 0),
        countByStatus: statusMap,
      },
    };
  }
}
