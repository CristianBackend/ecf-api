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

/**
 * Human-readable names for DGII 6-digit ProvinciaMunicipio codes (Tabla III).
 * Only the most-used codes are mapped; unmapped codes are silently omitted
 * from the address line so raw codes never appear in the printed document.
 */
export const MUNICIPIO_NAMES: Record<string, string> = {
  // 01 - DISTRITO NACIONAL
  '010000': 'Distrito Nacional',
  '010100': 'Santo Domingo de Guzmán',
  '010101': 'Cristo Rey',
  // 02 - AZUA
  '020000': 'Azua',
  '020100': 'Azua',
  // 04 - BARAHONA
  '040000': 'Barahona',
  '040100': 'Barahona',
  // 06 - DUARTE
  '060000': 'Duarte',
  '060100': 'San Francisco de Macorís',
  // 09 - ESPAILLAT
  '090000': 'Espaillat',
  '090100': 'Moca',
  // 11 - LA ALTAGRACIA
  '110000': 'La Altagracia',
  '110100': 'Higüey',
  // 12 - LA ROMANA
  '120000': 'La Romana',
  '120100': 'La Romana',
  // 13 - LA VEGA
  '130000': 'La Vega',
  '130100': 'La Vega',
  // 18 - PUERTO PLATA
  '180000': 'Puerto Plata',
  '180100': 'Puerto Plata',
  // 21 - SAN CRISTÓBAL
  '210000': 'San Cristóbal',
  '210100': 'San Cristóbal',
  // 23 - SAN PEDRO DE MACORÍS
  '230000': 'San Pedro de Macorís',
  '230100': 'San Pedro de Macorís',
  // 25 - SANTIAGO
  '250000': 'Santiago',
  '250100': 'Santiago',
  '250101': 'Bisonó',
  '250102': 'Jánico',
  '250104': 'Licey al Medio',
  '250105': 'San José de las Matas',
  '250106': 'Tamboril',
  '250107': 'Villa González',
  // 32 - SANTO DOMINGO (province)
  '320000': 'Santo Domingo',
  '320100': 'Santo Domingo Este',
  '320101': 'Los Alcarrizos',
  '320102': 'Sabana Perdida',
  '320200': 'Santo Domingo Oeste',
  '320201': 'Boca Chica',
  '320300': 'Santo Domingo Norte',
  '320301': 'Viejo Arroyo Hondo',
  '320302': 'La Victoria',
  '320400': 'Boca Chica',
  '320500': 'San Antonio de Guerra',
  '320600': 'Los Alcarrizos',
  '320700': 'Pedro Brand',
};

export const PROVINCIA_NAMES: Record<string, string> = {
  '01': 'Distrito Nacional',
  '02': 'Azua',
  '03': 'Bahoruco',
  '04': 'Barahona',
  '05': 'Dajabón',
  '06': 'Duarte',
  '07': 'Elías Piña',
  '08': 'El Seibo',
  '09': 'Espaillat',
  '10': 'Independencia',
  '11': 'La Altagracia',
  '12': 'La Romana',
  '13': 'La Vega',
  '14': 'María Trinidad Sánchez',
  '15': 'Monte Cristi',
  '16': 'Pedernales',
  '17': 'Peravia',
  '18': 'Puerto Plata',
  '19': 'Hermanas Mirabal',
  '20': 'Samaná',
  '21': 'San Cristóbal',
  '22': 'San Juan',
  '23': 'San Pedro de Macorís',
  '24': 'Sánchez Ramírez',
  '25': 'Santiago',
  '26': 'Santiago Rodríguez',
  '27': 'Valverde',
  '28': 'Monseñor Nouel',
  '29': 'Monte Plata',
  '30': 'Hato Mayor',
  '31': 'San José de Ocoa',
  '32': 'Santo Domingo',
};

/**
 * Resolve a raw municipality/province field to a human-readable name.
 * Returns undefined when the value is a code we don't recognise — so the
 * caller can omit it instead of printing a raw numeric code.
 */
export function resolveLocationName(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  // Already a human-readable name (contains letters)
  if (/[a-zA-ZáéíóúÁÉÍÓÚñÑüÜ]/.test(trimmed)) return trimmed;
  // 6-digit municipality code
  if (/^\d{6}$/.test(trimmed)) return MUNICIPIO_NAMES[trimmed];
  // 2-digit province code
  if (/^\d{2}$/.test(trimmed)) return PROVINCIA_NAMES[trimmed];
  return undefined;
}
