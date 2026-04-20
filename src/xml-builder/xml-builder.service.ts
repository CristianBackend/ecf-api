import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import {
  InvoiceInput,
  InvoiceItemInput,
  InvoiceTotals,
  AdditionalTaxEntry,
  SubtotalInformativoInput,
  PaginacionInput,
} from './invoice-input.interface';
import {
  ECF_TYPE_CODES,
  REQUIRES_BUYER_RNC,
  REQUIRES_REFERENCE,
  ITBIS_RATES,
  FC_FULL_SUBMISSION_THRESHOLD,
  isIscEspecificoAlcohol,
  isIscAdvaloremAlcohol,
  isIscEspecificoCigarrillo,
  isIscAdvaloremCigarrillo,
  isOtrosImpuestos,
} from './ecf-types';
import { ValidationService } from '../validation/validation.service';
import { isValidProvinciaMunicipio } from './provincia-municipio-codes';

const r2 = ValidationService.round2;
const r4 = ValidationService.round4;
const fmt = ValidationService.formatAmount;
const fmtPrice = ValidationService.formatPrice;

/**
 * Builds DGII-compliant XML for all 10 types of e-CF.
 *
 * XML structure follows the official XSD schemas v1.0:
 * <ECF>
 *   <Encabezado>
 *     <IdDoc>...</IdDoc>
 *     <Emisor>...</Emisor>
 *     <Comprador>...</Comprador>
 *     <InformacionesAdicionales>...</InformacionesAdicionales>
 *     <Totales>...</Totales>
 *     <OtraMoneda>...</OtraMoneda>
 *   </Encabezado>
 *   <DetallesItems>
 *     <Item>...</Item>
 *   </DetallesItems>
 *   <Subtotales>...</Subtotales>  (optional, section C)
 *   <DescuentosORecargos>...</DescuentosORecargos>  (optional, section D)
 *   <Paginacion>...</Paginacion>  (optional, section E)
 *   <InformacionReferencia>...</InformacionReferencia>  (required for 33,34)
 *   <FechaHoraFirma>...</FechaHoraFirma>  (section H, set at signing)
 * </ECF>
 *
 * Updated: Full DGII compliance - rounding, ISC, additional taxes, cuadratura
 */
@Injectable()
export class XmlBuilderService {
  constructor(
    private readonly validationService: ValidationService,
    @InjectPinoLogger(XmlBuilderService.name)
    private readonly logger: PinoLogger,
  ) {}

  /**
   * Build complete e-CF XML from invoice input and emitter data.
   */
  buildEcfXml(
    input: InvoiceInput,
    emitter: EmitterData,
    encf: string,
  ): { xml: string; totals: InvoiceTotals } {
    // Validate input
    this.validationService.validateInvoiceInput(input);

    // Calculate totals with proper rounding
    const totals = this.calculateTotals(input.items, input.indicadorMontoGravado || 0);

    // Validate cuadratura
    const cuadratura = this.validationService.validateCuadratura(input.items, totals);
    if (cuadratura.warnings.length > 0) {
      cuadratura.warnings.forEach(w => this.logger.warn(w));
    }

    const typeCode = ECF_TYPE_CODES[input.ecfType as keyof typeof ECF_TYPE_CODES];

    // Build XML sections
    const idDoc = this.buildIdDoc(typeCode, encf, input, totals.totalAmount);
    const emisor = this.buildEmisor(emitter, input.fechaEmision);
    const comprador = this.buildComprador(typeCode, input.buyer);
    const totalesXml = this.buildTotales(typeCode, totals, input);

    // OtraMoneda within Encabezado
    const otraMoneda = input.currency && input.currency.code !== 'DOP'
      ? this.buildOtraMoneda(input.currency, totals)
      : '';

    // InformacionesAdicionales (optional — E31 has 12 elements, E46 has 22 with export-specific fields)
    const infoAdicional = input.additionalInfo
      ? this.buildInformacionesAdicionales(input.additionalInfo, typeCode)
      : '';

    // Transporte (optional — E31 has 7 common elements, E46 adds 7 export-specific)
    const transporte = input.transport
      ? this.buildTransporte(input.transport, typeCode)
      : '';

    const foreignCurrency = input.currency && input.currency.code !== 'DOP' ? input.currency : undefined;
    const detalles = this.buildDetallesItem(input.items, input.indicadorMontoGravado || 0, typeCode, foreignCurrency);

    // Optional sections (XSD order: DetallesItems → SubtotalesInformativos → DescuentosORecargos → Paginacion → InformacionReferencia)
    const subtotalesInf = input.subtotalesInformativos?.length
      ? this.buildSubtotalesInformativos(input.subtotalesInformativos)
      : '';
    const descuentos = input.discountsOrSurcharges?.length
      ? this.buildDescuentosORecargos(input.discountsOrSurcharges)
      : '';
    const paginacion = input.paginacion?.length
      ? this.buildPaginacion(input.paginacion)
      : '';
    const referencia = REQUIRES_REFERENCE.includes(typeCode) && input.reference
      ? this.buildInformacionReferencia(input.reference)
      : '';

    // Assemble final XML per XSD xs:sequence order
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<ECF xmlns="http://dgii.gov.do/eCF">',
      '  <Encabezado>',
      '    <Version>1.0</Version>',
      idDoc,
      emisor,
      comprador,
      infoAdicional,
      transporte,
      totalesXml,
      otraMoneda,
      '  </Encabezado>',
      detalles,
      subtotalesInf,
      descuentos,
      paginacion,
      referencia,
      '</ECF>',
    ]
      .filter(Boolean)
      .join('\n');

    this.logger.debug(`Built XML for ${input.ecfType} (${encf}): ${xml.length} chars`);
    return { xml, totals };
  }

  // ============================================================
  // RFCE - Resumen Factura Consumo < RD$250,000
  // ============================================================

  /**
   * Build RFCE XML (Resumen Factura Consumo Electrónica).
   * For E32 invoices with total < RD$250,000.
   * Only the summary is sent to DGII; full XML stored locally.
   */
  buildRfceXml(
    input: InvoiceInput,
    emitter: EmitterData,
    encf: string,
    totals: InvoiceTotals,
    securityCode: string,
  ): string {
    const typeCode = 32;

    // S3 fix: Use input.fechaEmision when available (contingency resends preserve original date)
    const fechaEmision = input.fechaEmision || formatDate(new Date());

    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<RFCE xmlns="http://dgii.gov.do/RFCE">',
      `  <RNCEmisor>${escapeXml(emitter.rnc)}</RNCEmisor>`,
      `  <eNCF>${escapeXml(encf)}</eNCF>`,
      `  <FechaEmision>${fechaEmision}</FechaEmision>`,
      `  <MontoTotal>${fmt(totals.totalAmount)}</MontoTotal>`,
      totals.totalItbis > 0 ? `  <TotalITBIS>${fmt(totals.totalItbis)}</TotalITBIS>` : '',
      totals.totalIsc > 0 ? `  <MontoImpuestoAdicional>${fmt(totals.totalIsc)}</MontoImpuestoAdicional>` : '',
      `  <CantidadItems>${input.items.length}</CantidadItems>`,
      `  <CodigoSeguridad>${escapeXml(securityCode)}</CodigoSeguridad>`,
      input.buyer?.rnc ? `  <RNCComprador>${escapeXml(input.buyer.rnc)}</RNCComprador>` : '',
      '</RFCE>',
    ].filter(Boolean).join('\n');

    return xml;
  }

  // ============================================================
  // ANECF - Anulación de Secuencias e-NCF
  // ============================================================

  /**
   * Build ANECF XML for voiding unused sequences or
   * e-CF that were signed but not sent to DGII/receptor.
   */
  buildAnecfXml(
    emitter: EmitterData,
    sequences: Array<{
      encfDesde: string;
      encfHasta: string;
    }>,
  ): string {
    const now = new Date();

    let rangesXml = '';
    sequences.forEach((seq, i) => {
      rangesXml += `    <Rango>\n`;
      rangesXml += `      <NumeroLinea>${i + 1}</NumeroLinea>\n`;
      rangesXml += `      <eNCFDesde>${escapeXml(seq.encfDesde)}</eNCFDesde>\n`;
      rangesXml += `      <eNCFHasta>${escapeXml(seq.encfHasta)}</eNCFHasta>\n`;
      rangesXml += `    </Rango>\n`;
    });

    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<ANECF xmlns="http://dgii.gov.do/ANECF">',
      `  <Encabezado>`,
      `    <RNCEmisor>${escapeXml(emitter.rnc)}</RNCEmisor>`,
      `    <FechaAnulacion>${formatDate(now)}</FechaAnulacion>`,
      `    <CantidadRangos>${sequences.length}</CantidadRangos>`,
      `  </Encabezado>`,
      `  <DetalleAnulacion>`,
      rangesXml.trimEnd(),
      `  </DetalleAnulacion>`,
      '</ANECF>',
    ].join('\n');

    return xml;
  }

  // ============================================================
  // TOTALS CALCULATION (with proper DGII rounding)
  // ============================================================

  calculateTotals(items: InvoiceItemInput[], indicadorMontoGravado: number = 0): InvoiceTotals {
    let taxableAmount18 = 0;
    let taxableAmount16 = 0;
    let taxableAmount0 = 0;
    let exemptAmount = 0;
    let itbis18 = 0;
    let itbis16 = 0;
    let itbis0 = 0;
    let totalDiscount = 0;
    let totalIscEspecifico = 0;
    let totalIscAdvalorem = 0;
    let totalOtrosImpuestos = 0;
    let montoNoFacturable = 0;

    // Track per-tax-code entries for ImpuestosAdicionales wrapper in Totales
    const taxEntriesMap = new Map<string, AdditionalTaxEntry>();

    for (const item of items) {
      const qty = item.quantity;
      const price = item.unitPrice;
      const discount = item.discount || 0;
      const surcharge = item.surcharge || 0;
      const lineSubtotal = r2(qty * price - discount + surcharge);
      const rate = item.itbisRate ?? ITBIS_RATES.STANDARD;

      // Resolve IndicadorFacturacion per XSD: 0=No Facturable, 1=ITBIS 18%, 2=ITBIS 16%, 3=ITBIS 0%, 4=Exento
      const indicadorFact = this.resolveIndicadorFacturacion(item, rate);

      totalDiscount += discount;

      // Determine taxable amounts based on XSD IndicadorFacturacion
      if (indicadorFact === 0) {
        // No Facturable — does NOT contribute to taxable/exempt/ITBIS
        montoNoFacturable += lineSubtotal;
      } else if (indicadorFact === 4) {
        // Exento
        exemptAmount += lineSubtotal;
      } else if (indicadorFact === 3) {
        // ITBIS 0%
        taxableAmount0 += lineSubtotal;
      } else if (indicadorFact === 1) {
        // ITBIS 18%
        taxableAmount18 += lineSubtotal;
        itbis18 += r2(lineSubtotal * 0.18);
      } else if (indicadorFact === 2) {
        // ITBIS 16%
        taxableAmount16 += lineSubtotal;
        itbis16 += r2(lineSubtotal * 0.16);
      } else {
        // Default: use rate
        if (rate === 18) {
          taxableAmount18 += lineSubtotal;
          itbis18 += r2(lineSubtotal * 0.18);
        } else if (rate === 16) {
          taxableAmount16 += lineSubtotal;
          itbis16 += r2(lineSubtotal * 0.16);
        }
      }

      // ISC calculations — track per-tax-code for Totales ImpuestosAdicionales wrapper
      if (item.additionalTaxCode) {
        const code = item.additionalTaxCode;
        const tasa = item.additionalTaxRate || 0;

        if (!taxEntriesMap.has(code)) {
          taxEntriesMap.set(code, {
            tipoImpuesto: code,
            tasaImpuestoAdicional: tasa,
            montoIscEspecifico: 0,
            montoIscAdvalorem: 0,
            otrosImpuestosAdicionales: 0,
          });
        }
        const entry = taxEntriesMap.get(code)!;

        if (isIscEspecificoAlcohol(code)) {
          const amt = this.validationService.calculateIscEspecificoAlcohol(item);
          totalIscEspecifico += amt;
          entry.montoIscEspecifico = r2((entry.montoIscEspecifico || 0) + amt);
        } else if (isIscEspecificoCigarrillo(code)) {
          const amt = this.validationService.calculateIscEspecificoCigarrillo(item);
          totalIscEspecifico += amt;
          entry.montoIscEspecifico = r2((entry.montoIscEspecifico || 0) + amt);
        } else if (isIscAdvaloremAlcohol(code)) {
          const iscEsp = this.validationService.calculateIscEspecificoAlcohol(item);
          const amt = this.validationService.calculateIscAdvaloremAlcohol(
            item, iscEsp, rate, tasa,
          );
          totalIscAdvalorem += amt;
          entry.montoIscAdvalorem = r2((entry.montoIscAdvalorem || 0) + amt);
        } else if (isIscAdvaloremCigarrillo(code)) {
          const amt = this.validationService.calculateIscAdvaloremCigarrillo(
            item, rate, tasa,
          );
          totalIscAdvalorem += amt;
          entry.montoIscAdvalorem = r2((entry.montoIscAdvalorem || 0) + amt);
        } else if (isOtrosImpuestos(code)) {
          const amt = this.validationService.calculateOtrosImpuestos(
            lineSubtotal, tasa,
            item.indicadorMontoGravado || indicadorMontoGravado, rate,
          );
          totalOtrosImpuestos += amt;
          entry.otrosImpuestosAdicionales = r2((entry.otrosImpuestosAdicionales || 0) + amt);
        }
      }
    }

    const subtotalBeforeTax = r2(taxableAmount18 + taxableAmount16 + taxableAmount0 + exemptAmount);
    const totalItbis = r2(itbis18 + itbis16 + itbis0);
    const totalIsc = r2(totalIscEspecifico + totalIscAdvalorem);
    const totalAmount = r2(subtotalBeforeTax + totalItbis + totalIsc + totalOtrosImpuestos + montoNoFacturable);

    return {
      subtotalBeforeTax: r2(subtotalBeforeTax),
      totalDiscount: r2(totalDiscount),
      taxableAmount18: r2(taxableAmount18),
      taxableAmount16: r2(taxableAmount16),
      taxableAmount0: r2(taxableAmount0),
      exemptAmount: r2(exemptAmount),
      itbis18: r2(itbis18),
      itbis16: r2(itbis16),
      itbis0: r2(itbis0),
      totalItbis: r2(totalItbis),
      totalIscEspecifico: r2(totalIscEspecifico),
      totalIscAdvalorem: r2(totalIscAdvalorem),
      totalIsc: r2(totalIsc),
      totalOtrosImpuestos: r2(totalOtrosImpuestos),
      montoNoFacturable: r2(montoNoFacturable),
      totalAmount: r2(totalAmount),
      toleranciaGlobal: items.length,
      additionalTaxEntries: Array.from(taxEntriesMap.values()),
    };
  }

  /**
   * Resolve IndicadorFacturacion per XSD IndicadorFacturacionType:
   * 0=No Facturable, 1=ITBIS 18%, 2=ITBIS 16%, 3=ITBIS 0%, 4=Exento
   */
  private resolveIndicadorFacturacion(item: InvoiceItemInput, rate: number): number {
    if (item.indicadorFacturacion !== undefined && item.indicadorFacturacion !== null) {
      return item.indicadorFacturacion;
    }
    // Auto-derive from ITBIS rate
    if (rate === 18) return 1;
    if (rate === 16) return 2;
    if (rate === 0) return 3;
    return 1; // default ITBIS 18%
  }

  // ============================================================
  // XML SECTION BUILDERS
  // ============================================================

  private buildIdDoc(typeCode: number, encf: string, input: InvoiceInput, totalAmount: number): string {
    const now = new Date();
    const paymentDate = input.payment.date || formatDate(now);

    // ============================================================
    // DGII Obligatoriedad table (Formato e-CF v1.0, Sección A - IdDoc)
    // 0=No corresponde, 1=Obligatorio, 2=Condicional, 3=Opcional
    // Types:          31  32  33  34  41  43  44  45  46  47
    // ============================================================

    let xml = '';
    xml += `    <IdDoc>\n`;
    xml += `      <TipoeCF>${typeCode}</TipoeCF>\n`;
    xml += `      <eNCF>${escapeXml(encf)}</eNCF>\n`;

    // FechaVencimientoSecuencia: 1  0  1  0  1  1  1  1  1  1
    if (typeCode !== 32 && typeCode !== 34) {
      if (!input.sequenceExpiresAt) {
        this.logger.warn(
          `FechaVencimientoSecuencia not provided for ${encf}. ` +
          `Using fallback date — this MUST match the real DGII-authorized expiry.`,
        );
      }
      const expiryDate = input.sequenceExpiresAt
        ? formatDate(new Date(input.sequenceExpiresAt))
        : formatDate(new Date(now.getFullYear() + 1, 11, 31));
      xml += `      <FechaVencimientoSecuencia>${expiryDate}</FechaVencimientoSecuencia>\n`;
    }

    // IndicadorNotaCredito: 0  0  0  1  0  0  0  0  0  0
    // Value: 0 if ≤ 30 days from original, 1 if > 30 days
    if (typeCode === 34) {
      let indicador = 0;
      if (input.reference?.date) {
        const refDate = this.parseDgiiDate(input.reference.date);
        const diffDays = Math.floor((now.getTime() - refDate.getTime()) / (1000 * 60 * 60 * 24));
        indicador = diffDays > 30 ? 1 : 0;
      }
      xml += `      <IndicadorNotaCredito>${indicador}</IndicadorNotaCredito>\n`;
    }

    // IndicadorEnvioDiferido: 2  2  2  2  0  0  2  2  2  0
    //                        31 32 33 34 41 43 44 45 46 47
    // 0=No corresponde (E41, E43, E47). E46=2 (conditional — CAN have deferred sending)
    const noEnvioDiferido = [41, 43, 47];
    if (!noEnvioDiferido.includes(typeCode) && input.indicadorEnvioDiferido === 1) {
      xml += `      <IndicadorEnvioDiferido>1</IndicadorEnvioDiferido>\n`;
    }

    // IndicadorMontoGravado: 2  2  2  2  2  0  0  2  0  0
    //                        31 32 33 34 41 43 44 45 46 47
    // Verified per XSD: E43/E44/E46/E47 IdDoc does NOT include this element.
    // E44 (Regímenes Especiales) uses MontoExento in Totales, NOT ITBIS gravado amounts.
    // 0 = precios NO incluyen ITBIS, 1 = precios YA incluyen ITBIS
    const noMontoGravado = [43, 44, 46, 47];
    if (!noMontoGravado.includes(typeCode)) {
      const hasGravado = input.items.some(i => (i.itbisRate ?? 18) > 0);
      if (hasGravado) {
        xml += `      <IndicadorMontoGravado>${input.indicadorMontoGravado ?? 0}</IndicadorMontoGravado>\n`;
      }
    }

    // TipoIngresos: 1  1  1  1  0  0  1  1  1  0
    const noTipoIngresos = [41, 43, 47];
    if (!noTipoIngresos.includes(typeCode)) {
      const tipoIngreso = input.items[0]?.incomeType || 1;
      xml += `      <TipoIngresos>${String(tipoIngreso).padStart(2, '0')}</TipoIngresos>\n`;
    }

    // TipoPago: 1  1  1  1  1  3  1  1  1  3
    // For E43 and E47 it's optional (code 3), for E34 it's obligatory (code 1)
    const tipoPagoOptional = [43, 47];
    if (tipoPagoOptional.includes(typeCode)) {
      if (input.payment.type) {
        xml += `      <TipoPago>${input.payment.type}</TipoPago>\n`;
      }
    } else {
      xml += `      <TipoPago>${input.payment.type}</TipoPago>\n`;
    }

    // FechaLimitePago: 2  2  2  2  2  0  2  2  2  3
    // Condicional a que TipoPago = 2 (Crédito)
    const noFechaLimite = [43];
    if (!noFechaLimite.includes(typeCode) && input.payment.type === 2) {
      xml += `      <FechaLimitePago>${paymentDate}</FechaLimitePago>\n`;
    }

    // TerminoPago: 3  3  3  0  3  0  3  3  3  3
    const noTerminoPago = [34, 43];
    if (!noTerminoPago.includes(typeCode) && input.payment.termDays) {
      xml += `      <TerminoPago>${input.payment.termDays} dias</TerminoPago>\n`;
    }

    // TablaFormasPago: 3  3  3  0  3  0  3  3  3  3
    const noFormasPago = [34, 43];
    if (!noFormasPago.includes(typeCode)) {
      const formaPago = input.payment.method || 1; // FormaPago defaults to 1 (Efectivo) if not specified
      xml += `      <TablaFormasPago>\n`;
      xml += `        <FormaDePago>\n`;
      xml += `          <FormaPago>${formaPago}</FormaPago>\n`;
      xml += `          <MontoPago>${fmt(totalAmount)}</MontoPago>\n`;
      xml += `        </FormaDePago>\n`;
      xml += `      </TablaFormasPago>\n`;
    }

    // M5: TipoCuentaPago, NumeroCuentaPago, BancoPago (optional, after TablaFormasPago per XSD)
    // Per XSD: NOT in E34, E43
    const noPaymentAccountFields = [34, 43];
    if (!noPaymentAccountFields.includes(typeCode)) {
      if (input.payment.accountType) {
        xml += `      <TipoCuentaPago>${escapeXml(input.payment.accountType)}</TipoCuentaPago>\n`;
      }
      if (input.payment.accountNumber) {
        xml += `      <NumeroCuentaPago>${escapeXml(input.payment.accountNumber)}</NumeroCuentaPago>\n`;
      }
      if (input.payment.bank) {
        xml += `      <BancoPago>${escapeXml(input.payment.bank)}</BancoPago>\n`;
      }
    }

    xml += `    </IdDoc>`;

    return xml;
  }

  private buildEmisor(emitter: EmitterData, fechaEmisionOverride?: string): string {
    let xml = '';
    xml += `    <Emisor>\n`;
    xml += `      <RNCEmisor>${escapeXml(emitter.rnc)}</RNCEmisor>\n`;
    xml += `      <RazonSocialEmisor>${escapeXml(emitter.businessName)}</RazonSocialEmisor>\n`;

    if (emitter.tradeName) {
      xml += `      <NombreComercial>${escapeXml(emitter.tradeName)}</NombreComercial>\n`;
    }

    // M1: Sucursal (optional, after NombreComercial per XSD sequence)
    if (emitter.branchCode) {
      xml += `      <Sucursal>${escapeXml(emitter.branchCode)}</Sucursal>\n`;
    }

    xml += `      <DireccionEmisor>${escapeXml(emitter.address || 'N/A')}</DireccionEmisor>\n`;

    if (emitter.municipality) {
      this.validateProvinciaMunicipio(emitter.municipality, 'Emisor.Municipio');
      xml += `      <Municipio>${escapeXml(emitter.municipality)}</Municipio>\n`;
    }

    if (emitter.province) {
      this.validateProvinciaMunicipio(emitter.province, 'Emisor.Provincia');
      xml += `      <Provincia>${escapeXml(emitter.province)}</Provincia>\n`;
    }

    // M2: ActividadEconomica (optional, after Provincia per XSD sequence)
    if (emitter.economicActivity) {
      xml += `      <ActividadEconomica>${escapeXml(emitter.economicActivity)}</ActividadEconomica>\n`;
    }

    // Use override date (e.g., for contingency resubmission) or current date
    const fechaEmision = fechaEmisionOverride || formatDate(new Date());
    xml += `      <FechaEmision>${fechaEmision}</FechaEmision>\n`;
    xml += `    </Emisor>`;

    return xml;
  }

  private buildComprador(typeCode: number, buyer: any): string {
    // E43 (Gastos Menores): Comprador código 0 - NO corresponde
    if (typeCode === 43) {
      return '';
    }

    // E47 (Pagos Exterior): Comprador código 3 - opcional
    // Si se incluye, ciertos sub-campos son código 0
    const isE47 = typeCode === 47;

    if (!buyer || (!buyer.rnc && !REQUIRES_BUYER_RNC.includes(typeCode))) {
      if (typeCode === 32) {
        // M4: E32 simplified Comprador should also emit IdentificadorExtranjero when available
        const lines = ['    <Comprador>'];
        if (buyer?.foreignId) {
          lines.push(`      <IdentificadorExtranjero>${escapeXml(buyer.foreignId)}</IdentificadorExtranjero>`);
        }
        lines.push(`      <RazonSocialComprador>${escapeXml(buyer?.name || 'CONSUMIDOR FINAL')}</RazonSocialComprador>`);
        lines.push('    </Comprador>');
        return lines.join('\n');
      }
      // E47 without buyer data - skip entirely (optional)
      if (isE47) return '';
    }

    let xml = '';
    xml += `    <Comprador>\n`;

    // E47: RNCComprador does NOT exist in XSD — only IdentificadorExtranjero + RazonSocialComprador
    if (buyer.rnc && !isE47) {
      xml += `      <RNCComprador>${escapeXml(buyer.rnc)}</RNCComprador>\n`;
    }

    // IdentificadorExtranjero: for E32>250K, E33/E34 ref E32>250K, E44 diplomáticos, E46, E47
    if (isE47 && (buyer.foreignId || buyer.rnc)) {
      // E47: always use IdentificadorExtranjero (foreignId preferred, fallback to rnc)
      xml += `      <IdentificadorExtranjero>${escapeXml(buyer.foreignId || buyer.rnc)}</IdentificadorExtranjero>\n`;
    } else if (!buyer.rnc && buyer.foreignId) {
      xml += `      <IdentificadorExtranjero>${escapeXml(buyer.foreignId)}</IdentificadorExtranjero>\n`;
    }

    xml += `      <RazonSocialComprador>${escapeXml(buyer.name)}</RazonSocialComprador>\n`;

    // E47: ContactoComprador=0, CorreoComprador=0, DireccionComprador=0, etc
    if (!isE47) {
      // Per XSD: ContactoComprador (AlfNum80Type) is for general contact (phone/name)
      // CorreoComprador (CorreoValidationType) is specifically for email
      if (buyer.phone) {
        xml += `      <ContactoComprador>${escapeXml(buyer.phone)}</ContactoComprador>\n`;
      }
      if (buyer.email) {
        xml += `      <CorreoComprador>${escapeXml(buyer.email)}</CorreoComprador>\n`;
      }

      if (buyer.address) {
        xml += `      <DireccionComprador>${escapeXml(buyer.address)}</DireccionComprador>\n`;
      }

      if (buyer.municipality) {
        this.validateProvinciaMunicipio(buyer.municipality, 'Comprador.MunicipioComprador');
        xml += `      <MunicipioComprador>${escapeXml(buyer.municipality)}</MunicipioComprador>\n`;
      }

      if (buyer.province) {
        this.validateProvinciaMunicipio(buyer.province, 'Comprador.ProvinciaComprador');
        xml += `      <ProvinciaComprador>${escapeXml(buyer.province)}</ProvinciaComprador>\n`;
      }
    }

    // PaisComprador: solo E46 (opcional, código 3)
    if (typeCode === 46 && buyer.country) {
      xml += `      <PaisComprador>${escapeXml(buyer.country)}</PaisComprador>\n`;
    }

    xml += `    </Comprador>`;
    return xml;
  }

  private buildTotales(typeCode: number, totals: InvoiceTotals, input: InvoiceInput): string {
    // Per-XSD type guards — verified via grep against all 10 XSD files
    const hasGravadoTotal = ![43, 44, 47].includes(typeCode);       // MontoGravadoTotal
    const hasGravadoBreakdown = ![43, 44, 46, 47].includes(typeCode); // MontoGravadoI1/I2/I3
    const hasExento = typeCode !== 46;                                // MontoExento
    const hasItbisRates = ![43, 44, 46, 47].includes(typeCode);     // ITBIS1/2/3
    const hasTotalItbis = ![43, 44, 47].includes(typeCode);         // TotalITBIS
    const hasItbisBreakdown = ![43, 44, 46, 47].includes(typeCode); // TotalITBIS1/2/3
    const hasImpuestoAdicional = ![41, 43, 46, 47].includes(typeCode); // MontoImpuestoAdicional + ImpuestosAdicionales
    const hasMontoNoFacturable = ![41, 43, 47].includes(typeCode);  // MontoNoFacturable
    const hasItbisRetenido = [31, 33, 34, 41].includes(typeCode);   // TotalITBISRetenido
    const hasIsrRetencion = [31, 33, 34, 41, 47].includes(typeCode); // TotalISRRetencion
    const hasItbisPercepcion = [31, 33, 34, 41].includes(typeCode); // TotalITBISPercepcion
    const hasIsrPercepcion = [31, 33, 34, 41].includes(typeCode);   // TotalISRPercepcion

    let xml = '';
    xml += `    <Totales>\n`;

    // === XSD Totales xs:sequence order ===

    // 1. MontoGravadoTotal
    if (hasGravadoTotal) {
      const montoGravadoTotal = r2(totals.taxableAmount18 + totals.taxableAmount16 + totals.taxableAmount0);
      if (montoGravadoTotal > 0) {
        xml += `      <MontoGravadoTotal>${fmt(montoGravadoTotal)}</MontoGravadoTotal>\n`;
      }
    }

    // 2-4. MontoGravadoI1/I2/I3 (breakdown by rate)
    if (hasGravadoBreakdown) {
      if (totals.taxableAmount18 > 0) {
        xml += `      <MontoGravadoI1>${fmt(totals.taxableAmount18)}</MontoGravadoI1>\n`;
      }
      if (totals.taxableAmount16 > 0) {
        xml += `      <MontoGravadoI2>${fmt(totals.taxableAmount16)}</MontoGravadoI2>\n`;
      }
      if (totals.taxableAmount0 > 0) {
        xml += `      <MontoGravadoI3>${fmt(totals.taxableAmount0)}</MontoGravadoI3>\n`;
      }
    }

    // 5. MontoExento
    if (hasExento && totals.exemptAmount > 0) {
      xml += `      <MontoExento>${fmt(totals.exemptAmount)}</MontoExento>\n`;
    }

    // 6-8. ITBIS1/2/3 (rate values)
    if (hasItbisRates) {
      if (totals.itbis18 > 0) {
        xml += `      <ITBIS1>18</ITBIS1>\n`;
      }
      if (totals.itbis16 > 0) {
        xml += `      <ITBIS2>16</ITBIS2>\n`;
      }
      if (totals.itbis0 > 0) {
        xml += `      <ITBIS3>0</ITBIS3>\n`;
      }
    }

    // 9. TotalITBIS
    if (hasTotalItbis && totals.totalItbis > 0) {
      xml += `      <TotalITBIS>${fmt(totals.totalItbis)}</TotalITBIS>\n`;
    }

    // 10-12. TotalITBIS1/2/3
    if (hasItbisBreakdown) {
      if (totals.itbis18 > 0) {
        xml += `      <TotalITBIS1>${fmt(totals.itbis18)}</TotalITBIS1>\n`;
      }
      if (totals.itbis16 > 0) {
        xml += `      <TotalITBIS2>${fmt(totals.itbis16)}</TotalITBIS2>\n`;
      }
      if (totals.itbis0 > 0) {
        xml += `      <TotalITBIS3>${fmt(totals.itbis0)}</TotalITBIS3>\n`;
      }
    }

    // 13. MontoImpuestoAdicional (summary total of all additional taxes)
    if (hasImpuestoAdicional) {
      const montoImpuestoAdicional = r2(totals.totalIsc + totals.totalOtrosImpuestos);
      if (montoImpuestoAdicional > 0) {
        xml += `      <MontoImpuestoAdicional>${fmt(montoImpuestoAdicional)}</MontoImpuestoAdicional>\n`;
      }
    }

    // 14. ImpuestosAdicionales wrapper (per XSD: ImpuestosAdicionales > ImpuestoAdicional(1,20))
    if (hasImpuestoAdicional && totals.additionalTaxEntries && totals.additionalTaxEntries.length > 0) {
      xml += `      <ImpuestosAdicionales>\n`;
      for (const entry of totals.additionalTaxEntries) {
        xml += `        <ImpuestoAdicional>\n`;
        xml += `          <TipoImpuesto>${entry.tipoImpuesto}</TipoImpuesto>\n`;
        xml += `          <TasaImpuestoAdicional>${entry.tasaImpuestoAdicional}</TasaImpuestoAdicional>\n`;
        if (entry.montoIscEspecifico && entry.montoIscEspecifico > 0) {
          xml += `          <MontoImpuestoSelectivoConsumoEspecifico>${fmt(entry.montoIscEspecifico)}</MontoImpuestoSelectivoConsumoEspecifico>\n`;
        }
        if (entry.montoIscAdvalorem && entry.montoIscAdvalorem > 0) {
          xml += `          <MontoImpuestoSelectivoConsumoAdvalorem>${fmt(entry.montoIscAdvalorem)}</MontoImpuestoSelectivoConsumoAdvalorem>\n`;
        }
        if (entry.otrosImpuestosAdicionales && entry.otrosImpuestosAdicionales > 0) {
          xml += `          <OtrosImpuestosAdicionales>${fmt(entry.otrosImpuestosAdicionales)}</OtrosImpuestosAdicionales>\n`;
        }
        xml += `        </ImpuestoAdicional>\n`;
      }
      xml += `      </ImpuestosAdicionales>\n`;
    }

    // 15. MontoTotal (required in ALL types, minOccurs=1)
    xml += `      <MontoTotal>${fmt(totals.totalAmount)}</MontoTotal>\n`;

    // 16. MontoNoFacturable
    if (hasMontoNoFacturable && totals.montoNoFacturable > 0) {
      xml += `      <MontoNoFacturable>${fmt(totals.montoNoFacturable)}</MontoNoFacturable>\n`;
    }

    // 17-20. Retenciones y Percepciones (per XSD: only in E31, E33, E34, E41; ISR also E47)
    if (hasItbisRetenido && input.retention?.itbisRetenido && input.retention.itbisRetenido > 0) {
      xml += `      <TotalITBISRetenido>${fmt(input.retention.itbisRetenido)}</TotalITBISRetenido>\n`;
    }
    if (hasIsrRetencion && input.retention?.isrRetencion && input.retention.isrRetencion > 0) {
      xml += `      <TotalISRRetencion>${fmt(input.retention.isrRetencion)}</TotalISRRetencion>\n`;
    }
    if (hasItbisPercepcion && input.retention?.itbisPercepcion && input.retention.itbisPercepcion > 0) {
      xml += `      <TotalITBISPercepcion>${fmt(input.retention.itbisPercepcion)}</TotalITBISPercepcion>\n`;
    }
    if (hasIsrPercepcion && input.retention?.isrPercepcion && input.retention.isrPercepcion > 0) {
      xml += `      <TotalISRPercepcion>${fmt(input.retention.isrPercepcion)}</TotalISRPercepcion>\n`;
    }

    xml += `    </Totales>`;

    return xml;
  }

  private buildDetallesItem(items: InvoiceItemInput[], indicadorMontoGravado: number, typeCode?: number, currency?: { code: string; exchangeRate: number }): string {
    let xml = '  <DetallesItems>\n';

    // Per XSD: types that have ISC item-level fields (CantidadReferencia, GradosAlcohol, etc.)
    const hasIscItemFields = [31, 32, 33, 34, 44, 45];
    const emitIscFields = typeCode ? hasIscItemFields.includes(typeCode) : true;

    // Per XSD: types that require Retencion block (E41: minOccurs=1, E47: minOccurs=1)
    const retencionRequired = typeCode === 41 || typeCode === 47;
    // E31/E32/E33/E34 have optional Retencion (minOccurs=0)
    const retencionOptional = [31, 32, 33, 34].includes(typeCode || 0);
    // E43/E44/E45/E46 have NO Retencion element in their XSD at all
    const noRetencion = [43, 44, 45, 46].includes(typeCode || 0);

    items.forEach((item, index) => {
      const lineNum = item.lineNumber || index + 1;
      const qty = item.quantity;
      const price = item.unitPrice;
      const discount = item.discount || 0;
      const surcharge = item.surcharge || 0;
      const lineSubtotal = r2(qty * price - discount + surcharge);
      const rate = item.itbisRate ?? ITBIS_RATES.STANDARD;

      // C1 fix: IndicadorFacturacion per XSD: 0=No Facturable, 1=ITBIS 18%, 2=ITBIS 16%, 3=ITBIS 0%, 4=Exento
      const indicadorFact = this.resolveIndicadorFacturacion(item, rate);

      xml += `    <Item>\n`;

      // === XSD xs:sequence order (e-CF-31.xsd lines 217-327) ===

      // 1. NumeroLinea
      xml += `      <NumeroLinea>${lineNum}</NumeroLinea>\n`;

      // 2. TablaCodigosItem (optional)
      if (item.code) {
        xml += `      <TablaCodigosItem>\n`;
        xml += `        <CodigosItem>\n`;
        xml += `          <TipoCodigo>${escapeXml(item.codeType || 'INT')}</TipoCodigo>\n`;
        xml += `          <CodigoItem>${escapeXml(item.code)}</CodigoItem>\n`;
        xml += `        </CodigosItem>\n`;
        xml += `      </TablaCodigosItem>\n`;
      }

      // 3. IndicadorFacturacion (required, xs:integer 0-4)
      xml += `      <IndicadorFacturacion>${indicadorFact}</IndicadorFacturacion>\n`;

      // 4. Retencion (varies by type)
      // Per XSD IndicadorAgenteRetencionoPercepcionType: only values 1 (Retención) and 2 (Percepción) are valid.
      // Value 0 does NOT exist in the XSD restriction — never emit 0.
      if (retencionRequired) {
        xml += `      <Retencion>\n`;
        const indicador = item.retencionIndicador === 1 || item.retencionIndicador === 2
          ? item.retencionIndicador : 1; // Default to 1 (Retención) for required types
        xml += `        <IndicadorAgenteRetencionoPercepcion>${indicador}</IndicadorAgenteRetencionoPercepcion>\n`;
        if (typeCode !== 47 && item.montoItbisRetenido) {
          xml += `        <MontoITBISRetenido>${fmt(item.montoItbisRetenido)}</MontoITBISRetenido>\n`;
        }
        if (item.montoIsrRetenido) {
          xml += `        <MontoISRRetenido>${fmt(item.montoIsrRetenido)}</MontoISRRetenido>\n`;
        }
        xml += `      </Retencion>\n`;
      } else if (retencionOptional && !noRetencion && item.retencionIndicador) {
        xml += `      <Retencion>\n`;
        xml += `        <IndicadorAgenteRetencionoPercepcion>${item.retencionIndicador}</IndicadorAgenteRetencionoPercepcion>\n`;
        if (item.montoItbisRetenido) {
          xml += `        <MontoITBISRetenido>${fmt(item.montoItbisRetenido)}</MontoITBISRetenido>\n`;
        }
        if (item.montoIsrRetenido) {
          xml += `        <MontoISRRetenido>${fmt(item.montoIsrRetenido)}</MontoISRRetenido>\n`;
        }
        xml += `      </Retencion>\n`;
      }

      // 5. NombreItem
      xml += `      <NombreItem>${escapeXml(item.description)}</NombreItem>\n`;

      // 6. IndicadorBienoServicio (1=Bien, 2=Servicio)
      xml += `      <IndicadorBienoServicio>${item.goodService || 1}</IndicadorBienoServicio>\n`;

      // 7. DescripcionItem (optional)
      if (item.longDescription) {
        xml += `      <DescripcionItem>${escapeXml(item.longDescription)}</DescripcionItem>\n`;
      }

      // 8. CantidadItem
      xml += `      <CantidadItem>${qty}</CantidadItem>\n`;

      // 9. UnidadMedida (optional)
      if (item.unitMeasureCode) {
        xml += `      <UnidadMedida>${item.unitMeasureCode}</UnidadMedida>\n`;
      } else if (item.unit) {
        xml += `      <UnidadMedida>${escapeXml(item.unit)}</UnidadMedida>\n`;
      }

      // C3 fix: ISC fields are DIRECT children of Item (not inside TablaImpuestoAdicional)
      // Only for types 31/32/33/34/44/45 per XSD
      if (emitIscFields && item.additionalTaxCode) {
        // 10. CantidadReferencia (direct Item child)
        if (item.referenceQuantity) {
          xml += `      <CantidadReferencia>${item.referenceQuantity}</CantidadReferencia>\n`;
        }

        // 12. TablaSubcantidad > SubcantidadItem > Subcantidad + CodigoSubcantidad
        if (item.subQuantity) {
          xml += `      <TablaSubcantidad>\n`;
          xml += `        <SubcantidadItem>\n`;
          xml += `          <Subcantidad>${ValidationService.formatSubQuantity(item.subQuantity)}</Subcantidad>\n`;
          // M6: CodigoSubcantidad (optional, after Subcantidad per XSD)
          if (item.subQuantityCode) {
            xml += `          <CodigoSubcantidad>${item.subQuantityCode}</CodigoSubcantidad>\n`;
          }
          xml += `        </SubcantidadItem>\n`;
          xml += `      </TablaSubcantidad>\n`;
        }

        // 13. GradosAlcohol (direct Item child)
        if (item.alcoholDegrees) {
          xml += `      <GradosAlcohol>${item.alcoholDegrees}</GradosAlcohol>\n`;
        }

        // 14. PrecioUnitarioReferencia (direct Item child)
        if (item.referenceUnitPrice) {
          xml += `      <PrecioUnitarioReferencia>${fmt(item.referenceUnitPrice)}</PrecioUnitarioReferencia>\n`;
        }

        // M4: FechaElaboracion (optional, after PrecioUnitarioReferencia per XSD)
        if (item.manufacturingDate) {
          xml += `      <FechaElaboracion>${item.manufacturingDate}</FechaElaboracion>\n`;
        }
      }

      // 17. PrecioUnitarioItem (up to 4 decimals per DGII)
      xml += `      <PrecioUnitarioItem>${fmtPrice(price)}</PrecioUnitarioItem>\n`;

      // 18. DescuentoMonto (optional, not in E47)
      if (discount > 0 && typeCode !== 47) {
        xml += `      <DescuentoMonto>${fmt(discount)}</DescuentoMonto>\n`;
      }

      // M3: RecargoMonto (optional, after DescuentoMonto/TablaSubDescuento per XSD)
      if (surcharge > 0) {
        xml += `      <RecargoMonto>${fmt(surcharge)}</RecargoMonto>\n`;
      }

      // 22. TablaImpuestoAdicional — per XSD: contains ImpuestoAdicional > TipoImpuesto ONLY
      // Only for types 31/32/33/34/44/45
      if (emitIscFields && item.additionalTaxCode) {
        xml += `      <TablaImpuestoAdicional>\n`;
        xml += `        <ImpuestoAdicional>\n`;
        xml += `          <TipoImpuesto>${item.additionalTaxCode}</TipoImpuesto>\n`;
        xml += `        </ImpuestoAdicional>\n`;
        xml += `      </TablaImpuestoAdicional>\n`;
      }

      // C2 fix: TasaITBIS and MontoITBIS DO NOT EXIST in any XSD — removed entirely

      // 23. OtraMonedaDetalle (optional, per XSD: PrecioOtraMoneda, DescuentoOtraMoneda, RecargoOtraMoneda, MontoItemOtraMoneda)
      if (currency) {
        const xRate = currency.exchangeRate;
        xml += `      <OtraMonedaDetalle>\n`;
        xml += `        <PrecioOtraMoneda>${fmtPrice(r4(price / xRate))}</PrecioOtraMoneda>\n`;
        if (discount > 0) {
          xml += `        <DescuentoOtraMoneda>${fmt(r2(discount / xRate))}</DescuentoOtraMoneda>\n`;
        }
        if (surcharge > 0) {
          xml += `        <RecargoOtraMoneda>${fmt(r2(surcharge / xRate))}</RecargoOtraMoneda>\n`;
        }
        xml += `        <MontoItemOtraMoneda>${fmt(r2(lineSubtotal / xRate))}</MontoItemOtraMoneda>\n`;
        xml += `      </OtraMonedaDetalle>\n`;
      }

      // 24. MontoItem (required) — per XSD this is the line total (without ITBIS at item level)
      xml += `      <MontoItem>${fmt(lineSubtotal)}</MontoItem>\n`;

      xml += `    </Item>\n`;
    });

    xml += '  </DetallesItems>';
    return xml;
  }

  /**
   * Section D: DescuentosORecargos (optional).
   * Per XSD e-CF-31.xsd lines 360-380: strict xs:sequence order.
   */
  private buildDescuentosORecargos(items: any[]): string {
    if (!items || items.length === 0) return '';

    let xml = '  <DescuentosORecargos>\n';

    items.forEach((item, index) => {
      xml += `    <DescuentoORecargo>\n`;

      // 1. NumeroLinea (required)
      xml += `      <NumeroLinea>${index + 1}</NumeroLinea>\n`;

      // 2. TipoAjuste (required): D=Descuento, R=Recargo
      xml += `      <TipoAjuste>${item.isDiscount ? 'D' : 'R'}</TipoAjuste>\n`;

      // 3. IndicadorNorma1007 (optional) — MUST come BEFORE description per XSD
      if (item.indicadorNorma1007) {
        xml += `      <IndicadorNorma1007>${item.indicadorNorma1007}</IndicadorNorma1007>\n`;
      }

      // 4. DescripcionDescuentooRecargo (optional)
      xml += `      <DescripcionDescuentooRecargo>${escapeXml(item.description)}</DescripcionDescuentooRecargo>\n`;

      // 5. TipoValor (optional): per XSD TipoDescuentoRecargoType (xs:string: "$" or "%")
      if (item.percentage) {
        xml += `      <TipoValor>%</TipoValor>\n`;
        // 6. ValorDescuentooRecargo
        xml += `      <ValorDescuentooRecargo>${item.percentage}</ValorDescuentooRecargo>\n`;
      }

      // 7. MontoDescuentooRecargo
      xml += `      <MontoDescuentooRecargo>${fmt(item.amount)}</MontoDescuentooRecargo>\n`;

      // M7: MontoDescuentooRecargoOtraMoneda (optional, after MontoDescuentooRecargo per XSD)
      if (item.amountOtherCurrency != null && item.amountOtherCurrency > 0) {
        xml += `      <MontoDescuentooRecargoOtraMoneda>${fmt(item.amountOtherCurrency)}</MontoDescuentooRecargoOtraMoneda>\n`;
      }

      // M7: IndicadorFacturacionDescuentooRecargo (optional, 1-4 per IndicadorFacturacionDRType)
      if (item.indicadorFacturacion != null) {
        xml += `      <IndicadorFacturacionDescuentooRecargo>${item.indicadorFacturacion}</IndicadorFacturacionDescuentooRecargo>\n`;
      }

      xml += `    </DescuentoORecargo>\n`;
    });

    xml += '  </DescuentosORecargos>';
    return xml;
  }

  /**
   * Section C: Subtotales (optional, código 3).
   * Per XSD e-CF-31.xsd lines 333-359: <Subtotales> > <Subtotal>(1,20)
   * Element names per XSD xs:sequence (note: "SubTotaITBIS" is the official XSD name, NOT "SubTotalITBIS")
   */
  private buildSubtotalesInformativos(subtotales: SubtotalInformativoInput[]): string {
    if (!subtotales || subtotales.length === 0) return '';

    let xml = '  <Subtotales>\n';

    for (const st of subtotales) {
      xml += `    <Subtotal>\n`;

      // 1. NumeroSubTotal (XSD: Integer2ValidationType)
      xml += `      <NumeroSubTotal>${st.numero}</NumeroSubTotal>\n`;

      // 2. DescripcionSubtotal (XSD: AlfNum40Type)
      xml += `      <DescripcionSubtotal>${escapeXml(st.nombre)}</DescripcionSubtotal>\n`;

      // 3. Orden — omitted (not in input interface, optional in XSD)

      // 4. SubTotalMontoGravadoTotal
      const gravadoTotal = r2((st.gravadoI1 || 0) + (st.gravadoI2 || 0) + (st.gravadoI3 || 0));
      if (gravadoTotal > 0) {
        xml += `      <SubTotalMontoGravadoTotal>${fmt(gravadoTotal)}</SubTotalMontoGravadoTotal>\n`;
      }

      // 5-7. SubTotalMontoGravadoI1/I2/I3
      if (st.gravadoI1 != null && st.gravadoI1 > 0) {
        xml += `      <SubTotalMontoGravadoI1>${fmt(st.gravadoI1)}</SubTotalMontoGravadoI1>\n`;
      }
      if (st.gravadoI2 != null && st.gravadoI2 > 0) {
        xml += `      <SubTotalMontoGravadoI2>${fmt(st.gravadoI2)}</SubTotalMontoGravadoI2>\n`;
      }
      if (st.gravadoI3 != null && st.gravadoI3 > 0) {
        xml += `      <SubTotalMontoGravadoI3>${fmt(st.gravadoI3)}</SubTotalMontoGravadoI3>\n`;
      }

      // 8-11. SubTotaITBIS, SubTotaITBIS1/2/3 (NOTE: XSD uses "SubTotaITBIS" — no "l" before ITBIS)
      if (st.totalItbis != null && st.totalItbis > 0) {
        xml += `      <SubTotaITBIS>${fmt(st.totalItbis)}</SubTotaITBIS>\n`;
      }
      if (st.itbis1 != null && st.itbis1 > 0) {
        xml += `      <SubTotaITBIS1>${fmt(st.itbis1)}</SubTotaITBIS1>\n`;
      }
      if (st.itbis2 != null && st.itbis2 > 0) {
        xml += `      <SubTotaITBIS2>${fmt(st.itbis2)}</SubTotaITBIS2>\n`;
      }
      if (st.itbis3 != null && st.itbis3 > 0) {
        xml += `      <SubTotaITBIS3>${fmt(st.itbis3)}</SubTotaITBIS3>\n`;
      }

      // 12. SubTotalImpuestoAdicional
      if (st.impuestoAdicional != null && st.impuestoAdicional > 0) {
        xml += `      <SubTotalImpuestoAdicional>${fmt(st.impuestoAdicional)}</SubTotalImpuestoAdicional>\n`;
      }

      // 13. SubTotalExento
      if (st.exento != null && st.exento > 0) {
        xml += `      <SubTotalExento>${fmt(st.exento)}</SubTotalExento>\n`;
      }

      // 14. MontoSubTotal
      xml += `      <MontoSubTotal>${fmt(st.montoSubtotal)}</MontoSubTotal>\n`;

      // 15. Lineas — omitted (not in input interface, optional in XSD)

      xml += `    </Subtotal>\n`;
    }

    xml += '  </Subtotales>';
    return xml;
  }

  /**
   * Section E: Paginacion (optional, código 3).
   * Per-page subtotals for multi-page invoices.
   */
  private buildPaginacion(paginas: PaginacionInput[]): string {
    if (!paginas || paginas.length === 0) return '';

    let xml = '  <Paginacion>\n';

    for (const p of paginas) {
      xml += `    <Pagina>\n`;
      xml += `      <PaginaNo>${p.paginaNo}</PaginaNo>\n`;
      xml += `      <NoLineaDesde>${p.noLineaDesde}</NoLineaDesde>\n`;
      xml += `      <NoLineaHasta>${p.noLineaHasta}</NoLineaHasta>\n`;

      if (p.subtotalMontoGravadoPagina != null && p.subtotalMontoGravadoPagina > 0) {
        xml += `      <SubtotalMontoGravadoPagina>${fmt(p.subtotalMontoGravadoPagina)}</SubtotalMontoGravadoPagina>\n`;
      }
      if (p.subtotalMontoGravado1Pagina != null && p.subtotalMontoGravado1Pagina > 0) {
        xml += `      <SubtotalMontoGravado1Pagina>${fmt(p.subtotalMontoGravado1Pagina)}</SubtotalMontoGravado1Pagina>\n`;
      }
      if (p.subtotalMontoGravado2Pagina != null && p.subtotalMontoGravado2Pagina > 0) {
        xml += `      <SubtotalMontoGravado2Pagina>${fmt(p.subtotalMontoGravado2Pagina)}</SubtotalMontoGravado2Pagina>\n`;
      }
      if (p.subtotalMontoGravado3Pagina != null && p.subtotalMontoGravado3Pagina > 0) {
        xml += `      <SubtotalMontoGravado3Pagina>${fmt(p.subtotalMontoGravado3Pagina)}</SubtotalMontoGravado3Pagina>\n`;
      }
      if (p.subtotalExentoPagina != null && p.subtotalExentoPagina > 0) {
        xml += `      <SubtotalExentoPagina>${fmt(p.subtotalExentoPagina)}</SubtotalExentoPagina>\n`;
      }
      // M10: Per XSD element names use "Itbis" (NOT "ITBIS") in Paginacion section
      if (p.subtotalItbisPagina != null && p.subtotalItbisPagina > 0) {
        xml += `      <SubtotalItbisPagina>${fmt(p.subtotalItbisPagina)}</SubtotalItbisPagina>\n`;
      }
      if (p.subtotalItbis1Pagina != null && p.subtotalItbis1Pagina > 0) {
        xml += `      <SubtotalItbis1Pagina>${fmt(p.subtotalItbis1Pagina)}</SubtotalItbis1Pagina>\n`;
      }
      if (p.subtotalItbis2Pagina != null && p.subtotalItbis2Pagina > 0) {
        xml += `      <SubtotalItbis2Pagina>${fmt(p.subtotalItbis2Pagina)}</SubtotalItbis2Pagina>\n`;
      }
      if (p.subtotalItbis3Pagina != null && p.subtotalItbis3Pagina > 0) {
        xml += `      <SubtotalItbis3Pagina>${fmt(p.subtotalItbis3Pagina)}</SubtotalItbis3Pagina>\n`;
      }
      if (p.subtotalImpuestoAdicionalPagina != null && p.subtotalImpuestoAdicionalPagina > 0) {
        xml += `      <SubtotalImpuestoAdicionalPagina>${fmt(p.subtotalImpuestoAdicionalPagina)}</SubtotalImpuestoAdicionalPagina>\n`;
      }

      xml += `      <MontoSubtotalPagina>${fmt(p.montoSubtotalPagina)}</MontoSubtotalPagina>\n`;

      if (p.subtotalMontoNoFacturablePagina != null && p.subtotalMontoNoFacturablePagina > 0) {
        xml += `      <SubtotalMontoNoFacturablePagina>${fmt(p.subtotalMontoNoFacturablePagina)}</SubtotalMontoNoFacturablePagina>\n`;
      }

      xml += `    </Pagina>\n`;
    }

    xml += '  </Paginacion>';
    return xml;
  }

  private buildInformacionReferencia(ref: any): string {
    let xml = '  <InformacionReferencia>\n';
    xml += `    <NCFModificado>${escapeXml(ref.encf)}</NCFModificado>\n`;

    // RNCOtroContribuyente: when NC/ND references another contributor's e-CF
    if (ref.rncOtroContribuyente) {
      xml += `    <RNCOtroContribuyente>${escapeXml(ref.rncOtroContribuyente)}</RNCOtroContribuyente>\n`;
    }

    xml += `    <FechaNCFModificado>${ref.date}</FechaNCFModificado>\n`;
    xml += `    <CodigoModificacion>${ref.modificationCode}</CodigoModificacion>\n`;

    // RazonModificacion: optional per XSD (AlfNum90ValidationType, max 90 chars)
    if (ref.reason) {
      xml += `    <RazonModificacion>${escapeXml(ref.reason.substring(0, 90))}</RazonModificacion>\n`;
    }

    xml += '  </InformacionReferencia>';
    return xml;
  }

  private buildOtraMoneda(currency: { code: string; exchangeRate: number }, totals: InvoiceTotals): string {
    const rate = currency.exchangeRate;

    let xml = '    <OtraMoneda>\n';
    xml += `      <TipoMoneda>${escapeXml(currency.code)}</TipoMoneda>\n`;
    xml += `      <TipoCambio>${ValidationService.formatExchangeRate(rate)}</TipoCambio>\n`;

    // MontoGravadoTotalOtraMoneda
    const gravadoTotal = r2(totals.taxableAmount18 + totals.taxableAmount16 + totals.taxableAmount0);
    xml += `      <MontoGravadoTotalOtraMoneda>${fmt(r2(gravadoTotal / rate))}</MontoGravadoTotalOtraMoneda>\n`;

    // Breakdown by rate
    if (totals.taxableAmount18 > 0) {
      xml += `      <MontoGravado1OtraMoneda>${fmt(r2(totals.taxableAmount18 / rate))}</MontoGravado1OtraMoneda>\n`;
    }
    if (totals.taxableAmount16 > 0) {
      xml += `      <MontoGravado2OtraMoneda>${fmt(r2(totals.taxableAmount16 / rate))}</MontoGravado2OtraMoneda>\n`;
    }
    if (totals.taxableAmount0 > 0) {
      xml += `      <MontoGravado3OtraMoneda>${fmt(r2(totals.taxableAmount0 / rate))}</MontoGravado3OtraMoneda>\n`;
    }

    // MontoExentoOtraMoneda
    if (totals.exemptAmount > 0) {
      xml += `      <MontoExentoOtraMoneda>${fmt(r2(totals.exemptAmount / rate))}</MontoExentoOtraMoneda>\n`;
    }

    // ITBIS totals in other currency
    if (totals.totalItbis > 0) {
      xml += `      <TotalITBISOtraMoneda>${fmt(r2(totals.totalItbis / rate))}</TotalITBISOtraMoneda>\n`;
    }
    if (totals.itbis18 > 0) {
      xml += `      <TotalITBIS1OtraMoneda>${fmt(r2(totals.itbis18 / rate))}</TotalITBIS1OtraMoneda>\n`;
    }
    if (totals.itbis16 > 0) {
      xml += `      <TotalITBIS2OtraMoneda>${fmt(r2(totals.itbis16 / rate))}</TotalITBIS2OtraMoneda>\n`;
    }
    if (totals.itbis0 > 0) {
      xml += `      <TotalITBIS3OtraMoneda>${fmt(r2(totals.itbis0 / rate))}</TotalITBIS3OtraMoneda>\n`;
    }

    // ISC in other currency
    const montoImpAdOtra = r2((totals.totalIsc + totals.totalOtrosImpuestos) / rate);
    if (montoImpAdOtra > 0) {
      xml += `      <MontoImpuestoAdicionalOtraMoneda>${fmt(montoImpAdOtra)}</MontoImpuestoAdicionalOtraMoneda>\n`;
    }

    // ImpuestosAdicionalesOtraMoneda wrapper (per XSD: ImpuestoAdicionalOtraMoneda(1,20))
    if (totals.additionalTaxEntries && totals.additionalTaxEntries.length > 0) {
      xml += `      <ImpuestosAdicionalesOtraMoneda>\n`;
      for (const entry of totals.additionalTaxEntries) {
        xml += `        <ImpuestoAdicionalOtraMoneda>\n`;
        xml += `          <TipoImpuestoOtraMoneda>${entry.tipoImpuesto}</TipoImpuestoOtraMoneda>\n`;
        xml += `          <TasaImpuestoAdicionalOtraMoneda>${entry.tasaImpuestoAdicional}</TasaImpuestoAdicionalOtraMoneda>\n`;
        if (entry.montoIscEspecifico && entry.montoIscEspecifico > 0) {
          xml += `          <MontoImpuestoSelectivoConsumoEspecificoOtraMoneda>${fmt(r2(entry.montoIscEspecifico / rate))}</MontoImpuestoSelectivoConsumoEspecificoOtraMoneda>\n`;
        }
        if (entry.montoIscAdvalorem && entry.montoIscAdvalorem > 0) {
          xml += `          <MontoImpuestoSelectivoConsumoAdvaloremOtraMoneda>${fmt(r2(entry.montoIscAdvalorem / rate))}</MontoImpuestoSelectivoConsumoAdvaloremOtraMoneda>\n`;
        }
        if (entry.otrosImpuestosAdicionales && entry.otrosImpuestosAdicionales > 0) {
          xml += `          <OtrosImpuestosAdicionalesOtraMoneda>${fmt(r2(entry.otrosImpuestosAdicionales / rate))}</OtrosImpuestosAdicionalesOtraMoneda>\n`;
        }
        xml += `        </ImpuestoAdicionalOtraMoneda>\n`;
      }
      xml += `      </ImpuestosAdicionalesOtraMoneda>\n`;
    }

    // Total
    xml += `      <MontoTotalOtraMoneda>${fmt(r2(totals.totalAmount / rate))}</MontoTotalOtraMoneda>\n`;
    xml += '    </OtraMoneda>';

    return xml;
  }
  // ============================================================
  // E46 SPECIFIC: InformacionesAdicionales & Transporte
  // ============================================================

  private buildInformacionesAdicionales(info: any, typeCode: number): string {
    let xml = '    <InformacionesAdicionales>\n';

    // Common fields (present in both E31 and E46 XSDs)
    if (info.shipmentDate) {
      xml += `      <FechaEmbarque>${info.shipmentDate}</FechaEmbarque>\n`;
    }
    if (info.shipmentNumber) {
      xml += `      <NumeroEmbarque>${escapeXml(info.shipmentNumber)}</NumeroEmbarque>\n`;
    }
    if (info.containerNumber) {
      xml += `      <NumeroContenedor>${escapeXml(info.containerNumber)}</NumeroContenedor>\n`;
    }
    if (info.referenceNumber) {
      xml += `      <NumeroReferencia>${escapeXml(info.referenceNumber)}</NumeroReferencia>\n`;
    }

    // E31 XSD fields (PesoBruto, PesoNeto, Unidades, CantidadBulto, VolumenBulto)
    if (info.grossWeight) {
      xml += `      <PesoBruto>${info.grossWeight}</PesoBruto>\n`;
    }
    if (info.netWeight) {
      xml += `      <PesoNeto>${info.netWeight}</PesoNeto>\n`;
    }
    if (info.grossWeightUnit) {
      xml += `      <UnidadPesoBruto>${info.grossWeightUnit}</UnidadPesoBruto>\n`;
    }
    if (info.netWeightUnit) {
      xml += `      <UnidadPesoNeto>${info.netWeightUnit}</UnidadPesoNeto>\n`;
    }
    if (info.packageCount) {
      xml += `      <CantidadBulto>${info.packageCount}</CantidadBulto>\n`;
    }
    if (info.packageUnit) {
      xml += `      <UnidadBulto>${info.packageUnit}</UnidadBulto>\n`;
    }
    if (info.packageVolume) {
      xml += `      <VolumenBulto>${info.packageVolume}</VolumenBulto>\n`;
    }
    if (info.volumeUnit) {
      xml += `      <UnidadVolumen>${info.volumeUnit}</UnidadVolumen>\n`;
    }

    // E46-only export fields (NOT in E31 XSD — guarded by typeCode)
    if (typeCode === 46) {
      if (info.portOfShipment) {
        xml += `      <NombrePuertoEmbarque>${escapeXml(info.portOfShipment)}</NombrePuertoEmbarque>\n`;
      }
      if (info.deliveryConditions) {
        xml += `      <CondicionesEntrega>${escapeXml(info.deliveryConditions)}</CondicionesEntrega>\n`;
      }
      if (info.totalFob) {
        xml += `      <TotalFob>${fmt(info.totalFob)}</TotalFob>\n`;
      }
      if (info.insurance) {
        xml += `      <Seguro>${fmt(info.insurance)}</Seguro>\n`;
      }
      if (info.freight) {
        xml += `      <Flete>${fmt(info.freight)}</Flete>\n`;
      }
      if (info.otherExpenses) {
        xml += `      <OtrosGastos>${fmt(info.otherExpenses)}</OtrosGastos>\n`;
      }
      if (info.totalCif) {
        xml += `      <TotalCif>${fmt(info.totalCif)}</TotalCif>\n`;
      }
      if (info.customsRegime) {
        xml += `      <RegimenAduanero>${escapeXml(info.customsRegime)}</RegimenAduanero>\n`;
      }
      if (info.departurePort) {
        xml += `      <NombrePuertoSalida>${escapeXml(info.departurePort)}</NombrePuertoSalida>\n`;
      }
      if (info.arrivalPort) {
        xml += `      <NombrePuertoDesembarque>${escapeXml(info.arrivalPort)}</NombrePuertoDesembarque>\n`;
      }
    }

    xml += '    </InformacionesAdicionales>';
    return xml;
  }

  private buildTransporte(transport: any, typeCode: number): string {
    let xml = '    <Transporte>\n';

    // Common transport fields (E31 XSD: 7 elements — all types that have Transporte)
    if (transport.conductor) {
      xml += `      <Conductor>${escapeXml(transport.conductor)}</Conductor>\n`;
    }
    if (transport.documentoTransporte) {
      xml += `      <DocumentoTransporte>${transport.documentoTransporte}</DocumentoTransporte>\n`;
    }
    if (transport.ficha) {
      xml += `      <Ficha>${escapeXml(transport.ficha)}</Ficha>\n`;
    }
    if (transport.placa) {
      xml += `      <Placa>${escapeXml(transport.placa)}</Placa>\n`;
    }
    if (transport.rutaTransporte) {
      xml += `      <RutaTransporte>${escapeXml(transport.rutaTransporte)}</RutaTransporte>\n`;
    }
    if (transport.zonaTransporte) {
      xml += `      <ZonaTransporte>${escapeXml(transport.zonaTransporte)}</ZonaTransporte>\n`;
    }
    if (transport.numeroAlbaran) {
      xml += `      <NumeroAlbaran>${escapeXml(transport.numeroAlbaran)}</NumeroAlbaran>\n`;
    }

    // E46-only export transport fields (NOT in E31 XSD)
    if (typeCode === 46) {
      if (transport.viaTransporte) {
        xml += `      <ViaTransporte>${String(transport.viaTransporte).padStart(2, '0')}</ViaTransporte>\n`;
      }
      if (transport.countryOrigin) {
        xml += `      <PaisOrigen>${escapeXml(transport.countryOrigin)}</PaisOrigen>\n`;
      }
      if (transport.destinationAddress) {
        xml += `      <DireccionDestino>${escapeXml(transport.destinationAddress)}</DireccionDestino>\n`;
      }
      if (transport.countryDestination) {
        xml += `      <PaisDestino>${escapeXml(transport.countryDestination)}</PaisDestino>\n`;
      }
      if (transport.carrierRnc) {
        xml += `      <RNCIdentificacionCompaniaTransportista>${escapeXml(transport.carrierRnc)}</RNCIdentificacionCompaniaTransportista>\n`;
      }
      if (transport.carrierName) {
        xml += `      <NombreCompaniaTransportista>${escapeXml(transport.carrierName)}</NombreCompaniaTransportista>\n`;
      }
      if (transport.tripNumber) {
        xml += `      <NumeroViaje>${escapeXml(transport.tripNumber)}</NumeroViaje>\n`;
      }
    }

    xml += '    </Transporte>';
    return xml;
  }

  /**
   * Validate that a municipality/province code is a valid DGII ProvinciaMunicipioType.
   * Must be a 6-digit code from the official DGII enumeration (582 codes).
   */
  private validateProvinciaMunicipio(code: string, fieldName: string): void {
    if (!isValidProvinciaMunicipio(code)) {
      throw new BadRequestException(
        `${fieldName}: "${code}" no es un código DGII válido. ` +
        `Debe ser un código de 6 dígitos del catálogo ProvinciaMunicipioType de la DGII ` +
        `(ej: "010101" para Santo Domingo de Guzmán, "250101" para Santiago).`,
      );
    }
  }

  /**
   * Parse DGII date format (DD-MM-YYYY) to Date object.
   * Also handles YYYY-MM-DD and ISO formats as fallback.
   */
  private parseDgiiDate(dateStr: string): Date {
    // Try DD-MM-YYYY
    const dgiiMatch = dateStr.match(/^(\d{2})-(\d{2})-(\d{4})$/);
    if (dgiiMatch) {
      return new Date(parseInt(dgiiMatch[3]), parseInt(dgiiMatch[2]) - 1, parseInt(dgiiMatch[1]));
    }
    // Fallback to native Date parsing (YYYY-MM-DD, ISO, etc.)
    return new Date(dateStr);
  }
}

// ============================================================
// HELPER TYPES AND FUNCTIONS
// ============================================================

export interface EmitterData {
  rnc: string;
  businessName: string;
  tradeName?: string;
  /** Sucursal: branch/office ID (AlfNum20Type, max 20 chars) */
  branchCode?: string;
  address?: string;
  municipality?: string;
  province?: string;
  /** ActividadEconomica: economic activity description (AlfNum100Type, max 100 chars) */
  economicActivity?: string;
}

/** Escape XML special characters and control chars per DGII Descripción Técnica p.63 */
function escapeXml(str: string): string {
  return str
    // Strip XML-invalid control characters (0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F)
    // XML 1.0 only allows: #x9 (tab), #xA (LF), #xD (CR) among control chars
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    // Escape XML special characters
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&#34;')
    .replace(/'/g, '&#39;')
    // Escape allowed control chars as numeric references for safety
    .replace(/\t/g, '&#9;')
    .replace(/\n/g, '&#10;')
    .replace(/\r/g, '&#13;');
}

/**
 * Format date as DD-MM-YYYY in GMT-4 (America/Santo_Domingo).
 * Per DGII: all dates must be in Dominican Republic timezone.
 * FechaValidationType per DGII XSD e-CF v1.0.
 */
function formatDate(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Santo_Domingo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);

  const get = (type: string) => parts.find(p => p.type === type)?.value || '00';
  return `${get('day')}-${get('month')}-${get('year')}`;
}

