import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiParam } from '@nestjs/swagger';
import { SequencesService } from './sequences.service';
import { CreateSequenceDto, AnnulSequencesDto } from './dto/sequence.dto';
import { ApiKeyGuard } from '../common/guards/api-key.guard';
import { RequireScopes } from '../common/decorators/scopes.decorator';
import { CurrentTenant, RequestTenant } from '../common/decorators/tenant.decorator';
import { ApiKeyScope, EcfType } from '@prisma/client';
import { ApiStandardErrors, ApiReadErrors, ApiNotFoundError } from '../common/swagger/api-errors';

const COMPANY_ID_PARAM = ApiParam({
  name: 'companyId',
  description: 'UUID de la empresa',
  example: 'clng9x0010000vwc0l5s1234',
  format: 'uuid',
});

@ApiTags('sequences')
@Controller('sequences')
@UseGuards(ApiKeyGuard)
@ApiBearerAuth('api-key')
export class SequencesController {
  constructor(private readonly sequencesService: SequencesService) {}

  @Post()
  @RequireScopes(ApiKeyScope.INVOICES_WRITE)
  @ApiOperation({
    summary: 'Registrar secuencia eNCF autorizada por DGII',
    description:
      'Registra un rango de números de comprobante fiscal electrónico (eNCF) autorizado por DGII para una empresa. ' +
      'Debe obtener la autorización de la DGII primero (solicitud de secuencias en OFV). ' +
      'Una empresa puede tener múltiples secuencias activas, una por tipo de e-CF.',
  })
  @ApiResponse({
    status: 201,
    description: 'Secuencia registrada exitosamente',
    schema: {
      example: {
        success: true,
        data: {
          id: 'seq-uuid...',
          companyId: 'company-uuid...',
          ecfType: 'E31',
          startNumber: 1,
          endNumber: 10000,
          currentNumber: 1,
          available: 10000,
          expiresAt: '2027-12-31T23:59:59.000Z',
        },
      },
    },
  })
  @ApiStandardErrors()
  async create(
    @CurrentTenant() tenant: RequestTenant,
    @Body() dto: CreateSequenceDto,
  ) {
    return this.sequencesService.create(tenant.id, dto);
  }

  @Get(':companyId')
  @RequireScopes(ApiKeyScope.SEQUENCES_READ)
  @ApiOperation({
    summary: 'Ver secuencias de una empresa',
    description: 'Retorna todas las secuencias de eNCF configuradas para la empresa, con el estado actual (disponibles, usados, vencimiento).',
  })
  @COMPANY_ID_PARAM
  @ApiResponse({
    status: 200,
    description: 'Lista de secuencias de la empresa',
    schema: {
      example: {
        success: true,
        data: [
          { id: 'seq-1...', ecfType: 'E31', startNumber: 1, endNumber: 10000, currentNumber: 150, available: 9850 },
          { id: 'seq-2...', ecfType: 'E32', startNumber: 1, endNumber: 5000, currentNumber: 22, available: 4978 },
        ],
      },
    },
  })
  @ApiReadErrors()
  @ApiNotFoundError('Empresa')
  async findAll(
    @CurrentTenant() tenant: RequestTenant,
    @Param('companyId') companyId: string,
  ) {
    return this.sequencesService.findAll(tenant.id, companyId);
  }

  @Get(':companyId/available')
  @RequireScopes(ApiKeyScope.SEQUENCES_READ)
  @ApiOperation({
    summary: 'Verificar disponibilidad de secuencia por tipo',
    description: 'Consulta si existe una secuencia activa con números disponibles para el tipo de e-CF solicitado.',
  })
  @COMPANY_ID_PARAM
  @ApiQuery({ name: 'type', enum: EcfType, example: 'E31', description: 'Tipo de e-CF a verificar', required: true })
  @ApiResponse({
    status: 200,
    description: 'Estado de disponibilidad de la secuencia',
    schema: {
      example: {
        success: true,
        data: { available: true, nextEncf: 'E310000000151', remaining: 9850, expiresAt: '2027-12-31T23:59:59.000Z' },
      },
    },
  })
  @ApiReadErrors()
  @ApiNotFoundError('Secuencia')
  async getAvailable(
    @CurrentTenant() tenant: RequestTenant,
    @Param('companyId') companyId: string,
    @Query('type') ecfType: EcfType,
  ) {
    return this.sequencesService.getAvailable(tenant.id, companyId, ecfType);
  }

  @Post(':companyId/annul')
  @RequireScopes(ApiKeyScope.INVOICES_WRITE)
  @ApiOperation({
    summary: 'Anular rangos de eNCF no utilizados (ANECF)',
    description:
      'Envía el documento ANECF a DGII para anular rangos de eNCF que no serán utilizados. ' +
      'Requerido cuando una secuencia vence o se cancela antes de agotar los números.',
  })
  @COMPANY_ID_PARAM
  @ApiResponse({
    status: 201,
    description: 'Anulación enviada a DGII exitosamente',
    schema: {
      example: {
        success: true,
        data: { annulmentId: 'anecf-uuid...', status: 'SENT', ranges: [{ encfFrom: 'E310000000151', encfTo: 'E310000010000' }] },
      },
    },
  })
  @ApiStandardErrors()
  @ApiNotFoundError('Empresa o secuencia')
  async annulSequences(
    @CurrentTenant() tenant: RequestTenant,
    @Param('companyId') companyId: string,
    @Body() dto: AnnulSequencesDto,
  ) {
    return this.sequencesService.annulSequences(tenant.id, companyId, dto.ranges);
  }
}
