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
import { CompaniesService } from './companies.service';
import { CreateCompanyDto, UpdateCompanyDto } from './dto/company.dto';
import { ApiKeyGuard } from '../common/guards/api-key.guard';
import { RequireScopes } from '../common/decorators/scopes.decorator';
import { CurrentTenant, RequestTenant } from '../common/decorators/tenant.decorator';
import { ApiKeyScope } from '@prisma/client';
import { ApiStandardErrors, ApiReadErrors, ApiNotFoundError } from '../common/swagger/api-errors';

const COMPANY_ID_PARAM = ApiParam({
  name: 'id',
  description: 'UUID de la empresa',
  example: 'clng9x0010000vwc0l5s1234',
  format: 'uuid',
});

@ApiTags('companies')
@Controller('companies')
@UseGuards(ApiKeyGuard)
@ApiBearerAuth('api-key')
export class CompaniesController {
  constructor(private readonly companiesService: CompaniesService) {}

  @Post()
  @RequireScopes(ApiKeyScope.COMPANIES_WRITE)
  @ApiOperation({
    summary: 'Registrar empresa emisora',
    description: 'Crea una empresa emisora asociada al tenant. El RNC se valida contra el padrón DGII. La empresa debe tener un certificado .p12 activo y secuencias configuradas antes de emitir facturas.',
  })
  @ApiResponse({
    status: 201,
    description: 'Empresa creada exitosamente',
    schema: {
      example: {
        success: true,
        data: {
          id: 'clng9x0010000vwc0l5s1234',
          rnc: '130000001',
          businessName: 'Empresa Ejemplo SRL',
          dgiiEnv: 'DEV',
          isActive: true,
          createdAt: '2026-05-03T12:00:00.000Z',
        },
      },
    },
  })
  @ApiStandardErrors()
  async create(
    @CurrentTenant() tenant: RequestTenant,
    @Body() dto: CreateCompanyDto,
  ) {
    return this.companiesService.create(tenant.id, dto);
  }

  @Get()
  @RequireScopes(ApiKeyScope.COMPANIES_READ)
  @ApiOperation({
    summary: 'Listar empresas del tenant',
    description: 'Retorna todas las empresas emisoras registradas bajo el tenant actual.',
  })
  @ApiResponse({
    status: 200,
    description: 'Lista de empresas',
    schema: {
      example: {
        success: true,
        data: [{ id: 'uuid...', rnc: '130000001', businessName: 'Empresa Ejemplo SRL', isActive: true }],
      },
    },
  })
  @ApiReadErrors()
  async findAll(@CurrentTenant() tenant: RequestTenant) {
    return this.companiesService.findAll(tenant.id);
  }

  @Get(':id')
  @RequireScopes(ApiKeyScope.COMPANIES_READ)
  @ApiOperation({
    summary: 'Ver detalle de una empresa',
    description: 'Retorna el detalle completo de una empresa incluyendo certificados activos y secuencias configuradas.',
  })
  @COMPANY_ID_PARAM
  @ApiResponse({
    status: 200,
    description: 'Detalle de la empresa',
    schema: {
      example: {
        success: true,
        data: {
          id: 'clng9x001...',
          rnc: '130000001',
          businessName: 'Empresa Ejemplo SRL',
          address: 'Av. Winston Churchill 1099, Santo Domingo',
          dgiiEnv: 'DEV',
          isActive: true,
          activeCertificate: { id: 'cert-uuid', expiresAt: '2027-01-01T00:00:00.000Z' },
        },
      },
    },
  })
  @ApiReadErrors()
  @ApiNotFoundError('Empresa')
  async findOne(
    @CurrentTenant() tenant: RequestTenant,
    @Param('id') companyId: string,
  ) {
    return this.companiesService.findOne(tenant.id, companyId);
  }

  @Patch(':id')
  @RequireScopes(ApiKeyScope.COMPANIES_WRITE)
  @ApiOperation({
    summary: 'Actualizar empresa',
    description: 'Actualiza los datos de una empresa emisora. Todos los campos son opcionales.',
  })
  @COMPANY_ID_PARAM
  @ApiResponse({
    status: 200,
    description: 'Empresa actualizada exitosamente',
    schema: { example: { success: true, data: { id: 'uuid...', businessName: 'Empresa Actualizada SRL' } } },
  })
  @ApiStandardErrors()
  @ApiNotFoundError('Empresa')
  async update(
    @CurrentTenant() tenant: RequestTenant,
    @Param('id') companyId: string,
    @Body() dto: UpdateCompanyDto,
  ) {
    return this.companiesService.update(tenant.id, companyId, dto);
  }

  @Delete(':id')
  @RequireScopes(ApiKeyScope.COMPANIES_WRITE)
  @ApiOperation({
    summary: 'Desactivar empresa',
    description: 'Desactiva una empresa (soft-delete). La empresa deja de poder emitir facturas pero su historial se conserva.',
  })
  @COMPANY_ID_PARAM
  @ApiResponse({
    status: 200,
    description: 'Empresa desactivada exitosamente',
    schema: { example: { success: true, data: { id: 'uuid...', isActive: false } } },
  })
  @ApiReadErrors()
  @ApiNotFoundError('Empresa')
  async deactivate(
    @CurrentTenant() tenant: RequestTenant,
    @Param('id') companyId: string,
  ) {
    return this.companiesService.deactivate(tenant.id, companyId);
  }
}
