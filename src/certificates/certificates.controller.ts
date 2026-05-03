import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { CertificatesService } from './certificates.service';
import { UploadCertificateDto } from './dto/certificate.dto';
import { ApiKeyGuard } from '../common/guards/api-key.guard';
import { RequireScopes } from '../common/decorators/scopes.decorator';
import { CurrentTenant, RequestTenant } from '../common/decorators/tenant.decorator';
import { ApiKeyScope } from '@prisma/client';
import { ApiStandardErrors, ApiReadErrors, ApiNotFoundError } from '../common/swagger/api-errors';

const COMPANY_ID_PARAM = ApiParam({
  name: 'companyId',
  description: 'UUID de la empresa',
  example: 'clng9x0010000vwc0l5s1234',
  format: 'uuid',
});

@ApiTags('certificates')
@Controller('companies/:companyId/certificates')
@UseGuards(ApiKeyGuard)
@ApiBearerAuth('api-key')
export class CertificatesController {
  constructor(private readonly certificatesService: CertificatesService) {}

  @Post()
  @RequireScopes(ApiKeyScope.CERTIFICATES_WRITE)
  @ApiOperation({
    summary: 'Subir certificado .p12 de firma digital',
    description:
      'Sube y activa el certificado .p12 (XMLDSig) de la empresa. El archivo debe convertirse a Base64 antes del envío. ' +
      'El certificado se cifra con AES-GCM antes de almacenarse. Solo puede haber un certificado activo por empresa a la vez. ' +
      'Convierte a Base64: `base64 -i certificado.p12` (macOS/Linux) o PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes("cert.p12"))`',
  })
  @COMPANY_ID_PARAM
  @ApiResponse({
    status: 201,
    description: 'Certificado subido y activado exitosamente',
    schema: {
      example: {
        success: true,
        data: {
          id: 'cert-uuid...',
          companyId: 'company-uuid...',
          isActive: true,
          expiresAt: '2027-01-01T00:00:00.000Z',
          createdAt: '2026-05-03T12:00:00.000Z',
        },
      },
    },
  })
  @ApiStandardErrors()
  @ApiNotFoundError('Empresa')
  async upload(
    @CurrentTenant() tenant: RequestTenant,
    @Param('companyId') companyId: string,
    @Body() dto: UploadCertificateDto,
  ) {
    dto.companyId = companyId;
    return this.certificatesService.upload(tenant.id, dto);
  }

  @Get()
  @RequireScopes(ApiKeyScope.COMPANIES_READ)
  @ApiOperation({
    summary: 'Listar certificados de una empresa',
    description: 'Retorna el historial de certificados subidos para la empresa. El certificado activo se indica con `isActive: true`.',
  })
  @COMPANY_ID_PARAM
  @ApiResponse({
    status: 200,
    description: 'Lista de certificados',
    schema: {
      example: {
        success: true,
        data: [
          { id: 'cert-uuid-1...', isActive: true, expiresAt: '2027-01-01T00:00:00.000Z', createdAt: '2026-01-01T00:00:00.000Z' },
          { id: 'cert-uuid-2...', isActive: false, expiresAt: '2026-01-01T00:00:00.000Z', createdAt: '2025-01-01T00:00:00.000Z' },
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
    return this.certificatesService.findAll(tenant.id, companyId);
  }

  @Get('active')
  @RequireScopes(ApiKeyScope.COMPANIES_READ)
  @ApiOperation({
    summary: 'Ver certificado activo de una empresa',
    description: 'Retorna el certificado .p12 actualmente activo para firma de facturas. Retorna 404 si la empresa no tiene certificado activo.',
  })
  @COMPANY_ID_PARAM
  @ApiResponse({
    status: 200,
    description: 'Certificado activo de la empresa',
    schema: {
      example: {
        success: true,
        data: {
          id: 'cert-uuid...',
          isActive: true,
          expiresAt: '2027-01-01T00:00:00.000Z',
          daysUntilExpiry: 243,
        },
      },
    },
  })
  @ApiReadErrors()
  @ApiNotFoundError('Certificado activo')
  async getActive(
    @CurrentTenant() tenant: RequestTenant,
    @Param('companyId') companyId: string,
  ) {
    return this.certificatesService.getActive(tenant.id, companyId);
  }
}
