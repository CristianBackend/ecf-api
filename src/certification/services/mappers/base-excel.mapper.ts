/**
 * Shared utilities used by all type-specific Excel mappers.
 *
 * Design:
 * - `v()`  → safe getter: returns undefined for '#e', null, empty string
 * - `s()`  → coerce to string | undefined
 * - `n()`  → coerce to number | undefined
 * - `mapBuyer()`, `mapPayment()`, `mapItems()` → common section builders
 * - `mapBase()` → builds the shared DTO skeleton every mapper extends
 */

import { ExcelRow, ExcelItem } from './excel-mapper.interface';

// ---------------------------------------------------------------------------
// Primitive helpers
// ---------------------------------------------------------------------------

/** Return undefined for Excel "not included" sentinel values. */
export function v(raw: unknown): string | number | undefined {
  if (raw === undefined || raw === null || raw === '' || raw === '#e') return undefined;
  return raw as string | number;
}

export function s(raw: unknown): string | undefined {
  const r = v(raw);
  return r !== undefined ? String(r).trim() : undefined;
}

export function n(raw: unknown): number | undefined {
  const r = v(raw);
  if (r === undefined) return undefined;
  const num = Number(r);
  return isNaN(num) ? undefined : num;
}

/** Parse an integer, stripping leading zeros (e.g. "01" → 1). */
export function int(raw: unknown): number | undefined {
  const r = v(raw);
  if (r === undefined) return undefined;
  const parsed = parseInt(String(r), 10);
  return isNaN(parsed) ? undefined : parsed;
}

/**
 * Return the verbatim string representation of a numeric Excel cell,
 * preserving the EXACT decimal precision the source used. Returns undefined
 * for empty / '#e' cells, and also if the value does not look like a valid
 * number (so we never propagate garbage to the XML).
 *
 * DGII certification compares XML field values as STRINGS byte-for-byte
 * against the dataset. The set is loaded with varying precision per case:
 *   PrecioUnitarioItem "100.00" (E43) vs "1500.0000" (E31)
 *   CantidadItem "1" (E43:12) vs "7.00" (E43:1)
 * Round-tripping through Number() loses this formatting, so we keep the
 * verbatim string separately and emit it as-is.
 */
export function rawNum(raw: unknown): string | undefined {
  const r = v(raw);
  if (r === undefined) return undefined;
  const str = String(r).trim();
  // Accept integers, decimals, optional leading minus. Reject anything else
  // (text, dates) to avoid emitting non-numeric values into numeric XML fields.
  if (!/^-?\d+(\.\d+)?$/.test(str)) return undefined;
  return str;
}

/**
 * Extract the decimal sequence number from a full eNCF string.
 * "E320000000011" → 11
 */
export function encfToOverride(encf: string | undefined): number | undefined {
  if (!encf || encf.length !== 13) return undefined;
  return parseInt(encf.slice(3), 10) || undefined;
}

// ---------------------------------------------------------------------------
// Section mappers
// ---------------------------------------------------------------------------

export function mapBuyer(row: ExcelRow) {
  return {
    rnc:                s(row.RNCComprador),
    name:               s(row.RazonSocialComprador) ?? 'Consumidor Final',
    contactName:        s(row.ContactoComprador),
    email:              s(row.CorreoComprador),
    address:            s(row.DireccionComprador),
    municipality:       s(row.MunicipioComprador),
    province:           s(row.ProvinciaComprador),
    type:               int(row.TipoPersonaComprador),
    foreignId:          s(row.IdentificadorExtranjero),
    country:            s(row.PaisCompradorResidencia),
    deliveryDate:       s(row.FechaEntrega),
    deliveryContact:    s(row.ContactoEntrega),
    deliveryAddress:    s(row.DireccionEntrega),
    additionalPhone:    s(row.TelefonoAdicional),
    orderDate:          s(row.FechaOrdenCompra),
    orderNumber:        s(row.NumeroOrdenCompra),
    internalCode:       s(row.CodigoInternoComprador),
    paymentResponsible: s(row.ResponsablePago),
    additionalInfo:     s(row.InformacionAdicionalComprador),
  };
}

export function mapPayment(row: ExcelRow) {
  return {
    type:        n(row.TipoPago) ?? 1,
    method:      int(row.FormaPago),
    date:        s(row.FechaPago),
    termDays:    int(row.TerminoPago),
    accountType: s(row.TipoCuentaPago),
    accountNumber: s(row.NumeroCuentaPago),
    bank:        s(row.BancoPago),
  };
}

export function mapItem(item: ExcelItem) {
  // TipoIngresos in Excel is a 2-char string "01"–"06", parse to int
  const tipoIngresos = item.TipoIngresos !== undefined ? int(item.TipoIngresos) : undefined;

  // Verbatim decimal strings from the Excel cell. Only set when the source
  // value parses as a number; otherwise undefined (so the builder falls
  // back to its standard fmt()).
  const rawText = {
    CantidadItem:             rawNum(item.CantidadItem),
    PrecioUnitarioItem:       rawNum(item.PrecioUnitarioItem),
    PrecioUnitarioReferencia: rawNum(item.PrecioUnitarioReferencia),
    PrecioOtraMoneda:         rawNum(item.PrecioOtraMoneda),
    MontoItem:                rawNum(item.MontoItem),
    DescuentoMonto:           rawNum(item.DescuentoMonto),
    RecargoMonto:             rawNum(item.RecargoMonto),
    CantidadReferencia:       rawNum(item.CantidadReferencia),
  };
  const hasAnyRaw = Object.values(rawText).some(v => v !== undefined);

  return {
    description:          s(item.NombreItem) ?? 'Item',
    quantity:             n(item.CantidadItem) ?? 1,
    unitPrice:            n(item.PrecioUnitarioItem) ?? 0,
    discount:             n(item.DescuentoMonto),
    surcharge:            n(item.RecargoMonto),
    itbisRate:            n(item.TasaITBIS),
    indicadorFacturacion: int(item.IndicadorFacturacion),
    // DGII Excel header is `IndicadorBienoServicio[N]` (one 'o', not "BienOServicio").
    // Reading the wrong header silently returned undefined, the builder omitted
    // the tag, and DGII rejected E43/E44/E47 with:
    //   "valor enviado (1) no coincide con valor (2)" (servicio)
    goodService:          int(item.IndicadorBienoServicio),
    unit:                 s(item.UnidadMedida),
    incomeType:           tipoIngresos,
    manufacturingDate:    s(item.FechaElaboracion),
    // ISC fields
    additionalTaxRate:    n(item.TasaImpuestoAdicional),
    alcoholDegrees:       n(item.GradosAlcohol),
    referenceQuantity:    n(item.CantidadReferencia),
    referenceUnitPrice:   n(item.PrecioUnitarioReferencia),
    // Retention (E41)
    retencionIndicador:   int(item.IndicadorAgenteRetencionoPercepcion),
    montoItbisRetenido:   n(item.MontoITBISRetenido),
    montoIsrRetenido:     n(item.MontoISRRetenido),
    // Verbatim Excel strings for decimal fields (Fix 4f).
    ...(hasAnyRaw ? { rawText } : {}),
  };
}

export function mapItems(row: ExcelRow) {
  return Object.entries(row._items)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, item]) => mapItem(item));
}

export function mapCurrency(row: ExcelRow) {
  const code = s(row.TipoMoneda);
  const rate = n(row.TipoCambio);
  if (!code || code === 'DOP') return undefined;
  return { code, exchangeRate: rate ?? 1 };
}

// ---------------------------------------------------------------------------
// InformacionesAdicionales (Peso, Bulto, Volumen) — XSD optional for E31/E32/E33/E34
// ---------------------------------------------------------------------------

/**
 * Lift weight/package/volume fields from the certification Excel into the
 * additionalInfo block. These are root-level columns (PesoBruto, PesoNeto,
 * CantidadBulto, VolumenBulto and their unit codes), not per-item.
 *
 * Without this, the XML omits PesoNeto entirely but DGII for E310000000005
 * expects it filled (the test set has "24.50"). The mismatch causes:
 *   "El campo PesoNeto del área InformacionesAdicionales no es válido"
 */
export function mapAdditionalInfo(row: ExcelRow) {
  const info = {
    grossWeight:     n(row.PesoBruto),
    netWeight:       n(row.PesoNeto),
    grossWeightUnit: int(row.UnidadPesoBruto),
    netWeightUnit:   int(row.UnidadPesoNeto),
    packageCount:    n(row.CantidadBulto),
    packageUnit:     int(row.UnidadBulto),
    packageVolume:   n(row.VolumenBulto),
    volumeUnit:      int(row.UnidadVolumen),
  };

  // Strip undefined: if Excel sends '#e' for everything, return undefined so
  // the builder omits the entire InformacionesAdicionales block.
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(info)) {
    if (v !== undefined) cleaned[k] = v;
  }
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

// ---------------------------------------------------------------------------
// Base DTO builder
// ---------------------------------------------------------------------------

/**
 * Build the common DTO fields shared by every e-CF type.
 * Type-specific mappers spread this and add their own fields.
 */
export function mapBase(row: ExcelRow, companyId: string, ecfType: string): Record<string, unknown> {
  const encf = s(row.eNCF ?? row.ENCF);
  const emitterOverride = mapEmitter(row);
  const additionalInfo = mapAdditionalInfo(row);

  // DGII certification overrides — read straight from the Excel row.
  //
  // The DGII test set is inconsistent across cases for MontoPeriodo,
  // ValorPagar and TipoPago: the SAME e-CF type can want different
  // present/absent behavior on different rows. Honoring the value from
  // the Excel is the only way to match all of them without violating XSD.
  //   - '#e' / missing → undefined → builder omits the tag
  //   - numeric value  → builder emits with that value
  // For TipoPago we also encode "Excel said #e" as emitTipoPago=false so
  // the builder omits the tag even when input.payment.type defaults to 1
  // (the underlying default is set elsewhere to keep PROD callers safe).
  const montoPeriodoExcel = n(row.MontoPeriodo);
  const valorPagarExcel = n(row.ValorPagar);
  const tipoPagoExcelRaw = v(row.TipoPago);

  return {
    companyId,
    ecfType,
    buyer:           mapBuyer(row),
    items:           mapItems(row),
    payment:         mapPayment(row),
    currency:        mapCurrency(row),
    fechaEmision:    s(row.FechaEmision),
    encfOverride:    encfToOverride(encf),
    idempotencyKey:  `cert-${encf ?? Date.now()}`,
    indicadorMontoGravado:  int(row.IndicadorMontoGravado),
    indicadorEnvioDiferido: int(row.IndicadorEnvioDiferido),
    // IndicadorNotaCredito: DGII test set expects fixed values per row, not
    // a computed one from reference.date. If Excel sends '#e' (-> undefined),
    // the builder will fall back to its 30-day calculation.
    indicadorNotaCredito:   int(row.IndicadorNotaCredito),
    ...(montoPeriodoExcel !== undefined ? { montoPeriodo: montoPeriodoExcel } : {}),
    ...(valorPagarExcel !== undefined ? { valorPagar: valorPagarExcel } : {}),
    // tipoPagoExcelRaw === undefined means the Excel had '#e' (or was empty).
    // Encode that intent as emitTipoPago=false so the builder omits the tag
    // for E43/E47 (the only types where it's XSD-optional).
    ...(tipoPagoExcelRaw === undefined ? { emitTipoPago: false } : {}),
    ...(emitterOverride ? { emitterOverride } : {}),
    ...(additionalInfo ? { additionalInfo } : {}),
    metadata: { certificationRow: true, casoPrueba: s(row.CasoPrueba) },
  };
}

export function mapReference(row: ExcelRow) {
  const encf = s(row.NCFModificado);
  if (!encf) return undefined;
  return {
    encf,
    date:               s(row.FechaNCFModificado) ?? '01-01-2020',
    modificationCode:   int(row.CodigoModificacion) ?? 1,
    rncOtroContribuyente: s(row.RNCOtroContribuyente),
    reason:             s(row.RazonModificacion),
  };
}

// ---------------------------------------------------------------------------
// Emitter override (CERT/DEV only)
// ---------------------------------------------------------------------------

/**
 * DGII certification test set has FIXED expected values for Emisor fields
 * (RazonSocial, Direccion, etc.) that don't match the real company in DB.
 * For each row, lift these values from the Excel into an `emitterOverride`
 * that the backend will merge over the Company data when building the XML.
 *
 * This is only honored when the company is in CERT/DEV environment.
 * In PROD it is rejected by InvoicesService.create().
 */
export function mapEmitter(row: ExcelRow) {
  // TelefonoValidationType in DGII XSD requires format "DDD-DDD-DDDD"
  // (e.g. "809-472-7676"). The Excel already provides them in this format,
  // so we only validate the pattern and pass through — no normalization.
  const rawPhones = Array.isArray(row.TelefonoEmisor)
    ? (row.TelefonoEmisor as unknown[])
    : [];
  const phones = rawPhones
    .map(p => s(p))
    .filter((p): p is string => !!p && /^\d{3}-\d{3}-\d{4}$/.test(p));

  const override = {
    businessName:           s(row.RazonSocialEmisor),
    tradeName:              s(row.NombreComercial),
    branchCode:             s(row.Sucursal),
    address:                s(row.DireccionEmisor),
    municipality:           s(row.Municipio),
    province:               s(row.Provincia),
    phones:                 phones.length > 0 ? phones : undefined,
    email:                  s(row.CorreoEmisor),
    website:                s(row.WebSite),
    economicActivity:       s(row.ActividadEconomica),
    vendorCode:             s(row.CodigoVendedor),
    internalInvoiceNumber:  s(row.NumeroFacturaInterna),
    internalOrderNumber:    s(row.NumeroPedidoInterno),
    salesZone:              s(row.ZonaVenta),
    salesRoute:             s(row.RutaVenta),
    additionalEmitterInfo:  s(row.InformacionAdicionalEmisor),
  };

  // Strip undefined keys so the DTO validator doesn't see empty strings.
  const cleaned: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(override)) {
    if (val !== undefined) cleaned[k] = val;
  }

  // If no overridable field is present, return undefined (no override sent).
  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}
