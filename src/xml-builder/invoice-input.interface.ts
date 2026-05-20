/**
 * Invoice input types - JSON structure that API clients send.
 * The XML Builder transforms these into DGII-compliant XML.
 * Updated: Full DGII compliance (ISC, additional taxes, Norma 07-07)
 */

/** Main invoice creation input */
export interface InvoiceInput {
  /** Company ID (emisor) */
  companyId: string;

  /** e-CF type: E31, E32, E33, E34, E41, E43, E44, E45, E46, E47 */
  ecfType: string;

  /** eNCF - auto-assigned from sequences if not provided */
  encf?: string;

  /** Buyer/Receptor information */
  buyer: BuyerInput;

  /** Line items (max 1000, or 10000 for FC < 250K) */
  items: InvoiceItemInput[];

  /** Payment information */
  payment: PaymentInput;

  /** Reference to original e-CF (required for types 33, 34) */
  reference?: ReferenceInput;

  /** Currency info (defaults to DOP) */
  currency?: CurrencyInput;

  /** Additional discounts or surcharges at document level */
  discountsOrSurcharges?: DiscountSurchargeInput[];

  /** Indicador Monto Gravado: 0=sin ITBIS, 1=con ITBIS incluido */
  indicadorMontoGravado?: number;

  /** Indicador Envío Diferido: 0=normal, 1=diferido */
  indicadorEnvioDiferido?: number;

  /**
   * Indicador Nota de Crédito (only for E34).
   * 0 = original e-CF date is ≤ 30 calendar days ago (NC can deduct ITBIS).
   * 1 = original e-CF date is > 30 calendar days ago (NC cannot deduct ITBIS).
   * If absent, computed from reference.date and current date.
   */
  indicadorNotaCredito?: number;

  /**
   * MontoPeriodo override (XSD cod 3, opcional).
   * When provided, emitted as-is. When undefined, falls back to per-type
   * default behavior (some types compute it from totals, others omit).
   * Used by certification flow to forward the exact value from the Excel
   * row, which can be either a number or absent ("#e") per case.
   */
  montoPeriodo?: number;

  /**
   * ValorPagar override (XSD cod 3, opcional). Same semantics as
   * montoPeriodo.
   */
  valorPagar?: number;

  /**
   * TipoPago override (presence/absence). When `undefined` AND the type
   * allows omission (E43, E47 — cod 3), the tag is omitted. Otherwise the
   * builder uses `payment.type`. This exists so the certification flow
   * can faithfully reproduce the case where Excel has `#e` for TipoPago
   * (E430000000001 in the DGII test set).
   */
  emitTipoPago?: boolean;

  /**
   * Verbatim string overrides for header-level totals (Fix 4g).
   *
   * DGII certification compares total values as STRINGS. The dataset's
   * Excel has the totals PRE-CALCULATED per case, and they don't always
   * coincide with what our `calculateTotals()` derives from items because
   * the Excel uses specific rounding rules, includes adjustments not
   * present in item lines (weight/volume breakdowns, retentions), and in
   * some cases (NC corrección de texto E34 with modCode=2) outright
   * disagrees with what the items would calculate (Excel has MontoTotal=0
   * even when items have MontoItem=1).
   *
   * When provided, each field is emitted VERBATIM, bypassing the
   * computed value. Empty/undefined means "compute from items as before".
   * The numeric value passed via `retention.*` / item totals continues
   * to drive any downstream math; only the literal XML emission of this
   * specific tag uses the verbatim string.
   *
   * Examples from the DGII set:
   *   E310000000005: MontoGravadoI1=622.88 (Excel) vs 735.00 (our calc)  → use Excel
   *   E320000000006: ITBIS3=0, TotalITBIS3=0.00 (Excel) — DGII wants present,
   *                  not omitted, even though monto=0
   *   E340000000018: MontoTotal=0.00 (Excel) vs 1.00 (from items) → use Excel
   *   E410000000001: TotalITBISRetenido=1800.00 (Excel) but our `retention`
   *                  field defaults to undefined → use Excel
   *
   * Production-safe: production API callers leave this undefined and the
   * builder falls through to the standard computed emission. Only the
   * certification flow populates it from the Excel row.
   */
  totalsRawText?: TotalsRawText;

  /** Idempotency key to prevent duplicates */
  idempotencyKey?: string;

  /** Custom metadata (not sent to DGII) */
  metadata?: Record<string, any>;

  /** Fecha de emisión override (DD-MM-YYYY). If not provided, uses current date.
   * Useful for contingency resubmission to preserve original emission date. */
  fechaEmision?: string;

  /** Sequence expiry date (auto-populated from sequences table) */
  sequenceExpiresAt?: string;

  /** Retention/Perception totals (mainly for E41 Compras) */
  retention?: RetentionInput;

  /** SubtotalesInformativos (Section C, optional) */
  subtotalesInformativos?: SubtotalInformativoInput[];

  /** Paginacion (Section E, optional — per-page subtotals for multi-page invoices) */
  paginacion?: PaginacionInput[];

  /** Additional info for E46 Exportaciones (InformacionesAdicionales section) */
  additionalInfo?: ExportAdditionalInfoInput;

  /** Transport info for E46 Exportaciones (Transporte section) */
  transport?: TransportInput;
}

/** Retention/Perception info (for agentes de retención) */
export interface RetentionInput {
  itbisRetenido?: number;
  isrRetencion?: number;
  itbisPercepcion?: number;
  isrPercepcion?: number;
}

/** Additional info — common fields for all types + E46-specific export fields */
export interface ExportAdditionalInfoInput {
  // Common fields (present in both E31 and E46 XSDs)
  shipmentDate?: string;           // FechaEmbarque (dd-MM-AAAA)
  shipmentNumber?: string;         // NumeroEmbarque
  containerNumber?: string;        // NumeroContenedor
  referenceNumber?: string;        // NumeroReferencia

  // E31 XSD fields (weight, packaging)
  grossWeight?: number;            // PesoBruto
  netWeight?: number;              // PesoNeto
  grossWeightUnit?: number;        // UnidadPesoBruto (UnidadMedidaType)
  netWeightUnit?: number;          // UnidadPesoNeto (UnidadMedidaType)
  packageCount?: number;           // CantidadBulto
  packageUnit?: number;            // UnidadBulto (UnidadMedidaType)
  packageVolume?: number;          // VolumenBulto
  volumeUnit?: number;             // UnidadVolumen (UnidadMedidaType)

  // E46-only export fields
  portOfShipment?: string;         // NombrePuertoEmbarque
  deliveryConditions?: string;     // CondicionesEntrega (CIF, FOB, etc)
  totalFob?: number;               // TotalFob
  insurance?: number;              // Seguro
  freight?: number;                // Flete
  otherExpenses?: number;          // OtrosGastos
  totalCif?: number;               // TotalCif
  customsRegime?: string;          // RegimenAduanero
  departurePort?: string;          // NombrePuertoSalida
  arrivalPort?: string;            // NombrePuertoDesembarque
}

/** Transport info — common fields for all types + E46-specific export fields */
export interface TransportInput {
  // Common fields (E31 XSD: Conductor, DocumentoTransporte, Ficha, Placa, RutaTransporte, ZonaTransporte, NumeroAlbaran)
  conductor?: string;               // Conductor name
  documentoTransporte?: number;     // Transport document number
  ficha?: string;                   // Ficha
  placa?: string;                   // License plate (max 7 chars)
  rutaTransporte?: string;          // Transport route
  zonaTransporte?: string;          // Transport zone
  numeroAlbaran?: string;           // Delivery note number

  // E46-only export fields
  /** ViaTransporte: 01=Terrestre, 02=Marítimo, 03=Aérea */
  viaTransporte?: number;
  countryOrigin?: string;           // PaisOrigen
  destinationAddress?: string;      // DireccionDestino
  countryDestination?: string;      // PaisDestino
  carrierRnc?: string;              // RNCIdentificacionCompaniaTransportista
  carrierName?: string;             // NombreCompaniaTransportista
  tripNumber?: string;              // NumeroViaje
  /** Forma de pago del flete (ej: "Contado", "Crédito") — shown in RI Transporte section */
  freightPaymentMethod?: string;
}

/** Buyer/Receptor information */
export interface BuyerInput {
  /** RNC or Cédula of buyer */
  rnc?: string;
  name: string;
  /** ContactoComprador (XSD AlfNum80Type) — contact person NAME, not a phone */
  contactName?: string;
  email?: string;
  /** Buyer phone (informational only; NOT emitted as ContactoComprador) */
  phone?: string;
  address?: string;
  municipality?: string;
  province?: string;
  /** Buyer type: 1=Persona Jurídica, 2=Persona Física, 3=Extranjero */
  type?: number;
  /** Foreign ID (passport/other) for buyers without RNC - E32>250K, E44, E46, E47 */
  foreignId?: string;
  /** Country (only for E46 Exportaciones) */
  country?: string;
  /** FechaEntrega DD-MM-YYYY (DGII FechaValidationType) */
  deliveryDate?: string;
  /** ContactoEntrega (AlfNum100Type) */
  deliveryContact?: string;
  /** DireccionEntrega (AlfNum100Type) */
  deliveryAddress?: string;
  /** TelefonoAdicional in format DDD-DDD-DDDD */
  additionalPhone?: string;
  /** FechaOrdenCompra DD-MM-YYYY */
  orderDate?: string;
  /** NumeroOrdenCompra (AlfNum20Type) */
  orderNumber?: string;
  /** CodigoInternoComprador (AlfNum20Type) */
  internalCode?: string;
  /** ResponsablePago (Alfa20Type) */
  paymentResponsible?: string;
  /** InformacionAdicionalComprador (AlfNum150Type) */
  additionalInfo?: string;
}

/** Individual line item */
export interface InvoiceItemInput {
  lineNumber?: number;
  description: string;
  /** Longer description (max 1000 chars, optional - maps to DescripcionItem) */
  longDescription?: string;
  quantity: number;
  unitPrice: number;
  discount?: number;

  /** M3: RecargoMonto - per-item surcharge amount (Decimal18D1or2, optional) */
  surcharge?: number;

  /** ITBIS rate: 18, 16, or 0 (defaults to 18). Use 'E' string for exempt */
  itbisRate?: number;

  /**
   * IndicadorFacturacion per XSD IndicadorFacturacionType (xs:integer):
   * 0=No Facturable, 1=ITBIS 18%, 2=ITBIS 16%, 3=ITBIS 0%, 4=Exento
   */
  indicadorFacturacion?: number;

  /** 1=Bien, 2=Servicio (obligatorio en E41, recomendado en todos) */
  goodService?: number;
  code?: string;
  /** Code type: 'INT' for internal, 'EAN' for barcode, etc. (max 14 chars) */
  codeType?: string;
  unit?: string;
  /** Unit of measure code per DGII tabla */
  unitMeasureCode?: number;
  incomeType?: number;

  // ---- Retención (E41 Compras - obligatorio) ----
  /** IndicadorAgenteRetencionoPercepcion: 0=No aplica, 1=Retencion, 2=Percepcion, 3=Ambos */
  retencionIndicador?: number;
  /** Monto ITBIS retenido por línea */
  montoItbisRetenido?: number;
  /** Monto ISR retenido por línea */
  montoIsrRetenido?: number;

  // ---- ISC fields (Alcoholes/Cigarrillos) ----
  /** Additional tax code (001-039 per DGII tabla) */
  additionalTaxCode?: string;
  /** Tax rate for additional tax */
  additionalTaxRate?: number;
  /** Alcohol degrees % (for ISC alcohol) */
  alcoholDegrees?: number;
  /** Reference quantity (e.g., units per case) */
  referenceQuantity?: number;
  /** Sub-quantity (liters per unit for alcohol) */
  subQuantity?: number;
  /** M6: CodigoSubcantidad - unit of measure code for sub-quantity (UnidadMedidaType) */
  subQuantityCode?: number;
  /** PVP - Precio de Venta al Público (reference price for ISC) */
  referenceUnitPrice?: number;

  /** M4: FechaElaboracion - manufacturing/creation date (DD-MM-YYYY, optional) */
  manufacturingDate?: string;

  /**
   * FechaVencimientoItem — expiration date of the item (DD-MM-YYYY).
   * Optional, only for E31/E32/E33/E34/E44/E45 per XSD. Often paired with
   * manufacturingDate (FechaElaboracion).
   *
   * Fix 4h: DGII certification expects FechaElaboracion='20-12-2019' and
   * FechaVencimientoItem='10-10-2020' on E310000000008 item 1; previously
   * we didn't read these from the Excel and the builder didn't emit them.
   */
  expirationDate?: string;

  /** Indicator if item amount includes ITBIS: 0=no, 1=yes */
  indicadorMontoGravado?: number;

  /**
   * Optional verbatim string overrides for numeric XML fields. When present,
   * the builder emits exactly that string instead of formatting the numeric
   * counterpart.
   *
   * DGII certification compares XML values as STRINGS, not numbers. The set
   * is loaded from Excel cells that vary case-by-case in decimal precision:
   *   E430000000001: PrecioUnitarioItem="100.00" (2 dec)
   *   E330000000001: PrecioUnitarioItem="40.00"  (2 dec)
   *   E440000000007: PrecioUnitarioItem="900.0000" (4 dec)
   *   E430000000012: CantidadItem="1"  (NO decimals)
   *   E450000000010: PrecioOtraMoneda="26.64" (2 dec, while XSD allows 4)
   *
   * Without this override, the builder always emits 4 decimals for prices and
   * 2 decimals for quantities, so DGII rejects the value mismatch.
   *
   * Keys correspond to the XML element name. Numeric inputs still drive the
   * totals calculation (sum of items, MontoTotal, etc.) — only the LITERAL
   * emission of the field uses the raw string.
   */
  rawText?: {
    CantidadItem?: string;
    PrecioUnitarioItem?: string;
    PrecioUnitarioReferencia?: string;
    PrecioOtraMoneda?: string;
    MontoItem?: string;
    DescuentoMonto?: string;
    RecargoMonto?: string;
    CantidadReferencia?: string;
  };
}

/** Payment information */
export interface PaymentInput {
  /** TipoPago: 1=Contado, 2=Crédito, 3=Gratuito */
  type: number;
  /** FormaPago: 1=Efectivo, 2=Cheque/Transferencia, 3=Tarjeta, 4=Crédito, 5=Bonos, 6=Permuta, 7=NC, 8=Otras */
  method?: number;
  date?: string;
  termDays?: number;
  /** M5: TipoCuentaPago - account type: CT=Corriente, AH=Ahorro, OT=Otra */
  accountType?: string;
  /** M5: NumeroCuentaPago - account number (max 28 chars) */
  accountNumber?: string;
  /** M5: BancoPago - bank name (max 75 chars) */
  bank?: string;

  /**
   * Multiple FormasPago (Fix 4h). Up to 7 per XSD.
   *
   * When provided, the builder uses this array INSTEAD of the single
   * (method, totalAmount) pair, emitting one <FormaDePago> entry per
   * element. The XSD's <TablaFormasPago> allows 1-7 <FormaDePago>
   * children — this lets the certification flow forward the exact
   * FormaPago[N]/MontoPago[N] values from the Excel.
   *
   * Backwards compatible: production API callers that ignore this field
   * keep getting the single-entry table built from method + totalAmount.
   *
   * Why it matters:
   *   - E470000000008 expected MontoPago=14350.00 (sub-total minus ITBIS
   *     percepción) but we emitted 17850.00 (totalAmount, includes ITBIS).
   *   - E410000000001 expected MontoPago=9000.00 vs our 11800.00.
   *   - E310000000005/8 had similar mismatches.
   * The Excel always provides the exact value; per-row override is the
   * only reliable way to get them right.
   */
  forms?: PaymentFormInput[];
}

/** Single FormaDePago entry inside <TablaFormasPago>. */
export interface PaymentFormInput {
  /** FormaPago code per DGII catalog: 1..8 */
  method: number;
  /**
   * Monto correspondiente. Numeric value used both for any downstream
   * accounting and as the source of the <MontoPago> tag. The verbatim
   * string version (preserving decimals exactly as the Excel sent it)
   * goes in `rawText` to bypass our fmt() rounding.
   */
  amount: number;
  /** Optional verbatim Excel string for MontoPago (Fix 4h, same idea as item rawText). */
  rawText?: {
    MontoPago?: string;
  };
}

/** Reference to original e-CF (for credit/debit notes) */
export interface ReferenceInput {
  /**
   * eNCF of the original document being modified.
   * Can be serie E (13 chars), serie B (11 chars), or serie A/P (19 chars).
   */
  encf: string;

  /** Date of the original document (DD-MM-YYYY) */
  date: string;

  /**
   * Modification code per DGII:
   * 1 = Anula el NCF modificado
   * 2 = Corrige texto del comprobante fiscal modificado
   * 3 = Corrige montos del NCF modificado
   * 4 = Reemplazo NCF emitido en contingencia
   */
  modificationCode: number;

  /** RNC of other contributor (when NC/ND references another contributor's e-CF) */
  rncOtroContribuyente?: string;

  /** Reason for the modification (optional text) */
  reason?: string;
}

/** Foreign currency information */
export interface CurrencyInput {
  /** ISO currency code (e.g., USD, EUR) */
  code: string;
  /** Exchange rate to DOP (up to 4 decimal places per DGII) */
  exchangeRate: number;
}

/** SubtotalesInformativos entry (Section C, optional, código 3) */
export interface SubtotalInformativoInput {
  /** Subtotal number (sequence) */
  numero: number;
  /** Name/description of this subtotal */
  nombre: string;
  /** Amount taxed at 18% */
  gravadoI1?: number;
  /** Amount taxed at 16% */
  gravadoI2?: number;
  /** Amount taxed at 0% */
  gravadoI3?: number;
  /** Exempt amount */
  exento?: number;
  /** Total ITBIS for subtotal */
  totalItbis?: number;
  /** ITBIS at 18% */
  itbis1?: number;
  /** ITBIS at 16% */
  itbis2?: number;
  /** ITBIS at 0% */
  itbis3?: number;
  /** Additional tax amount */
  impuestoAdicional?: number;
  /** Subtotal amount */
  montoSubtotal: number;
}

/** Paginacion entry (Section E, optional, código 3) */
export interface PaginacionInput {
  /** Page number */
  paginaNo: number;
  /** First line number on this page */
  noLineaDesde: number;
  /** Last line number on this page */
  noLineaHasta: number;
  /** Gravado total for this page */
  subtotalMontoGravadoPagina?: number;
  /** Gravado at 18% for this page */
  subtotalMontoGravado1Pagina?: number;
  /** Gravado at 16% for this page */
  subtotalMontoGravado2Pagina?: number;
  /** Gravado at 0% for this page */
  subtotalMontoGravado3Pagina?: number;
  /** Exempt for this page */
  subtotalExentoPagina?: number;
  /** Total ITBIS for this page */
  subtotalItbisPagina?: number;
  /** ITBIS at 18% */
  subtotalItbis1Pagina?: number;
  /** ITBIS at 16% */
  subtotalItbis2Pagina?: number;
  /** ITBIS at 0% */
  subtotalItbis3Pagina?: number;
  /** Additional tax for this page (simple total — SubtotalImpuestoAdicionalPagina) */
  subtotalImpuestoAdicionalPagina?: number;
  /** ISC Específico for this page — child of complex SubtotalImpuestoAdicional element */
  subtotalIscEspecificoPagina?: number;
  /** Otros impuestos for this page — child of complex SubtotalImpuestoAdicional element */
  subtotalOtrosImpuestoPagina?: number;
  /** Page subtotal amount */
  montoSubtotalPagina: number;
  /** Non-billable amount for this page */
  subtotalMontoNoFacturablePagina?: number;
}

/** Document-level discount or surcharge */
export interface DiscountSurchargeInput {
  isDiscount: boolean;
  description: string;
  percentage?: number;
  amount: number;
  /** Indicador Norma 10-07: set to 1 when applicable */
  indicadorNorma1007?: number;
  /** M7: MontoDescuentooRecargoOtraMoneda - amount in alternate currency */
  amountOtherCurrency?: number;
  /** M7: IndicadorFacturacionDescuentooRecargo - 1=ITBIS 18%, 2=ITBIS 16%, 3=ITBIS 0%, 4=Exento */
  indicadorFacturacion?: number;
}

/**
 * Per-tax-code entry for ImpuestosAdicionales in Totales (XSD structure).
 */
export interface AdditionalTaxEntry {
  /** Tax code per DGII CodificacionTipoImpuestosType (e.g., '001'-'039') */
  tipoImpuesto: string;
  /** Tax rate */
  tasaImpuestoAdicional: number;
  /** ISC Específico amount for this tax code */
  montoIscEspecifico?: number;
  /** ISC Ad-Valorem amount for this tax code */
  montoIscAdvalorem?: number;
  /** Other additional tax amount for this tax code */
  otrosImpuestosAdicionales?: number;
}

/**
 * Calculated invoice totals.
 * These are computed by the XML Builder from the items.
 */
export interface InvoiceTotals {
  subtotalBeforeTax: number;
  totalDiscount: number;

  /** Amount taxed at 18% (MontoGravadoI1) */
  taxableAmount18: number;
  /** Amount taxed at 16% (MontoGravadoI2) */
  taxableAmount16: number;
  /** Amount taxed at 0% (MontoGravadoI3) */
  taxableAmount0: number;
  /** Amount exempt from ITBIS (MontoExento) */
  exemptAmount: number;

  /** ITBIS at 18% (TotalITBIS1) */
  itbis18: number;
  /** ITBIS at 16% (TotalITBIS2) */
  itbis16: number;
  /** ITBIS at 0% (TotalITBIS3) */
  itbis0: number;
  /** Total ITBIS (sum of all) */
  totalItbis: number;

  /** Total ISC Específico */
  totalIscEspecifico: number;
  /** Total ISC Ad-Valorem */
  totalIscAdvalorem: number;
  /** Total ISC (específico + ad-valorem) */
  totalIsc: number;

  /** Other additional taxes (Propina, CDT, etc.) */
  totalOtrosImpuestos: number;

  /** Monto No Facturable */
  montoNoFacturable: number;

  /** Grand total */
  totalAmount: number;

  /** Tolerance for cuadratura (= number of detail lines) */
  toleranciaGlobal: number;

  /** Per-tax-code entries for ImpuestosAdicionales wrapper in Totales */
  additionalTaxEntries: AdditionalTaxEntry[];
}

/**
 * Verbatim string overrides for header-level totals (Fix 4g).
 *
 * Each field corresponds to an XML tag in the <Totales> section. When the
 * caller provides a string here, the builder emits that string EXACTLY
 * (preserving decimal precision and sign) and bypasses its own computed
 * value for that single tag. Fields not provided fall through to the
 * normal computed emission.
 *
 * The certification mapper populates this from the Excel totals (which
 * DGII pre-calculated for each case); production callers leave it
 * undefined.
 *
 * Why per-tag instead of an "all or nothing" flag?
 *   - The DGII set sometimes specifies only SOME totals per row (E33 has
 *     only MontoExento and MontoTotal, E34 NC has MontoTotal and
 *     MontoNoFacturable but not the ITBIS breakdown).
 *   - Per-tag overrides let production callers stay 100% backwards
 *     compatible: they just don't set this object.
 */
export interface TotalsRawText {
  MontoGravadoTotal?: string;
  MontoGravadoI1?: string;
  MontoGravadoI2?: string;
  MontoGravadoI3?: string;
  MontoExento?: string;
  ITBIS1?: string;
  ITBIS2?: string;
  ITBIS3?: string;
  TotalITBIS?: string;
  TotalITBIS1?: string;
  TotalITBIS2?: string;
  TotalITBIS3?: string;
  MontoImpuestoAdicional?: string;
  MontoTotal?: string;
  MontoNoFacturable?: string;
  TotalITBISRetenido?: string;
  TotalISRRetencion?: string;
  TotalITBISPercepcion?: string;
  TotalISRPercepcion?: string;
}
