import {
  Controller, Post, Get, Param, Body, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import {
  ApiTags, ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiProperty, ApiPropertyOptional,
} from '@nestjs/swagger';
import { IsString, IsOptional } from 'class-validator';
import { ApiKeyGuard } from '../common/guards/api-key.guard';
import { RequireScopes } from '../common/decorators/scopes.decorator';
import { ApiKeyScope } from '@prisma/client';
import { AdminPlansService } from './admin-plans.service';
import { ApiStandardErrors, ApiNotFoundError } from '../common/swagger/api-errors';

class AssignPlanDto {
  @ApiProperty({ example: 'tenant-uuid' })
  @IsString()
  tenantId: string;

  @ApiProperty({ example: 'TIER_1', enum: ['TIER_1', 'TIER_2', 'TIER_3', 'TIER_4'] })
  @IsString()
  planCode: string;

  @ApiPropertyOptional({ example: 'Pago confirmado por transferencia 06/05/2026' })
  @IsOptional()
  @IsString()
  notes?: string;
}

@ApiTags('admin')
@Controller('admin')
@UseGuards(ApiKeyGuard)
@ApiBearerAuth('api-key')
export class AdminPlansController {
  constructor(private readonly service: AdminPlansService) {}

  @Post('plans/assign')
  @RequireScopes(ApiKeyScope.ADMIN)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Asignar plan a un tenant (PENDING_PAYMENT)' })
  @ApiResponse({ status: 201, description: 'Plan asignado — pendiente de pago' })
  @ApiResponse({ status: 409, description: 'Tenant ya tiene plan activo' })
  @ApiStandardErrors()
  assignPlan(@Body() dto: AssignPlanDto) {
    return this.service.assignPlan(dto.tenantId, dto.planCode, dto.notes);
  }

  @Post('plans/:tenantPlanId/activate')
  @RequireScopes(ApiKeyScope.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Activar plan (confirma pago manual)' })
  @ApiParam({ name: 'tenantPlanId', description: 'UUID del TenantPlan', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Plan activado — ventana de 30 días iniciada' })
  @ApiNotFoundError('TenantPlan')
  @ApiStandardErrors()
  activatePlan(@Param('tenantPlanId') tenantPlanId: string) {
    return this.service.activatePlan(tenantPlanId);
  }

  @Post('plans/:tenantPlanId/cancel')
  @RequireScopes(ApiKeyScope.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancelar plan' })
  @ApiParam({ name: 'tenantPlanId', description: 'UUID del TenantPlan', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Plan cancelado' })
  @ApiNotFoundError('TenantPlan')
  @ApiStandardErrors()
  cancelPlan(@Param('tenantPlanId') tenantPlanId: string) {
    return this.service.cancelPlan(tenantPlanId);
  }

  @Get('plans')
  @RequireScopes(ApiKeyScope.ADMIN)
  @ApiOperation({ summary: 'Listar catálogo de planes de facturación' })
  @ApiResponse({ status: 200, description: 'Lista de BillingPlan activos' })
  listPlans() {
    return this.service.listPlans();
  }

  @Get('tenants/:id/plans')
  @RequireScopes(ApiKeyScope.ADMIN)
  @ApiOperation({ summary: 'Historial de planes de un tenant' })
  @ApiParam({ name: 'id', description: 'UUID del tenant', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Lista de TenantPlan del tenant' })
  @ApiNotFoundError('Tenant')
  getTenantPlanHistory(@Param('id') id: string) {
    return this.service.getTenantPlanHistory(id);
  }

  @Get('billing/dashboard')
  @RequireScopes(ApiKeyScope.ADMIN)
  @ApiOperation({ summary: 'Dashboard global de billing' })
  @ApiResponse({
    status: 200,
    description: 'Métricas globales de billing',
    schema: {
      example: {
        totalActivePlans: 12,
        totalPendingPayment: 3,
        totalExpired: 5,
        expectedMonthlyRevenue: '1440.00',
        tenantsNearLimit: [{ tenantId: 'uuid', name: 'Empresa', percentage: 85, planCode: 'TIER_2' }],
        expiringSoon: [{ tenantId: 'uuid', name: 'Empresa', planCode: 'TIER_1', expiresAt: '2026-05-10', daysLeft: 4 }],
      },
    },
  })
  getDashboard() {
    return this.service.getDashboard();
  }
}
