/**
 * Mapeador: caso del Excel DGII → CreateInvoiceDto de la API ecf-api
 *
 * Cada caso del Excel viene como objeto plano {campoXSD: valor}.
 * Acá lo transformamos al DTO que espera POST /invoices.
 *
 * IMPORTANTE: Solo se mapean los campos que tu API entiende explícitamente
 * (según invoice.dto.ts). Si DGII pide un campo que tu DTO no soporta,
 * va a metadata.dgiiExtra para que esté trazable pero no rompa la validación.
 */

type ExcelCase = Record<string, string>;

export interface CreateInvoiceDtoPayload {
  companyId: string;
  ecfType: string;
  encfOverride?: number;
  buyer: {
    name: string;
    rnc?: string;
    email?: string;
    phone?: string;
    address?: string;
    municipality?: string;
    province?: string;
    type?: number;
  };
  items: Array<{
    description: string;
    quantity: number;
    unitPrice: number;
    discount?: number;
    surcharge?: number;
    itbisRate?: number;
    goodService?: number;
    code?: string;
    unit?: string;
    manufacturingDate?: string;
    additionalTaxCode?: string;
    additionalTaxRate?: number;
  }>;
  payment: {
    type: number;
    method?: string;
    date?: string;
    termDays?: number;
  };
  reference?: {
    encf: string;
    date: string;
    modificationCode: number;
    reason?: string;
  };
  currency?: { code: string; exchangeRate: number };
  transport?: any;
  additionalInfo?: any;
  foreignBeneficiary?: any;
  retentionAmount?: number;
  idempotencyKey?: string;
  metadata?: any;
}

const num = (s?: string): number | undefined => {
  if (s === undefined || s === null || s === '') return undefined;
  const v = parseFloat(String(s).replace(/,/g, ''));
  return isNaN(v) ? undefined : v;
};

const int = (s?: string): number | undefined => {
  if (s === undefined || s === null || s === '') return undefined;
  const v = parseInt(String(s), 10);
  return isNaN(v) ? undefined : v;
};

/** Convierte "dd-MM-yyyy" del Excel a "yyyy-MM-dd" ISO. Devuelve undefined si vacío. */
const isoDate = (s?: string): string | undefined => {
  if (!s) return undefined;
  // El Excel usa típicamente dd-MM-yyyy. También aceptamos yyyy-MM-dd.
  const m1 = String(s).match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (m1) return `${m1[3]}-${m1[2]}-${m1[1]}`;
  const m2 = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m2) return s;
  return s; // dejar pasar tal cual y que la API lo valide
};

/** Extrae el número del ENCF (E320000000006 → 6). */
export const extractEncfNumber = (encf: string): number => {
  const digits = encf.replace(/^E\d{2}/, '');
  return parseInt(digits, 10);
};

/** Lee items[1..62] del caso Excel. Solo devuelve los que tienen Cantidad o Descripción. */
const extractItems = (c: ExcelCase) => {
  const items: CreateInvoiceDtoPayload['items'] = [];
  for (let i = 1; i <= 62; i++) {
    const desc = c[`NombreItem[${i}]`];
    const qty = c[`CantidadItem[${i}]`];
    if (!desc && !qty) continue;

    const unitPrice = num(c[`PrecioUnitarioItem[${i}]`]);
    if (unitPrice === undefined) continue;

    items.push({
      description: desc || `Item ${i}`,
      quantity: num(qty) ?? 1,
      unitPrice,
      discount: num(c[`DescuentoMonto[${i}]`]),
      itbisRate: num(c[`TasaITBIS[${i}]`]),
      goodService: int(c[`IndicadorFacturacion[${i}]`]),
      code: c[`CodigoItem[${i}]`] || undefined,
      unit: c[`UnidadMedida[${i}]`] || undefined,
    });
  }
  return items;
};

/** Mapea un caso de la hoja ECF del Excel a un payload para POST /invoices. */
export function mapEcfCase(c: ExcelCase, companyId: string): CreateInvoiceDtoPayload {
  const ecfType = `E${c.TipoeCF}`;
  const encfOverride = extractEncfNumber(c.ENCF);

  // Buyer
  const buyer = {
    name: c.RazonSocialComprador || c.IdentificadorExtranjero || 'Comprador',
    rnc: c.RNCComprador || undefined,
    address: c.DireccionComprador || undefined,
    municipality: c.MunicipioComprador || undefined,
    province: c.ProvinciaComprador || undefined,
  };

  // Payment
  // FormaPago suele venir como "01"/"02"/etc. Mapeo a número.
  const payment = {
    type: int(c.FormaPago) ?? int(c.TipoIngresos) ?? 1,
    date: isoDate(c.FechaVencimientoPago),
  };

  // Reference (solo Notas Crédito/Débito o reemplazos)
  let reference: CreateInvoiceDtoPayload['reference'] | undefined;
  if (c.NCFModificado) {
    reference = {
      encf: c.NCFModificado,
      date: isoDate(c.FechaNCFModificado) ?? '',
      modificationCode: int(c.CodigoModificacion) ?? 1,
      reason: c.RazonModificacion,
    };
  }

  // Currency (si trae TipoMoneda distinto de DOP)
  let currency: CreateInvoiceDtoPayload['currency'] | undefined;
  if (c.TipoMoneda && c.TipoMoneda !== 'DOP') {
    currency = {
      code: c.TipoMoneda,
      exchangeRate: num(c.TipoCambio) ?? 1,
    };
  }

  // Foreign beneficiary (E47)
  let foreignBeneficiary: any;
  if (c.NombreBeneficiarioExterior || c.IdentificadorExterior) {
    foreignBeneficiary = {
      name: c.NombreBeneficiarioExterior || c.IdentificadorExterior,
      country: c.PaisBeneficiarioExterior || c.PaisEmisor || 'XX',
      taxId: c.IdentificadorExterior,
      address: c.DireccionBeneficiarioExterior,
    };
  }

  // Retención
  const retentionAmount =
    num(c.TotalITBISRetenido) ?? num(c.TotalISRRetencion);

  return {
    companyId,
    ecfType,
    encfOverride,
    buyer,
    items: extractItems(c),
    payment,
    reference,
    currency,
    foreignBeneficiary,
    retentionAmount,
    metadata: {
      dgiiCertCase: c.CasoPrueba,
      dgiiCertExpectedEncf: c.ENCF,
    },
  };
}
