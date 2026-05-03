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
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { WebhooksService } from './webhooks.service';
import { CreateWebhookDto, UpdateWebhookDto } from './dto/webhook.dto';
import { ApiKeyGuard } from '../common/guards/api-key.guard';
import { RequireScopes } from '../common/decorators/scopes.decorator';
import { CurrentTenant, RequestTenant } from '../common/decorators/tenant.decorator';
import { ApiKeyScope } from '@prisma/client';
import { ApiStandardErrors, ApiReadErrors, ApiNotFoundError } from '../common/swagger/api-errors';

const WEBHOOK_ID_PARAM = ApiParam({
  name: 'id',
  description: 'UUID del webhook',
  example: 'clng9x0010000vwc0webhook',
  format: 'uuid',
});

@ApiTags('webhooks')
@Controller('webhooks')
@UseGuards(ApiKeyGuard)
@ApiBearerAuth('api-key')
export class WebhooksController {
  constructor(private readonly webhooksService: WebhooksService) {}

  @Post()
  @RequireScopes(ApiKeyScope.WEBHOOKS_MANAGE)
  @ApiOperation({
    summary: 'Crear suscripción webhook',
    description:
      'Registra una URL para recibir notificaciones de eventos de facturación. ' +
      'Cada entrega incluye header `X-ECF-Signature: sha256=<hmac>` para verificación. ' +
      'Eventos disponibles: `invoice.accepted`, `invoice.rejected`, `invoice.conditional`, ' +
      '`invoice.contingency`, `invoice.queued`, `invoice.submitted`.',
  })
  @ApiResponse({
    status: 201,
    description: 'Webhook creado. El `secret` solo se muestra una vez — guárdalo para verificar las firmas HMAC.',
    schema: {
      example: {
        success: true,
        data: {
          id: 'webhook-uuid...',
          url: 'https://mi-sistema.com/webhooks/ecf',
          events: ['invoice.accepted', 'invoice.rejected'],
          secret: 'whsec_aBcDeFgHiJkLmNoPqRsTuVwXyZ123456',
          isActive: true,
          createdAt: '2026-05-03T12:00:00.000Z',
        },
      },
    },
  })
  @ApiStandardErrors()
  async create(
    @CurrentTenant() tenant: RequestTenant,
    @Body() dto: CreateWebhookDto,
  ) {
    return this.webhooksService.create(tenant.id, dto);
  }

  @Get()
  @RequireScopes(ApiKeyScope.WEBHOOKS_MANAGE)
  @ApiOperation({
    summary: 'Listar webhooks',
    description: 'Retorna todos los webhooks del tenant con sus estadísticas de entrega.',
  })
  @ApiResponse({
    status: 200,
    description: 'Lista de webhooks',
    schema: {
      example: {
        success: true,
        data: [
          {
            id: 'webhook-uuid...',
            url: 'https://mi-sistema.com/webhooks/ecf',
            events: ['invoice.accepted', 'invoice.rejected'],
            isActive: true,
            deliveryStats: { success: 142, failed: 3, pending: 0 },
          },
        ],
      },
    },
  })
  @ApiReadErrors()
  async findAll(@CurrentTenant() tenant: RequestTenant) {
    return this.webhooksService.findAll(tenant.id);
  }

  @Get(':id')
  @RequireScopes(ApiKeyScope.WEBHOOKS_MANAGE)
  @ApiOperation({
    summary: 'Ver webhook con historial de entregas',
    description: 'Retorna el webhook con las últimas entregas y sus códigos de respuesta. Útil para debugging.',
  })
  @WEBHOOK_ID_PARAM
  @ApiResponse({
    status: 200,
    description: 'Webhook con historial de entregas recientes',
    schema: {
      example: {
        success: true,
        data: {
          id: 'webhook-uuid...',
          url: 'https://mi-sistema.com/webhooks/ecf',
          events: ['invoice.accepted'],
          isActive: true,
          deliveries: [
            { id: 'del-uuid...', event: 'invoice.accepted', statusCode: 200, attemptCount: 1, createdAt: '2026-05-03T12:00:05.000Z' },
            { id: 'del-uuid-2...', event: 'invoice.accepted', statusCode: 500, attemptCount: 3, createdAt: '2026-05-03T11:00:00.000Z' },
          ],
        },
      },
    },
  })
  @ApiReadErrors()
  @ApiNotFoundError('Webhook')
  async findOne(
    @CurrentTenant() tenant: RequestTenant,
    @Param('id') id: string,
  ) {
    return this.webhooksService.findOne(tenant.id, id);
  }

  @Patch(':id')
  @RequireScopes(ApiKeyScope.WEBHOOKS_MANAGE)
  @ApiOperation({
    summary: 'Actualizar webhook',
    description: 'Actualiza URL, eventos o estado activo/inactivo del webhook. El secret no puede modificarse.',
  })
  @WEBHOOK_ID_PARAM
  @ApiResponse({
    status: 200,
    description: 'Webhook actualizado exitosamente',
    schema: { example: { success: true, data: { id: 'webhook-uuid...', isActive: false } } },
  })
  @ApiStandardErrors()
  @ApiNotFoundError('Webhook')
  async update(
    @CurrentTenant() tenant: RequestTenant,
    @Param('id') id: string,
    @Body() dto: UpdateWebhookDto,
  ) {
    return this.webhooksService.update(tenant.id, id, dto);
  }

  @Delete(':id')
  @RequireScopes(ApiKeyScope.WEBHOOKS_MANAGE)
  @ApiOperation({
    summary: 'Eliminar webhook',
    description: 'Elimina permanentemente el webhook y su historial de entregas.',
  })
  @WEBHOOK_ID_PARAM
  @ApiResponse({
    status: 200,
    description: 'Webhook eliminado exitosamente',
    schema: { example: { success: true, data: { id: 'webhook-uuid...', deleted: true } } },
  })
  @ApiReadErrors()
  @ApiNotFoundError('Webhook')
  async delete(
    @CurrentTenant() tenant: RequestTenant,
    @Param('id') id: string,
  ) {
    return this.webhooksService.delete(tenant.id, id);
  }
}
