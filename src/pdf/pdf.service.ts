import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { SigningService } from '../signing/signing.service';
import { ECF_TYPE_NAMES, FC_FULL_SUBMISSION_THRESHOLD } from '../xml-builder/ecf-types';

/**
 * PDF / RI generation service.
 *
 * Generates Representación Impresa per DGII Informe Técnico:
 * - QR Code con URL exacta DGII (estándar o FC < 250K)
 * - Código de Seguridad (primeros 6 hex del hash del SignatureValue)
 * - FechaHoraFirma digital
 * - Campos completos según tipo de e-CF
 *
 * Updated: Correct QR URL, security code, NC/ND reference display
 */
@Injectable()
export class PdfService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly signingService: SigningService,
    @InjectPinoLogger(PdfService.name)
    private readonly logger: PinoLogger,
  ) {}

  async generateHtml(tenantId: string, invoiceId: string): Promise<string> {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, tenantId },
      include: {
        lines: { orderBy: { lineNumber: 'asc' } },
        company: true,
      },
    });

    if (!invoice) throw new NotFoundException('Factura no encontrada');

    const typeCode = parseInt(invoice.ecfType.replace('E', ''), 10);
    const ecfTypeName = ECF_TYPE_NAMES[typeCode] || invoice.ecfType;

    // Determine if this is a fiscally valid document
    const isAccepted = invoice.status === 'ACCEPTED';
    const isDraft = invoice.status === 'DRAFT';
    const statusLabel = this.getStatusLabel(invoice.status);

    // QR URL per DGII spec
    const isFcUnder250k = invoice.ecfType === 'E32' &&
      Number(invoice.totalAmount) < FC_FULL_SUBMISSION_THRESHOLD;

    const qrUrl = this.signingService.buildQrUrl({
      rncEmisor: invoice.company.rnc,
      rncComprador: invoice.buyerRnc || '',
      encf: invoice.encf || '',
      fechaEmision: invoice.createdAt,
      montoTotal: Number(invoice.totalAmount),
      fechaFirma: invoice.signedAt || invoice.createdAt,
      securityCode: invoice.securityCode || '000000',
      isFcUnder250k,
      dgiiEnv: invoice.company.dgiiEnv,
    });

    const securityCode = invoice.securityCode || 'N/A';
    const signDate = invoice.signedAt
      ? this.fmtDateTime(new Date(invoice.signedAt))
      : 'No firmado';

    // Extract RI-mandatory fields from metadata (stored from original DTO)
    const meta = typeof invoice.metadata === 'object' && invoice.metadata !== null
      ? (invoice.metadata as any)
      : {};
    const originalDto = meta._originalDto || {};
    const fechaVencSecuencia = originalDto.sequenceExpiresAt
      ? this.fmtDate(new Date(originalDto.sequenceExpiresAt))
      : '';
    const indicadorMontoGravado = originalDto.indicadorMontoGravado ?? 0;
    const tipoIngresos = originalDto.items?.[0]?.incomeType || 1;

    // Reference info for NC/ND
    const isNcNd = typeCode === 33 || typeCode === 34;
    const refInfo = isNcNd && invoice.referenceEncf
      ? `<div class="ref-banner">
           <strong>${typeCode === 34 ? 'NOTA DE CRÉDITO' : 'NOTA DE DÉBITO'}</strong><br>
           NCF Modificado: <strong>${this.esc(invoice.referenceEncf)}</strong><br>
           ${invoice.referenceDate ? `Fecha Original: ${this.fmtDate(new Date(invoice.referenceDate))}` : ''}
         </div>`
      : '';

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <title>RI - ${invoice.encf || 'BORRADOR'}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 12px; color: #333; padding: 20px; max-width: 800px; margin: 0 auto; }
    .header { text-align: center; border-bottom: 2px solid #1a56db; padding-bottom: 15px; margin-bottom: 15px; }
    .header h1 { font-size: 16px; color: #1a56db; margin-bottom: 4px; }
    .header .rnc { font-size: 13px; font-weight: bold; }
    .header .address { font-size: 11px; color: #666; }
    .ecf-section { text-align: center; margin-bottom: 15px; }
    .ecf-section .type { background: #1a56db; color: white; display: inline-block; padding: 4px 12px; border-radius: 4px; font-size: 11px; font-weight: bold; }
    .ecf-section .encf { font-size: 20px; font-weight: bold; font-family: monospace; color: #1a56db; margin: 5px 0; }
    .ref-banner { background: #fff3cd; border: 1px solid #ffc107; border-radius: 6px; padding: 8px 12px; margin: 10px 0; font-size: 11px; }
    .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 15px; margin: 15px 0; }
    .info-box { background: #f8f9fa; border: 1px solid #e9ecef; border-radius: 6px; padding: 10px; }
    .info-box h3 { font-size: 10px; text-transform: uppercase; color: #888; margin-bottom: 6px; letter-spacing: 0.5px; }
    .info-box p { font-size: 12px; margin-bottom: 3px; }
    .label { color: #666; }
    .value { font-weight: 600; }
    table { width: 100%; border-collapse: collapse; margin: 15px 0; }
    thead th { background: #1a56db; color: white; padding: 8px 6px; text-align: left; font-size: 10px; text-transform: uppercase; }
    tbody td { padding: 6px; border-bottom: 1px solid #eee; font-size: 11px; }
    tbody tr:nth-child(even) { background: #f8f9fa; }
    .text-right { text-align: right; }
    .totals { margin-left: auto; width: 300px; margin-top: 10px; }
    .totals .row { display: flex; justify-content: space-between; padding: 4px 0; font-size: 12px; }
    .totals .row.total { border-top: 2px solid #1a56db; font-size: 16px; font-weight: bold; color: #1a56db; padding-top: 8px; margin-top: 5px; }
    .footer { margin-top: 20px; border-top: 1px solid #ddd; padding-top: 15px; display: flex; justify-content: space-between; align-items: flex-start; }
    .qr-section { text-align: center; min-width: 150px; }
    .qr-section img { width: 130px; height: 130px; }
    .qr-section .security-code { font-family: monospace; font-size: 18px; font-weight: bold; color: #1a56db; margin-top: 6px; letter-spacing: 2px; }
    .qr-section .code-label { font-size: 9px; color: #888; }
    .sign-info { font-size: 11px; line-height: 1.6; }
    .legal { text-align: center; font-size: 9px; color: #999; margin-top: 20px; padding-top: 10px; border-top: 1px dashed #ddd; }
    .watermark { position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%) rotate(-35deg); font-size: 80px; font-weight: bold; color: rgba(255, 0, 0, 0.08); pointer-events: none; z-index: 0; white-space: nowrap; letter-spacing: 5px; }
    .status-banner { text-align: center; padding: 8px; border-radius: 6px; font-size: 12px; font-weight: 600; margin-bottom: 15px; }
    .status-accepted { background: #d1fae5; color: #065f46; border: 1px solid #6ee7b7; }
    .status-warning { background: #fef3c7; color: #92400e; border: 1px solid #fcd34d; }
    .status-error { background: #fee2e2; color: #991b1b; border: 1px solid #fca5a5; }
    @media print { body { padding: 0; } .watermark { position: fixed; } }
  </style>
</head>
<body>
  <!-- WATERMARK for non-accepted invoices -->
  ${!isAccepted ? '<div class="watermark">SIN VALIDEZ FISCAL</div>' : ''}

  <!-- STATUS BANNER -->
  ${isAccepted
    ? '<div class="status-banner status-accepted">✅ DOCUMENTO FISCAL VÁLIDO — Aceptado por DGII</div>'
    : `<div class="status-banner ${invoice.status === 'ERROR' || invoice.status === 'REJECTED' ? 'status-error' : 'status-warning'}">⚠️ ${statusLabel} — Este documento NO tiene validez fiscal</div>`
  }

  <!-- ENCABEZADO EMISOR -->
  <div class="header">
    <h1>${this.esc(invoice.company.businessName)}</h1>
    ${invoice.company.tradeName ? `<p>${this.esc(invoice.company.tradeName)}</p>` : ''}
    <p class="rnc">RNC: ${invoice.company.rnc}</p>
    <p class="address">${this.esc(invoice.company.address || '')}</p>
    ${invoice.company.municipality ? `<p class="address">${this.esc(invoice.company.municipality)}${invoice.company.province ? `, ${this.esc(invoice.company.province)}` : ''}</p>` : ''}
    ${invoice.company.phone ? `<p class="address">Tel: ${invoice.company.phone}</p>` : ''}
  </div>

  <!-- TIPO e-CF y eNCF -->
  <div class="ecf-section">
    <span class="type">${ecfTypeName.toUpperCase()}</span>
    <p class="encf">${invoice.encf || 'BORRADOR'}</p>
  </div>

  ${refInfo}

  <!-- INFO COMPRADOR / DOCUMENTO -->
  <div class="info-grid">
    <div class="info-box">
      <h3>Comprador</h3>
      ${invoice.buyerRnc ? `<p><span class="label">RNC:</span> <span class="value">${invoice.buyerRnc}</span></p>` : ''}
      <p><span class="label">Nombre:</span> <span class="value">${this.esc(invoice.buyerName || 'CONSUMIDOR FINAL')}</span></p>
      ${invoice.buyerEmail ? `<p><span class="label">Email:</span> <span class="value">${invoice.buyerEmail}</span></p>` : ''}
    </div>
    <div class="info-box">
      <h3>Documento</h3>
      <p><span class="label">Fecha Emisión:</span> <span class="value">${this.fmtDate(invoice.createdAt)}</span></p>
      ${fechaVencSecuencia ? `<p><span class="label">Venc. Secuencia:</span> <span class="value">${fechaVencSecuencia}</span></p>` : ''}
      <p><span class="label">Tipo Ingreso:</span> <span class="value">${this.getIncomeTypeName(tipoIngresos)}</span></p>
      <p><span class="label">Moneda:</span> <span class="value">${invoice.currency}${invoice.exchangeRate ? ` (TC: ${Number(invoice.exchangeRate).toFixed(4)})` : ''}</span></p>
      <p><span class="label">Forma Pago:</span> <span class="value">${this.getPaymentName(invoice.paymentType)}</span></p>
      <p><span class="label">Monto Gravado:</span> <span class="value">${indicadorMontoGravado === 1 ? 'Incluye ITBIS' : 'No incluye ITBIS'}</span></p>
      ${invoice.trackId ? `<p><span class="label">Track ID:</span> <span class="value">${invoice.trackId}</span></p>` : ''}
    </div>
  </div>

  <!-- DETALLE DE ITEMS -->
  <table>
    <thead>
      <tr>
        <th>#</th>
        <th>Descripción</th>
        <th class="text-right">Cant.</th>
        <th class="text-right">Precio</th>
        <th class="text-right">ITBIS</th>
        <th class="text-right">Subtotal</th>
      </tr>
    </thead>
    <tbody>
      ${invoice.lines.map((line: any) => `
        <tr>
          <td>${line.lineNumber}</td>
          <td>${this.esc(line.description)}</td>
          <td class="text-right">${Number(line.quantity).toLocaleString('es-DO')}</td>
          <td class="text-right">${this.fmtMoney(line.unitPrice)}</td>
          <td class="text-right">${Number(line.itbisRate) === 0 ? '<span style="color:#888">E</span>' : this.fmtMoney(line.itbisAmount)}</td>
          <td class="text-right">${this.fmtMoney(line.subtotal)}</td>
        </tr>`).join('\n')}
    </tbody>
  </table>

  <!-- TOTALES -->
  <div class="totals">
    <div class="row"><span>Subtotal:</span><span>${this.fmtMoney(invoice.subtotal)}</span></div>
    ${Number(invoice.totalDiscount) > 0 ? `<div class="row"><span>Descuento:</span><span>-${this.fmtMoney(invoice.totalDiscount)}</span></div>` : ''}
    <div class="row"><span>ITBIS:</span><span>${this.fmtMoney(invoice.totalItbis)}</span></div>
    <div class="row total"><span>TOTAL ${invoice.currency}:</span><span>${this.fmtMoney(invoice.totalAmount)}</span></div>
  </div>

  <!-- PIE: QR + CÓDIGO SEGURIDAD + FIRMA -->
  <div class="footer">
    <div class="sign-info">
      <p><strong>Firma Digital</strong></p>
      <p>Fecha y Hora Firma: ${signDate}</p>
      <p>Estado DGII: ${invoice.status}</p>
      ${invoice.trackId ? `<p>TrackId: ${invoice.trackId}</p>` : ''}
      <p style="margin-top: 8px; font-size: 10px; color: #666;">
        Documento firmado digitalmente<br>
        conforme Ley 32-23 de Facturación Electrónica
      </p>
    </div>
    <div class="qr-section">
      <img src="https://api.qrserver.com/v1/create-qr-code/?size=130x130&qzone=1&ecc=M&data=${encodeURIComponent(qrUrl)}" alt="QR DGII">
      <p class="code-label">Código de Seguridad</p>
      <p class="security-code">${securityCode}</p>
      <p class="code-label" style="margin-top: 4px;">Verificar en dgii.gov.do</p>
    </div>
  </div>

  <div class="legal">
    ${isAccepted
      ? '<p>Representación Impresa de Comprobante Fiscal Electrónico (e-CF)</p><p>Documento firmado digitalmente conforme Ley 32-23 | Conservar por 10 años</p>'
      : '<p>⚠️ BORRADOR — Este documento NO es un comprobante fiscal válido</p><p>No tiene firma digital ni ha sido aceptado por la DGII</p>'
    }
  </div>
</body>
</html>`;

    this.logger.debug(`Generated HTML RI for invoice ${invoiceId}`);
    return html;
  }

  /**
   * Generate a print-optimized HTML page that auto-triggers the browser's
   * print dialog (Save as PDF). No server-side dependencies needed.
   */
  async generatePrintableHtml(tenantId: string, invoiceId: string): Promise<string> {
    const html = await this.generateHtml(tenantId, invoiceId);

    // Wrap the existing HTML in a print-ready page with auto-print
    const printHtml = html
      .replace('</style>', `
    /* Print-specific overrides */
    @media print {
      body { padding: 0; margin: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .header { border-bottom-color: #1a56db !important; }
      thead th { background: #1a56db !important; color: white !important; -webkit-print-color-adjust: exact; }
      .ecf-section .type { background: #1a56db !important; color: white !important; }
      .no-print { display: none !important; }
    }
    .print-bar { 
      position: fixed; top: 0; left: 0; right: 0; z-index: 1000;
      background: #1a56db; color: white; padding: 10px 20px;
      display: flex; justify-content: space-between; align-items: center;
      font-family: 'Segoe UI', Arial, sans-serif; font-size: 14px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.15);
    }
    .print-bar button {
      background: white; color: #1a56db; border: none; padding: 8px 20px;
      border-radius: 6px; font-weight: 600; cursor: pointer; font-size: 14px;
    }
    .print-bar button:hover { background: #e8edfb; }
    body { padding-top: 60px; }
    @media print { body { padding-top: 0; } .print-bar { display: none; } }
    </style>`)
      .replace('<body>', `<body>
    <div class="print-bar no-print">
      <span>📄 Representación Impresa — Guardar como PDF con Ctrl+P / ⌘P</span>
      <button onclick="window.print()">🖨️ Imprimir / Guardar PDF</button>
    </div>`)
      .replace('</body>', `
    <script>
      // Auto-trigger print dialog after QR loads
      window.addEventListener('load', function() {
        const img = document.querySelector('.qr-section img');
        if (img && !img.complete) {
          img.onload = function() { setTimeout(function() { window.print(); }, 300); };
        } else {
          setTimeout(function() { window.print(); }, 500);
        }
      });
    </script>
  </body>`);

    return printHtml;
  }

  // ============================================================
  // HELPERS
  // ============================================================

  private getIncomeTypeName(type: number): string {
    const names: Record<number, string> = {
      1: 'Operacional', 2: 'Financieros', 3: 'Extraordinarios',
      4: 'Arrendamientos', 5: 'Venta Activos', 6: 'Otros',
    };
    return names[type] || `${type}`;
  }

  private getPaymentName(type: number | null): string {
    const names: Record<number, string> = {
      1: 'Efectivo', 2: 'Cheque/Transferencia', 3: 'Tarjeta',
      4: 'Crédito', 5: 'Bonos', 6: 'Permuta',
      7: 'Nota de Crédito', 8: 'Mixto', 9: 'Otro',
    };
    return type ? names[type] || 'N/A' : 'N/A';
  }

  private getStatusLabel(status: string): string {
    const labels: Record<string, string> = {
      DRAFT: 'BORRADOR — Pendiente de envío',
      PROCESSING: 'EN PROCESO — Enviando a DGII',
      SENT: 'ENVIADO — Esperando respuesta DGII',
      ACCEPTED: 'ACEPTADO POR DGII',
      REJECTED: 'RECHAZADO POR DGII',
      CONDITIONAL: 'ACEPTADO CONDICIONAL',
      VOIDED: 'ANULADO',
      CONTINGENCY: 'CONTINGENCIA — Envío pendiente',
      ERROR: 'ERROR — Envío fallido',
    };
    return labels[status] || status;
  }

  private fmtDate(date: Date | string): string {
    const d = new Date(date);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
  }

  private fmtDateTime(date: Date): string {
    const dd = String(date.getDate()).padStart(2, '0');
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const yyyy = date.getFullYear();
    const hh = String(date.getHours()).padStart(2, '0');
    const mi = String(date.getMinutes()).padStart(2, '0');
    const ss = String(date.getSeconds()).padStart(2, '0');
    return `${dd}-${mm}-${yyyy} ${hh}:${mi}:${ss}`;
  }

  private fmtMoney(amount: any): string {
    return `RD$${Number(amount).toLocaleString('es-DO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  private esc(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}
