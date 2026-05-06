import { Injectable, NotFoundException, ConflictException, BadRequestException } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { Plan, ApiKeyScope, TenantPlanStatus } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';

/** Scopes granted to admin-created tenant keys (never includes ADMIN). */
const TENANT_DEFAULT_SCOPES: ApiKeyScope[] = [
  ApiKeyScope.INVOICES_READ,
  ApiKeyScope.INVOICES_WRITE,
  ApiKeyScope.COMPANIES_READ,
  ApiKeyScope.COMPANIES_WRITE,
  ApiKeyScope.CERTIFICATES_WRITE,
  ApiKeyScope.SEQUENCES_READ,
  ApiKeyScope.WEBHOOKS_MANAGE,
  ApiKeyScope.FULL_ACCESS,
];

/** Character set for temp passwords — excludes ambiguous chars 0/O/1/l/I. */
const PASSWORD_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';

export interface AdminTenantsFilter {
  page?: number;
  limit?: number;
  search?: string;
  plan?: string;
  isActive?: boolean;
}

export interface AdminCreateTenantDto {
  name: string;
  email: string;
  plan?: Plan;
  /** Optional billing plan code (TIER_1–TIER_4). Creates a TenantPlan with PENDING_PAYMENT status. */
  planCode?: string;
}

@Injectable()
export class AdminTenantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: AuthService,
    @InjectPinoLogger(AdminTenantsService.name)
    private readonly logger: PinoLogger,
  ) {}

  async createTenant(dto: AdminCreateTenantDto) {
    const existing = await this.prisma.tenant.findUnique({ where: { email: dto.email } });
    if (existing) throw new ConflictException('Email already registered');

    // Validate planCode against billing plan catalog before doing any writes
    let billingPlan: { id: string; code: string } | null = null;
    if (dto.planCode) {
      billingPlan = await this.prisma.billingPlan.findUnique({ where: { code: dto.planCode } });
      if (!billingPlan) {
        throw new BadRequestException(`Plan code '${dto.planCode}' no existe en el catálogo`);
      }
    }

    // Generate readable 12-char temporary password from unambiguous charset
    const randomBytes = crypto.randomBytes(24);
    let tempPassword = '';
    for (let i = 0; i < 12; i++) {
      tempPassword += PASSWORD_CHARS[randomBytes[i] % PASSWORD_CHARS.length];
    }

    const passwordHash = await bcrypt.hash(tempPassword, 12);

    const tenant = await this.prisma.tenant.create({
      data: {
        name: dto.name,
        email: dto.email,
        passwordHash,
        plan: dto.plan ?? Plan.STARTER,
        mustChangePassword: true,
      },
    });

    const [testKey, liveKey] = await Promise.all([
      this.authService.generateApiKey(tenant.id, 'Default Test Key', false, TENANT_DEFAULT_SCOPES),
      this.authService.generateApiKey(tenant.id, 'Default Live Key', true, TENANT_DEFAULT_SCOPES),
    ]);

    // Create TenantPlan if planCode was provided
    let tenantPlan: { id: string; status: TenantPlanStatus; planId: string } | null = null;
    if (billingPlan) {
      tenantPlan = await this.prisma.tenantPlan.create({
        data: {
          tenantId: tenant.id,
          planId: billingPlan.id,
          status: TenantPlanStatus.PENDING_PAYMENT,
        },
      });
    }

    this.logger.info(
      `Admin created tenant: ${tenant.id} (${tenant.email})${billingPlan ? ` with plan ${billingPlan.code}` : ''}`,
    );

    return {
      tenant: {
        id: tenant.id,
        name: tenant.name,
        email: tenant.email,
        plan: tenant.plan,
        isActive: tenant.isActive,
        mustChangePassword: tenant.mustChangePassword,
        createdAt: tenant.createdAt,
      },
      credentials: {
        email: tenant.email,
        temporaryPassword: tempPassword,
      },
      apiKeys: {
        test: { key: testKey.key, prefix: testKey.keyPrefix, scopes: testKey.scopes },
        live: { key: liveKey.key, prefix: liveKey.keyPrefix, scopes: liveKey.scopes },
      },
      ...(tenantPlan ? { tenantPlan } : {}),
    };
  }

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
