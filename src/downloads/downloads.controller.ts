import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Res,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiParam } from '@nestjs/swagger';
import { Response } from 'express';
import { DownloadTokenService } from '../common/services/download-token.service';
import { InvoicesService } from '../invoices/invoices.service';

/**
 * Public download endpoints — NO ApiKeyGuard.
 *
 * Each route consumes a single-use token previously issued via an
 * authenticated endpoint (e.g. POST /invoices/:id/download-token). The
 * token is atomically GET+DEL'd from Redis on the first request: a replay
 * returns 404.
 *
 * This is how browser-driven downloads work without putting the API key
 * in the URL bar.
 */
@ApiTags('downloads')
@Controller('downloads')
export class DownloadsController {
  constructor(
    private readonly downloadTokens: DownloadTokenService,
    private readonly invoicesService: InvoicesService,
  ) {}

  @Get('invoice-xml/:token')
  @ApiOperation({
    summary: 'Descargar XML de factura via token de un solo uso',
    description:
      'Consume el token (se borra atómicamente en Redis) y devuelve el XML ' +
      'de la factura. Si el token ya fue usado, expiró o nunca existió, ' +
      'responde 404.',
  })
  @ApiParam({ name: 'token', description: 'UUID v4 emitido por POST /invoices/:id/download-token' })
  async getInvoiceXml(@Param('token') token: string, @Res() res: Response) {
    const payload = await this.downloadTokens.consume(token);
    if (!payload || payload.type !== 'invoice-xml') {
      throw new NotFoundException('Token inválido, expirado o ya utilizado.');
    }

    const xml = await this.invoicesService.getXml(payload.tenantId, payload.invoiceId);

    res.set({
      'Content-Type': 'application/xml',
      'Content-Disposition': `attachment; filename="${payload.invoiceId}.xml"`,
      // Tell caches/intermediate proxies to never store this — the token
      // is dead by the time the response is written anyway, but belts +
      // suspenders.
      'Cache-Control': 'no-store',
    });
    res.send(xml);
  }
}
