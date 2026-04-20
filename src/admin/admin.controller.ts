import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { ApiKeyGuard } from '../common/guards/api-key.guard';
import { RequireScopes } from '../common/decorators/scopes.decorator';
import { ApiKeyScope } from '@prisma/client';
import { QueueService } from '../queue/queue.service';

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
  constructor(private readonly queueService: QueueService) {}

  /**
   * GET /admin/queues/stats
   * Returns waiting/active/completed/failed/delayed counts for every
   * pipeline queue (ecfProcessing, statusPoll, certificateCheck).
   * Webhook-delivery stats are surfaced via a future extension of
   * WebhooksService.
   */
  @Get('queues/stats')
  @RequireScopes(ApiKeyScope.ADMIN)
  @ApiOperation({
    summary: 'Queue health — waiting/active/completed/failed/delayed counts',
    description:
      'Snapshot of BullMQ queue depths. Intended for oncall dashboards and ' +
      'alerting (e.g. page if statusPoll.delayed > threshold). Requires the ' +
      'ADMIN API-key scope.',
  })
  async queueStats() {
    return this.queueService.getQueueStats();
  }
}
