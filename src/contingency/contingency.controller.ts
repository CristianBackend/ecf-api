import { Controller, Get, Post, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { ContingencyService } from './contingency.service';
import { ApiKeyGuard } from '../common/guards/api-key.guard';
import { RequireScopes } from '../common/decorators/scopes.decorator';
import { CurrentTenant, RequestTenant } from '../common/decorators/tenant.decorator';
import { ApiKeyScope } from '@prisma/client';

@ApiTags('contingency')
@Controller('contingency')
@UseGuards(ApiKeyGuard)
@ApiBearerAuth('api-key')
export class ContingencyController {
  constructor(private readonly contingencyService: ContingencyService) {}

  @Get()
  @RequireScopes(ApiKeyScope.INVOICES_READ)
  @ApiOperation({ summary: 'Listar facturas en contingencia' })
  async getPending(@CurrentTenant() tenant: RequestTenant) {
    return this.contingencyService.getPendingInvoices(tenant.id);
  }

  @Get('stats')
  @RequireScopes(ApiKeyScope.INVOICES_READ)
  @ApiOperation({ summary: 'Estadísticas de contingencia' })
  async getStats(@CurrentTenant() tenant: RequestTenant) {
    return this.contingencyService.getStats(tenant.id);
  }

  @Post(':invoiceId/retry')
  @RequireScopes(ApiKeyScope.INVOICES_WRITE)
  @ApiOperation({ summary: 'Marcar factura con error para reintento' })
  async markForRetry(
    @CurrentTenant() tenant: RequestTenant,
    @Param('invoiceId') invoiceId: string,
  ) {
    return this.contingencyService.markForRetry(tenant.id, invoiceId);
  }

  @Post('retry-all')
  @RequireScopes(ApiKeyScope.INVOICES_WRITE)
  @ApiOperation({ summary: 'Marcar todas las facturas con error para reintento' })
  async markAllForRetry(@CurrentTenant() tenant: RequestTenant) {
    return this.contingencyService.markAllForRetry(tenant.id);
  }

  @Post('process')
  @RequireScopes(ApiKeyScope.INVOICES_WRITE)
  @ApiOperation({ summary: 'Procesar cola de contingencia (reenviar a DGII)' })
  async processQueue(@CurrentTenant() tenant: RequestTenant) {
    return this.contingencyService.processQueue(tenant.id);
  }
}
