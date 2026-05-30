import { Injectable } from '@nestjs/common';
import { InvoiceDataService } from './services/invoice-data.service';
import { QrBuilder, DgiiEnv } from './services/qr-builder.service';
import { PdfBuilder } from './services/pdf-builder.service';
import { extractXmlField, parseDgiiDate } from './helpers/xml-extractors';

@Injectable()
export class RepresentacionImpresaService {
  constructor(
    private readonly invoiceData: InvoiceDataService,
    private readonly qrBuilder: QrBuilder,
    private readonly pdfBuilder: PdfBuilder,
  ) {}

  async generatePdf(tenantId: string, invoiceId: string): Promise<Buffer> {
    const invoice = await this.invoiceData.getInvoiceForRi(tenantId, invoiceId);

    if (!invoice.xmlSigned) {
      throw new Error('Invoice has no signed XML — cannot generate RI');
    }

    const dgiiEnv: DgiiEnv = this.mapEnv(invoice.company.dgiiEnv);

    // FechaEmision comes from the signed XML — that is what DGII stored.
    // Using invoice.createdAt diverges from the signed document and causes
    // the QR consultation to return "No fue encontrada la factura e-CF".
    const xmlFechaEmision = parseDgiiDate(extractXmlField(invoice.xmlSigned, 'FechaEmision'));
    if (!xmlFechaEmision) {
      throw new Error('Could not extract FechaEmision from signed XML');
    }

    // Extract MontoTotal from the signed XML — this is what DGII has on file.
    // The DB column invoice.totalAmount can differ when exempt items are present,
    // causing "No fue encontrada la factura" on QR consultation.
    const xmlMontoTotal = extractXmlField(invoice.xmlSigned, 'MontoTotal');
    if (!xmlMontoTotal) {
      throw new Error('Could not extract MontoTotal from signed XML');
    }

    const qrUrl = this.qrBuilder.buildUrl({
      isRfce: invoice.isRfce,
      dgiiEnv,
      rncEmisor: invoice.company.rnc,
      rncComprador: invoice.buyer?.rnc || invoice.buyerRnc || undefined,
      encf: invoice.encf!,
      fechaEmision: xmlFechaEmision,
      montoTotal: xmlMontoTotal,
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
