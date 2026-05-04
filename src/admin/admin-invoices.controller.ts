import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse } from '@nestjs/swagger';
import { IsOptional, IsString, IsNumber, IsInt, Min, Max, IsIn } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiKeyGuard } from '../common/guards/api-key.guard';
import { RequireScopes } from '../common/decorators/scopes.decorator';
import { ApiKeyScope } from '@prisma/client';
import { AdminInvoicesService } from './admin-invoices.service';
import { ApiReadErrors } from '../common/swagger/api-errors';

class AdminInvoicesQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)             page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)   limit?: number;
  @IsOptional() @IsString()  tenantId?: string;
  @IsOptional() @IsString()  companyId?: string;
  @IsOptional() @IsString()  status?: string;
  @IsOptional() @IsString()  ecfType?: string;
  @IsOptional() @IsString()  buyerRnc?: string;
  @IsOptional() @IsString()  encf?: string;
  @IsOptional() @IsString()  trackId?: string;
  @IsOptional() @IsString()  dateFrom?: string;
  @IsOptional() @IsString()  dateTo?: string;
  @IsOptional() @Type(() => Number) @IsNumber()  amountMin?: number;
  @IsOptional() @Type(() => Number) @IsNumber()  amountMax?: number;
  @IsOptional() @IsIn(['createdAt', 'totalAmount', 'encf'])  sortBy?: 'createdAt' | 'totalAmount' | 'encf';
  @IsOptional() @IsIn(['asc', 'desc'])  sortOrder?: 'asc' | 'desc';
}

@ApiTags('admin')
@Controller('admin/invoices')
@UseGuards(ApiKeyGuard)
@ApiBearerAuth('api-key')
export class AdminInvoicesController {
  constructor(private readonly service: AdminInvoicesService) {}

  @Get()
  @RequireScopes(ApiKeyScope.ADMIN)
  @ApiOperation({
    summary: 'Búsqueda avanzada global de facturas (admin)',
    description: 'Busca facturas en todos los tenants con filtros avanzados y agregaciones. Requiere scope ADMIN.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'tenantId', required: false })
  @ApiQuery({ name: 'companyId', required: false })
  @ApiQuery({ name: 'status', required: false, enum: ['DRAFT','QUEUED','PROCESSING','ACCEPTED','REJECTED','CONDITIONAL','VOIDED','CONTINGENCY','ERROR'] })
  @ApiQuery({ name: 'ecfType', required: false, enum: ['E31','E32','E33','E34','E41','E43','E44','E45','E46','E47'] })
  @ApiQuery({ name: 'buyerRnc', required: false })
  @ApiQuery({ name: 'encf', required: false, description: 'Búsqueda exacta o por prefijo' })
  @ApiQuery({ name: 'trackId', required: false })
  @ApiQuery({ name: 'dateFrom', required: false, description: 'YYYY-MM-DD' })
  @ApiQuery({ name: 'dateTo', required: false, description: 'YYYY-MM-DD' })
  @ApiQuery({ name: 'amountMin', required: false, type: Number })
  @ApiQuery({ name: 'amountMax', required: false, type: Number })
  @ApiQuery({ name: 'sortBy', required: false, enum: ['createdAt', 'totalAmount', 'encf'] })
  @ApiQuery({ name: 'sortOrder', required: false, enum: ['asc', 'desc'] })
  @ApiResponse({ status: 200, description: 'Lista paginada con agregaciones' })
  @ApiReadErrors()
  findAll(@Query() query: AdminInvoicesQueryDto) {
    return this.service.findAll(query);
  }
}
