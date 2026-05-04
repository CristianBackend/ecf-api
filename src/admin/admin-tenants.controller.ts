import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
  ApiTags, ApiBearerAuth, ApiOperation, ApiQuery, ApiParam, ApiResponse,
} from '@nestjs/swagger';
import { IsOptional, IsString, IsInt, IsBoolean, Min, Max } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiKeyGuard } from '../common/guards/api-key.guard';
import { RequireScopes } from '../common/decorators/scopes.decorator';
import { ApiKeyScope } from '@prisma/client';
import { AdminTenantsService } from './admin-tenants.service';
import { ApiReadErrors, ApiNotFoundError } from '../common/swagger/api-errors';

class AdminTenantsQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  limit?: number;

  @IsOptional() @IsString()
  search?: string;

  @IsOptional() @IsString()
  plan?: string;

  @IsOptional() @Transform(({ value }) => value === 'true' || value === true) @IsBoolean()
  isActive?: boolean;
}

@ApiTags('admin')
@Controller('admin/tenants')
@UseGuards(ApiKeyGuard)
@ApiBearerAuth('api-key')
export class AdminTenantsController {
  constructor(private readonly service: AdminTenantsService) {}

  @Get()
  @RequireScopes(ApiKeyScope.ADMIN)
  @ApiOperation({
    summary: 'Listar todos los tenants (admin)',
    description: 'Vista global de todos los tenants. NO filtrada por tenant del caller. Requiere scope ADMIN.',
  })
  @ApiQuery({ name: 'page', required: false, type: Number, example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, example: 20 })
  @ApiQuery({ name: 'search', required: false, description: 'Buscar por nombre o email' })
  @ApiQuery({ name: 'plan', required: false, enum: ['STARTER', 'BUSINESS', 'ENTERPRISE', 'PLATFORM'] })
  @ApiQuery({ name: 'isActive', required: false, type: Boolean })
  @ApiResponse({ status: 200, description: 'Lista paginada de tenants' })
  @ApiReadErrors()
  findAll(@Query() query: AdminTenantsQueryDto) {
    return this.service.findAll(query);
  }

  @Get(':id')
  @RequireScopes(ApiKeyScope.ADMIN)
  @ApiOperation({
    summary: 'Detalle completo de un tenant',
    description: 'Incluye empresas, certificados, API keys (sin hash), webhooks y métricas. Requiere scope ADMIN.',
  })
  @ApiParam({ name: 'id', description: 'UUID del tenant', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Detalle del tenant' })
  @ApiReadErrors()
  @ApiNotFoundError('Tenant')
  findOne(@Param('id') id: string) {
    return this.service.findOne(id);
  }
}
