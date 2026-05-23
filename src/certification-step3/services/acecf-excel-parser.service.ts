import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import * as XLSX from 'xlsx';

/**
 * Parsea el Excel del Paso 3 DGII (Aprobaciones Comerciales).
 *
 * Sheet esperado: ACEECF_Generadas
 * Columnas: Version, RNCEmisor, eNCF, FechaEmision, MontoTotal,
 *           RNCComprador, Estado, DetalleMotivoRechazo,
 *           FechaHoraAprobacionComercial
 */

export interface ParsedAcecfRow {
  encf: string;
  ecfType: string;
  emitterRnc: string;
  receiverRnc: string;
  totalAmount: number;
  issueDate: Date;
  intendedEstado: 1 | 2;
  rejectionReason?: string;
}

const STEP3_SHEET_NAME = 'ACEECF_Generadas';

@Injectable()
export class AcecfExcelParser {
  constructor(
    @InjectPinoLogger(AcecfExcelParser.name)
    private readonly logger: PinoLogger,
  ) {}

  parse(fileBuffer: Buffer): ParsedAcecfRow[] {
    let workbook: XLSX.WorkBook;
    try {
      workbook = XLSX.read(fileBuffer, { type: 'buffer', raw: false });
    } catch {
      throw new BadRequestException('No se pudo leer el archivo. ¿Es un .xlsx válido?');
    }

    const sheetName = workbook.SheetNames.includes(STEP3_SHEET_NAME)
      ? STEP3_SHEET_NAME
      : workbook.SheetNames[0];

    if (!sheetName) {
      throw new BadRequestException('El Excel no contiene hojas');
    }

    const sheet = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { raw: false });

    if (!rows || rows.length === 0) {
      throw new BadRequestException(`Sheet "${sheetName}" está vacío`);
    }

    const result: ParsedAcecfRow[] = [];
    const errors: string[] = [];

    rows.forEach((row, idx) => {
      const rowNum = idx + 2;
      try {
        const encf = String(row['eNCF'] ?? row['ENCF'] ?? '').trim();
        if (!encf || encf.length < 3) {
          throw new Error(`eNCF inválido: "${encf}"`);
        }
        const ecfType = encf.substring(0, 3);

        const emitterRnc = String(row['RNCEmisor'] ?? '').trim();
        const receiverRnc = String(row['RNCComprador'] ?? '').trim();
        if (!emitterRnc || !receiverRnc) {
          throw new Error('RNCEmisor o RNCComprador faltante');
        }

        const totalAmount = parseFloat(String(row['MontoTotal'] ?? '0').replace(/,/g, ''));
        if (!isFinite(totalAmount) || totalAmount < 0) {
          throw new Error(`MontoTotal inválido: ${row['MontoTotal']}`);
        }

        const issueDate = this.parseDate(String(row['FechaEmision'] ?? ''));

        const estadoRaw = parseInt(String(row['Estado'] ?? ''), 10);
        if (![1, 2].includes(estadoRaw)) {
          throw new Error(`Estado debe ser 1 o 2, recibido: ${row['Estado']}`);
        }
        const intendedEstado = estadoRaw as 1 | 2;

        let rejectionReason: string | undefined;
        if (intendedEstado === 2) {
          rejectionReason = String(row['DetalleMotivoRechazo'] ?? '').trim();
          if (!rejectionReason) {
            throw new Error('DetalleMotivoRechazo requerido cuando Estado=2');
          }
        }

        result.push({ encf, ecfType, emitterRnc, receiverRnc, totalAmount, issueDate, intendedEstado, rejectionReason });
      } catch (e: any) {
        errors.push(`Fila ${rowNum}: ${e.message}`);
      }
    });

    if (errors.length > 0) {
      throw new BadRequestException(`Errores en el Excel:\n${errors.join('\n')}`);
    }

    this.logger.info(`Parseadas ${result.length} filas del Excel ACECF (sheet: ${sheetName})`);
    return result;
  }

  private parseDate(s: string): Date {
    const m = s.trim().match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/);
    if (!m) throw new Error(`FechaEmision inválida: "${s}" (debe ser dd-MM-yyyy)`);
    const [, day, month, year] = m;
    const d = parseInt(day, 10);
    const mo = parseInt(month, 10);
    const y = parseInt(year, 10);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) {
      throw new Error(`Fecha fuera de rango: ${s}`);
    }
    return new Date(Date.UTC(y, mo - 1, d, 0, 0, 0));
  }
}
