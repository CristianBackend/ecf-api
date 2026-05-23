export const ECF_TYPE_LABELS: Record<string, string> = {
  '31': 'FACTURA DE CRÉDITO FISCAL ELECTRÓNICA',
  '32': 'FACTURA DE CONSUMO ELECTRÓNICA',
  '33': 'NOTA DE DÉBITO ELECTRÓNICA',
  '34': 'NOTA DE CRÉDITO ELECTRÓNICA',
  '41': 'COMPROBANTE ELECTRÓNICO DE COMPRAS',
  '43': 'COMPROBANTE ELECTRÓNICO PARA GASTOS MENORES',
  '44': 'COMPROBANTE ELECTRÓNICO PARA REGÍMENES ESPECIALES',
  '45': 'COMPROBANTE ELECTRÓNICO GUBERNAMENTAL',
  '46': 'COMPROBANTE ELECTRÓNICO PARA EXPORTACIONES',
  '47': 'COMPROBANTE ELECTRÓNICO PARA PAGOS AL EXTERIOR',
};

export const MOD_CODE_LABELS: Record<number, string> = {
  1: 'Anula el NCF modificado',
  2: 'Corrige Texto del Comprobante Fiscal modificado',
  3: 'Corrige montos del NCF modificado',
  4: 'Reemplazo NCF emitido en contingencia',
};

// E32 y E34 no muestran Fecha de Vencimiento de Secuencia
export const TYPES_WITHOUT_EXPIRATION = new Set(['32', '34']);
