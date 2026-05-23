import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiConsumes,
  ApiBody,
} from '@nestjs/swagger';
import { CertificationStep3Service } from './certification-step3.service';
import { ApiKeyGuard } from '../common/guards/api-key.guard';
import { RequireScopes } from '../common/decorators/scopes.decorator';
import { CurrentTenant, RequestTenant } from '../common/decorators/tenant.decorator';
import { ApiKeyScope } from '@prisma/client';

@ApiTags('certification-step3')
@Controller('certification-step3')
@UseGuards(ApiKeyGuard)
@ApiBearerAuth('api-key')
export class CertificationStep3Controller {
  constructor(private readonly service: CertificationStep3Service) {}

  @Post('upload-excel')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes(ApiKeyScope.INVOICES_WRITE)
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'Subir Excel ACEECF_Generadas — carga documentos ACECF del Paso 3' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      properties: {
        file:      { type: 'string', format: 'binary' },
        companyId: { type: 'string', format: 'uuid' },
      },
      required: ['file', 'companyId'],
    },
  })
  async uploadExcel(
    @CurrentTenant() tenant: RequestTenant,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body('companyId') companyId: string,
  ) {
    if (!file) return { success: false, message: 'Archivo no encontrado (campo: file)' };
    if (!companyId) return { success: false, message: 'companyId es obligatorio' };
    return this.service.uploadExcel(tenant.id, companyId, file.buffer);
  }

  @Get('documents/:companyId')
  @RequireScopes(ApiKeyScope.INVOICES_READ)
  @ApiOperation({ summary: 'Listar documentos ACECF Step3 cargados' })
  async list(
    @CurrentTenant() tenant: RequestTenant,
    @Param('companyId') companyId: string,
  ) {
    return this.service.listDocuments(tenant.id, companyId);
  }

  @Post('documents/:documentId/process')
  @RequireScopes(ApiKeyScope.INVOICES_WRITE)
  @ApiOperation({ summary: 'Procesar (build/sign/submit a DGII) un documento individual' })
  async processOne(
    @CurrentTenant() tenant: RequestTenant,
    @Param('documentId') documentId: string,
  ) {
    return this.service.processDocument(tenant.id, documentId);
  }

  @Post('process-all/:companyId')
  @RequireScopes(ApiKeyScope.INVOICES_WRITE)
  @ApiOperation({ summary: 'Procesar todos los documentos PENDING/ERROR de una empresa' })
  async processAll(
    @CurrentTenant() tenant: RequestTenant,
    @Param('companyId') companyId: string,
  ) {
    return this.service.processAll(tenant.id, companyId);
  }

  @Delete('documents/:companyId/reset')
  @RequireScopes(ApiKeyScope.INVOICES_WRITE)
  @ApiOperation({ summary: 'Borrar todos los documentos Step3 (para re-subir el Excel)' })
  async resetAll(
    @CurrentTenant() tenant: RequestTenant,
    @Param('companyId') companyId: string,
  ) {
    return this.service.resetDocuments(tenant.id, companyId);
  }
}
