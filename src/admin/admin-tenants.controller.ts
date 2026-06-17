import { Controller, Get, Post, Param, Query, Body, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import {
  ApiTags, ApiBearerAuth, ApiOperation, ApiQuery, ApiParam, ApiResponse, ApiProperty, ApiPropertyOptional,
} from '@nestjs/swagger';
import { IsOptional, IsString, IsInt, IsBoolean, IsEmail, IsEnum, MinLength, MaxLength, Min, Max } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiKeyGuard } from '../common/guards/api-key.guard';
import { RequireScopes } from '../common/decorators/scopes.decorator';
import { ApiKeyScope, Plan } from '@prisma/client';
import { AdminTenantsService } from './admin-tenants.service';
import { ApiReadErrors, ApiNotFoundError, ApiStandardErrors } from '../common/swagger/api-errors';

class AdminCreateTenantBodyDto {
  @ApiProperty({ example: 'Empresa Ejemplo SRL' })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name: string;

  @ApiProperty({ example: 'admin@empresa.com' })
  @IsEmail()
  email: string;

  @ApiPropertyOptional({ enum: Plan, example: Plan.STARTER })
  @IsOptional()
  @IsEnum(Plan)
  plan?: Plan;
}

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

  @Post()
  @RequireScopes(ApiKeyScope.ADMIN)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Crear tenant (admin)',
    description:
      'El admin genera un tenant con contraseña temporal. ' +
      'La contraseña se muestra UNA sola vez. El tenant debe cambiarla en el primer login.',
  })
  @ApiResponse({
    status: 201,
    description: 'Tenant creado. Credenciales solo visibles en esta respuesta.',
    schema: {
      example: {
        success: true,
        data: {
          tenant: { id: 'uuid', name: 'Empresa SRL', email: 'admin@empresa.com', plan: 'STARTER', mustChangePassword: true },
          credentials: { email: 'admin@empresa.com', temporaryPassword: 'Xk3mWvP9nqJr' },
          apiKeys: {
            test: { key: 'frd_test_...', prefix: 'frd_test_xxxx', scopes: ['FULL_ACCESS'] },
            live: { key: 'frd_live_...', prefix: 'frd_live_xxxx', scopes: ['FULL_ACCESS'] },
          },
        },
      },
    },
  })
  @ApiStandardErrors()
  createTenant(@Body() dto: AdminCreateTenantBodyDto) {
    return this.service.createTenant(dto);
  }

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
