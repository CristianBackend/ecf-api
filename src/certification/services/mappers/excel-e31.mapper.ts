import { ExcelRow } from './excel-mapper.interface';
import { mapBase, s, n } from './base-excel.mapper';

/** E31 — Factura de Crédito Fiscal Electrónica. Buyer RNC required. */
export function mapE31(row: ExcelRow, companyId: string): Record<string, unknown> {
  const base = mapBase(row, companyId, 'E31');

  // E31 can carry InformacionesAdicionales (shipment, weights) and
  // optional transport section — include when present in the Excel row.
  const additionalInfo: Record<string, unknown> = {};
  if (s(row.FechaEmbarque))      additionalInfo.shipmentDate    = s(row.FechaEmbarque);
  if (s(row.NumeroEmbarque))     additionalInfo.shipmentNumber  = s(row.NumeroEmbarque);
  if (s(row.NumeroContenedor))   additionalInfo.containerNumber = s(row.NumeroContenedor);
  if (s(row.NumeroReferencia))   additionalInfo.referenceNumber = s(row.NumeroReferencia);
  if (n(row.PesoBruto) !== undefined) additionalInfo.grossWeight = n(row.PesoBruto);
  if (n(row.PesoNeto)  !== undefined) additionalInfo.netWeight   = n(row.PesoNeto);

  const transport: Record<string, unknown> = {};
  if (s(row.Conductor))           transport.conductor        = s(row.Conductor);
  if (n(row.DocumentoTransporte)) transport.documentoTransporte = n(row.DocumentoTransporte);
  if (s(row.Ficha))               transport.ficha            = s(row.Ficha);
  if (s(row.Placa))               transport.placa            = s(row.Placa);
  if (s(row.RutaTransporte))      transport.rutaTransporte   = s(row.RutaTransporte);
  if (s(row.ZonaTransporte))      transport.zonaTransporte   = s(row.ZonaTransporte);
  if (s(row.NumeroAlbaran))       transport.numeroAlbaran    = s(row.NumeroAlbaran);

  return {
    ...base,
    ...(Object.keys(additionalInfo).length ? { additionalInfo } : {}),
    ...(Object.keys(transport).length      ? { transport }      : {}),
  };
}
