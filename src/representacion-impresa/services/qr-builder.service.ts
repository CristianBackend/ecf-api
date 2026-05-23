import { Injectable } from '@nestjs/common';
import * as QRCode from 'qrcode';
import { formatDate, formatDateTimeUrl } from '../helpers/date-formatters';
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

    if (input.isRfce) {
      return (
        base +
        `RncEmisor=${input.rncEmisor}` +
        `&ENCF=${input.encf}` +
        `&MontoTotal=${formatQrAmount(input.montoTotal)}` +
        `&CodigoSeguridad=${input.codigoSeguridad}`
      );
    }

    let url =
      base +
      `RncEmisor=${input.rncEmisor}`;

    if (input.rncComprador) {
      url += `&RncComprador=${input.rncComprador}`;
    }

    url +=
      `&ENCF=${input.encf}` +
      `&FechaEmision=${formatDate(input.fechaEmision)}` +
      `&MontoTotal=${formatQrAmount(input.montoTotal)}` +
      `&FechaFirma=${formatDateTimeUrl(input.fechaFirma)}` +
      `&CodigoSeguridad=${input.codigoSeguridad}`;

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
