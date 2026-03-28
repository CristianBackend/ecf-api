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
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { ApiKeyGuard } from '../common/guards/api-key.guard';
import { RequireScopes } from '../common/decorators/scopes.decorator';
import { CurrentTenant, RequestTenant } from '../common/decorators/tenant.decorator';
import { ApiKeyScope } from '@prisma/client';
import { BuyersService } from './buyers.service';
import { CreateBuyerDto, UpdateBuyerDto } from './dto/buyer.dto';

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
      'Si se proporciona RNC, consulta DGII para auto-llenar datos. ' +
      'El tipo de comprobante (e-CF) se asigna automáticamente según el tipo de comprador.',
  })
  create(@CurrentTenant() tenant: RequestTenant, @Body() dto: CreateBuyerDto) {
    return this.buyersService.create(tenant.id, dto);
  }

  @Get()
  @RequireScopes(ApiKeyScope.INVOICES_READ)
  @ApiOperation({ summary: 'Listar clientes/compradores' })
  @ApiQuery({ name: 'search', required: false, description: 'Buscar por nombre, RNC o nombre comercial' })
  @ApiQuery({ name: 'buyerType', required: false, description: 'Filtrar por tipo' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
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
  @ApiOperation({ summary: 'Obtener detalle de un cliente con facturas recientes' })
  findOne(@CurrentTenant() tenant: RequestTenant, @Param('id') id: string) {
    return this.buyersService.findOne(tenant.id, id);
  }

  @Patch(':id')
  @RequireScopes(ApiKeyScope.INVOICES_WRITE)
  @ApiOperation({ summary: 'Actualizar datos de un cliente' })
  update(@CurrentTenant() tenant: RequestTenant, @Param('id') id: string, @Body() dto: UpdateBuyerDto) {
    return this.buyersService.update(tenant.id, id, dto);
  }

  @Post(':id/refresh-dgii')
  @RequireScopes(ApiKeyScope.INVOICES_WRITE)
  @ApiOperation({
    summary: 'Re-verificar RNC con DGII',
    description: 'Consulta DGII nuevamente y actualiza los datos del cliente (estado, actividad económica, etc.)',
  })
  refreshDgii(@CurrentTenant() tenant: RequestTenant, @Param('id') id: string) {
    return this.buyersService.refreshDgiiData(tenant.id, id);
  }
}
