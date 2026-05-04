import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ApiKeyGuard } from '../common/guards/api-key.guard';
import { RequireScopes } from '../common/decorators/scopes.decorator';
import { ApiKeyScope } from '@prisma/client';
import { AdminHealthService } from './admin-health.service';
import { ApiReadErrors } from '../common/swagger/api-errors';

@ApiTags('admin')
@Controller('admin/health')
@UseGuards(ApiKeyGuard)
@ApiBearerAuth('api-key')
export class AdminHealthController {
  constructor(private readonly service: AdminHealthService) {}

  @Get()
  @RequireScopes(ApiKeyScope.ADMIN)
  @ApiOperation({
    summary: 'Health detallado del sistema (admin)',
    description:
      'Checks de DB, Redis, colas BullMQ, scheduler last-runs y métricas de sistema. ' +
      'status=healthy|degraded|unhealthy. Diferente de /health (público) que solo sirve para Docker healthcheck. ' +
      'Requiere scope ADMIN.',
  })
  @ApiResponse({
    status: 200,
    description: 'Health detallado',
    schema: {
      example: {
        status: 'healthy',
        timestamp: '2026-05-04T12:00:00.000Z',
        checks: {
          database: { status: 'ok', responseTimeMs: 3 },
          redis: { status: 'ok', responseTimeMs: 1 },
          queues: { ecfProcessing: { waiting: 0, active: 0, completed: 100, failed: 0, delayed: 0 } },
          scheduler: { lastContingencyRun: null, lastTokenCleanup: null, lastCertificateCheck: null },
          system: { uptime: 1234, version: '0.1.0', nodeEnv: 'production' },
        },
      },
    },
  })
  @ApiReadErrors()
  getDetailedHealth() {
    return this.service.getDetailedHealth();
  }
}
