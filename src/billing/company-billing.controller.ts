import { Controller, Get, Post, Param, Body, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { ApiKeyGuard } from '../common/guards/api-key.guard';
import { RequireScopes } from '../common/decorators/scopes.decorator';
import { ApiKeyScope } from '@prisma/client';
import { CurrentTenant, RequestTenant } from '../common/decorators/tenant.decorator';
import { CompanyBillingService } from './company-billing.service';
import { AssignPlanDto } from './dto/assign-plan.dto';
import { PrismaService } from '../prisma/prisma.service';

@ApiTags('billing')
@Controller()
@UseGuards(ApiKeyGuard)
@ApiBearerAuth('api-key')
export class CompanyBillingController {
  constructor(
    private readonly companyBillingService: CompanyBillingService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('billing-plans')
  @RequireScopes(ApiKeyScope.BILLING_READ)
  @ApiOperation({ summary: 'Listar planes de facturación disponibles' })
  async listBillingPlans() {
    return this.prisma.billingPlan.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
      include: { pricingTiers: { orderBy: { sortOrder: 'asc' } } },
    });
  }

  @Get('companies/:id/plan')
  @RequireScopes(ApiKeyScope.BILLING_READ)
  @ApiOperation({ summary: 'Obtener plan activo de una empresa' })
  async getCompanyPlan(
    @CurrentTenant() tenant: RequestTenant,
    @Param('id') companyId: string,
  ) {
    return this.companyBillingService.getUsage(companyId, tenant.id);
  }

  @Post('companies/:id/plan')
  @RequireScopes(ApiKeyScope.BILLING_WRITE)
  @ApiOperation({ summary: 'Asignar plan a una empresa (manual)' })
  async assignPlan(
    @CurrentTenant() tenant: RequestTenant,
    @Param('id') companyId: string,
    @Body() dto: AssignPlanDto,
  ) {
    return this.companyBillingService.assignPlan(companyId, dto.planCode, tenant.id);
  }

  @Get('companies/:id/usage')
  @RequireScopes(ApiKeyScope.BILLING_READ)
  @ApiOperation({ summary: 'Obtener uso de facturación (aceptadas del ciclo) de una empresa' })
  async getCompanyUsage(
    @CurrentTenant() tenant: RequestTenant,
    @Param('id') companyId: string,
  ) {
    return this.companyBillingService.getUsage(companyId, tenant.id);
  }

  @Get('companies/:id/billing/current-month')
  @RequireScopes(ApiKeyScope.BILLING_READ)
  @ApiOperation({
    summary:
      'Cargo proyectado del ciclo vigente (US$60 + aceptadas×precio_rango, mín 500). ' +
      'Solo lectura — mide y calcula, no cobra.',
  })
  async getCurrentMonth(
    @CurrentTenant() tenant: RequestTenant,
    @Param('id') companyId: string,
  ) {
    return this.companyBillingService.getCurrentMonthBilling(companyId, tenant.id);
  }
}
