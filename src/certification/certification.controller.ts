import {
  Controller,
  Post,
  Get,
  Param,
  Query,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Body,
  Res,
  HttpCode,
  HttpStatus,
  BadRequestException,
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
        // Fix 4q: optional list of eNCF sequences to skip from the upload.
        // Comma-separated, case-insensitive. Whitespace tolerated. Use case:
        // DGII certification has consumed a sequence in a prior submission,
        // so re-sending it would fail with "secuencia ya utilizada" and
        // reset the entire portal counter. Skipping those rows lets the
        // remaining viable invoices process cleanly in a single upload.
        skipEncfs: {
          type: 'string',
          description: 'eNCFs a omitir (separados por coma). Ej: E320000000006,E460000000009',
          example: 'E320000000006,E460000000009,E330000000001,E340000000018',
          required: false,
        } as any,
      },
      required: ['file', 'companyId'],
    },
  })
  async uploadExcel(
    @CurrentTenant() tenant: RequestTenant,
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body('companyId') companyId: string,
    @Body('skipEncfs') skipEncfs?: string,
  ) {
    if (!file) {
      return { success: false, message: 'Archivo no encontrado en el request (campo: file)' };
    }
    if (!companyId) {
      return { success: false, message: 'companyId es obligatorio' };
    }

    // Parse and normalize: trim, uppercase, drop empties. Keep raw string
    // out of the service layer — pass a clean Set for O(1) lookup.
    const skipSet = new Set<string>(
      (skipEncfs ?? '')
        .split(',')
        .map(s => s.trim().toUpperCase())
        .filter(Boolean),
    );

    return this.certService.uploadExcel(
      tenant.id,
      companyId,
      file.buffer,
      file.originalname,
      skipSet,
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

  // -----------------------------------------------------------------------
  // Fix 4r: Descargar ZIP con XMLs ECF de las E32 resumidas como RFCE.
  // -----------------------------------------------------------------------
  // Usado para la segunda parte del Paso 2 de certificación DGII:
  // "Facturas de Consumo < 250 Mil" que requiere subir cada XML íntegro
  // de las E32 cuyo Resumen (RFCE) ya fue aceptado por DGII.
  //
  // Selecciona: E32 + isRfce=true + status=ACCEPTED + xmlSigned no nulo.
  // No modifica datos; pura lectura.
  // -----------------------------------------------------------------------

  @Get('rfce-source-xmls/zip')
  @RequireScopes(ApiKeyScope.INVOICES_READ)
  @ApiOperation({
    summary:
      'Descargar ZIP con XMLs íntegros (ECF) de las E32 resumidas como RFCE — para subir al portal DGII "Facturas de Consumo < 250 Mil"',
  })
  async downloadRfceSourceZip(
    @CurrentTenant() tenant: RequestTenant,
    @Query('companyId') companyId: string,
    @Res() res: Response,
  ) {
    if (!companyId) {
      throw new BadRequestException('companyId es obligatorio (query param)');
    }

    const zipBuffer = await this.certService.buildRfceSourceZip(tenant.id, companyId);

    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="rfce-source-xmls.zip"`,
      'Content-Length': String(zipBuffer.length),
    });
    res.send(zipBuffer);
  }
}
