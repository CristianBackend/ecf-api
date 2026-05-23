import { fmtDateTimeGmt4 } from '../../common/utils/date-format.util';

export const DGII_TZ = 'America/Santo_Domingo';

/**
 * "dd-MM-yyyy" in America/Santo_Domingo.
 * Matches <FechaElaboracion> in the signed XML — same Intl.DateTimeFormat
 * path used by signing.service.ts formatDateDgii().
 */
export function formatDateDgii(date: Date): string {
  return fmtDateTimeGmt4(date).split(' ')[0];
}

/**
 * "dd-MM-yyyy HH:mm:ss" in America/Santo_Domingo.
 * Must match <FechaHoraFirma> in the signed XML byte-for-byte so that
 * the QR's FechaFirma validates against the e-CF on DGII servers.
 */
export function formatDateTimeDgii(date: Date): string {
  return fmtDateTimeGmt4(date);
}

/**
 * Same as formatDateTimeDgii but with %20 in place of the space,
 * ready for the ConsultaTimbre QR URL parameter.
 */
export function formatDateTimeDgiiUrl(date: Date): string {
  return fmtDateTimeGmt4(date).replace(' ', '%20');
}
