import { Injectable } from '@nestjs/common';
import type PDFDocumentType from 'pdfkit';
// pdfkit is a CommonJS module; `import default` resolves to `.default` under
// ts-jest's ESM interop, which breaks at runtime. Require directly instead.
const PDFDocument: typeof PDFDocumentType = require('pdfkit');
import {
  ECF_TYPE_LABELS,
  MOD_CODE_LABELS,
  TYPES_WITHOUT_EXPIRATION,
  resolveLocationName,
} from '../constants';
import { formatDateDgii, formatDateTimeDgii } from '../helpers/date-formatters';
import { formatCurrency } from '../helpers/currency-formatter';
import { extractXmlField, parseDgiiDate } from '../helpers/xml-extractors';

// ─── Layout constants ────────────────────────────────────────────────────────
const M = 40;          // page margin (pt)
const PAGE_W = 595;    // A4 width
const RIGHT = PAGE_W - M;  // right content edge = 555

// Header two-column split
const HDR_L_W = 255;
const HDR_R_X = M + HDR_L_W + 5;  // 300
const HDR_R_W = RIGHT - HDR_R_X;  // 255

// Items-table column positions and widths
const COL = {
  cant:   { x: M,       w: 30  },
  desc:   { x: M + 33,  w: 177 },  // 73..250
  um:     { x: M + 213, w: 36  },  // 253..289
  precio: { x: M + 252, w: 72  },  // 292..364  right-align
  itbis:  { x: M + 327, w: 72  },  // 367..439  right-align
  valor:  { x: M + 402, w: 113 },  // 442..555  right-align
};

// Totals block (right side, absolute)
const TOT_LBL_X = 320;
const TOT_LBL_W = 115;
const TOT_VAL_X = 438;
const TOT_VAL_W = 117;  // ends at 555

// QR block
const QR_SIZE = 90;  // ~32 mm — above the 22 mm DGII minimum

@Injectable()
export class PdfBuilder {
  async build(invoice: any, qrImage: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];

      const doc = new PDFDocument({
        size: 'A4',
        margins: { top: M, bottom: M, left: M, right: M },
        info: {
          Title: `Representación Impresa ${invoice.encf}`,
          Author: invoice.company.businessName,
          Creator: 'ecf-api',
        },
        autoFirstPage: true,
        bufferPages: true,
      });

      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      try {
        let y = M;
        y = this.drawHeader(doc, invoice, y);
        y = this.drawSep(doc, y);
        y = this.drawClient(doc, invoice, y);
        y = this.drawSep(doc, y);
        y = this.drawItemsTable(doc, invoice, y);
        y = this.drawSep(doc, y);
        this.drawBottomSection(doc, invoice, qrImage, y);
        this.stampPageNumbers(doc);
        doc.end();
      } catch (err) {
        reject(err);
      }
    });
  }

  // ─── Header ────────────────────────────────────────────────────────────────

  private drawHeader(doc: PDFKit.PDFDocument, invoice: any, startY: number): number {
    const ecfTypeCode = invoice.ecfType.replace('E', '');
    const typeLabel = ECF_TYPE_LABELS[ecfTypeCode] || `e-CF ${ecfTypeCode}`;
    const isWithoutExpiration = TYPES_WITHOUT_EXPIRATION.has(ecfTypeCode);
    const company = invoice.company;

    // ── Left column ──────────────────────────────────────────────────────────
    let lY = startY;

    const tradeName = company.tradeName?.trim();
    const businessName = company.businessName?.trim();
    const showTrade = tradeName && tradeName !== businessName;

    if (showTrade) {
      doc.fontSize(11).font('Helvetica-Bold');
      doc.text(tradeName, M, lY, { width: HDR_L_W });
      lY = doc.y;
    }

    doc.fontSize(10).font(showTrade ? 'Helvetica' : 'Helvetica-Bold');
    doc.text(businessName, M, lY, { width: HDR_L_W });
    lY = doc.y;

    doc.fontSize(9).font('Helvetica');

    if (company.address?.trim()) {
      doc.text(company.address.trim(), M, lY, { width: HDR_L_W });
      lY = doc.y;
    }

    const cityLine = this.buildCityLine(company.municipality, company.province);
    if (cityLine) {
      doc.text(cityLine, M, lY, { width: HDR_L_W });
      lY = doc.y;
    }

    doc.text(`RNC: ${company.rnc}`, M, lY, { width: HDR_L_W });
    lY = doc.y;

    const xmlFechaEmision = parseDgiiDate(extractXmlField(invoice.xmlSigned ?? '', 'FechaEmision'));
    const fechaEmisionDate = xmlFechaEmision ?? invoice.createdAt;
    doc.text(`Fecha de Emisión: ${formatDateDgii(fechaEmisionDate)}`, M, lY, { width: HDR_L_W });
    lY = doc.y;

    // ── Right column (drawn at same startY) ──────────────────────────────────
    let rY = startY;

    doc.fontSize(11).font('Helvetica-Bold');
    doc.text(typeLabel, HDR_R_X, rY, { width: HDR_R_W, align: 'right' });
    rY = doc.y;

    doc.fontSize(9).font('Helvetica');
    rY += 4;

    doc.text(`e-NCF: ${invoice.encf}`, HDR_R_X, rY, { width: HDR_R_W, align: 'right' });
    rY = doc.y;

    if (!isWithoutExpiration) {
      const fechaVenc = this.getFechaVencimiento(invoice);
      doc.text(`Fecha Vencimiento: ${fechaVenc}`, HDR_R_X, rY, { width: HDR_R_W, align: 'right' });
      rY = doc.y;
    }

    if (invoice.referenceEncf && ['33', '34'].includes(ecfTypeCode)) {
      doc.text(`e-NCF Modificado: ${invoice.referenceEncf}`, HDR_R_X, rY, {
        width: HDR_R_W,
        align: 'right',
      });
      rY = doc.y;
      if (invoice.referenceModCode) {
        const modLabel = MOD_CODE_LABELS[invoice.referenceModCode] ?? `Código ${invoice.referenceModCode}`;
        doc.text(`Cód. Modificación: ${modLabel}`, HDR_R_X, rY, { width: HDR_R_W, align: 'right' });
        rY = doc.y;
      }
    }

    return Math.max(lY, rY) + 4;
  }

  private buildCityLine(municipality: string | null, province: string | null): string {
    const mun = resolveLocationName(municipality);
    const prov = resolveLocationName(province);
    const parts: string[] = [];
    if (mun) parts.push(mun);
    if (prov && prov !== mun) parts.push(prov);
    if (parts.length) parts.push('Rep. Dom.');
    return parts.join(', ');
  }

  private getFechaVencimiento(invoice: any): string {
    // Read directly from the signed XML — that is what DGII has on file.
    const xmlValue = extractXmlField(invoice.xmlSigned ?? '', 'FechaVencimientoSecuencia');
    if (xmlValue) return xmlValue;

    // Fallback: derive from createdAt (should never be reached for signed invoices).
    const year = invoice.createdAt
      ? new Date(invoice.createdAt).getFullYear()
      : new Date().getFullYear();
    return `31-12-${year + 1}`;
  }

  // ─── Separator ─────────────────────────────────────────────────────────────

  private drawSep(doc: PDFKit.PDFDocument, y: number): number {
    doc.moveTo(M, y).lineTo(RIGHT, y).stroke();
    return y + 6;
  }

  // ─── Client block ──────────────────────────────────────────────────────────

  private drawClient(doc: PDFKit.PDFDocument, invoice: any, startY: number): number {
    const ecfTypeCode = invoice.ecfType.replace('E', '');
    const isRfce = invoice.isRfce || (ecfTypeCode === '32' && Number(invoice.totalAmount) < 250000);

    if (isRfce) return startY;

    let y = startY;
    doc.fontSize(10).font('Helvetica-Bold');
    doc.text('Cliente:', M, y, { width: HDR_L_W });
    y = doc.y;

    doc.fontSize(9).font('Helvetica');
    const name = invoice.buyer?.name ?? invoice.buyerName ?? '';
    const rnc  = invoice.buyer?.rnc  ?? invoice.buyerRnc  ?? '';
    if (name) { doc.text(`Razón Social: ${name}`, M, y); y = doc.y; }
    if (rnc)  { doc.text(`RNC / Cédula: ${rnc}`, M, y); y = doc.y; }

    return y + 4;
  }

  // ─── Items table ───────────────────────────────────────────────────────────

  private drawItemsTable(doc: PDFKit.PDFDocument, invoice: any, startY: number): number {
    let y = startY;

    // Header row
    doc.fontSize(8).font('Helvetica-Bold');
    doc.text('Cant.',       COL.cant.x,   y, { width: COL.cant.w  });
    doc.text('Descripción', COL.desc.x,   y, { width: COL.desc.w  });
    doc.text('U/M',         COL.um.x,     y, { width: COL.um.w    });
    doc.text('Precio',      COL.precio.x, y, { width: COL.precio.w, align: 'right' });
    doc.text('ITBIS',       COL.itbis.x,  y, { width: COL.itbis.w,  align: 'right' });
    doc.text('Valor',       COL.valor.x,  y, { width: COL.valor.w,  align: 'right' });

    y = doc.y + 2;
    doc.moveTo(M, y).lineTo(RIGHT, y).stroke();
    y += 3;

    // Data rows
    doc.font('Helvetica').fontSize(8);
    for (const line of invoice.lines) {
      const rowY = y;
      const desc = this.lineDescription(line);
      const um   = this.lineUm(line);

      doc.text(this.fmtQty(line.quantity), COL.cant.x,   rowY, { width: COL.cant.w   });
      doc.text(desc,                        COL.desc.x,   rowY, { width: COL.desc.w   });
      doc.text(um,                          COL.um.x,     rowY, { width: COL.um.w     });
      doc.text(formatCurrency(line.unitPrice),   COL.precio.x, rowY, { width: COL.precio.w, align: 'right' });
      doc.text(formatCurrency(line.itbisAmount), COL.itbis.x,  rowY, { width: COL.itbis.w,  align: 'right' });
      doc.text(formatCurrency(line.subtotal),    COL.valor.x,  rowY, { width: COL.valor.w,  align: 'right' });

      y = doc.y + 2;
    }

    return y + 2;
  }

  private lineDescription(line: any): string {
    const desc = line.description ?? '';
    const isExempt = line.indicadorFacturacion === 2
      || (line.itbisRate !== undefined && Number(line.itbisRate) === 0 && Number(line.itbisAmount) === 0);
    return isExempt ? `${desc} (E)` : desc;
  }

  private lineUm(line: any): string {
    if (line.unitOfMeasure) return String(line.unitOfMeasure);
    return line.goodService === 2 ? 'SRV' : 'UND';
  }

  private fmtQty(qty: any): string {
    const n = Number(qty);
    return Number.isInteger(n) ? String(n) : n.toFixed(2);
  }

  // ─── Bottom section: QR (left) + Totals (right) ───────────────────────────

  private drawBottomSection(
    doc: PDFKit.PDFDocument,
    invoice: any,
    qrImage: Buffer,
    startY: number,
  ): void {
    const y = startY + 4;

    // ── Totals (right side) ──────────────────────────────────────────────────
    let tY = y;

    const totRows: [string, string][] = [
      ['Subtotal Gravado:', formatCurrency(invoice.subtotal)],
      [`Total ITBIS:`,      formatCurrency(invoice.totalItbis)],
    ];
    if (Number(invoice.totalIsc) > 0) {
      totRows.push(['Total ISC:', formatCurrency(invoice.totalIsc)]);
    }
    if (Number(invoice.totalDiscount) > 0) {
      totRows.push(['Descuento Total:', formatCurrency(invoice.totalDiscount)]);
    }

    doc.fontSize(9).font('Helvetica');
    for (const [label, value] of totRows) {
      doc.text(label, TOT_LBL_X, tY, { width: TOT_LBL_W, align: 'right' });
      doc.text(value, TOT_VAL_X, tY, { width: TOT_VAL_W, align: 'right' });
      tY += 14;
    }

    // Separator before TOTAL
    doc.moveTo(TOT_LBL_X, tY).lineTo(RIGHT, tY).stroke();
    tY += 4;

    doc.fontSize(11).font('Helvetica-Bold');
    doc.text('TOTAL:', TOT_LBL_X, tY, { width: TOT_LBL_W, align: 'right' });
    doc.text(formatCurrency(invoice.totalAmount), TOT_VAL_X, tY, { width: TOT_VAL_W, align: 'right' });

    // ── QR block (left side, same startY) ────────────────────────────────────
    doc.image(qrImage, M, y, { width: QR_SIZE, height: QR_SIZE });

    const textY = y + QR_SIZE + 5;
    doc.fontSize(8).font('Helvetica');
    doc.text(`Código de Seguridad: ${invoice.securityCode}`, M, textY, { width: 220 });
    doc.text(`Fecha de Firma: ${formatDateTimeDgii(invoice.signedAt)}`, M, textY + 12, { width: 220 });
  }

  // ─── Page numbers ──────────────────────────────────────────────────────────

  private stampPageNumbers(doc: PDFKit.PDFDocument): void {
    const pages = doc.bufferedPageRange();
    const total = pages.count;
    for (let i = 0; i < total; i++) {
      doc.switchToPage(pages.start + i);
      // Stay well inside the bottom margin to avoid pdfkit triggering a new page.
      const footerY = doc.page.height - doc.page.margins.bottom - 14;
      doc.fontSize(8).font('Helvetica');
      doc.text(`Página ${i + 1} de ${total}`, M, footerY, { width: RIGHT - M, align: 'right' });
    }
  }
}
