import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService } from '../auth/auth.service';
import { CreateTenantDto, UpdateTenantDto } from './dto/tenant.dto';
import { Plan, ApiKeyScope } from '@prisma/client';
import * as bcrypt from 'bcrypt';

@Injectable()
export class TenantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: AuthService,
    @InjectPinoLogger(TenantsService.name)
    private readonly logger: PinoLogger,
  ) {}

  /**
   * Register a new tenant and generate initial API keys.
   * Returns the tenant with a test and live API key.
   */
  async create(dto: CreateTenantDto) {
    // Check if email already exists
    const existing = await this.prisma.tenant.findUnique({
      where: { email: dto.email },
    });

    if (existing) {
      throw new ConflictException('Email already registered');
    }

    // Create tenant
    const passwordHash = await bcrypt.hash(dto.password, 12);
    const tenant = await this.prisma.tenant.create({
      data: {
        name: dto.name,
        email: dto.email,
        passwordHash,
        plan: dto.plan || Plan.STARTER,
      },
    });

    // Generate initial API keys (test + live)
    const testKey = await this.authService.generateApiKey(
      tenant.id,
      'Default Test Key',
      false,
      [ApiKeyScope.FULL_ACCESS],
    );

    const liveKey = await this.authService.generateApiKey(
      tenant.id,
      'Default Live Key',
      true,
      [ApiKeyScope.FULL_ACCESS],
    );

    this.logger.info(`Tenant created: ${tenant.id} (${tenant.name})`);

    return {
      tenant,
      apiKeys: {
        test: {
          key: testKey.key,
          prefix: testKey.keyPrefix,
          note: '⚠️ Guarda esta clave. No se mostrará de nuevo.',
        },
        live: {
          key: liveKey.key,
          prefix: liveKey.keyPrefix,
          note: '⚠️ Guarda esta clave. No se mostrará de nuevo.',
        },
      },
    };
  }

  /**
   * Get tenant by ID
   */
  async findOne(id: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id },
      include: {
        companies: {
          select: {
            id: true,
            rnc: true,
            businessName: true,
            tradeName: true,
            dgiiEnv: true,
            isActive: true,
          },
        },
        _count: {
          select: {
            apiKeys: true,
            webhooks: true,
          },
        },
      },
    });

    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }

    return tenant;
  }

  /**
   * Update tenant
   */
  async update(id: string, dto: UpdateTenantDto) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id } });
    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }

    return this.prisma.tenant.update({
      where: { id },
      data: dto,
    });
  }

  /**
   * Get tenant usage stats
   */
  async getStats(tenantId: string) {
    const [invoiceCount, companiesCount, thisMonth] = await Promise.all([
      this.prisma.invoice.count({ where: { tenantId } }),
      this.prisma.company.count({ where: { tenantId } }),
      this.prisma.invoice.count({
        where: {
          tenantId,
          createdAt: {
            gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1),
          },
        },
      }),
    ]);

    return {
      totalInvoices: invoiceCount,
      totalCompanies: companiesCount,
      invoicesThisMonth: thisMonth,
    };
  }
}
