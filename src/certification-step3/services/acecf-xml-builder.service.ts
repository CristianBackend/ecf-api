import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

/**
 * Step 3 ACECF XML Builder
 *
 * Completamente independiente de src/xml-builder/response-xml-builder.ts.
 * No modifica el builder antiguo para no afectar el flujo de recepción.
 *
 * Genera ACECF según:
 *   - DGII Formato Aprobación Comercial v1.0 (PDF Ene 2020, mod 21/12/2022)
 *   - IACECF.ts de la librería canónica dgii-ecf
 *
 * xs:sequence ESTRICTO:
 *   1. Version
 *   2. RNCEmisor
 *   3. eNCF
 *   4. FechaEmision        (dd-MM-yyyy)
 *   5. MontoTotal          (2 decimales)
 *   6. RNCComprador
 *   7. Estado              (1=Aceptado, 2=Rechazado)
 *   8. DetalleMotivoRechazo (solo cuando Estado=2)
 *   9. FechaHoraAprobacionComercial (dd-MM-yyyy HH:mm:ss)
 *
 * NO incluye MontoITBIS (no existe en el XSD oficial).
 */

export interface Step3AcecfInput {
  emitterRnc: string;
  receiverRnc: string;
  encf: string;
  issueDate: Date | string;    // FechaEmision del e-CF original
  totalAmount: number;
  approved: boolean;           // true → Estado=1, false → Estado=2
  rejectionReason?: string;    // requerido si approved=false
  approvalDatetime: string;    // FechaHoraAprobacionComercial exacta del Excel (dd-MM-yyyy HH:mm:ss)
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&#34;')
    .replace(/'/g, '&#39;');
}

function formatAmount2dec(n: number): string {
  return n.toFixed(2);
}

function toGmt4Parts(d: Date) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Santo_Domingo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(d);
  const get = (t: string) => p.find(x => x.type === t)?.value ?? '00';
  return { day: get('day'), month: get('month'), year: get('year'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

function formatDateDdMmYyyy(d: Date): string {
  const { day, month, year } = toGmt4Parts(d);
  return `${day}-${month}-${year}`;
}

function formatDateTimeDdMmYyyy(d: Date): string {
  const { day, month, year, hour, minute, second } = toGmt4Parts(d);
  return `${day}-${month}-${year} ${hour}:${minute}:${second}`;
}

@Injectable()
export class AcecfXmlBuilder {
  constructor(
    @InjectPinoLogger(AcecfXmlBuilder.name)
    private readonly logger: PinoLogger,
  ) {}

  buildXml(input: Step3AcecfInput): string {
    const estado = input.approved ? '1' : '2';

    const fechaEmision = typeof input.issueDate === 'string'
      ? input.issueDate
      : formatDateDdMmYyyy(input.issueDate);

    const lines: string[] = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<ACECF xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">',
      '  <DetalleAprobacionComercial>',
      '    <Version>1.0</Version>',
      `    <RNCEmisor>${escapeXml(input.emitterRnc)}</RNCEmisor>`,
      `    <eNCF>${escapeXml(input.encf)}</eNCF>`,
      `    <FechaEmision>${escapeXml(fechaEmision)}</FechaEmision>`,
      `    <MontoTotal>${formatAmount2dec(input.totalAmount)}</MontoTotal>`,
      `    <RNCComprador>${escapeXml(input.receiverRnc)}</RNCComprador>`,
      `    <Estado>${estado}</Estado>`,
    ];

    if (!input.approved) {
      const reason = input.rejectionReason ?? 'Rechazado por el comprador';
      lines.push(`    <DetalleMotivoRechazo>${escapeXml(reason)}</DetalleMotivoRechazo>`);
    }

    lines.push(
      `    <FechaHoraAprobacionComercial>${escapeXml(input.approvalDatetime)}</FechaHoraAprobacionComercial>`,
      '  </DetalleAprobacionComercial>',
      '</ACECF>',
    );

    const xml = lines.join('\n');
    this.logger.debug(`Step3 ACECF built for ${input.encf}: Estado=${estado}`);
    return xml;
  }
}
