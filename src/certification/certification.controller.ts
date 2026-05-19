import {
  Controller,
  Post,
  Get,
  Param,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Body,
  Res,
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
import { Response } from 'express';
import { CertificationService } from './certification.service';
import { ApiKeyGuard } from '../common/guards/api-key.guard';
import { RequireScopes } from '../common/decorators/scopes.decorator';
import { CurrentTenant, RequestTenant } from '../common/decorators/tenant.decorator';
import { ApiKeyScope } from '@prisma/client';

@ApiTags('certification')
@Controller('certification')
@UseGuards(ApiKeyGuard)
@ApiBearerAuth('api-key')
export class CertificationController {
  constructor(private readonly certService: CertificationService) {}

  // -----------------------------------------------------------------------
  // 1. Upload Excel → create all invoices
  // -----------------------------------------------------------------------

  @Post('upload-excel')
  @HttpCode(HttpStatus.CREATED)
  @RequireScopes(ApiKeyScope.INVOICES_WRITE)
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'Subir Excel de set de pruebas DGII y crear facturas' })
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
    if (!file) {
      return { success: false, message: 'Archivo no encontrado en el request (campo: file)' };
    }
    if (!companyId) {
      return { success: false, message: 'companyId es obligatorio' };
    }

    return this.certService.uploadExcel(
      tenant.id,
      companyId,
      file.buffer,
      file.originalname,
    );
  }

  // -----------------------------------------------------------------------
  // 2. Polling de estado del upload
  // -----------------------------------------------------------------------

  @Get('uploads/:uploadId/status')
  @RequireScopes(ApiKeyScope.INVOICES_READ)
  @ApiOperation({ summary: 'Consultar estado del upload (polling cada 2-3 s desde el frontend)' })
  async getUploadStatus(
    @CurrentTenant() tenant: RequestTenant,
    @Param('uploadId') uploadId: string,
  ) {
    return this.certService.getUploadStatus(tenant.id, uploadId);
  }

  // -----------------------------------------------------------------------
  // 3. Descargar XML firmado individual
  // -----------------------------------------------------------------------

  @Get('download/:invoiceId')
  @RequireScopes(ApiKeyScope.INVOICES_READ)
  @ApiOperation({ summary: 'Descargar XML firmado de una factura individual' })
  async downloadXml(
    @CurrentTenant() tenant: RequestTenant,
    @Param('invoiceId') invoiceId: string,
    @Res() res: Response,
  ) {
    const { xml, encf } = await this.certService.getSignedXml(tenant.id, invoiceId);

    res.set({
      'Content-Type': 'application/xml; charset=utf-8',
      'Content-Disposition': `attachment; filename="${encf}_firmado.xml"`,
    });
    res.send(xml);
  }

  // -----------------------------------------------------------------------
  // 4. Descargar ZIP con todos los XMLs del upload
  // -----------------------------------------------------------------------

  @Get('uploads/:uploadId/download-zip')
  @RequireScopes(ApiKeyScope.INVOICES_READ)
  @ApiOperation({ summary: 'Descargar ZIP con todos los XMLs firmados del upload' })
  async downloadZip(
    @CurrentTenant() tenant: RequestTenant,
    @Param('uploadId') uploadId: string,
    @Res() res: Response,
  ) {
    const zipBuffer = await this.certService.buildZip(tenant.id, uploadId);

    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="certification-${uploadId}.zip"`,
      'Content-Length': String(zipBuffer.length),
    });
    res.send(zipBuffer);
  }
}
