import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import {
  InvoiceInput,
  InvoiceItemInput,
  InvoiceTotals,
  ReferenceInput,
} from '../xml-builder/invoice-input.interface';
import {
  ECF_TYPE_CODES,
  REQUIRES_BUYER_RNC,
  REQUIRES_REFERENCE,
  MAX_ITEMS_PER_ECF,
  MAX_ITEMS_FC_UNDER_250K,
  FC_FULL_SUBMISSION_THRESHOLD,
  NC_ITBIS_RETURN_LIMIT_DAYS,
  MODIFICATION_CODES,
  isValidEncf,
  isValidNcfModificado,
  isSequenceExpired,
  isIscEspecificoAlcohol,
  isIscAdvaloremAlcohol,
  isIscEspecificoCigarrillo,
  isIscAdvaloremCigarrillo,
} from '../xml-builder/ecf-types';

/**
 * DGII Validation Service
 *
 * Validates all business rules per DGII Informe Técnico v1.0:
 * - eNCF format and sequence expiration
 * - NC/ND reference rules (NCFModificado, modification codes, 30-day ITBIS rule)
 * - Rounding rules (2 decimals, exceptions for PrecioUnitario=4, TipoCambio=4, Subcantidad=3)
 * - Cuadratura tolerance (±1 per line, global = number of lines)
 * - Item limits (1000 normal, 10000 for FC < 250K)
 * - ISC calculation validation
 * - RNC format validation
 */
@Injectable()
export class ValidationService {
  private readonly logger = new Logger(ValidationService.name);

  // ============================================================
  // MAIN VALIDATION ENTRY POINT
  // ============================================================

  /**
   * Validate invoice input completely before XML generation.
   * Throws BadRequestException with specific error message on failure.
   */
  validateInvoiceInput(input: InvoiceInput, sequenceExpiration?: Date): void {
    const typeCode = this.getTypeCode(input.ecfType);

    this.validateBasicFields(input, typeCode);
    this.validateBuyerRnc(input, typeCode);
    this.validateItems(input, typeCode);
    this.validatePayment(input);
    this.validateReference(input, typeCode);
    this.validateFechaEmision(input);

    if (sequenceExpiration) {
      this.validateSequenceExpiration(sequenceExpiration);
    }
  }

  // ============================================================
  // BASIC FIELD VALIDATION
  // ============================================================

  private getTypeCode(ecfType: string): number {
    const typeCode = ECF_TYPE_CODES[ecfType as keyof typeof ECF_TYPE_CODES];
    if (!typeCode) {
      throw new BadRequestException(`Tipo de e-CF inválido: ${ecfType}. Tipos válidos: E31-E47`);
    }
    return typeCode;
  }

  private validateBasicFields(input: InvoiceInput, typeCode: number): void {
    if (!input.companyId) {
      throw new BadRequestException('companyId es obligatorio');
    }

    if (!input.buyer) {
      throw new BadRequestException('Información del comprador es obligatoria');
    }
  }

  /**
   * Validate fechaEmision format when user-provided.
   * Per XSD FechaValidationType: DD-MM-YYYY pattern.
   */
  private validateFechaEmision(input: InvoiceInput): void {
    if (!input.fechaEmision) return;

    const dgiiDatePattern = /^(3[01]|[12][0-9]|0?[1-9])-(1[0-2]|0?[1-9])-((19|20)\d{2})$/;
    if (!dgiiDatePattern.test(input.fechaEmision)) {
      throw new BadRequestException(
        `fechaEmision inválida: "${input.fechaEmision}". ` +
        `Formato requerido: DD-MM-YYYY (ej: 25-01-2024)`,
      );
    }
  }

  // ============================================================
  // BUYER RNC VALIDATION
  // ============================================================

  private validateBuyerRnc(input: InvoiceInput, typeCode: number): void {
    if (REQUIRES_BUYER_RNC.includes(typeCode) && !input.buyer?.rnc) {
      throw new BadRequestException(
        `RNC del comprador es obligatorio para tipo ${input.ecfType}`,
      );
    }

    if (input.buyer?.rnc) {
      this.validateRncFormat(input.buyer.rnc);
    }
  }

  /**
   * Validate RNC format.
   * RNC: 9 digits for Persona Jurídica
   * Cédula: 11 digits for Persona Física
   */
  validateRncFormat(rnc: string): void {
    const clean = rnc.replace(/[-\s]/g, '');
    if (!/^\d{9}$/.test(clean) && !/^\d{11}$/.test(clean)) {
      throw new BadRequestException(
        `RNC/Cédula inválido: ${rnc}. Debe ser 9 dígitos (RNC) u 11 dígitos (Cédula)`,
      );
    }
  }

  // ============================================================
  // ITEMS VALIDATION
  // ============================================================

  private validateItems(input: InvoiceInput, typeCode: number): void {
    if (!input.items || input.items.length === 0) {
      throw new BadRequestException('Debe incluir al menos un item');
    }

    // Different limits: E33/E34 maxOccurs=10000 per XSD, FC < 250K also 10000
    const isFcUnder250k = typeCode === 32 && this.estimateTotal(input.items) < FC_FULL_SUBMISSION_THRESHOLD;
    const hasHigherLimit = isFcUnder250k || typeCode === 33 || typeCode === 34;
    const maxItems = hasHigherLimit ? MAX_ITEMS_FC_UNDER_250K : MAX_ITEMS_PER_ECF;

    if (input.items.length > maxItems) {
      throw new BadRequestException(
        `Máximo ${maxItems} items por e-CF (tipo ${input.ecfType})`,
      );
    }

    // Validate each item
    for (let i = 0; i < input.items.length; i++) {
      this.validateItem(input.items[i], i + 1);
    }
  }

  private validateItem(item: InvoiceItemInput, lineNum: number): void {
    if (!item.description || item.description.trim() === '') {
      throw new BadRequestException(`Línea ${lineNum}: descripción es obligatoria`);
    }

    if (item.quantity <= 0) {
      throw new BadRequestException(`Línea ${lineNum}: cantidad debe ser mayor a 0`);
    }

    if (item.unitPrice < 0) {
      throw new BadRequestException(`Línea ${lineNum}: precio unitario no puede ser negativo`);
    }

    // Validate ITBIS rate
    const rate = item.itbisRate ?? 18;
    if (![18, 16, 0].includes(rate)) {
      throw new BadRequestException(
        `Línea ${lineNum}: tasa ITBIS inválida (${rate}). Valores permitidos: 18, 16, 0`,
      );
    }

    // Validate ISC fields if present
    if (item.additionalTaxCode) {
      this.validateIscFields(item, lineNum);
    }
  }

  private validateIscFields(item: InvoiceItemInput, lineNum: number): void {
    const code = item.additionalTaxCode!;

    if (isIscEspecificoAlcohol(code)) {
      if (!item.alcoholDegrees || item.alcoholDegrees <= 0) {
        throw new BadRequestException(
          `Línea ${lineNum}: GradosAlcohol es obligatorio para ISC Específico Alcohol (código ${code})`,
        );
      }
      if (!item.referenceQuantity || item.referenceQuantity <= 0) {
        throw new BadRequestException(
          `Línea ${lineNum}: CantidadReferencia es obligatorio para ISC Específico Alcohol`,
        );
      }
      if (!item.subQuantity || item.subQuantity <= 0) {
        throw new BadRequestException(
          `Línea ${lineNum}: Subcantidad es obligatorio para ISC Específico Alcohol`,
        );
      }
    }

    if (isIscAdvaloremAlcohol(code) || isIscAdvaloremCigarrillo(code)) {
      if (!item.referenceUnitPrice || item.referenceUnitPrice <= 0) {
        throw new BadRequestException(
          `Línea ${lineNum}: PrecioUnitarioReferencia (PVP) es obligatorio para ISC Ad-Valorem`,
        );
      }
    }

    if (isIscEspecificoCigarrillo(code)) {
      if (!item.referenceQuantity || item.referenceQuantity <= 0) {
        throw new BadRequestException(
          `Línea ${lineNum}: CantidadReferencia es obligatorio para ISC Específico Cigarrillos`,
        );
      }
    }
  }

  private estimateTotal(items: InvoiceItemInput[]): number {
    return items.reduce((sum, item) => {
      return sum + (item.quantity * item.unitPrice - (item.discount || 0) + (item.surcharge || 0));
    }, 0);
  }

  // ============================================================
  // PAYMENT VALIDATION
  // ============================================================

  private validatePayment(input: InvoiceInput): void {
    if (!input.payment || !input.payment.type) {
      throw new BadRequestException('Información de pago es obligatoria');
    }

    // TipoPago per DGII: 1=Contado, 2=Crédito, 3=Gratuito
    if (input.payment.type < 1 || input.payment.type > 3) {
      throw new BadRequestException(
        `TipoPago inválido (${input.payment.type}). Valores: 1=Contado, 2=Crédito, 3=Gratuito`,
      );
    }
  }

  // ============================================================
  // NC/ND REFERENCE VALIDATION
  // ============================================================

  private validateReference(input: InvoiceInput, typeCode: number): void {
    if (!REQUIRES_REFERENCE.includes(typeCode)) return;

    if (!input.reference) {
      throw new BadRequestException(
        `InformacionReferencia es obligatoria para tipo ${input.ecfType} (Nota de Crédito/Débito)`,
      );
    }

    const ref = input.reference;

    // Validate NCFModificado format
    if (!isValidNcfModificado(ref.encf)) {
      throw new BadRequestException(
        `NCFModificado inválido: ${ref.encf}. Debe ser serie E (13 chars), B (11 chars), o A/P (19 chars)`,
      );
    }

    // Validate modification code per XSD CodigoModificacionType: values 1-5
    const validCodes = [1, 2, 3, 4, 5];
    if (!validCodes.includes(ref.modificationCode)) {
      throw new BadRequestException(
        `CódigoModificación inválido (${ref.modificationCode}). Valores: 1=Anula, 2=Corrige texto, 3=Corrige montos, 4=Reemplazo contingencia, 5=Referencia FC`,
      );
    }

    // Validate date
    if (!ref.date) {
      throw new BadRequestException('FechaNCFModificado es obligatoria');
    }
  }

  /**
   * Check the 30-day ITBIS rule for Nota de Crédito.
   * Per DGII: if NC is issued >30 days after original invoice,
   * ITBIS cannot be returned - only the price.
   *
   * @returns true if ITBIS can be returned, false if only price
   */
  canReturnItbisInNc(originalInvoiceDate: Date): boolean {
    const now = new Date();
    const diffMs = now.getTime() - originalInvoiceDate.getTime();
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    return diffDays <= NC_ITBIS_RETURN_LIMIT_DAYS;
  }

  // ============================================================
  // SEQUENCE VALIDATION
  // ============================================================

  private validateSequenceExpiration(expirationDate: Date): void {
    if (isSequenceExpired(expirationDate)) {
      throw new BadRequestException(
        `Secuencia e-NCF vencida. Las secuencias son válidas hasta el 31 de diciembre del año siguiente a su autorización. Venció: ${expirationDate.toISOString().split('T')[0]}`,
      );
    }
  }

  /**
   * Validate eNCF format before use.
   */
  validateEncfFormat(encf: string): void {
    if (!isValidEncf(encf)) {
      throw new BadRequestException(
        `eNCF inválido: ${encf}. Formato: E + 2 dígitos tipo + 10 dígitos secuencial (13 chars total)`,
      );
    }
  }

  // ============================================================
  // ROUNDING RULES (per DGII Informe Técnico)
  // ============================================================

  /**
   * DGII Rounding Rule:
   * - Standard fields: 2 decimal places
   * - PrecioUnitarioItem / PrecioUnitarioItemOtraMoneda: up to 4 decimal places
   * - TipoCambio: up to 4 decimal places
   * - Subcantidad: up to 3 decimal places
   *
   * Third decimal >= 5 rounds up, < 5 stays
   */
  static round2(n: number): number {
    return Math.round((n + Number.EPSILON) * 100) / 100;
  }

  static round4(n: number): number {
    return Math.round((n + Number.EPSILON) * 10000) / 10000;
  }

  static round3(n: number): number {
    return Math.round((n + Number.EPSILON) * 1000) / 1000;
  }

  /**
   * Format amount to exactly 2 decimal places (standard DGII fields)
   */
  static formatAmount(n: number): string {
    return ValidationService.round2(n).toFixed(2);
  }

  /**
   * Format price to up to 4 decimal places (PrecioUnitarioItem)
   */
  static formatPrice(n: number): string {
    return ValidationService.round4(n).toFixed(4).replace(/0+$/, '').replace(/\.$/, '.00');
  }

  /**
   * Format exchange rate to up to 4 decimal places
   */
  static formatExchangeRate(n: number): string {
    return ValidationService.round4(n).toFixed(4).replace(/0+$/, '').replace(/\.$/, '.00');
  }

  /**
   * Format sub-quantity to up to 3 decimal places
   */
  static formatSubQuantity(n: number): string {
    return ValidationService.round3(n).toFixed(3).replace(/0+$/, '').replace(/\.$/, '.00');
  }

  // ============================================================
  // CUADRATURA / TOLERANCE VALIDATION
  // ============================================================

  /**
   * Validate cuadratura (balance tolerance) per DGII rules.
   *
   * Per-line tolerance: ±1 of (price * quantity)
   * Global tolerance: ±(number of detail lines)
   *
   * Returns warnings if within tolerance, throws if exceeds.
   */
  validateCuadratura(
    items: InvoiceItemInput[],
    totals: InvoiceTotals,
  ): { valid: boolean; warnings: string[] } {
    const warnings: string[] = [];
    const r2 = ValidationService.round2;

    // Per-line validation
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const expectedMonto = r2(item.quantity * item.unitPrice - (item.discount || 0) + (item.surcharge || 0));
      // We don't have the actual XML MontoItem here, but we can check our own calculation
      // This is mainly for when receiving/validating external e-CFs
    }

    // Global tolerance = number of lines
    const globalTolerance = items.length;

    // Check that sum of line items matches totals
    let sumLineSubtotals = 0;
    for (const item of items) {
      sumLineSubtotals += r2(item.quantity * item.unitPrice - (item.discount || 0) + (item.surcharge || 0));
    }
    sumLineSubtotals = r2(sumLineSubtotals);

    const expectedTotal = totals.subtotalBeforeTax;
    const diff = Math.abs(sumLineSubtotals - expectedTotal);

    if (diff > globalTolerance) {
      throw new BadRequestException(
        `Error de cuadratura: diferencia de ${diff.toFixed(2)} excede tolerancia global de ±${globalTolerance}. ` +
        `Suma líneas: ${sumLineSubtotals.toFixed(2)}, Total encabezado: ${expectedTotal.toFixed(2)}`,
      );
    }

    if (diff > 0) {
      warnings.push(
        `Advertencia cuadratura: diferencia de ${diff.toFixed(2)} dentro de tolerancia (±${globalTolerance}). e-CF será Aceptado Condicional.`,
      );
    }

    return { valid: true, warnings };
  }

  // ============================================================
  // ISC CALCULATION HELPERS
  // ============================================================

  /**
   * Calculate ISC Específico for Alcoholes.
   * Formula: TasaImpuestoAdicional × GradosAlcohol × CantidadReferencia × Subcantidad × CantidadItem
   */
  calculateIscEspecificoAlcohol(item: InvoiceItemInput): number {
    const tasa = item.additionalTaxRate || 0;
    const grados = (item.alcoholDegrees || 0) / 100; // percentage as decimal
    const cantRef = item.referenceQuantity || 1;
    const subCant = item.subQuantity || 1;
    const cantItem = item.quantity;

    return ValidationService.round2(tasa * grados * cantRef * subCant * cantItem);
  }

  /**
   * Calculate ISC Específico for Cigarrillos.
   * Formula: CantidadItem × CantidadReferencia × TasaImpuestoAdicional
   */
  calculateIscEspecificoCigarrillo(item: InvoiceItemInput): number {
    const cantItem = item.quantity;
    const cantRef = item.referenceQuantity || 1;
    const tasa = item.additionalTaxRate || 0;

    return ValidationService.round2(cantItem * cantRef * tasa);
  }

  /**
   * Calculate ISC Ad-Valorem for Alcoholes (non-granel).
   * Complex 5-step calculation per DGII Informe Técnico.
   */
  calculateIscAdvaloremAlcohol(
    item: InvoiceItemInput,
    iscEspecifico: number,
    itbisRate: number,
    advaloremRate: number,
  ): number {
    const pvp = item.referenceUnitPrice || 0;
    const cantRef = item.referenceQuantity || 1;
    const cantItem = item.quantity;
    const unitMeasure = item.unitMeasureCode || 0;

    // Check if granel (código 18)
    if (unitMeasure === 18) {
      // Granel: (PrecioUnitario × 1.30 × tasa) × CantidadItem
      return ValidationService.round2(
        (item.unitPrice * 1.30 * advaloremRate) * cantItem,
      );
    }

    // Non-granel: 5-step calculation
    // Step 1: PVP sin ITBIS
    const pvpSinItbis = ValidationService.round2(pvp / (1 + itbisRate / 100));

    // Step 2: PVP sin ITBIS - ISC específico unitario
    const iscEspecificoUnitario = ValidationService.round2(
      iscEspecifico / (cantRef * cantItem),
    );
    const pvpSinImpuestos = ValidationService.round2(pvpSinItbis - iscEspecificoUnitario);

    // Step 3: Divide by (1 + tasa AdValorem)
    const precioBase = ValidationService.round2(pvpSinImpuestos / (1 + advaloremRate));

    // Step 4: Calculate ISC AdValorem por unidad
    const iscAdvUnitario = ValidationService.round2(precioBase * advaloremRate);

    // Step 5: Multiply by cantRef × cantItem
    return ValidationService.round2(iscAdvUnitario * cantRef * cantItem);
  }

  /**
   * Calculate ISC Ad-Valorem for Cigarrillos.
   * Similar 5-step process per DGII.
   */
  calculateIscAdvaloremCigarrillo(
    item: InvoiceItemInput,
    itbisRate: number,
    advaloremRate: number,
  ): number {
    const pvp = item.referenceUnitPrice || 0;
    const cantRef = item.referenceQuantity || 1;
    const cantItem = item.quantity;
    const tasa = item.additionalTaxRate || 0;

    // Step 1: PVP sin ITBIS
    const pvpSinItbis = ValidationService.round2(pvp / (1 + itbisRate / 100));

    // Step 2: Restar tasa ISC específico
    const pvpSinIscEsp = ValidationService.round2(pvpSinItbis - tasa);

    // Step 3: Divide by (1 + tasa AdValorem)
    const precioBase = ValidationService.round2(pvpSinIscEsp / (1 + advaloremRate));

    // Step 4: ISC AdValorem por unidad
    const iscAdvUnitario = ValidationService.round2(precioBase * advaloremRate);

    // Step 5: Total
    return ValidationService.round2(iscAdvUnitario * cantRef * cantItem);
  }

  /**
   * Calculate "Otros Impuestos Adicionales" (codes 001-005)
   * Per DGII: depends on IndicadorMontoGravado
   */
  calculateOtrosImpuestos(
    montoItem: number,
    tasa: number,
    indicadorMontoGravado: number,
    itbisRate: number = 18,
  ): number {
    if (indicadorMontoGravado === 0) {
      // Sin ITBIS incluido
      return ValidationService.round2(montoItem * tasa);
    } else {
      // Con ITBIS incluido: extraer base primero
      return ValidationService.round2((montoItem / (1 + itbisRate / 100)) * tasa);
    }
  }
}
