import { Controller, Get, Param, Query, Res, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
} from '@nestjs/swagger';
import { Response } from 'express';
import { PdfService } from './pdf.service';
import { ApiKeyGuard } from '../common/guards/api-key.guard';
import { RequireScopes } from '../common/decorators/scopes.decorator';
import { CurrentTenant, RequestTenant } from '../common/decorators/tenant.decorator';
import { ApiKeyScope } from '@prisma/client';
import { ApiReadErrors, ApiNotFoundError } from '../common/swagger/api-errors';

const INVOICE_ID_PARAM = ApiParam({
  name: 'id',
  description: 'UUID de la factura',
  format: 'uuid',
  example: 'clng9x0010000vwc0l5s1234',
});

@ApiTags('invoices')
@Controller('invoices')
@UseGuards(ApiKeyGuard)
@ApiBearerAuth('api-key')
export class PdfController {
  constructor(private readonly pdfService: PdfService) {}

  @Get(':id/preview')
  @RequireScopes(ApiKeyScope.INVOICES_READ)
  @ApiOperation({
    summary: 'Vista previa HTML de la Representación Impresa',
    description: 'Genera el HTML de la RI para visualización en browser.',
  })
  @INVOICE_ID_PARAM
  @ApiResponse({ status: 200, description: 'HTML de la Representación Impresa', schema: { type: 'string' } })
  @ApiReadErrors()
  @ApiNotFoundError('Factura')
  async preview(
    @CurrentTenant() tenant: RequestTenant,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const html = await this.pdfService.generateHtml(tenant.id, id);
    res.set('Content-Type', 'text/html');
    res.send(html);
  }

  @Get(':id/pdf')
  @RequireScopes(ApiKeyScope.INVOICES_READ)
  @ApiOperation({
    summary: 'Descargar PDF de la Representación Impresa',
    description:
      'Sin parámetros o `?format=pdf`: genera un PDF binario server-side (application/pdf). ' +
      'Con `?format=html`: devuelve HTML con barra de impresión para que el usuario guarde como PDF desde el browser.',
  })
  @INVOICE_ID_PARAM
  @ApiQuery({
    name: 'format',
    required: false,
    enum: ['pdf', 'html'],
    description: '`pdf` (default) = PDF binario server-side | `html` = HTML + ventana de impresión',
    example: 'pdf',
  })
  @ApiResponse({ status: 200, description: 'PDF binario (application/pdf) o HTML imprimible (text/html)' })
  @ApiReadErrors()
  @ApiNotFoundError('Factura')
  async downloadPdf(
    @CurrentTenant() tenant: RequestTenant,
    @Param('id') id: string,
    @Query('format') format: string = 'pdf',
    @Res() res: Response,
  ) {
    if (format === 'html') {
      const html = await this.pdfService.generatePrintableHtml(tenant.id, id);
      res.set('Content-Type', 'text/html');
      return res.send(html);
    }

    const buffer = await this.pdfService.generatePdfBuffer(tenant.id, id);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${id}.pdf"`,
      'Content-Length': String(buffer.length),
    });
    return res.send(buffer);
  }
}
