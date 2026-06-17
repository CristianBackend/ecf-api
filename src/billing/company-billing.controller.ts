import { Controller, Get, Post, Param, Body, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { ApiKeyGuard } from '../common/guards/api-key.guard';
import { RequireScopes } from '../common/decorators/scopes.decorator';
import { ApiKeyScope } from '@prisma/client';
import { CurrentTenant, RequestTenant } from '../common/decorators/tenant.decorator';
import { Actor, ActorContext } from '../common/decorators/actor.decorator';
import { CompanyBillingService } from './company-billing.service';
import { AssignPlanDto } from './dto/assign-plan.dto';
import { PurchaseTopupDto } from './dto/purchase-topup.dto';
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
    });
  }

  @Get('topup-packs')
  @RequireScopes(ApiKeyScope.BILLING_READ)
  @ApiOperation({ summary: 'Listar paquetes de topup disponibles' })
  async listTopupPacks() {
    return this.prisma.topupPack.findMany({
      where: { isActive: true },
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
  @ApiOperation({ summary: 'Asignar plan a una empresa' })
  async assignPlan(
    @CurrentTenant() tenant: RequestTenant,
    @Param('id') companyId: string,
    @Body() dto: AssignPlanDto,
    @Actor() actor: ActorContext,
  ) {
    return this.companyBillingService.assignPlan(companyId, dto.planCode, tenant.id, actor);
  }

  @Get('companies/:id/usage')
  @RequireScopes(ApiKeyScope.BILLING_READ)
  @ApiOperation({ summary: 'Obtener uso de facturación de una empresa' })
  async getCompanyUsage(
    @CurrentTenant() tenant: RequestTenant,
    @Param('id') companyId: string,
  ) {
    return this.companyBillingService.getUsage(companyId, tenant.id);
  }

  @Post('companies/:id/topup')
  @RequireScopes(ApiKeyScope.BILLING_WRITE)
  @ApiOperation({ summary: 'Adquirir topup para una empresa' })
  async purchaseTopup(
    @CurrentTenant() tenant: RequestTenant,
    @Param('id') companyId: string,
    @Body() dto: PurchaseTopupDto,
  ) {
    return this.companyBillingService.purchaseTopup(companyId, dto.topupPackCode, tenant.id);
  }

  @Get('companies/:id/billing-alerts')
  @RequireScopes(ApiKeyScope.BILLING_READ)
  @ApiOperation({ summary: 'Obtener alertas de facturación de una empresa' })
  async getBillingAlerts(
    @CurrentTenant() tenant: RequestTenant,
    @Param('id') companyId: string,
  ) {
    return this.companyBillingService.getAlerts(companyId, tenant.id);
  }

  @Post('companies/:id/billing-alerts/:alertId/read')
  @RequireScopes(ApiKeyScope.BILLING_READ)
  @ApiOperation({ summary: 'Marcar alerta de facturación como leída' })
  async markAlertRead(
    @CurrentTenant() tenant: RequestTenant,
    @Param('id') companyId: string,
    @Param('alertId') alertId: string,
  ) {
    return this.companyBillingService.markAlertRead(companyId, alertId, tenant.id);
  }
}
