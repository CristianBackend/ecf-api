import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { TenantsService } from './tenants.service';
import { BillingService } from '../billing/billing.service';
import { CreateTenantDto, UpdateTenantDto } from './dto/tenant.dto';
import { ApiKeyGuard } from '../common/guards/api-key.guard';
import { CurrentTenant, RequestTenant } from '../common/decorators/tenant.decorator';

@ApiTags('tenants')
@Controller('tenants')
export class TenantsController {
  constructor(
    private readonly tenantsService: TenantsService,
    private readonly billingService: BillingService,
  ) {}

  /**
   * Public endpoint - no auth required.
   * Creates a new tenant and returns initial API keys.
   */
  // DEPRECATED: use POST /admin/tenants for all tenant creation after initial bootstrap.
  @Post('register')
  @ApiOperation({
    summary: 'Bootstrap: registrar primer tenant (DEPRECATED)',
    description:
      '⚠️ DEPRECATED — Solo funciona cuando no existe ningún tenant en el sistema (bootstrap inicial). ' +
      'Para crear tenants adicionales usar POST /admin/tenants con scope ADMIN.',
    deprecated: true,
  })
  @ApiResponse({ status: 201, description: 'Primer tenant creado (bootstrap)' })
  @ApiResponse({ status: 403, description: 'Ya existe al menos un tenant — registro público deshabilitado' })
  async register(@Body() dto: CreateTenantDto) {
    return this.tenantsService.create(dto);
  }

  @Get('me')
  @UseGuards(ApiKeyGuard)
  @ApiBearerAuth('api-key')
  @ApiOperation({ summary: 'Ver información del tenant actual' })
  async getMe(@CurrentTenant() tenant: RequestTenant) {
    return this.tenantsService.findOne(tenant.id);
  }

  @Patch('me')
  @UseGuards(ApiKeyGuard)
  @ApiBearerAuth('api-key')
  @ApiOperation({ summary: 'Actualizar tenant actual' })
  async updateMe(
    @CurrentTenant() tenant: RequestTenant,
    @Body() dto: UpdateTenantDto,
  ) {
    return this.tenantsService.update(tenant.id, dto);
  }

  @Get('me/stats')
  @UseGuards(ApiKeyGuard)
  @ApiBearerAuth('api-key')
  @ApiOperation({ summary: 'Estadísticas de uso del tenant' })
  async getStats(@CurrentTenant() tenant: RequestTenant) {
    return this.tenantsService.getStats(tenant.id);
  }

  @Get('me/usage')
  @UseGuards(ApiKeyGuard)
  @ApiBearerAuth('api-key')
  @ApiOperation({ summary: 'Uso del plan de facturación del tenant actual' })
  @ApiResponse({
    status: 200,
    description: 'Resumen de uso del plan activo',
    schema: {
      example: {
        success: true,
        data: {
          hasActivePlan: true,
          plan: { code: 'TIER_1', name: 'Tier 1 — Básico', monthlyFee: 60, includedInvoices: 1500 },
          usage: {
            current: 300, limit: 1500, percentage: 20, remaining: 1200,
            periodStart: '2026-05-06T12:00:00.000Z',
            periodEnd: '2026-06-05T12:00:00.000Z',
            daysRemaining: 29,
          },
          status: 'ACTIVE',
        },
      },
    },
  })
  async getUsage(@CurrentTenant() tenant: RequestTenant) {
    return this.billingService.getTenantUsageSummary(tenant.id);
  }
}
