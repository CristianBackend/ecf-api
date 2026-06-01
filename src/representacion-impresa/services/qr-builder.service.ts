import { Injectable } from '@nestjs/common';
import * as QRCode from 'qrcode';
import { formatDateDgii, formatDateTimeDgii } from '../helpers/date-formatters';
import { formatQrAmount } from '../helpers/currency-formatter';

export type DgiiEnv = 'DEV' | 'CERT' | 'PROD';

export interface QrInput {
  isRfce: boolean;
  dgiiEnv: DgiiEnv;
  rncEmisor: string;
  rncComprador?: string;
  encf: string;
  fechaEmision: Date;
  montoTotal: any;
  fechaFirma: Date;
  codigoSeguridad: string;
}

@Injectable()
export class QrBuilder {
  buildUrl(input: QrInput): string {
    const base = this.getBaseUrl(input.isRfce, input.dgiiEnv);
    const montoStr = typeof input.montoTotal === 'string'
      ? input.montoTotal
      : formatQrAmount(input.montoTotal);

    // Encode every param, matching the official dgii-ecf generateEcfQRCodeURL.
    // Critical for CodigoSeguridad values containing '+' or '/' — a literal '+'
    // is decoded as a space, producing a broken QR. We encode the RAW date
    // strings (literal space → %20, ':' → %3A); never pre-encoded values, to
    // avoid double-encoding (% → %25).
    const rncEmisor = encodeURIComponent(input.rncEmisor);
    const encf = encodeURIComponent(input.encf);
    const monto = encodeURIComponent(montoStr);
    const codigoSeguridad = encodeURIComponent(input.codigoSeguridad);

    if (input.isRfce) {
      return (
        base +
        `RncEmisor=${rncEmisor}` +
        `&ENCF=${encf}` +
        `&MontoTotal=${monto}` +
        `&CodigoSeguridad=${codigoSeguridad}`
      );
    }

    let url =
      base +
      `RncEmisor=${rncEmisor}`;

    if (input.rncComprador) {
      url += `&RncComprador=${encodeURIComponent(input.rncComprador)}`;
    }

    url +=
      `&ENCF=${encf}` +
      `&FechaEmision=${encodeURIComponent(formatDateDgii(input.fechaEmision))}` +
      `&MontoTotal=${monto}` +
      `&FechaFirma=${encodeURIComponent(formatDateTimeDgii(input.fechaFirma))}` +
      `&CodigoSeguridad=${codigoSeguridad}`;

    return url;
  }

  async buildImage(url: string, sizePx = 300): Promise<Buffer> {
    return QRCode.toBuffer(url, {
      errorCorrectionLevel: 'H',
      type: 'png',
      margin: 1,
      width: sizePx,
    });
  }

  private getBaseUrl(isRfce: boolean, env: DgiiEnv): string {
    if (isRfce) {
      switch (env) {
        case 'DEV':  return 'https://fc.dgii.gov.do/TesteCF/ConsultaTimbreFC?';
        case 'CERT': return 'https://fc.dgii.gov.do/CerteCF/ConsultaTimbreFC?';
        case 'PROD': return 'https://fc.dgii.gov.do/eCF/ConsultaTimbreFC?';
      }
    } else {
      switch (env) {
        case 'DEV':  return 'https://ecf.dgii.gov.do/testecf/ConsultaTimbre?';
        case 'CERT': return 'https://ecf.dgii.gov.do/certecf/ConsultaTimbre?';
        case 'PROD': return 'https://ecf.dgii.gov.do/ecf/ConsultaTimbre?';
      }
    }
    throw new Error(`Unknown DGII env: ${env}`);
  }
}
