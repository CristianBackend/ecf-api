/**
 * ECF Types and Constants for Dominican Republic e-CF
 * Based on DGII Technical Documentation v1.0 + Informe Técnico
 * Updated: Full compliance audit
 */

/** e-CF Type codes as used in the eNCF format */
export const ECF_TYPE_CODES = {
  E31: 31, // Factura de Crédito Fiscal Electrónica
  E32: 32, // Factura de Consumo Electrónica
  E33: 33, // Nota de Débito Electrónica
  E34: 34, // Nota de Crédito Electrónica
  E41: 41, // Compras Electrónico
  E43: 43, // Gastos Menores Electrónico
  E44: 44, // Regímenes Especiales Electrónico
  E45: 45, // Gubernamental Electrónico
  E46: 46, // Exportaciones Electrónico
  E47: 47, // Pagos al Exterior Electrónico
} as const;

/** Human-readable names for each e-CF type */
export const ECF_TYPE_NAMES: Record<number, string> = {
  31: 'Factura de Crédito Fiscal Electrónica',
  32: 'Factura de Consumo Electrónica',
  33: 'Nota de Débito Electrónica',
  34: 'Nota de Crédito Electrónica',
  41: 'Comprobante de Compras Electrónico',
  43: 'Comprobante de Gastos Menores Electrónico',
  44: 'Comprobante de Regímenes Especiales Electrónico',
  45: 'Comprobante Gubernamental Electrónico',
  46: 'Comprobante de Exportaciones Electrónico',
  47: 'Comprobante de Pagos al Exterior Electrónico',
};

/** Which e-CF types ALWAYS require buyer RNC (código obligatoriedad = 1)
 * E46: código 2 (condicional - Zonas Francas a Residentes)
 * E47: código 0 (RNC NO corresponde)
 */
export const REQUIRES_BUYER_RNC = [31, 41, 45];

/** E-CF types where Comprador section itself is condicional (código 2) or optional (código 3)
 * E33, E34: Comprador código 2
 * E44: Comprador código 1 but RNC código 2
 * E46: Comprador código 1 but RNC código 2
 * E47: Comprador código 3
 */

/** Which e-CF types require InformacionReferencia */
export const REQUIRES_REFERENCE = [33, 34]; // Notas débito y crédito

/**
 * e-CF types that do NOT apply Aprobación Comercial (ACECF).
 * Per DGII Descripción Técnica p.28-29:
 * ACECF only applies to: E31, E33, E34, E44, E45
 */
export const ACECF_EXCLUDED_TYPES = [32, 41, 43, 46, 47];

/** ITBIS rates allowed in Dominican Republic */
export const ITBIS_RATES = {
  STANDARD: 18,  // Tasa estándar
  REDUCED: 16,   // Tasa reducida
  EXEMPT: 0,     // Exento
} as const;

/**
 * FormaPago (payment method) per DGII XSD FormaPagoType.
 * Values 01-08. NOT to be confused with TipoPago (1=Contado, 2=Crédito, 3=Gratuito).
 */
export const FORMA_PAGO = {
  EFECTIVO: 1,
  CHEQUE_TRANSFERENCIA: 2,
  TARJETA: 3,
  CREDITO: 4,
  BONOS: 5,
  PERMUTA: 6,
  NOTA_CREDITO: 7,
  MIXTO: 8,
} as const;

/** Income type indicator (Tipo de Ingreso) */
export const INCOME_TYPES = {
  OPERATIONAL: 1,
  FINANCIAL: 2,
  EXTRAORDINARY: 3,
  LEASING: 4,
  ASSET_SALE: 5,
  OTHER: 6,
} as const;

// ============================================================
// MODIFICATION CODES (for Notas de Crédito/Débito)
// ============================================================

/** Modification codes per DGII Informe Técnico */
export const MODIFICATION_CODES = {
  VOID: 1,           // Anula el NCF modificado
  CORRECT_TEXT: 2,   // Corrige texto del comprobante fiscal modificado
  CORRECT_AMOUNT: 3, // Corrige montos del NCF modificado
  REPLACE_CONTINGENCY: 4, // Reemplazo NCF emitido en contingencia
  REFERENCE_FC: 5,   // Referencia Factura Consumo Electrónica
} as const;

export const MODIFICATION_CODE_NAMES: Record<number, string> = {
  1: 'Anula el NCF modificado',
  2: 'Corrige texto del comprobante fiscal modificado',
  3: 'Corrige montos del NCF modificado',
  4: 'Reemplazo NCF emitido en contingencia',
  5: 'Referencia Factura Consumo Electrónica',
};

// ============================================================
// ADDITIONAL TAX CODES (Impuestos Adicionales)
// ============================================================

/**
 * Codificación Tipos de Impuestos Adicionales
 * Codes 001-005: Otros Impuestos Adicionales
 * Codes 006-018: ISC Específico Alcoholes
 * Codes 019-022: ISC Específico Cigarrillos
 * Codes 023-035: ISC Ad-Valorem Alcoholes
 * Codes 036-039: ISC Ad-Valorem Cigarrillos
 */
export const ADDITIONAL_TAX_TYPES = {
  // Otros impuestos (001-005)
  PROPINA_LEGAL: '001',
  CDT: '002',                     // Contribución Desarrollo Telecomunicaciones
  SERVICIOS_SEGUROS: '003',
  SERVICIOS_TELECOM: '004',
  EXPEDICION_PRIMERA_PLACA: '005',
  // ISC ranges
  ISC_ESPECIFICO_ALCOHOL_START: '006',
  ISC_ESPECIFICO_ALCOHOL_END: '018',
  ISC_ESPECIFICO_CIGARRILLO_START: '019',
  ISC_ESPECIFICO_CIGARRILLO_END: '022',
  ISC_ADVALOREM_ALCOHOL_START: '023',
  ISC_ADVALOREM_ALCOHOL_END: '035',
  ISC_ADVALOREM_CIGARRILLO_START: '036',
  ISC_ADVALOREM_CIGARRILLO_END: '039',
} as const;

/** Check if tax code is ISC Específico (alcohol) */
export function isIscEspecificoAlcohol(code: string): boolean {
  const num = parseInt(code, 10);
  return num >= 6 && num <= 18;
}

/** Check if tax code is ISC Ad-Valorem (alcohol) */
export function isIscAdvaloremAlcohol(code: string): boolean {
  const num = parseInt(code, 10);
  return num >= 23 && num <= 35;
}

/** Check if tax code is ISC Específico (cigarrillo) */
export function isIscEspecificoCigarrillo(code: string): boolean {
  const num = parseInt(code, 10);
  return num >= 19 && num <= 22;
}

/** Check if tax code is ISC Ad-Valorem (cigarrillo) */
export function isIscAdvaloremCigarrillo(code: string): boolean {
  const num = parseInt(code, 10);
  return num >= 36 && num <= 39;
}

/** Check if tax code is "Otros Impuestos" (not ISC) */
export function isOtrosImpuestos(code: string): boolean {
  const num = parseInt(code, 10);
  return num >= 1 && num <= 5;
}

// ============================================================
// DGII ENDPOINTS
// ============================================================

export const DGII_ENDPOINTS = {
  DEV: {
    base: 'https://ecf.dgii.gov.do/testecf',
    fc: 'https://fc.dgii.gov.do/testecf',
    ambiente: 'testecf',
  },
  CERT: {
    base: 'https://ecf.dgii.gov.do/certecf',
    fc: 'https://fc.dgii.gov.do/certecf',
    ambiente: 'certecf',
  },
  PROD: {
    base: 'https://ecf.dgii.gov.do/ecf',
    fc: 'https://fc.dgii.gov.do/ecf',
    ambiente: 'ecf',
  },
} as const;

/**
 * DGII service paths per Descripción Técnica v1.6
 *
 * URL pattern: {base}/{servicio}/api/{recurso}
 * Example: https://ecf.dgii.gov.do/testecf/recepcion/api/facturaselectronicas
 *
 * Each entry has:
 *   service: the service name segment in the URL
 *   resource: the API resource path after the service
 */
export const DGII_SERVICES = {
  SEED: { service: 'autenticacion', resource: '/api/autenticacion/semilla' },
  VALIDATE_SEED: { service: 'autenticacion', resource: '/api/autenticacion/validarsemilla' },
  SEND_ECF: { service: 'recepcion', resource: '/api/facturaselectronicas' },
  QUERY_RESULT: { service: 'consultaresultado', resource: '/api/consultas/estado' },
  QUERY_STATE: { service: 'consultaestado', resource: '/api/consultas/estado' },
  QUERY_TRACKIDS: { service: 'consultatrackids', resource: '/api/trackids/consulta' },
  VOID: { service: 'anulacionrangos', resource: '/api/operaciones/anularrango' },
  DIRECTORY: { service: 'consultadirectorio', resource: '/api/consultas/listado' },
  DIRECTORY_BY_RNC: { service: 'consultadirectorio', resource: '/api/consultas/obtenerdirectorioporrnc' },
  COMMERCIAL_APPROVAL: { service: 'aprobacioncomercial', resource: '/api/aprobacioncomercial' },
  // FC-specific (facturas consumo < 250K) — uses fc.dgii.gov.do domain
  FC_RECEIVE: { service: 'recepcionfc', resource: '/api/recepcion/ecf' },
  // Consulta RFCE — fc.dgii.gov.do only (per Descripción Técnica p.17)
  FC_QUERY: { service: 'consultarfce', resource: '/api/Consultas/Consulta' },
} as const;

/** Estatus servicios uses a separate domain */
export const DGII_STATUS_SERVICE_URL = 'https://statusecf.dgii.gov.do/api/estatusservicios/obtenerestatus';

/**
 * Build a full DGII service URL.
 * Pattern: {base}/{service.service}{service.resource}
 */
export function buildDgiiUrl(
  baseUrl: string,
  service: { service: string; resource: string },
): string {
  return `${baseUrl}/${service.service}${service.resource}`;
}

/** DGII response status codes */
export const DGII_STATUS = {
  NOT_FOUND: 0,
  ACCEPTED: 1,
  REJECTED: 2,
  IN_PROCESS: 3,
  CONDITIONAL: 4, // Aceptado Condicional
} as const;

// ============================================================
// THRESHOLDS AND LIMITS
// ============================================================

/** Factura Consumo < 250K sends only RFCE (resumen) */
export const FC_FULL_SUBMISSION_THRESHOLD = 250000;

/** Maximum items per e-CF (1000 normal, 10000 for FC < 250K) */
export const MAX_ITEMS_PER_ECF = 1000;
export const MAX_ITEMS_FC_UNDER_250K = 10000;

/** NC/ND: days after which ITBIS cannot be returned */
export const NC_ITBIS_RETURN_LIMIT_DAYS = 30;

/** e-CF storage requirement: 10 years */
export const STORAGE_RETENTION_YEARS = 10;

// ============================================================
// QR CODE URL TEMPLATES (per DGII Informe Técnico)
// ============================================================

/**
 * Resolve DgiiEnvironment enum to the ambiente path segment.
 */
export function getAmbiente(env: string): string {
  return DGII_ENDPOINTS[env as keyof typeof DGII_ENDPOINTS]?.ambiente || 'testecf';
}

/**
 * Build QR URL for standard e-CF per DGII Descripción Técnica p.37-39.
 * Pattern: https://ecf.dgii.gov.do/{ambiente}/consultatimbre?...
 * Parameters per spec example: rncemisor, rnccomprador, encf, fechaemision,
 *                               montototal, fechafirma, codigoseguridad
 */
export function buildStandardQrUrl(params: {
  rncEmisor: string;
  rncComprador: string;
  encf: string;
  fechaEmision: string;     // dd-MM-aaaa
  montoTotal: string;       // X.XX
  fechaFirma: string;       // dd-MM-aaaa HH:mm:ss
  codigoSeguridad: string;  // first 6 hex of SignatureValue hash
  ambiente: string;         // testecf | certecf | ecf
}): string {
  const p = params;
  const baseUrl = `https://ecf.dgii.gov.do/${p.ambiente}/ConsultaTimbre`;
  return `${baseUrl}?rncemisor=${p.rncEmisor}&rnccomprador=${p.rncComprador}&encf=${p.encf}&fechaemision=${p.fechaEmision}&montototal=${p.montoTotal}&fechafirma=${encodeURIComponent(p.fechaFirma)}&codigoseguridad=${p.codigoSeguridad}`;
}

/**
 * Build QR URL for FC < 250K per DGII Descripción Técnica p.37-39.
 * Pattern: https://fc.dgii.gov.do/{ambiente}/consultatimbrefc?...
 * Parameters per spec example: rncemisor, encf, montototal, codigoseguridad
 */
export function buildFcUnder250kQrUrl(params: {
  rncEmisor: string;
  encf: string;
  montoTotal: string;
  codigoSeguridad: string;
  ambiente: string;         // testecf | certecf | ecf
}): string {
  const p = params;
  const baseUrl = `https://fc.dgii.gov.do/${p.ambiente}/ConsultaTimbreFC`;
  return `${baseUrl}?rncemisor=${p.rncEmisor}&encf=${p.encf}&montototal=${p.montoTotal}&codigoseguridad=${p.codigoSeguridad}`;
}

// ============================================================
// eNCF FORMAT UTILITIES
// ============================================================

/** eNCF format: E + 2 digit type + 10 digit padded sequence */
export function formatEncf(typeCode: number, sequenceNumber: number): string {
  return `E${typeCode}${String(sequenceNumber).padStart(10, '0')}`;
}

/** Extract type code from eNCF string */
export function getTypeFromEncf(encf: string): number {
  return parseInt(encf.substring(1, 3), 10);
}

/** Validate eNCF format */
export function isValidEncf(encf: string): boolean {
  if (!encf || encf.length !== 13) return false;
  if (encf[0] !== 'E') return false;
  const typeCode = parseInt(encf.substring(1, 3), 10);
  const validTypes = [31, 32, 33, 34, 41, 43, 44, 45, 46, 47];
  if (!validTypes.includes(typeCode)) return false;
  const seq = encf.substring(3);
  return /^\d{10}$/.test(seq) && parseInt(seq, 10) > 0;
}

/**
 * Check if a sequence has expired.
 * Sequences are valid until December 31 of the year following authorization.
 */
export function isSequenceExpired(expirationDate: Date): boolean {
  return new Date() > expirationDate;
}

/**
 * Validate that an NCFModificado can be a valid reference.
 * Can be serie E (13 chars), serie B (11 chars), or serie A/P (19 chars).
 */
export function isValidNcfModificado(ncf: string): boolean {
  if (!ncf) return false;
  // Serie E: E + 2 type + 10 seq = 13
  if (ncf.startsWith('E') && ncf.length === 13) return true;
  // Serie B: B + 2 type + 8 seq = 11
  if (ncf.startsWith('B') && ncf.length === 11) return true;
  // Serie A or P: 19 chars
  if ((ncf.startsWith('A') || ncf.startsWith('P')) && ncf.length === 19) return true;
  return false;
}
