import {
  Injectable,
  BadRequestException,
} from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

export interface DgiiTaxpayerInfo {
  rnc: string;
  name: string;
  commercialName: string;
  status: string;
  paymentRegime: string;
  category: string;
  economicActivity: string;
  isElectronicInvoicer: boolean;
}

@Injectable()
export class RncValidationService {
  constructor(
    @InjectPinoLogger(RncValidationService.name)
    private readonly logger: PinoLogger,
  ) {}

  /**
   * Full validation: format → check digit (soft) → DGII lookup.
   *
   * Regla DGII:
   *  - Si el comprador es contribuyente activo → E31 (Crédito Fiscal)
   *  - Si NO es contribuyente → E32 (Consumo), no se registra como cliente
   */
  async validateAndLookup(rnc: string): Promise<DgiiTaxpayerInfo> {
    const clean = this.clean(rnc);

    if (clean.length === 9) {
      if (!this.validateRncCheckDigit(clean)) {
        this.logger.warn(`RNC ${clean} failed check digit — may be legacy`);
      }
    } else if (clean.length === 11) {
      if (!this.validateCedulaCheckDigit(clean)) {
        this.logger.warn(`Cédula ${clean} failed check digit`);
      }
    }

    try {
      const info = await this.lookupDgii(clean);
      if (!info) {
        throw new BadRequestException(
          `RNC/Cédula ${clean} no se encuentra registrado como contribuyente en la DGII. ` +
          `Si no es contribuyente, se le emite E32 (Factura de Consumo) y no necesita registrarlo como cliente.`,
        );
      }
      if (info.status !== 'ACTIVO') {
        this.logger.warn(`RNC ${clean} found but status: ${info.status}`);
      }
      return info;
    } catch (error: any) {
      if (error instanceof BadRequestException) throw error;
      this.logger.warn(`DGII lookup failed for ${clean}: ${error.message}`);
      return null as any;
    }
  }

  validateFormat(rnc: string): { valid: boolean; error?: string; warning?: string } {
    const clean = this.clean(rnc);
    if (clean.length === 9) {
      if (!this.validateRncCheckDigit(clean)) {
        return { valid: true, warning: 'Dígito verificador no coincide (puede ser RNC legacy)' };
      }
    } else if (clean.length === 11) {
      if (!this.validateCedulaCheckDigit(clean)) {
        return { valid: true, warning: 'Dígito verificador no coincide para Cédula' };
      }
    } else {
      return { valid: false, error: 'RNC debe tener 9 dígitos o Cédula 11 dígitos' };
    }
    return { valid: true };
  }

  // ═══ CHECK DIGIT ALGORITHMS ═══

  private validateRncCheckDigit(rnc: string): boolean {
    if (rnc.length !== 9 || !/^\d{9}$/.test(rnc)) return false;
    const weights = [7, 9, 8, 6, 5, 4, 3, 2];
    const digits = rnc.split('').map(Number);
    let sum = 0;
    for (let i = 0; i < 8; i++) sum += digits[i] * weights[i];
    const r = sum % 11;
    const expected = r === 0 ? 2 : r === 1 ? 1 : 11 - r;
    return digits[8] === expected;
  }

  private validateCedulaCheckDigit(cedula: string): boolean {
    if (cedula.length !== 11 || !/^\d{11}$/.test(cedula)) return false;
    const digits = cedula.split('').map(Number);
    let sum = 0;
    for (let i = 0; i < 10; i++) {
      let val = digits[i] * (i % 2 === 0 ? 1 : 2);
      if (val > 9) val -= 9;
      sum += val;
    }
    return digits[10] === (10 - (sum % 10)) % 10;
  }

  // ═══ DGII LOOKUP ═══

  private async lookupDgii(rnc: string): Promise<DgiiTaxpayerInfo | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      const response = await fetch(
        `https://api.indexa.do/api/rnc?rnc=${rnc}`,
        { method: 'GET', headers: { 'Accept': 'application/json' }, signal: controller.signal },
      );
      clearTimeout(timeout);

      if (!response.ok) {
        if (response.status === 404) return null;
        throw new Error(`Indexa API returned ${response.status}`);
      }

      const json = await response.json();
      if (json.status !== 'success' || !json.data?.length) return null;

      const data = json.data[0];
      return {
        rnc,
        name: data.business_name || '',
        commercialName: data.tradename || '',
        status: data.state || 'DESCONOCIDO',
        paymentRegime: data.payment_regime || '',
        category: data.sector || '',
        economicActivity: data.economic_activity || '',
        isElectronicInvoicer: false,
      };
    } catch (error: any) {
      clearTimeout(timeout);
      if (error.name === 'AbortError') throw new Error('RNC lookup timeout (5s)');
      throw error;
    }
  }

  private clean(rnc: string): string {
    const cleaned = (rnc || '').replace(/[^0-9]/g, '');
    if (cleaned.length !== 9 && cleaned.length !== 11) {
      throw new BadRequestException(
        `RNC debe tener 9 dígitos o Cédula 11 dígitos. Recibido: ${cleaned.length} dígitos.`,
      );
    }
    return cleaned;
  }
}
