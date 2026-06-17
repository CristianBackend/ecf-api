import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ApiKeyGuard } from '../common/guards/api-key.guard';
import { RequireScopes } from '../common/decorators/scopes.decorator';
import { ApiKeyScope } from '@prisma/client';
import { AdminPlansService } from './admin-plans.service';

@ApiTags('admin')
@Controller('admin')
@UseGuards(ApiKeyGuard)
@ApiBearerAuth('api-key')
export class AdminPlansController {
  constructor(private readonly service: AdminPlansService) {}

  @Get('plans')
  @RequireScopes(ApiKeyScope.ADMIN)
  @ApiOperation({ summary: 'Listar catálogo de planes de facturación (per-emission)' })
  @ApiResponse({ status: 200, description: 'Lista de BillingPlan activos con sus PricingTier' })
  listPlans() {
    return this.service.listPlans();
  }

  @Get('billing/dashboard')
  @RequireScopes(ApiKeyScope.ADMIN)
  @ApiOperation({ summary: 'Dashboard global de billing (company-level, per-emission)' })
  @ApiResponse({
    status: 200,
    description: 'Métricas globales de billing',
    schema: {
      example: {
        totalActivePlans: 12,
        expectedMonthlyRevenue: 1440.0,
        companiesRequiringQuote: 1,
        companies: [
          { companyId: 'uuid', name: 'Empresa', planCode: 'PER_EMISSION', acceptedCount: 2000, total: 140.0, requiresQuote: false },
        ],
      },
    },
  })
  getDashboard() {
    return this.service.getDashboard();
  }
}
