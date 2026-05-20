import { ExcelRow } from './excel-mapper.interface';
import { mapBase, s, n, int } from './base-excel.mapper';

/** E31 — Factura de Crédito Fiscal Electrónica. Buyer RNC required. */
export function mapE31(row: ExcelRow, companyId: string): Record<string, unknown> {
  const base = mapBase(row, companyId, 'E31');

  // E31 can carry InformacionesAdicionales (shipment, weights, packaging,
  // volume) and an optional transport section. We read everything from the
  // Excel here; mapBase already reads the same set via mapAdditionalInfo,
  // but historically this mapper had its OWN slimmer version that
  // overrode mapBase's complete version with grossWeight/netWeight only,
  // dropping all the unit/package/volume fields.
  //
  // Fix 4h: merge with base.additionalInfo so we keep packageCount,
  // packageUnit, packageVolume, volumeUnit, grossWeightUnit, netWeightUnit
  // (DGII rejected E310000000005 with "UnidadPesoBruto enviado () no
  // coincide con (23)" etc.).
  const baseAdditional = (base as any).additionalInfo as Record<string, unknown> | undefined;
  const additionalInfo: Record<string, unknown> = { ...(baseAdditional ?? {}) };
  if (s(row.FechaEmbarque))      additionalInfo.shipmentDate    = s(row.FechaEmbarque);
  if (s(row.NumeroEmbarque))     additionalInfo.shipmentNumber  = s(row.NumeroEmbarque);
  if (s(row.NumeroContenedor))   additionalInfo.containerNumber = s(row.NumeroContenedor);
  if (s(row.NumeroReferencia))   additionalInfo.referenceNumber = s(row.NumeroReferencia);
  if (n(row.PesoBruto) !== undefined) additionalInfo.grossWeight = n(row.PesoBruto);
  if (n(row.PesoNeto)  !== undefined) additionalInfo.netWeight   = n(row.PesoNeto);
  if (int(row.UnidadPesoBruto) !== undefined) additionalInfo.grossWeightUnit = int(row.UnidadPesoBruto);
  if (int(row.UnidadPesoNeto)  !== undefined) additionalInfo.netWeightUnit   = int(row.UnidadPesoNeto);
  if (n(row.CantidadBulto) !== undefined)     additionalInfo.packageCount    = n(row.CantidadBulto);
  if (int(row.UnidadBulto) !== undefined)     additionalInfo.packageUnit     = int(row.UnidadBulto);
  if (n(row.VolumenBulto) !== undefined)      additionalInfo.packageVolume   = n(row.VolumenBulto);
  if (int(row.UnidadVolumen) !== undefined)   additionalInfo.volumeUnit      = int(row.UnidadVolumen);

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
