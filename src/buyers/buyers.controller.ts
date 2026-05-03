import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiParam } from '@nestjs/swagger';
import { ApiKeyGuard } from '../common/guards/api-key.guard';
import { RequireScopes } from '../common/decorators/scopes.decorator';
import { CurrentTenant, RequestTenant } from '../common/decorators/tenant.decorator';
import { ApiKeyScope } from '@prisma/client';
import { BuyersService } from './buyers.service';
import { CreateBuyerDto, UpdateBuyerDto } from './dto/buyer.dto';
import { ApiStandardErrors, ApiReadErrors, ApiNotFoundError } from '../common/swagger/api-errors';

const BUYER_ID_PARAM = ApiParam({
  name: 'id',
  description: 'UUID del comprador',
  example: 'clng9x0010000vwc0l5s5678',
  format: 'uuid',
});

@ApiTags('buyers')
@Controller('buyers')
@UseGuards(ApiKeyGuard)
@ApiBearerAuth('api-key')
export class BuyersController {
  constructor(private readonly buyersService: BuyersService) {}

  @Post()
  @RequireScopes(ApiKeyScope.INVOICES_WRITE)
  @ApiOperation({
    summary: 'Crear cliente/comprador',
    description:
      'Crea un cliente con validación DGII automática. ' +
      'Si se proporciona RNC, consulta DGII para auto-llenar razón social, actividad económica y estado. ' +
      'Consumidores finales (sin RNC, facturas E32) no se registran aquí.',
  })
  @ApiResponse({
    status: 201,
    description: 'Cliente creado exitosamente',
    schema: {
      example: {
        success: true,
        data: {
          id: 'clng9x001...',
          rnc: '131793916',
          name: 'EMPRESA EJEMPLO SRL',
          commercialName: 'Empresa Ejemplo',
          status: 'NORMAL',
          economicActivity: 'Venta de productos tecnológicos',
          isActive: true,
          createdAt: '2026-05-03T12:00:00.000Z',
        },
      },
    },
  })
  @ApiStandardErrors()
  create(@CurrentTenant() tenant: RequestTenant, @Body() dto: CreateBuyerDto) {
    return this.buyersService.create(tenant.id, dto);
  }

  @Get()
  @RequireScopes(ApiKeyScope.INVOICES_READ)
  @ApiOperation({
    summary: 'Listar clientes/compradores',
    description: 'Retorna lista paginada de compradores del tenant. Soporta búsqueda por nombre, RNC o nombre comercial.',
  })
  @ApiQuery({ name: 'search', required: false, description: 'Buscar por nombre, RNC o nombre comercial', example: 'Empresa Ejemplo' })
  @ApiQuery({ name: 'buyerType', required: false, description: 'Filtrar por tipo: JURIDICAL, PHYSICAL, FOREIGN', example: 'JURIDICAL' })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Página (default: 1)', example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items por página (default: 20)', example: 20 })
  @ApiResponse({
    status: 200,
    description: 'Lista paginada de clientes',
    schema: {
      example: {
        success: true,
        data: [{ id: 'uuid...', rnc: '131793916', name: 'EMPRESA EJEMPLO SRL', isActive: true }],
        meta: { total: 45, page: 1, limit: 20 },
      },
    },
  })
  @ApiReadErrors()
  findAll(
    @CurrentTenant() tenant: RequestTenant,
    @Query('search') search?: string,
    @Query('buyerType') buyerType?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.buyersService.findAll(tenant.id, {
      search,
      buyerType,
      page: page ? parseInt(page) : undefined,
      limit: limit ? parseInt(limit) : undefined,
    });
  }

  @Get(':id')
  @RequireScopes(ApiKeyScope.INVOICES_READ)
  @ApiOperation({
    summary: 'Obtener detalle de un cliente',
    description: 'Retorna el detalle completo del cliente incluyendo sus últimas facturas emitidas.',
  })
  @BUYER_ID_PARAM
  @ApiResponse({
    status: 200,
    description: 'Detalle del cliente',
    schema: {
      example: {
        success: true,
        data: {
          id: 'uuid...',
          rnc: '131793916',
          name: 'EMPRESA EJEMPLO SRL',
          email: 'contacto@empresa.com',
          phone: '809-555-0101',
          recentInvoices: [{ id: 'inv-uuid...', encf: 'E310000000001', status: 'ACCEPTED' }],
        },
      },
    },
  })
  @ApiReadErrors()
  @ApiNotFoundError('Comprador')
  findOne(@CurrentTenant() tenant: RequestTenant, @Param('id') id: string) {
    return this.buyersService.findOne(tenant.id, id);
  }

  @Patch(':id')
  @RequireScopes(ApiKeyScope.INVOICES_WRITE)
  @ApiOperation({
    summary: 'Actualizar datos de un cliente',
    description: 'Actualiza los campos editables del cliente. Los datos auto-llenados de DGII (razón social, actividad) se pueden actualizar manualmente o con /refresh-dgii.',
  })
  @BUYER_ID_PARAM
  @ApiResponse({
    status: 200,
    description: 'Cliente actualizado exitosamente',
    schema: { example: { success: true, data: { id: 'uuid...', email: 'nuevo@empresa.com' } } },
  })
  @ApiStandardErrors()
  @ApiNotFoundError('Comprador')
  update(@CurrentTenant() tenant: RequestTenant, @Param('id') id: string, @Body() dto: UpdateBuyerDto) {
    return this.buyersService.update(tenant.id, id, dto);
  }

  @Post(':id/refresh-dgii')
  @RequireScopes(ApiKeyScope.INVOICES_WRITE)
  @ApiOperation({
    summary: 'Re-verificar RNC con DGII',
    description: 'Consulta DGII nuevamente y actualiza razón social, estado RNC y actividad económica del cliente.',
  })
  @BUYER_ID_PARAM
  @ApiResponse({
    status: 200,
    description: 'Datos del cliente actualizados desde DGII',
    schema: {
      example: {
        success: true,
        data: { id: 'uuid...', name: 'EMPRESA EJEMPLO SRL', status: 'NORMAL', economicActivity: 'ACTIVIDAD ACTUALIZADA' },
      },
    },
  })
  @ApiReadErrors()
  @ApiNotFoundError('Comprador')
  refreshDgii(@CurrentTenant() tenant: RequestTenant, @Param('id') id: string) {
    return this.buyersService.refreshDgiiData(tenant.id, id);
  }
}
