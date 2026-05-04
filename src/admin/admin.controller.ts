import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ApiKeyGuard } from '../common/guards/api-key.guard';
import { RequireScopes } from '../common/decorators/scopes.decorator';
import { ApiKeyScope } from '@prisma/client';
import { QueueService } from '../queue/queue.service';
import { MetricsService } from './metrics.service';
import { ApiReadErrors } from '../common/swagger/api-errors';

/**
 * Admin endpoints — platform-level introspection that's NOT tenant-scoped.
 *
 * Every route here requires the ADMIN API-key scope (or FULL_ACCESS, which
 * inherits all scopes via ApiKeyGuard). These are for operational dashboards
 * and oncall runbooks, never for end-users.
 */
@ApiTags('admin')
@Controller('admin')
@UseGuards(ApiKeyGuard)
@ApiBearerAuth('api-key')
export class AdminController {
  constructor(
    private readonly queueService: QueueService,
    private readonly metricsService: MetricsService,
  ) {}

  @Get('queues/stats')
  @RequireScopes(ApiKeyScope.ADMIN)
  @ApiOperation({
    summary: 'Queue health — waiting/active/completed/failed/delayed counts',
    description: 'Snapshot of BullMQ queue depths. Requires ADMIN scope.',
  })
  @ApiResponse({ status: 200, description: 'Queue statistics' })
  @ApiReadErrors()
  async queueStats() {
    return this.queueService.getQueueStats();
  }

  @Get('metrics')
  @RequireScopes(ApiKeyScope.ADMIN)
  @ApiOperation({
    summary: 'Métricas globales del sistema (cached 30s)',
    description:
      'Agrega conteos de tenants, empresas, facturas, certificados, webhooks, ' +
      'colas BullMQ e info de sistema. Resultado cacheado 30 segundos para ' +
      'no saturar la BD. Requiere scope ADMIN.',
  })
  @ApiResponse({ status: 200, description: 'Métricas globales del sistema' })
  @ApiReadErrors()
  async globalMetrics() {
    return this.metricsService.getGlobalMetrics();
  }
}
