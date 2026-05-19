import { ExcelRow } from './excel-mapper.interface';
import { mapBase, s, n, int } from './base-excel.mapper';

/**
 * E46 — Comprobante de Exportaciones.
 * Requires transport and export (additionalInfo) sections.
 */
export function mapE46(row: ExcelRow, companyId: string): Record<string, unknown> {
  const base = mapBase(row, companyId, 'E46');

  const transport: Record<string, unknown> = {
    viaTransporte:    int(row.ViaTransporte),
    countryOrigin:    s(row.PaisOrigen),
    countryDestination: s(row.PaisDestino),
    destinationAddress: s(row.DireccionDestino),
    carrierRnc:       s(row.RNCCompaniaTransportista) ?? s(row.RNCIdentificacionCompaniaTransportista),
    carrierName:      s(row.NombreCompaniaTransportista),
    tripNumber:       s(row.NumeroViaje),
    conductor:        s(row.Conductor),
    placa:            s(row.Placa),
    numeroAlbaran:    s(row.NumeroAlbaran),
  };
  // Remove undefined keys so ValidationPipe doesn't complain
  Object.keys(transport).forEach(k => transport[k] === undefined && delete transport[k]);

  const additionalInfo: Record<string, unknown> = {
    deliveryConditions: s(row.CondicionesEntrega),
    customsRegime:      s(row.RegimenAduanero),
    portOfShipment:     s(row.NombrePuertoEmbarque),
    departurePort:      s(row.NombrePuertoSalida),
    arrivalPort:        s(row.NombrePuertoDesembarque),
    totalFob:           n(row.TotalFob),
    insurance:          n(row.Seguro),
    freight:            n(row.Flete),
    otherExpenses:      n(row.OtrosGastos),
    totalCif:           n(row.TotalCif),
    shipmentDate:       s(row.FechaEmbarque),
    shipmentNumber:     s(row.NumeroEmbarque),
    containerNumber:    s(row.NumeroContenedor),
    referenceNumber:    s(row.NumeroReferencia),
  };
  Object.keys(additionalInfo).forEach(k => additionalInfo[k] === undefined && delete additionalInfo[k]);

  return {
    ...base,
    transport,
    additionalInfo,
  };
}
