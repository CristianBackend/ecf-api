import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import * as QRCode from 'qrcode';
import { PrismaService } from '../prisma/prisma.service';
import { SigningService } from '../signing/signing.service';
import { ECF_TYPE_NAMES, FC_FULL_SUBMISSION_THRESHOLD } from '../xml-builder/ecf-types';
import { fmtDateGmt4, fmtDateTimeGmt4 } from '../common/utils/date-format.util';

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

    const isAccepted = invoice.status === 'ACCEPTED';
    const statusLabel = this.getStatusLabel(invoice.status);

    const isFcUnder250k =
      invoice.ecfType === 'E32' &&
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

    // Generate QR as embedded data URL — no external network dependency
    const qrDataUrl = await QRCode.toDataURL(qrUrl, {
      width: 130,
      margin: 1,
      errorCorrectionLevel: 'M',
    });

    const securityCode = invoice.securityCode || 'N/A';
    const signDate = invoice.signedAt
      ? fmtDateTimeGmt4(new Date(invoice.signedAt))
      : 'No firmado';

    const meta =
      typeof invoice.metadata === 'object' && invoice.metadata !== null
        ? (invoice.metadata as Record<string, any>)
        : {};
    const originalDto = meta._originalDto || {};
    const fechaVencSecuencia = originalDto.sequenceExpiresAt
      ? fmtDateGmt4(new Date(originalDto.sequenceExpiresAt))
      : '';
    const indicadorMontoGravado = originalDto.indicadorMontoGravado ?? 0;
    const tipoIngresos = originalDto.items?.[0]?.incomeType || 1;

    const isNcNd = typeCode === 33 || typeCode === 34;
    const refInfo = isNcNd ? this.buildRefInfo(typeCode, invoice) : '';

    const hasIscLines = invoice.lines.some((l: any) => Number(l.iscAmount) > 0);
    const fiscalLegend = this.getFiscalLegend(invoice.ecfType);

    const isE41 = typeCode === 41;
    const isE46 = typeCode === 46;

    const buyerOrVendorSection = isE41
      ? this.buildVendorSection(invoice, originalDto)
      : this.buildBuyerSection(invoice);

    const exportSections = isE46 ? this.buildExportSections(originalDto) : '';

    const paymentDateHtml = invoice.paymentDate
      ? `<p><span class="label">Fecha Pago:</span> <span class="value">${fmtDateGmt4(invoice.paymentDate)}</span></p>`
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
    .export-section { background: #f0f4ff; border: 1px solid #c7d2fe; border-radius: 6px; padding: 12px; margin: 15px 0; }
    .export-section h3 { font-size: 11px; font-weight: bold; color: #3730a3; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.5px; }
    .export-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 12px; }
    .export-field { font-size: 11px; padding: 2px 0; }
    @media print { body { padding: 0; } .watermark { position: fixed; } }
  </style>
</head>
<body>
  ${!isAccepted ? '<div class="watermark">SIN VALIDEZ FISCAL</div>' : ''}

  <div class="status-banner ${
    isAccepted
      ? 'status-accepted'
      : invoice.status === 'ERROR' || invoice.status === 'REJECTED'
      ? 'status-error'
      : 'status-warning'
  }">
    ${
      isAccepted
        ? '&#x2705; DOCUMENTO FISCAL V&Aacute;LIDO &mdash; Aceptado por DGII'
        : `&#x26A0;&#xFE0F; ${statusLabel} &mdash; Este documento NO tiene validez fiscal`
    }
  </div>

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

  <!-- INFO COMPRADOR/VENDEDOR y DOCUMENTO -->
  <div class="info-grid">
    ${buyerOrVendorSection}
    <div class="info-box">
      <h3>Documento</h3>
      <p><span class="label">Fecha Emisi&oacute;n:</span> <span class="value">${fmtDateGmt4(invoice.createdAt)}</span></p>
      ${fechaVencSecuencia ? `<p><span class="label">Venc. Secuencia:</span> <span class="value">${fechaVencSecuencia}</span></p>` : ''}
      <p><span class="label">Tipo Ingreso:</span> <span class="value">${this.getIncomeTypeName(tipoIngresos)}</span></p>
      <p><span class="label">Moneda:</span> <span class="value">${invoice.currency}${invoice.exchangeRate ? ` (TC: ${Number(invoice.exchangeRate).toFixed(4)})` : ''}</span></p>
      <p><span class="label">Forma Pago:</span> <span class="value">${this.getPaymentName(invoice.paymentType)}</span></p>
      ${paymentDateHtml}
      <p><span class="label">Monto Gravado:</span> <span class="value">${indicadorMontoGravado === 1 ? 'Incluye ITBIS' : 'No incluye ITBIS'}</span></p>
      ${invoice.trackId ? `<p><span class="label">Track ID:</span> <span class="value">${invoice.trackId}</span></p>` : ''}
    </div>
  </div>

  <!-- DETALLE DE ITEMS -->
  <table>
    <thead>
      <tr>
        <th>#</th>
        <th>Descripci&oacute;n</th>
        <th class="text-right">Cant.</th>
        <th class="text-right">Precio</th>
        <th class="text-right">Descuento</th>
        <th class="text-right">ITBIS</th>
        ${hasIscLines ? '<th class="text-right">ISC</th>' : ''}
        <th class="text-right">Subtotal</th>
      </tr>
    </thead>
    <tbody>
      ${invoice.lines
        .map(
          (line: any) => `
        <tr>
          <td>${line.lineNumber}</td>
          <td>${this.esc(line.description)}</td>
          <td class="text-right">${Number(line.quantity).toLocaleString('es-DO')}</td>
          <td class="text-right">${this.fmtMoney(line.unitPrice)}</td>
          <td class="text-right">${Number(line.discount) > 0 ? this.fmtMoney(line.discount) : '&mdash;'}</td>
          <td class="text-right">${Number(line.itbisRate) === 0 ? '<span style="color:#888">E</span>' : this.fmtMoney(line.itbisAmount)}</td>
          ${hasIscLines ? `<td class="text-right">${Number(line.iscAmount) > 0 ? this.fmtMoney(line.iscAmount) : '&mdash;'}</td>` : ''}
          <td class="text-right">${this.fmtMoney(line.subtotal)}</td>
        </tr>`,
        )
        .join('\n')}
    </tbody>
  </table>

  <!-- TOTALES -->
  <div class="totals">
    <div class="row"><span>Subtotal:</span><span>${this.fmtMoney(invoice.subtotal)}</span></div>
    ${Number(invoice.totalDiscount) > 0 ? `<div class="row"><span>Descuento:</span><span>-${this.fmtMoney(invoice.totalDiscount)}</span></div>` : ''}
    <div class="row"><span>ITBIS:</span><span>${this.fmtMoney(invoice.totalItbis)}</span></div>
    ${Number(invoice.totalIsc) > 0 ? `<div class="row"><span>ISC:</span><span>${this.fmtMoney(invoice.totalIsc)}</span></div>` : ''}
    <div class="row total"><span>TOTAL ${invoice.currency}:</span><span>${this.fmtMoney(invoice.totalAmount)}</span></div>
  </div>

  ${exportSections}

  <!-- PIE: QR + CÓDIGO SEGURIDAD + FIRMA -->
  <div class="footer">
    <div class="sign-info">
      <p><strong>Firma Digital</strong></p>
      <p>Fecha y Hora Firma: ${signDate}</p>
      <p>Estado DGII: ${invoice.status}</p>
      ${invoice.trackId ? `<p>TrackId: ${invoice.trackId}</p>` : ''}
      <p style="margin-top: 8px; font-size: 10px; color: #666;">
        Documento firmado digitalmente<br>
        conforme Ley 32-23 de Facturaci&oacute;n Electr&oacute;nica
      </p>
    </div>
    <div class="qr-section">
      <img src="${qrDataUrl}" alt="QR DGII" width="130" height="130">
      <p class="code-label">C&oacute;digo de Seguridad</p>
      <p class="security-code">${securityCode}</p>
      <p class="code-label" style="margin-top: 4px;">Verificar en dgii.gov.do</p>
    </div>
  </div>

  <div class="legal">
    <p class="fiscal-legend"><strong>${this.esc(fiscalLegend)}</strong></p>
    ${
      isAccepted
        ? '<p>Representaci&oacute;n Impresa de Comprobante Fiscal Electr&oacute;nico (e-CF)</p><p>Documento firmado digitalmente conforme Ley 32-23 | Conservar por 10 a&ntilde;os</p>'
        : '<p>&#x26A0;&#xFE0F; BORRADOR &mdash; Este documento NO es un comprobante fiscal v&aacute;lido</p><p>No tiene firma digital ni ha sido aceptado por la DGII</p>'
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

    const printHtml = html
      .replace('</style>', `
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
      <span>&#x1F4C4; Representaci&oacute;n Impresa &mdash; Guardar como PDF con Ctrl+P / &#x2318;P</span>
      <button onclick="window.print()">&#x1F5A8;&#xFE0F; Imprimir / Guardar PDF</button>
    </div>`)
      .replace('</body>', `
    <script>
      window.addEventListener('load', function() {
        setTimeout(function() { window.print(); }, 500);
      });
    </script>
  </body>`);

    return printHtml;
  }

  // ============================================================
  // HTML SECTION BUILDERS
  // ============================================================

  private buildRefInfo(typeCode: number, invoice: any): string {
    if (!invoice.referenceEncf) return '';

    const modCodeHtml =
      invoice.referenceModCode != null
        ? `<br>C&oacute;digo Modificaci&oacute;n: <strong>${this.esc(this.getModCodeName(invoice.referenceModCode))}</strong>`
        : '<br><span style="color:#c0392b">&#x26A0; C&oacute;digo de modificaci&oacute;n no especificado</span>';

    return `<div class="ref-banner">
      <strong>${typeCode === 34 ? 'NOTA DE CR&Eacute;DITO' : 'NOTA DE D&Eacute;BITO'}</strong><br>
      NCF Modificado: <strong>${this.esc(invoice.referenceEncf)}</strong><br>
      ${invoice.referenceDate ? `Fecha Original: ${fmtDateGmt4(new Date(invoice.referenceDate))}` : ''}
      ${modCodeHtml}
    </div>`;
  }

  private buildBuyerSection(invoice: any): string {
    return `<div class="info-box">
      <h3>Comprador</h3>
      ${invoice.buyerRnc ? `<p><span class="label">RNC:</span> <span class="value">${invoice.buyerRnc}</span></p>` : ''}
      <p><span class="label">Nombre:</span> <span class="value">${this.esc(invoice.buyerName || 'CONSUMIDOR FINAL')}</span></p>
      ${invoice.buyerEmail ? `<p><span class="label">Email:</span> <span class="value">${invoice.buyerEmail}</span></p>` : ''}
    </div>`;
  }

  /**
   * For E41 (Comprobante Compras), the relevant party is the vendor/supplier.
   * The buyer columns in the DB store the vendor's data for this type.
   * Checks metadata._originalDto.vendedor first for an explicit override.
   */
  private buildVendorSection(invoice: any, originalDto: any): string {
    const vendedor = originalDto.vendedor || null;
    const vendorRnc = vendedor?.rnc || invoice.buyerRnc || null;
    const vendorName = vendedor?.name || invoice.buyerName || null;

    if (!vendorRnc && !vendorName) {
      return `<div class="info-box">
        <h3>Vendedor / Proveedor</h3>
        <p><span class="value" style="color:#888">Vendedor / Proveedor: informaci&oacute;n no disponible</span></p>
      </div>`;
    }

    return `<div class="info-box">
      <h3>Vendedor / Proveedor</h3>
      ${vendorRnc ? `<p><span class="label">RNC:</span> <span class="value">${vendorRnc}</span></p>` : ''}
      ${vendorName ? `<p><span class="label">Nombre:</span> <span class="value">${this.esc(vendorName)}</span></p>` : ''}
    </div>`;
  }

  /**
   * E46 transport and export info sections.
   * Data sourced from metadata._originalDto.transport and .additionalInfo.
   * TODO: if fields are absent the RI shows [no especificado]. A future migration
   * should promote these fields to dedicated Invoice columns for reliability.
   */
  private buildExportSections(originalDto: any): string {
    const transport = (originalDto.transport as Record<string, any>) || {};
    const addInfo = (originalDto.additionalInfo as Record<string, any>) || {};

    const noSpec = '[no especificado]';

    const viaNames: Record<number, string> = { 1: 'Terrestre', 2: 'Mar&iacute;timo', 3: 'A&eacute;rea' };
    const via = transport.viaTransporte
      ? (viaNames[transport.viaTransporte as number] || String(transport.viaTransporte))
      : noSpec;

    const transportSection = `<div class="export-section">
      <h3>Transporte</h3>
      <div class="export-grid">
        <div class="export-field"><span class="label">Transportista:</span> <span class="value">${this.esc(String(transport.carrierName ?? noSpec))}</span></div>
        <div class="export-field"><span class="label">RNC Transportista:</span> <span class="value">${transport.carrierRnc ?? noSpec}</span></div>
        <div class="export-field"><span class="label">V&iacute;a de Transporte:</span> <span class="value">${via}</span></div>
        <div class="export-field"><span class="label">N&uacute;mero de Viaje:</span> <span class="value">${transport.tripNumber ?? noSpec}</span></div>
        <div class="export-field"><span class="label">Pa&iacute;s de Origen:</span> <span class="value">${transport.countryOrigin ?? noSpec}</span></div>
        <div class="export-field"><span class="label">Pa&iacute;s de Destino:</span> <span class="value">${transport.countryDestination ?? noSpec}</span></div>
        <div class="export-field"><span class="label">Direcci&oacute;n de Destino:</span> <span class="value">${this.esc(String(transport.destinationAddress ?? noSpec))}</span></div>
        <div class="export-field"><span class="label">Peso Bruto:</span> <span class="value">${addInfo.grossWeight != null ? addInfo.grossWeight : noSpec}</span></div>
        <div class="export-field"><span class="label">Peso Neto:</span> <span class="value">${addInfo.netWeight != null ? addInfo.netWeight : noSpec}</span></div>
        <div class="export-field"><span class="label">Volumen:</span> <span class="value">${addInfo.packageVolume != null ? addInfo.packageVolume : noSpec}</span></div>
      </div>
    </div>`;

    const exportInfoSection = `<div class="export-section">
      <h3>Informaci&oacute;n de Exportaci&oacute;n</h3>
      <div class="export-grid">
        <div class="export-field"><span class="label">INCOTERM:</span> <span class="value">${this.esc(String(addInfo.deliveryConditions ?? noSpec))}</span></div>
        <div class="export-field"><span class="label">R&eacute;gimen Aduanero:</span> <span class="value">${this.esc(String(addInfo.customsRegime ?? noSpec))}</span></div>
        <div class="export-field"><span class="label">Puerto de Embarque:</span> <span class="value">${this.esc(String(addInfo.portOfShipment ?? noSpec))}</span></div>
        <div class="export-field"><span class="label">Puerto de Salida:</span> <span class="value">${this.esc(String(addInfo.departurePort ?? noSpec))}</span></div>
        <div class="export-field"><span class="label">Puerto de Desembarque:</span> <span class="value">${this.esc(String(addInfo.arrivalPort ?? noSpec))}</span></div>
        <div class="export-field"><span class="label">Total FOB:</span> <span class="value">${addInfo.totalFob != null ? this.fmtMoney(addInfo.totalFob) : noSpec}</span></div>
        <div class="export-field"><span class="label">Seguro:</span> <span class="value">${addInfo.insurance != null ? this.fmtMoney(addInfo.insurance) : noSpec}</span></div>
        <div class="export-field"><span class="label">Flete:</span> <span class="value">${addInfo.freight != null ? this.fmtMoney(addInfo.freight) : noSpec}</span></div>
        <div class="export-field"><span class="label">Total CIF:</span> <span class="value">${addInfo.totalCif != null ? this.fmtMoney(addInfo.totalCif) : noSpec}</span></div>
        <div class="export-field"><span class="label">Referencia:</span> <span class="value">${this.esc(String(addInfo.referenceNumber ?? noSpec))}</span></div>
      </div>
    </div>`;

    return transportSection + exportInfoSection;
  }

  // ============================================================
  // HELPERS
  // ============================================================

  getFiscalLegend(ecfType: string): string {
    const legends: Record<string, string> = {
      E31: 'El ITBIS facturado forma parte de su crédito fiscal',
      E32: 'No aplica como crédito fiscal ni sustento de costos y gastos',
      E33: 'Nota de Débito que modifica el NCF indicado',
      E34: 'Nota de Crédito que modifica el NCF indicado',
      E41: 'El ITBIS facturado es un gasto sujeto a proporcionalidad',
      E43: 'Comprobante de gasto menor — no aplica como crédito fiscal',
      E44: 'Régimen especial de tributación',
      E45: 'Documento gubernamental — exento de ITBIS',
      E46: 'Exportación libre de ITBIS conforme Art. 343 Cód. Tributario',
      E47: 'Pago al exterior sujeto a retención',
    };
    return legends[ecfType] || '';
  }

  private getModCodeName(code: number): string {
    const names: Record<number, string> = {
      1: 'Anula Comprobante Fiscal Electrónico',
      2: 'Corrección de Texto del Comprobante Fiscal Electrónico',
      3: 'Corrección de Montos del Comprobante Fiscal Electrónico',
      4: 'Comprobante emitido en Contingencia',
    };
    return names[code] || `Código ${code}`;
  }

  private getIncomeTypeName(type: number): string {
    const names: Record<number, string> = {
      1: 'Operacional',
      2: 'Financieros',
      3: 'Extraordinarios',
      4: 'Arrendamientos',
      5: 'Venta Activos',
      6: 'Otros',
    };
    return names[type] || `${type}`;
  }

  private getPaymentName(type: number | null): string {
    const names: Record<number, string> = {
      1: 'Efectivo',
      2: 'Cheque/Transferencia',
      3: 'Tarjeta',
      4: 'Crédito',
      5: 'Bonos',
      6: 'Permuta',
      7: 'Nota de Crédito',
      8: 'Mixto',
      9: 'Otro',
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

  private fmtMoney(amount: any): string {
    return `RD$${Number(amount).toLocaleString('es-DO', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
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
