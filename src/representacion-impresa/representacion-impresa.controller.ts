import { Controller, Get, Param, Res } from '@nestjs/common';
import { Response } from 'express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { RepresentacionImpresaService } from './representacion-impresa.service';
import { CurrentTenant, RequestTenant } from '../common/decorators/tenant.decorator';
import { RequireScopes } from '../common/decorators/scopes.decorator';
import { ApiKeyScope } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@ApiTags('representacion-impresa')
@Controller('representacion-impresa')
export class RepresentacionImpresaController {
  constructor(
    private readonly service: RepresentacionImpresaService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * GET /api/v1/representacion-impresa/invoice/:invoiceId/pdf
   * Devuelve el PDF de la Representación Impresa inline.
   */
  @Get('invoice/:invoiceId/pdf')
  @RequireScopes(ApiKeyScope.INVOICES_READ)
  @ApiOperation({ summary: 'Generar PDF de Representación Impresa de un e-CF' })
  async generatePdf(
    @CurrentTenant() tenant: RequestTenant,
    @Param('invoiceId') invoiceId: string,
    @Res() res: Response,
  ) {
    const pdfBuffer = await this.service.generatePdf(tenant.id, invoiceId);

    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, tenantId: tenant.id },
      select: { encf: true },
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${invoice?.encf || invoiceId}.pdf"`,
    );
    res.setHeader('Content-Length', pdfBuffer.length);
    res.end(pdfBuffer);
  }
}
