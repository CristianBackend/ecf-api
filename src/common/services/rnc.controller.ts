import {
  Controller,
  Get,
  Param,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiParam } from '@nestjs/swagger';
import { RncValidationService } from './rnc-validation.service';
import { ApiKeyGuard } from '../guards/api-key.guard';
import { RequireScopes } from '../decorators/scopes.decorator';
import { ApiKeyScope } from '@prisma/client';

@ApiTags('rnc')
@Controller('rnc')
@UseGuards(ApiKeyGuard)
@ApiBearerAuth('api-key')
export class RncController {
  constructor(private readonly rncService: RncValidationService) {}

  @Get(':rnc/validate')
  @RequireScopes(ApiKeyScope.INVOICES_READ)
  @ApiOperation({
    summary: 'Validar formato de RNC/Cédula (offline, sin consulta DGII)',
    description: 'Verifica el dígito verificador algorítmicamente. No requiere conexión a DGII.',
  })
  @ApiParam({ name: 'rnc', description: 'RNC (9 dígitos) o Cédula (11 dígitos)' })
  validate(@Param('rnc') rnc: string) {
    return this.rncService.validateFormat(rnc);
  }

  @Get(':rnc/lookup')
  @RequireScopes(ApiKeyScope.INVOICES_READ)
  @ApiOperation({
    summary: 'Consultar datos del contribuyente en DGII',
    description:
      'Valida formato + dígito verificador + consulta datos en DGII. ' +
      'Retorna razón social, nombre comercial, estado, actividad económica, etc.',
  })
  @ApiParam({ name: 'rnc', description: 'RNC (9 dígitos) o Cédula (11 dígitos)' })
  async lookup(@Param('rnc') rnc: string) {
    return this.rncService.validateAndLookup(rnc);
  }
}
