import { Injectable } from '@nestjs/common';
import { InvoiceDataService } from './services/invoice-data.service';
import { QrBuilder, DgiiEnv } from './services/qr-builder.service';
import { PdfBuilder } from './services/pdf-builder.service';

@Injectable()
export class RepresentacionImpresaService {
  constructor(
    private readonly invoiceData: InvoiceDataService,
    private readonly qrBuilder: QrBuilder,
    private readonly pdfBuilder: PdfBuilder,
  ) {}

  async generatePdf(tenantId: string, invoiceId: string): Promise<Buffer> {
    const invoice = await this.invoiceData.getInvoiceForRi(tenantId, invoiceId);

    const dgiiEnv: DgiiEnv = this.mapEnv(invoice.company.dgiiEnv);

    const qrUrl = this.qrBuilder.buildUrl({
      isRfce: invoice.isRfce,
      dgiiEnv,
      rncEmisor: invoice.company.rnc,
      rncComprador: invoice.buyer?.rnc || invoice.buyerRnc || undefined,
      encf: invoice.encf!,
      fechaEmision: invoice.createdAt,
      montoTotal: invoice.totalAmount,
      fechaFirma: invoice.signedAt!,
      codigoSeguridad: invoice.securityCode!,
    });

    const qrImage = await this.qrBuilder.buildImage(qrUrl, 300);

    return this.pdfBuilder.build(invoice, qrImage);
  }

  private mapEnv(prismaEnv: string): DgiiEnv {
    switch (prismaEnv) {
      case 'PROD': return 'PROD';
      case 'CERT': return 'CERT';
      default:     return 'DEV';
    }
  }
}
