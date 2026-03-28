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
}

/** Buyer/Receptor information */
export interface BuyerInput {
  /** RNC or Cédula of buyer */
  rnc?: string;
  name: string;
  email?: string;
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

  /** Indicator if item amount includes ITBIS: 0=no, 1=yes */
  indicadorMontoGravado?: number;
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
  /** Additional tax for this page */
  subtotalImpuestoAdicionalPagina?: number;
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
