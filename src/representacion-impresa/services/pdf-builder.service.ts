import { Injectable } from '@nestjs/common';
import type PDFDocumentType from 'pdfkit';
// pdfkit is a CommonJS module; `import default` resolves to `.default` under
// ts-jest's ESM interop, which breaks at runtime. Require directly instead.
const PDFDocument: typeof PDFDocumentType = require('pdfkit');
import { ECF_TYPE_LABELS, MOD_CODE_LABELS, TYPES_WITHOUT_EXPIRATION } from '../constants';
import { formatDate, formatDateTime } from '../helpers/date-formatters';
import { formatCurrency } from '../helpers/currency-formatter';

@Injectable()
export class PdfBuilder {
  async build(invoice: any, qrImage: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];

      const doc = new PDFDocument({
        size: 'A4',
        margin: 50,
        info: {
          Title: `Representación Impresa ${invoice.encf}`,
          Author: invoice.company.businessName,
          Creator: 'ecf-api',
        },
      });

      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      try {
        this.drawHeader(doc, invoice);
        this.drawClient(doc, invoice);
        this.drawItemsTable(doc, invoice);
        this.drawTotals(doc, invoice);
        this.drawQrFooter(doc, invoice, qrImage);
        doc.end();
      } catch (err) {
        reject(err);
      }
    });
  }

  private drawHeader(doc: PDFKit.PDFDocument, invoice: any) {
    const ecfTypeCode = invoice.ecfType.replace('E', '');
    const typeLabel = ECF_TYPE_LABELS[ecfTypeCode] || `e-CF ${ecfTypeCode}`;
    const isWithoutExpiration = TYPES_WITHOUT_EXPIRATION.has(ecfTypeCode);

    const startY = doc.y;

    // LEFT — Emisor
    doc.fontSize(10).font('Helvetica-Bold');
    if (invoice.company.tradeName) {
      doc.text(invoice.company.tradeName, 50, startY);
    }
    doc.font('Helvetica').fontSize(9);
    doc.text(invoice.company.businessName);
    doc.text(`RNC: ${invoice.company.rnc}`);
    if (invoice.company.address) doc.text(invoice.company.address);
    const cityLine = [invoice.company.municipality, invoice.company.province]
      .filter(Boolean)
      .join(', ');
    if (cityLine) doc.text(cityLine);
    doc.text(`Fecha de Emisión: ${formatDate(invoice.createdAt)}`);

    // RIGHT — Tipo + e-NCF
    const rightX = 320;
    doc.fontSize(11).font('Helvetica-Bold');
    doc.text(typeLabel, rightX, startY, { width: 225, align: 'right' });

    doc.fontSize(10).font('Helvetica');
    let rightY = doc.y + 5;
    doc.text(`e-NCF: ${invoice.encf}`, rightX, rightY, { width: 225, align: 'right' });
    rightY = doc.y;

    if (!isWithoutExpiration) {
      const fechaVenc = this.getFechaVencimientoSecuencia(invoice);
      doc.text(`Fecha Vencimiento: ${fechaVenc}`, rightX, rightY, { width: 225, align: 'right' });
      rightY = doc.y;
    }

    if (invoice.referenceEncf && ['33', '34'].includes(ecfTypeCode)) {
      doc.text(`e-NCF Modificado: ${invoice.referenceEncf}`, rightX, rightY, { width: 225, align: 'right' });
      rightY = doc.y;
      if (invoice.referenceModCode) {
        const modLabel = MOD_CODE_LABELS[invoice.referenceModCode] || `Código ${invoice.referenceModCode}`;
        doc.text(`Cód. Modificación: ${modLabel}`, rightX, rightY, { width: 225, align: 'right' });
      }
    }

    doc.moveDown(2);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.5);
  }

  private getFechaVencimientoSecuencia(invoice: any): string {
    // Según norma DGII: 31-12 del año siguiente a la autorización.
    const year = invoice.createdAt
      ? new Date(invoice.createdAt).getFullYear()
      : new Date().getFullYear();
    return `31-12-${year + 1}`;
  }

  private drawClient(doc: PDFKit.PDFDocument, invoice: any) {
    doc.fontSize(10).font('Helvetica-Bold').text('Cliente:');
    doc.font('Helvetica').fontSize(9);

    const clientName = invoice.buyer?.name || invoice.buyerName || '';
    const clientRnc = invoice.buyer?.rnc || invoice.buyerRnc || '';

    if (clientName) doc.text(`Razón Social: ${clientName}`);
    if (clientRnc) doc.text(`RNC: ${clientRnc}`);

    doc.moveDown(0.5);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.5);
  }

  private drawItemsTable(doc: PDFKit.PDFDocument, invoice: any) {
    const tableTop = doc.y;
    const cols = { cant: 50, desc: 90, precio: 360, itbis: 430, valor: 490 };

    doc.fontSize(8).font('Helvetica-Bold');
    doc.text('Cant.', cols.cant, tableTop);
    doc.text('Descripción', cols.desc, tableTop);
    doc.text('Precio', cols.precio, tableTop, { width: 60, align: 'right' });
    doc.text('ITBIS', cols.itbis, tableTop, { width: 50, align: 'right' });
    doc.text('Valor', cols.valor, tableTop, { width: 55, align: 'right' });

    doc.moveDown(0.3);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.3);

    doc.font('Helvetica').fontSize(8);
    for (const line of invoice.lines) {
      const y = doc.y;
      doc.text(String(line.quantity), cols.cant, y, { width: 35 });
      doc.text(line.description, cols.desc, y, { width: 260 });
      doc.text(formatCurrency(line.unitPrice), cols.precio, y, { width: 60, align: 'right' });
      doc.text(formatCurrency(line.itbisAmount), cols.itbis, y, { width: 50, align: 'right' });
      doc.text(formatCurrency(line.subtotal), cols.valor, y, { width: 55, align: 'right' });
      doc.moveDown(0.5);
    }

    doc.moveDown(0.3);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.3);
  }

  private drawTotals(doc: PDFKit.PDFDocument, invoice: any) {
    const totalsX = 380;
    doc.fontSize(9).font('Helvetica');

    const rows: [string, string][] = [
      ['Subtotal Gravado:', formatCurrency(invoice.subtotal)],
      ['Total ITBIS:', formatCurrency(invoice.totalItbis)],
    ];

    if (Number(invoice.totalIsc) > 0) {
      rows.push(['Total ISC:', formatCurrency(invoice.totalIsc)]);
    }
    if (Number(invoice.totalDiscount) > 0) {
      rows.push(['Descuento Total:', formatCurrency(invoice.totalDiscount)]);
    }

    for (const [label, value] of rows) {
      const y = doc.y;
      doc.text(label, totalsX, y, { width: 100, align: 'right' });
      doc.text(value, totalsX + 105, y, { width: 60, align: 'right' });
      doc.moveDown(0.4);
    }

    doc.font('Helvetica-Bold').fontSize(11);
    const y = doc.y;
    doc.text('TOTAL:', totalsX, y, { width: 100, align: 'right' });
    doc.text(formatCurrency(invoice.totalAmount), totalsX + 105, y, { width: 60, align: 'right' });
    doc.font('Helvetica').fontSize(9);

    doc.moveDown(2);
  }

  private drawQrFooter(doc: PDFKit.PDFDocument, invoice: any, qrImage: Buffer) {
    const qrSize = 80; // ~28mm — sobre el mínimo de 22mm requerido por DGII
    const qrX = 57;   // 2cm desde el borde izquierdo (≈57pt)
    const pageHeight = doc.page.height;
    const qrY = pageHeight - 150;

    if (doc.y < qrY - 20) {
      doc.moveTo(50, qrY - 20).lineTo(545, qrY - 20).stroke();
    }

    doc.image(qrImage, qrX, qrY, { width: qrSize, height: qrSize });

    const textY = qrY + qrSize + 5;
    doc.fontSize(8).font('Helvetica');
    doc.text(`Código de Seguridad: ${invoice.securityCode}`, qrX, textY);
    doc.text(`Fecha de Firma: ${formatDateTime(invoice.signedAt)}`, qrX, textY + 12);
  }
}
