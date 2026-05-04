import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface AdminAuditFilter {
  page?: number;
  limit?: number;
  tenantId?: string;
  entityType?: string;
  entityId?: string;
  action?: string;
  actor?: string;
  dateFrom?: string;
  dateTo?: string;
}

@Injectable()
export class AdminAuditService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(filter: AdminAuditFilter) {
    const page  = Math.max(1, filter.page  ?? 1);
    const limit = Math.min(filter.limit ?? 50, 200);
    const skip  = (page - 1) * limit;

    const where: any = {};
    if (filter.tenantId)   where.tenantId   = filter.tenantId;
    if (filter.entityType) where.entityType = filter.entityType;
    if (filter.entityId)   where.entityId   = filter.entityId;
    if (filter.action)     where.action     = filter.action;
    if (filter.actor)      where.actor      = { contains: filter.actor, mode: 'insensitive' };
    if (filter.dateFrom || filter.dateTo) {
      where.createdAt = {};
      if (filter.dateFrom) where.createdAt.gte = new Date(filter.dateFrom);
      if (filter.dateTo)   where.createdAt.lte = new Date(filter.dateTo);
    }

    const [items, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          tenant: { select: { name: true } },
        },
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }
}
