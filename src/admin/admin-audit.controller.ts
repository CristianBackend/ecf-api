import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { ApiKeyGuard } from '../common/guards/api-key.guard';
import { RequireScopes } from '../common/decorators/scopes.decorator';
import { ApiKeyScope } from '@prisma/client';
import { AdminAuditService } from './admin-audit.service';
import { ApiReadErrors } from '../common/swagger/api-errors';

@ApiTags('admin')
@Controller('admin/audit-logs')
@UseGuards(ApiKeyGuard)
@ApiBearerAuth('api-key')
export class AdminAuditController {
  constructor(private readonly service: AdminAuditService) {}

  @Get()
  @RequireScopes(ApiKeyScope.ADMIN)
  @ApiOperation({
    summary: 'Logs de auditoría del sistema',
    description: 'Lista global de audit logs con filtros. Requiere scope ADMIN.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Max 200' })
  @ApiQuery({ name: 'tenantId', required: false })
  @ApiQuery({ name: 'entityType', required: false, description: 'invoice|company|certificate|tenant|...' })
  @ApiQuery({ name: 'entityId', required: false })
  @ApiQuery({ name: 'action', required: false, description: 'created|updated|signed|sent|accepted|...' })
  @ApiQuery({ name: 'actor', required: false })
  @ApiQuery({ name: 'dateFrom', required: false, description: 'YYYY-MM-DD' })
  @ApiQuery({ name: 'dateTo', required: false, description: 'YYYY-MM-DD' })
  @ApiResponse({ status: 200, description: 'Lista paginada de audit logs con tenant.name resuelto' })
  @ApiReadErrors()
  findAll(@Query() query: any) {
    return this.service.findAll({
      page: query.page ? +query.page : undefined,
      limit: query.limit ? +query.limit : undefined,
      tenantId: query.tenantId,
      entityType: query.entityType,
      entityId: query.entityId,
      action: query.action,
      actor: query.actor,
      dateFrom: query.dateFrom,
      dateTo: query.dateTo,
    });
  }
}
