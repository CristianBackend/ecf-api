import { Controller, Get, Post, Param, Query, UseGuards } from '@nestjs/common';
import {
  ApiTags, ApiBearerAuth, ApiOperation, ApiQuery, ApiParam, ApiResponse,
} from '@nestjs/swagger';
import { ApiKeyGuard } from '../common/guards/api-key.guard';
import { RequireScopes } from '../common/decorators/scopes.decorator';
import { ApiKeyScope } from '@prisma/client';
import { AdminWebhooksService } from './admin-webhooks.service';
import { ApiReadErrors, ApiNotFoundError, ApiStandardErrors } from '../common/swagger/api-errors';

@ApiTags('admin')
@Controller('admin/webhooks')
@UseGuards(ApiKeyGuard)
@ApiBearerAuth('api-key')
export class AdminWebhooksController {
  constructor(private readonly service: AdminWebhooksService) {}

  @Get('deliveries')
  @RequireScopes(ApiKeyScope.ADMIN)
  @ApiOperation({
    summary: 'Listar webhook deliveries (admin)',
    description: 'Lista global de entregas de webhook con filtros. Requiere scope ADMIN.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'tenantId', required: false })
  @ApiQuery({ name: 'subscriptionId', required: false })
  @ApiQuery({ name: 'event', required: false })
  @ApiQuery({ name: 'statusCode', required: false, type: Number })
  @ApiQuery({ name: 'dateFrom', required: false, description: 'YYYY-MM-DD' })
  @ApiQuery({ name: 'dateTo', required: false, description: 'YYYY-MM-DD' })
  @ApiQuery({ name: 'onlyFailed', required: false, type: Boolean, description: 'Solo entregas sin deliveredAt' })
  @ApiResponse({ status: 200, description: 'Lista paginada de deliveries' })
  @ApiReadErrors()
  findDeliveries(@Query() query: any) {
    return this.service.findDeliveries({
      page: query.page ? +query.page : undefined,
      limit: query.limit ? +query.limit : undefined,
      tenantId: query.tenantId,
      subscriptionId: query.subscriptionId,
      event: query.event,
      statusCode: query.statusCode ? +query.statusCode : undefined,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
      onlyFailed: query.onlyFailed === 'true',
    });
  }

  @Get('deliveries/:id')
  @RequireScopes(ApiKeyScope.ADMIN)
  @ApiOperation({ summary: 'Detalle de un webhook delivery', description: 'Requiere scope ADMIN.' })
  @ApiParam({ name: 'id', description: 'UUID del delivery', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Detalle del delivery' })
  @ApiReadErrors()
  @ApiNotFoundError('Delivery')
  findDelivery(@Param('id') id: string) {
    return this.service.findDelivery(id);
  }

  @Post('deliveries/:id/retry')
  @RequireScopes(ApiKeyScope.ADMIN)
  @ApiOperation({
    summary: 'Forzar reintento de un webhook delivery',
    description:
      'Re-encola el delivery en BullMQ. Solo válido cuando attempts >= maxAttempts (BullMQ agotó sus reintentos). Requiere scope ADMIN.',
  })
  @ApiParam({ name: 'id', description: 'UUID del delivery', format: 'uuid' })
  @ApiResponse({ status: 201, description: 'Delivery re-encolado', schema: { example: { success: true, jobId: 'job-uuid', deliveryId: 'delivery-uuid' } } })
  @ApiStandardErrors()
  @ApiNotFoundError('Delivery')
  retryDelivery(@Param('id') id: string) {
    return this.service.retryDelivery(id);
  }
}
