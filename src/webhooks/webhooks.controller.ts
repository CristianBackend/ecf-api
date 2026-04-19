import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { WebhooksService } from './webhooks.service';
import { CreateWebhookDto, UpdateWebhookDto } from './dto/webhook.dto';
import { ApiKeyGuard } from '../common/guards/api-key.guard';
import { RequireScopes } from '../common/decorators/scopes.decorator';
import { CurrentTenant, RequestTenant } from '../common/decorators/tenant.decorator';
import { ApiKeyScope } from '@prisma/client';

@ApiTags('webhooks')
@Controller('webhooks')
@UseGuards(ApiKeyGuard)
@ApiBearerAuth('api-key')
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  @Post()
  @RequireScopes(ApiKeyScope.WEBHOOKS_MANAGE)
  @ApiOperation({ summary: 'Crear suscripción webhook' })
  async create(
    @CurrentTenant() tenant: RequestTenant,
    @Body() dto: CreateWebhookDto,
  ) {
    return this.webhooksService.create(tenant.id, dto);
  }

  @Get()
  @RequireScopes(ApiKeyScope.WEBHOOKS_MANAGE)
  @ApiOperation({ summary: 'Listar webhooks' })
  async findAll(@CurrentTenant() tenant: RequestTenant) {
    return this.webhooksService.findAll(tenant.id);
  }

  @Get(':id')
  @RequireScopes(ApiKeyScope.WEBHOOKS_MANAGE)
  @ApiOperation({ summary: 'Ver webhook con historial de entregas' })
  async findOne(
    @CurrentTenant() tenant: RequestTenant,
    @Param('id') id: string,
  ) {
    return this.webhooksService.findOne(tenant.id, id);
  }

  @Patch(':id')
  @RequireScopes(ApiKeyScope.WEBHOOKS_MANAGE)
  @ApiOperation({ summary: 'Actualizar webhook' })
  async update(
    @CurrentTenant() tenant: RequestTenant,
    @Param('id') id: string,
    @Body() dto: UpdateWebhookDto,
  ) {
    return this.webhooksService.update(tenant.id, id, dto);
  }

  @Delete(':id')
  @RequireScopes(ApiKeyScope.WEBHOOKS_MANAGE)
  @ApiOperation({ summary: 'Eliminar webhook' })
  async delete(
    @CurrentTenant() tenant: RequestTenant,
    @Param('id') id: string,
  ) {
    return this.webhooksService.delete(tenant.id, id);
  }
}
