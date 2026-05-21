/**
 * XML Builder Tests — DGII e-CF Compliance
 *
 * Tests XML generation for all 10 e-CF types against DGII XSD/Formato v1.0.
 * Validates: field presence, field order (xs:sequence), conditional fields,
 * formatting (dates DD-MM-YYYY, amounts 2 decimals, padding), and type-specific logic.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { XmlBuilderService, EmitterData } from './xml-builder.service';
import { ValidationService } from '../validation/validation.service';
import { TestLoggerModule } from '../common/logger/test-logger.module';
import {
  InvoiceInput,
  InvoiceItemInput,
  PaymentInput,
  BuyerInput,
} from './invoice-input.interface';

// ============================================================
// TEST FIXTURES
// ============================================================

const mockEmitter: EmitterData = {
  rnc: '131234567',
  businessName: 'Test Company SRL',
  tradeName: 'TestCo',
  address: 'Calle Principal #1, Santiago',
  municipality: '250101',  // Santiago (D.M.) per ProvinciaMunicipioType
  province: '250000',      // Provincia Santiago per ProvinciaMunicipioType
};

const basicItem = (overrides?: Partial<InvoiceItemInput>): InvoiceItemInput => ({
  description: 'Servicio de Consultoría',
  quantity: 1,
  unitPrice: 1000,
  itbisRate: 18,
  incomeType: 1,
  code: 'SVC-001',
  unit: 'UND',
  ...overrides,
});

const exemptItem = (overrides?: Partial<InvoiceItemInput>): InvoiceItemInput => ({
  description: 'Producto Exento',
  quantity: 2,
  unitPrice: 500,
  itbisRate: 0,
  indicadorFacturacion: 4,
  incomeType: 1,
  code: 'EXM-001',
  unit: 'UND',
  ...overrides,
});

const basicPayment: PaymentInput = {
  type: 1, // Contado
  method: 1, // Efectivo
};

const creditPayment: PaymentInput = {
  type: 2, // Crédito
  method: 4, // Venta a crédito
  date: '15-03-2025',
  termDays: 30,
};

const basicBuyer: BuyerInput = {
  rnc: '101234567',
  name: 'Comprador Test SRL',
  type: 1,
  email: 'comprador@test.com',
  phone: '809-555-1234',
  address: 'Av. 27 de Febrero',
  municipality: '010101',  // Santo Domingo de Guzmán (D.M.) per ProvinciaMunicipioType
  province: '010000',      // Distrito Nacional per ProvinciaMunicipioType
};

const consumerBuyer: BuyerInput = {
  name: 'Juan Pérez',
  type: 2,
};

function makeInput(ecfType: string, overrides?: Partial<InvoiceInput>): InvoiceInput {
  return {
    companyId: 'test-company-id',
    ecfType,
    buyer: basicBuyer,
    items: [basicItem()],
    payment: basicPayment,
    ...overrides,
  };
}

// ============================================================
// HELPERS
// ============================================================

/** Extract content of an XML tag */
function tagContent(xml: string, tag: string): string | null {
  const re = new RegExp(`<${tag}>([^<]*)</${tag}>`);
  const m = xml.match(re);
  return m ? m[1] : null;
}

/** Check if tag exists in XML */
function hasTag(xml: string, tag: string): boolean {
  return xml.includes(`<${tag}>`);
}

/** Check order of two tags (a must come before b) */
function tagBefore(xml: string, tagA: string, tagB: string): boolean {
  const posA = xml.indexOf(`<${tagA}>`);
  const posB = xml.indexOf(`<${tagB}>`);
  if (posA === -1 || posB === -1) return true; // skip if either missing
  return posA < posB;
}

/** Extract all Item blocks */
function getItems(xml: string): string[] {
  const matches = xml.match(/<Item>[\s\S]*?<\/Item>/g);
  return matches || [];
}

// ============================================================
// TEST SUITE
// ============================================================

describe('XmlBuilderService', () => {
  let service: XmlBuilderService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [TestLoggerModule],
      providers: [XmlBuilderService, ValidationService],
    }).compile();

    service = module.get<XmlBuilderService>(XmlBuilderService);
  });

  // ============================================================
  // A. ESTRUCTURA GENERAL
  // ============================================================

  describe('General XML Structure', () => {
    it('should generate valid XML declaration and root element', () => {
      const input = makeInput('E31');
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');

      expect(xml).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/);
      expect(xml).toContain('<ECF>');
      expect(xml).not.toContain('xmlns="http://dgii.gov.do/eCF"');
      expect(xml).toContain('</ECF>');
    });

    it('should include Version 1.0 as first child of Encabezado', () => {
      const input = makeInput('E31');
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');

      expect(tagContent(xml, 'Version')).toBe('1.0');
      expect(xml.indexOf('<Version>')).toBeLessThan(xml.indexOf('<IdDoc>'));
    });

    it('should follow XSD Encabezado order: IdDoc → Emisor → Comprador → Totales → OtraMoneda', () => {
      const input = makeInput('E31');
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');

      expect(tagBefore(xml, 'IdDoc', 'Emisor')).toBe(true);
      expect(tagBefore(xml, 'Emisor', 'Comprador')).toBe(true);
      expect(tagBefore(xml, 'Comprador', 'Totales')).toBe(true);
    });

    it('should place InformacionesAdicionales and Transporte before Totales when present', () => {
      const input = makeInput('E46', {
        buyer: { ...basicBuyer, country: 'US' },
        additionalInfo: { portOfShipment: 'Puerto Caucedo', totalFob: 5000 },
        transport: { viaTransporte: 2, countryDestination: 'United States' },
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E460000000001');

      expect(tagBefore(xml, 'InformacionesAdicionales', 'Totales')).toBe(true);
      expect(tagBefore(xml, 'Transporte', 'Totales')).toBe(true);
    });

    it('should include DetallesItems after Encabezado', () => {
      const input = makeInput('E31');
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');

      expect(xml.indexOf('</Encabezado>')).toBeLessThan(xml.indexOf('<DetallesItems>'));
    });
  });

  // ============================================================
  // B. IdDoc TESTS
  // ============================================================

  describe('IdDoc Section', () => {
    it('should emit TipoeCF correctly for each type', () => {
      const types: [string, string][] = [
        ['E31', '31'], ['E32', '32'], ['E33', '33'], ['E34', '34'],
        ['E41', '41'], ['E43', '43'], ['E44', '44'], ['E45', '45'],
        ['E46', '46'], ['E47', '47'],
      ];

      for (const [ecfType, expected] of types) {
        const input = makeInput(ecfType, {
          buyer: ecfType === 'E43' ? consumerBuyer : basicBuyer,
          reference: ['E33', 'E34'].includes(ecfType) ? {
            encf: 'E310000000099', date: '01-01-2025', modificationCode: 1,
          } : undefined,
        });
        const encf = `${ecfType.replace('E', 'E')}0000000001`;
        const { xml } = service.buildEcfXml(input, mockEmitter, encf);
        expect(tagContent(xml, 'TipoeCF')).toBe(expected);
      }
    });

    it('should emit eNCF correctly', () => {
      const input = makeInput('E31');
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000042');
      expect(tagContent(xml, 'eNCF')).toBe('E310000000042');
    });

    it('should emit FechaVencimientoSecuencia when provided', () => {
      // Use ISO format with explicit time to avoid UTC→GMT-4 date shift
      const input = makeInput('E31', { sequenceExpiresAt: '2025-12-31T12:00:00' });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');
      expect(tagContent(xml, 'FechaVencimientoSecuencia')).toBe('31-12-2025');
    });

    it('should handle E32 without FechaVencimientoSecuencia (code 0)', () => {
      const input = makeInput('E32', {
        buyer: consumerBuyer,
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E320000000001');
      // E32 FechaVencimientoSecuencia = 0 (no debe ir)
      // Our builder conditionally emits it only when sequenceExpiresAt is set
      // Without setting it, it shouldn't appear
      expect(hasTag(xml, 'TipoeCF')).toBe(true);
      expect(tagContent(xml, 'TipoeCF')).toBe('32');
    });

    it('should pad TipoIngresos to 2 digits', () => {
      const input = makeInput('E31', { items: [basicItem({ incomeType: 1 })] });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');
      expect(tagContent(xml, 'TipoIngresos')).toBe('01');
    });

    it('should NOT emit TipoIngresos for E41, E43, E47 (code 0)', () => {
      for (const ecfType of ['E41', 'E43', 'E47']) {
        const input = makeInput(ecfType, {
          buyer: ecfType === 'E43' ? consumerBuyer : basicBuyer,
        });
        const { xml } = service.buildEcfXml(input, mockEmitter, `${ecfType.replace('E', 'E')}0000000001`);
        expect(hasTag(xml, 'TipoIngresos')).toBe(false);
      }
    });

    it('should emit IndicadorNotaCredito only for E34', () => {
      const input = makeInput('E34', {
        reference: { encf: 'E310000000050', date: '01-12-2024', modificationCode: 3 },
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E340000000001');
      expect(hasTag(xml, 'IndicadorNotaCredito')).toBe(true);
    });

    it('should NOT emit IndicadorEnvioDiferido when not authorized', () => {
      const input = makeInput('E31');
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');
      expect(hasTag(xml, 'IndicadorEnvioDiferido')).toBe(false);
    });

    it('should emit IndicadorEnvioDiferido=1 when authorized', () => {
      const input = makeInput('E31', { indicadorEnvioDiferido: 1 });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');
      expect(tagContent(xml, 'IndicadorEnvioDiferido')).toBe('1');
    });

    it('should NOT emit IndicadorMontoGravado for E43, E44, E46, E47', () => {
      for (const ecfType of ['E43', 'E44', 'E46', 'E47']) {
        const input = makeInput(ecfType, {
          buyer: ecfType === 'E43' ? consumerBuyer : basicBuyer,
        });
        const { xml } = service.buildEcfXml(input, mockEmitter, `${ecfType.replace('E', 'E')}0000000001`);
        expect(hasTag(xml, 'IndicadorMontoGravado')).toBe(false);
      }
    });

    it('should emit TipoPago as required for standard types', () => {
      const input = makeInput('E31');
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');
      expect(tagContent(xml, 'TipoPago')).toBe('1');
    });

    it('should emit FormaPago as xs:integer (no zero-padding per XSD FormaPagoType)', () => {
      const input = makeInput('E31', { payment: { type: 1, method: 1 } });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');
      expect(tagContent(xml, 'FormaPago')).toBe('1');
    });

    it('should wrap FormaPago/MontoPago inside FormaDePago container', () => {
      const input = makeInput('E31');
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');
      expect(xml).toContain('<TablaFormasPago>');
      expect(xml).toContain('<FormaDePago>');
      expect(xml).toContain('</FormaDePago>');
      expect(xml).toContain('</TablaFormasPago>');
    });

    it('should NOT emit TablaFormasPago for E34', () => {
      const input = makeInput('E34', {
        reference: { encf: 'E310000000001', date: '01-01-2025', modificationCode: 1 },
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E340000000001');
      expect(hasTag(xml, 'TablaFormasPago')).toBe(false);
    });

    it('should emit FechaLimitePago when TipoPago=2 (crédito)', () => {
      const input = makeInput('E31', { payment: creditPayment });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');
      expect(hasTag(xml, 'FechaLimitePago')).toBe(true);
    });

    it('should NOT emit FechaLimitePago when TipoPago=1 (contado)', () => {
      const input = makeInput('E31');
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');
      expect(hasTag(xml, 'FechaLimitePago')).toBe(false);
    });

    // ----- Fix 4b: condicional / override behaviors -----

    it('Fix 4b: should NOT emit IndicadorMontoGravado when input.indicadorMontoGravado is undefined', () => {
      // DGII test set has rows where this tag must be absent. Defaulting to 0
      // caused rejections: "valor enviado (0) no coincide con valor ()".
      const input = makeInput('E31');
      delete (input as any).indicadorMontoGravado;
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');
      expect(hasTag(xml, 'IndicadorMontoGravado')).toBe(false);
    });

    it('Fix 4b: should emit IndicadorMontoGravado=0 when explicitly provided', () => {
      const input = makeInput('E31', { indicadorMontoGravado: 0 });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');
      expect(tagContent(xml, 'IndicadorMontoGravado')).toBe('0');
    });

    it('Fix 4b: should emit IndicadorMontoGravado=1 when explicitly provided', () => {
      const input = makeInput('E31', { indicadorMontoGravado: 1 });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');
      expect(tagContent(xml, 'IndicadorMontoGravado')).toBe('1');
    });

    it('Fix 4c: should emit TipoIngresos=01 by default when type requires it and incomeType is absent', () => {
      // The Fix 4b attempt to make TipoIngresos conditional broke XSD validation:
      //   "Element 'TipoPago': This element is not expected. Expected is one
      //    of (..., TipoIngresos)"
      // because XSD requires the field at a fixed position for these types.
      // Fix 4c restores the default '01' so the XML is structurally valid.
      const input = makeInput('E31', { items: [basicItem({ incomeType: undefined })] });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');
      expect(tagContent(xml, 'TipoIngresos')).toBe('01');
    });

    it('Fix 4b: should honor input.indicadorNotaCredito override for E34', () => {
      // DGII test set provides fixed expected values regardless of 30-day rule.
      // Without override, the builder computes from reference.date — wrong for cert.
      const oldDate = '01-01-2018'; // >30 days, normally computes 1
      const input = makeInput('E34', {
        reference: { encf: 'E310000000050', date: oldDate, modificationCode: 3 },
        indicadorNotaCredito: 0, // override forces 0
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E340000000001');
      expect(tagContent(xml, 'IndicadorNotaCredito')).toBe('0');
    });

    it('Fix 4b: should fall back to 30-day calculation when indicadorNotaCredito is absent', () => {
      // Production behavior must not regress.
      const oldDate = '01-01-2018';
      const input = makeInput('E34', {
        reference: { encf: 'E310000000050', date: oldDate, modificationCode: 3 },
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E340000000001');
      expect(tagContent(xml, 'IndicadorNotaCredito')).toBe('1'); // > 30 days
    });

    it('Fix 4e: emits MontoPeriodo and ValorPagar only when input provides them', () => {
      // Fix 4c emitted these unconditionally for [31, 32, 44, 45, 47]; Fix 4e
      // delegates the decision to the caller because the DGII certification
      // dataset is inconsistent — the SAME e-CF type can want these tags
      // present on one row and absent on another (e.g. E31:6 vs E31:34).
      const inputWithValues = makeInput('E31', {
        montoPeriodo: 1234.56,
        valorPagar: 1234.56,
      });
      const { xml: xmlWith } = service.buildEcfXml(inputWithValues, mockEmitter, 'E310000000001');
      expect(tagContent(xmlWith, 'MontoPeriodo')).toBe('1234.56');
      expect(tagContent(xmlWith, 'ValorPagar')).toBe('1234.56');

      const inputWithout = makeInput('E31');
      const { xml: xmlNo } = service.buildEcfXml(inputWithout, mockEmitter, 'E310000000001');
      expect(hasTag(xmlNo, 'MontoPeriodo')).toBe(false);
      expect(hasTag(xmlNo, 'ValorPagar')).toBe(false);
    });

    it('Fix 4e: MontoPeriodo can be emitted without ValorPagar and vice versa', () => {
      // E410000000001 in the DGII test set has MontoPeriodo absent but
      // ValorPagar=11800.00. The two fields are independent.
      const input = makeInput('E41', { valorPagar: 11800 });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E410000000001');
      expect(hasTag(xml, 'MontoPeriodo')).toBe(false);
      expect(tagContent(xml, 'ValorPagar')).toBe('11800.00');
    });

    it('Fix 4e: TipoPago can be omitted on E43 via emitTipoPago=false', () => {
      // E430000000001 in the DGII test set has TipoPago='#e'. The mapper
      // encodes that as emitTipoPago=false so the builder omits the tag.
      const input = makeInput('E43', {
        buyer: consumerBuyer,
        emitTipoPago: false,
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E430000000001');
      expect(hasTag(xml, 'TipoPago')).toBe(false);
    });

    it('Fix 4e: TipoPago is still emitted on E43 by default (production safety)', () => {
      const input = makeInput('E43', { buyer: consumerBuyer });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E430000000001');
      expect(tagContent(xml, 'TipoPago')).toBe('1');
    });

    it('Fix 4e: TipoPago is ALWAYS emitted on non-optional types regardless of emitTipoPago', () => {
      // For E31/E32/E33/E34/E41/E44/E45/E46 TipoPago is cod 1 (obligatorio).
      // The flag must not let us omit it on these types.
      const input = makeInput('E31', { emitTipoPago: false as any });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');
      expect(tagContent(xml, 'TipoPago')).toBe('1');
    });

    // ----- Fix 4f: rawText verbatim emission -----

    it('Fix 4f: emits PrecioUnitarioItem verbatim from rawText (no fmt rounding)', () => {
      // Without rawText, fmtPrice(100) emits "100.0000". The DGII set wants "100.00".
      const input = makeInput('E43', {
        buyer: consumerBuyer,
        items: [basicItem({
          quantity: 7,
          unitPrice: 100,
          rawText: { PrecioUnitarioItem: '100.00' },
        }) as any],
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E430000000001');
      expect(tagContent(xml, 'PrecioUnitarioItem')).toBe('100.00');
    });

    it('Fix 4f: emits CantidadItem verbatim ("1" without decimals)', () => {
      const input = makeInput('E43', {
        buyer: consumerBuyer,
        items: [basicItem({
          quantity: 1,
          unitPrice: 10000,
          rawText: { CantidadItem: '1' },
        }) as any],
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E430000000012');
      expect(tagContent(xml, 'CantidadItem')).toBe('1');
    });

    it('Fix 4f: emits PrecioOtraMoneda verbatim ("26.64" not "26.6430")', () => {
      const input = makeInput('E45', {
        currency: { code: 'USD', exchangeRate: 56.2876 },
        items: [basicItem({
          quantity: 20,
          unitPrice: 1500,
          rawText: { PrecioOtraMoneda: '26.64' },
        }) as any],
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E450000000010');
      expect(tagContent(xml, 'PrecioOtraMoneda')).toBe('26.64');
    });

    it('Fix 4f: falls back to fmt() when rawText for that field is undefined', () => {
      // Production safety: callers that don't pass rawText still get formatted output.
      const input = makeInput('E31');
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');
      // Default basicItem has unitPrice=1000, no rawText → 4-decimal format.
      expect(tagContent(xml, 'PrecioUnitarioItem')).toBe('1000.0000');
    });

    it('Fix 4f: rawText for only ONE field does not affect siblings', () => {
      // E330000000001 has rawText for PrecioUnitarioItem but not for CantidadItem.
      const input = makeInput('E31', {
        items: [basicItem({
          quantity: 10000,
          unitPrice: 40,
          rawText: { PrecioUnitarioItem: '40.00' }, // only this is overridden
        }) as any],
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');
      expect(tagContent(xml, 'PrecioUnitarioItem')).toBe('40.00');
      // CantidadItem still goes through fmt() since no rawText for it.
      expect(tagContent(xml, 'CantidadItem')).toBe('10000.00');
    });

    // ----- Fix 4g: totalsRawText verbatim header totals -----

    it('Fix 4g: emits MontoGravadoI1 verbatim from totalsRawText', () => {
      // Real DGII rejection: E310000000005 had MontoGravadoI1=735.00 (our calc)
      // but DGII expected 622.88 (per the Excel set). With totalsRawText we
      // emit exactly what the Excel says.
      const input = makeInput('E31', {
        totalsRawText: {
          MontoGravadoI1: '622.88',
          TotalITBIS1: '112.12',
          MontoTotal: '83320.00',
        },
      } as any);
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000005');
      expect(tagContent(xml, 'MontoGravadoI1')).toBe('622.88');
      expect(tagContent(xml, 'TotalITBIS1')).toBe('112.12');
      expect(tagContent(xml, 'MontoTotal')).toBe('83320.00');
    });

    it('Fix 4g: emits ITBIS3=0 and TotalITBIS3=0.00 even when computed amount is zero', () => {
      // E320000000006 was rejected because we omitted <ITBIS3> when the tax
      // amount = 0, but DGII expected the tag PRESENT with value 0 (indicates
      // that an exonerated/0%-rate tax bracket is in use).
      const input = makeInput('E32', {
        buyer: consumerBuyer,
        totalsRawText: {
          ITBIS3: '0',
          TotalITBIS3: '0.00',
        },
      } as any);
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E320000000006');
      expect(tagContent(xml, 'ITBIS3')).toBe('0');
      expect(tagContent(xml, 'TotalITBIS3')).toBe('0.00');
    });

    it('Fix 4g: emits MontoTotal=0 even when items add up to a positive number', () => {
      // E340000000018 is an NC for text correction (CodigoModificacion=2).
      // The Excel has MontoItem=1 but MontoTotal=0 (DGII semantic: text-only
      // corrections must not move money). Builder must honor the override.
      const input = makeInput('E34', {
        items: [basicItem({ quantity: 1, unitPrice: 1 }) as any], // would sum to 1.00
        totalsRawText: {
          MontoTotal: '0.00',
          MontoNoFacturable: '1.00',
        },
        reference: {
          encf: 'E310000000001',
          date: '01-01-2020',
          modificationCode: 2,
        } as any,
      } as any);
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E340000000018');
      expect(tagContent(xml, 'MontoTotal')).toBe('0.00');
      expect(tagContent(xml, 'MontoNoFacturable')).toBe('1.00');
    });

    it('Fix 4g: emits TotalITBISRetenido verbatim from totalsRawText', () => {
      // E410000000001 expected TotalITBISRetenido=1800.00 but we omitted the
      // field entirely because input.retention.* was undefined.
      const input = makeInput('E41', {
        totalsRawText: {
          TotalITBISRetenido: '1800.00',
          TotalISRRetencion: '1000.00',
        },
      } as any);
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E410000000001');
      expect(tagContent(xml, 'TotalITBISRetenido')).toBe('1800.00');
      expect(tagContent(xml, 'TotalISRRetencion')).toBe('1000.00');
    });

    it('Fix 4g: emits TotalISRRetencion on E47 verbatim from totalsRawText', () => {
      // E470000000009 expected TotalISRRetencion=17820.00.
      const input = makeInput('E47', {
        buyer: consumerBuyer,
        totalsRawText: {
          TotalISRRetencion: '17820.00',
        },
      } as any);
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E470000000009');
      expect(tagContent(xml, 'TotalISRRetencion')).toBe('17820.00');
    });

    it('Fix 4g: falls back to computed value when totalsRawText[field] is undefined', () => {
      // Production safety: callers that don't pass totalsRawText (or pass
      // an empty object) get the original behavior.
      const input = makeInput('E31', {
        totalsRawText: { MontoTotal: '999.99' }, // only override MontoTotal
      } as any);
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');
      // MontoTotal is overridden
      expect(tagContent(xml, 'MontoTotal')).toBe('999.99');
      // MontoGravadoTotal NOT overridden → still computed
      expect(hasTag(xml, 'MontoGravadoTotal')).toBe(true);
    });

    it('Fix 4g: undefined totalsRawText leaves all behavior unchanged (no PROD regression)', () => {
      const noRaw = makeInput('E31');
      const withEmpty = makeInput('E31', { totalsRawText: {} as any });
      const { xml: xmlNoRaw } = service.buildEcfXml(noRaw, mockEmitter, 'E310000000001');
      const { xml: xmlEmpty } = service.buildEcfXml(withEmpty, mockEmitter, 'E310000000001');
      // The two XMLs must be byte-identical except for any timestamp-like
      // fields. We compare the Totales section.
      const totalesNo = xmlNoRaw.match(/<Totales>[\s\S]*?<\/Totales>/)?.[0];
      const totalesEmpty = xmlEmpty.match(/<Totales>[\s\S]*?<\/Totales>/)?.[0];
      expect(totalesNo).toBe(totalesEmpty);
    });

    // ----- Fix 4h: multiple FormasPago + FechaVencimientoItem -----

    it('Fix 4h: emits multiple <FormaDePago> entries when payment.forms is provided', () => {
      const input = makeInput('E31', {
        payment: {
          type: 1,
          forms: [
            { method: 1, amount: 9000 },
            { method: 2, amount: 2800 },
          ],
        },
      } as any);
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');
      const formaCount = (xml.match(/<FormaDePago>/g) || []).length;
      expect(formaCount).toBe(2);
      expect(xml).toContain('<FormaPago>1</FormaPago>');
      expect(xml).toContain('<MontoPago>9000.00</MontoPago>');
      expect(xml).toContain('<FormaPago>2</FormaPago>');
      expect(xml).toContain('<MontoPago>2800.00</MontoPago>');
    });

    it('Fix 4h: emits MontoPago verbatim from payment.forms[].rawText', () => {
      // E470000000008 expected MontoPago=14350.00 (Excel verbatim); the
      // single-entry fallback used to emit totalAmount (17850.00). With
      // payment.forms[] + rawText we match the expected string exactly.
      const input = makeInput('E47', {
        buyer: consumerBuyer,
        payment: {
          type: 1,
          forms: [
            { method: 1, amount: 14350, rawText: { MontoPago: '14350.00' } },
          ],
        },
      } as any);
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E470000000008');
      expect(tagContent(xml, 'MontoPago')).toBe('14350.00');
    });

    it('Fix 4h: falls back to single-entry table when payment.forms is absent', () => {
      // Production safety: API callers that don't pass forms[] should
      // continue to get the old single-entry behavior built from method +
      // totalAmount.
      const input = makeInput('E31', {
        payment: { type: 1, method: 2 },
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');
      const formaCount = (xml.match(/<FormaDePago>/g) || []).length;
      expect(formaCount).toBe(1);
      expect(xml).toContain('<FormaPago>2</FormaPago>');
    });

    it('Fix 4h: emits FechaVencimientoItem after FechaElaboracion when set', () => {
      // E310000000008 expected FechaElaboracion=20-12-2019 and
      // FechaVencimientoItem=10-10-2020. These fields are at the item level
      // regardless of ISC code — use a plain item to avoid ISC validation.
      const input = makeInput('E31', {
        items: [basicItem({
          quantity: 1,
          unitPrice: 1500,
          manufacturingDate: '20-12-2019',
          expirationDate: '10-10-2020',
        }) as any],
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000008');
      expect(xml).toContain('<FechaElaboracion>20-12-2019</FechaElaboracion>');
      expect(xml).toContain('<FechaVencimientoItem>10-10-2020</FechaVencimientoItem>');
      // Order: FechaElaboracion before FechaVencimientoItem
      const elIdx = xml.indexOf('<FechaElaboracion>');
      const vencIdx = xml.indexOf('<FechaVencimientoItem>');
      expect(elIdx).toBeLessThan(vencIdx);
    });

    it('Fix 4h: omits FechaVencimientoItem when item.expirationDate is undefined', () => {
      const input = makeInput('E31', {
        items: [basicItem({
          quantity: 1,
          unitPrice: 1500,
          manufacturingDate: '20-12-2019',
          // no expirationDate
        }) as any],
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000008');
      expect(xml).toContain('<FechaElaboracion>20-12-2019</FechaElaboracion>');
      expect(xml).not.toContain('<FechaVencimientoItem>');
    });
  });

  // ============================================================
  // C. EMISOR TESTS
  // ============================================================

  describe('Emisor Section', () => {
    it('should emit required fields: RNCEmisor, RazonSocial, Direccion, FechaEmision', () => {
      const input = makeInput('E31');
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');

      expect(tagContent(xml, 'RNCEmisor')).toBe('131234567');
      expect(tagContent(xml, 'RazonSocialEmisor')).toBe('Test Company SRL');
      expect(hasTag(xml, 'DireccionEmisor')).toBe(true);
      expect(hasTag(xml, 'FechaEmision')).toBe(true);
    });

    it('should NOT emit HoraEmision (not in XSD)', () => {
      const input = makeInput('E31');
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');
      expect(hasTag(xml, 'HoraEmision')).toBe(false);
    });

    it('should emit FechaEmision in DD-MM-YYYY format', () => {
      const input = makeInput('E31');
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');
      const fecha = tagContent(xml, 'FechaEmision');
      expect(fecha).toMatch(/^\d{2}-\d{2}-\d{4}$/);
    });

    it('should emit Municipio and Provincia without Emisor suffix (XSD tags)', () => {
      const input = makeInput('E31');
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');
      // XSD uses <Municipio>, NOT <MunicipioEmisor>
      expect(hasTag(xml, 'Municipio')).toBe(true);
      expect(hasTag(xml, 'Provincia')).toBe(true);
    });

    it('should emit NombreComercial when provided', () => {
      const input = makeInput('E31');
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');
      expect(tagContent(xml, 'NombreComercial')).toBe('TestCo');
    });

    it('should emit optional emitter fields (phones, email, website, vendorCode, internal numbers) in XSD order', () => {
      const richEmitter: EmitterData = {
        ...mockEmitter,
        phones: ['809-555-1111', '809-555-2222'],
        email: 'test@example.com',
        website: 'www.testco.com',
        economicActivity: 'COMERCIO DE TESTING',
        vendorCode: 'V001',
        internalInvoiceNumber: 'INV-2026-1',
        internalOrderNumber: '12345',
        salesZone: 'NORTE',
      };
      const input = makeInput('E31');
      const { xml } = service.buildEcfXml(input, richEmitter, 'E310000000001');

      // Each field emits
      expect(hasTag(xml, 'TablaTelefonoEmisor')).toBe(true);
      expect(xml).toContain('<TelefonoEmisor>809-555-1111</TelefonoEmisor>');
      expect(xml).toContain('<TelefonoEmisor>809-555-2222</TelefonoEmisor>');
      expect(tagContent(xml, 'CorreoEmisor')).toBe('test@example.com');
      expect(tagContent(xml, 'WebSite')).toBe('www.testco.com');
      expect(tagContent(xml, 'ActividadEconomica')).toBe('COMERCIO DE TESTING');
      expect(tagContent(xml, 'CodigoVendedor')).toBe('V001');
      expect(tagContent(xml, 'NumeroFacturaInterna')).toBe('INV-2026-1');
      expect(tagContent(xml, 'NumeroPedidoInterno')).toBe('12345');
      expect(tagContent(xml, 'ZonaVenta')).toBe('NORTE');

      // XSD-required order: TablaTelefonoEmisor → CorreoEmisor → WebSite → ActividadEconomica → CodigoVendedor → NumeroFacturaInterna → NumeroPedidoInterno → ZonaVenta
      expect(tagBefore(xml, 'TablaTelefonoEmisor', 'CorreoEmisor')).toBe(true);
      expect(tagBefore(xml, 'CorreoEmisor', 'WebSite')).toBe(true);
      expect(tagBefore(xml, 'WebSite', 'ActividadEconomica')).toBe(true);
      expect(tagBefore(xml, 'ActividadEconomica', 'CodigoVendedor')).toBe(true);
      expect(tagBefore(xml, 'CodigoVendedor', 'NumeroFacturaInterna')).toBe(true);
      expect(tagBefore(xml, 'NumeroFacturaInterna', 'NumeroPedidoInterno')).toBe(true);
      expect(tagBefore(xml, 'NumeroPedidoInterno', 'ZonaVenta')).toBe(true);
      expect(tagBefore(xml, 'ZonaVenta', 'FechaEmision')).toBe(true);
    });

    it('should cap TablaTelefonoEmisor at 3 phones (XSD maxOccurs="3")', () => {
      const tooManyPhones: EmitterData = {
        ...mockEmitter,
        phones: ['809-000-0001', '809-000-0002', '809-000-0003', '809-000-0004', '809-000-0005'],
      };
      const input = makeInput('E31');
      const { xml } = service.buildEcfXml(input, tooManyPhones, 'E310000000001');
      const matches = xml.match(/<TelefonoEmisor>/g);
      expect(matches?.length).toBe(3);
    });
  });

  // ============================================================
  // D. COMPRADOR TESTS
  // ============================================================

  describe('Comprador Section', () => {
    it('should emit Comprador for E31 with all fields', () => {
      const input = makeInput('E31');
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');

      expect(hasTag(xml, 'Comprador')).toBe(true);
      expect(tagContent(xml, 'RNCComprador')).toBe('101234567');
      expect(tagContent(xml, 'RazonSocialComprador')).toBe('Comprador Test SRL');
    });

    it('should NOT emit Comprador for E43 (Gastos Menores, code 0)', () => {
      const input = makeInput('E43', { buyer: consumerBuyer });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E430000000001');
      // E43 Comprador is code 0
      expect(hasTag(xml, 'RNCComprador')).toBe(false);
    });

    it('should emit PaisComprador only for E46', () => {
      const input = makeInput('E46', {
        buyer: { ...basicBuyer, country: 'Estados Unidos' },
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E460000000001');
      expect(tagContent(xml, 'PaisComprador')).toBe('Estados Unidos');
    });

    it('should NOT emit PaisComprador for non-E46 types', () => {
      const input = makeInput('E31', {
        buyer: { ...basicBuyer, country: 'Some country' },
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');
      expect(hasTag(xml, 'PaisComprador')).toBe(false);
    });

    it('should emit IdentificadorExtranjero when foreignId is present', () => {
      const input = makeInput('E44', {
        buyer: { name: 'Diplomático', type: 3, foreignId: 'PASS-12345' },
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E440000000001');
      expect(tagContent(xml, 'IdentificadorExtranjero')).toBe('PASS-12345');
    });

    it('should emit ContactoComprador from buyer.contactName, NOT buyer.phone (regression)', () => {
      // Bug: previously ContactoComprador was being filled with buyer.phone, but XSD
      // AlfNum80Type and DGII expects the contact's NAME there, not the phone number.
      const input = makeInput('E31', {
        buyer: {
          ...basicBuyer,
          contactName: 'María Pérez',
          phone: '809-555-1234',  // should NOT appear as ContactoComprador
        },
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');
      expect(tagContent(xml, 'ContactoComprador')).toBe('María Pérez');
      expect(xml).not.toContain('<ContactoComprador>809-555-1234</ContactoComprador>');
    });

    it('should emit all optional Comprador fields in XSD order', () => {
      const input = makeInput('E31', {
        buyer: {
          ...basicBuyer,
          contactName: 'MARCOS LATIPLOL',
          email: 'marcos@example.com',
          address: 'Calle Falsa 123',
          municipality: '010100',
          province: '010000',
          deliveryDate: '10-10-2020',
          deliveryContact: 'Juan Entrega',
          deliveryAddress: 'Dir Entrega 456',
          additionalPhone: '809-555-9999',
          orderDate: '10-11-2018',
          orderNumber: '4500352238',
          internalCode: '10633440',
          paymentResponsible: 'María Pago',
          additionalInfo: 'Cliente VIP',
        },
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');

      expect(tagContent(xml, 'ContactoComprador')).toBe('MARCOS LATIPLOL');
      expect(tagContent(xml, 'CorreoComprador')).toBe('marcos@example.com');
      expect(tagContent(xml, 'FechaEntrega')).toBe('10-10-2020');
      expect(tagContent(xml, 'ContactoEntrega')).toBe('Juan Entrega');
      expect(tagContent(xml, 'DireccionEntrega')).toBe('Dir Entrega 456');
      expect(tagContent(xml, 'TelefonoAdicional')).toBe('809-555-9999');
      expect(tagContent(xml, 'FechaOrdenCompra')).toBe('10-11-2018');
      expect(tagContent(xml, 'NumeroOrdenCompra')).toBe('4500352238');
      expect(tagContent(xml, 'CodigoInternoComprador')).toBe('10633440');
      expect(tagContent(xml, 'ResponsablePago')).toBe('María Pago');
      expect(tagContent(xml, 'InformacionAdicionalComprador')).toBe('Cliente VIP');

      // XSD order: RNCComprador → RazonSocialComprador → ContactoComprador → CorreoComprador
      // → DireccionComprador → MunicipioComprador → ProvinciaComprador → FechaEntrega
      // → ContactoEntrega → DireccionEntrega → TelefonoAdicional → FechaOrdenCompra
      // → NumeroOrdenCompra → CodigoInternoComprador → ResponsablePago → InformacionAdicionalComprador
      expect(tagBefore(xml, 'RazonSocialComprador', 'ContactoComprador')).toBe(true);
      expect(tagBefore(xml, 'ContactoComprador', 'CorreoComprador')).toBe(true);
      expect(tagBefore(xml, 'CorreoComprador', 'DireccionComprador')).toBe(true);
      expect(tagBefore(xml, 'DireccionComprador', 'MunicipioComprador')).toBe(true);
      expect(tagBefore(xml, 'MunicipioComprador', 'ProvinciaComprador')).toBe(true);
      expect(tagBefore(xml, 'ProvinciaComprador', 'FechaEntrega')).toBe(true);
      expect(tagBefore(xml, 'FechaEntrega', 'ContactoEntrega')).toBe(true);
      expect(tagBefore(xml, 'ContactoEntrega', 'DireccionEntrega')).toBe(true);
      expect(tagBefore(xml, 'DireccionEntrega', 'TelefonoAdicional')).toBe(true);
      expect(tagBefore(xml, 'TelefonoAdicional', 'FechaOrdenCompra')).toBe(true);
      expect(tagBefore(xml, 'FechaOrdenCompra', 'NumeroOrdenCompra')).toBe(true);
      expect(tagBefore(xml, 'NumeroOrdenCompra', 'CodigoInternoComprador')).toBe(true);
      expect(tagBefore(xml, 'CodigoInternoComprador', 'ResponsablePago')).toBe(true);
      expect(tagBefore(xml, 'ResponsablePago', 'InformacionAdicionalComprador')).toBe(true);
    });
  });

  // ============================================================
  // E. TOTALES TESTS
  // ============================================================

  describe('Totales Section', () => {
    it('should emit MontoGravadoTotal', () => {
      const input = makeInput('E31');
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');
      expect(hasTag(xml, 'MontoGravadoTotal')).toBe(true);
    });

    it('should emit MontoGravadoI1 for 18% items', () => {
      const input = makeInput('E31', { items: [basicItem({ itbisRate: 18 })] });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');
      expect(hasTag(xml, 'MontoGravadoI1')).toBe(true);
      expect(tagContent(xml, 'MontoGravadoI1')).toBe('1000.00');
    });

    it('should emit ITBIS1 rate value (18) when there are 18% items', () => {
      const input = makeInput('E31');
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');
      expect(tagContent(xml, 'ITBIS1')).toBe('18');
    });

    it('should emit TotalITBIS and TotalITBIS1 for 18% items', () => {
      const input = makeInput('E31', { items: [basicItem({ unitPrice: 1000, itbisRate: 18 })] });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');
      expect(tagContent(xml, 'TotalITBIS')).toBe('180.00');
      expect(tagContent(xml, 'TotalITBIS1')).toBe('180.00');
    });

    it('should emit MontoExento for exempt items', () => {
      const input = makeInput('E31', { items: [exemptItem()] });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');
      expect(hasTag(xml, 'MontoExento')).toBe(true);
    });

    it('should emit MontoTotal', () => {
      const input = makeInput('E31');
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');
      expect(hasTag(xml, 'MontoTotal')).toBe(true);
    });

    it('should follow XSD order in Totales', () => {
      const input = makeInput('E31', {
        items: [basicItem(), exemptItem()],
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');

      expect(tagBefore(xml, 'MontoGravadoTotal', 'MontoGravadoI1')).toBe(true);
      expect(tagBefore(xml, 'MontoExento', 'ITBIS1')).toBe(true);
      expect(tagBefore(xml, 'TotalITBIS', 'MontoTotal')).toBe(true);
    });

    it('should emit ISC fields in Totales when ISC items exist', () => {
      const input = makeInput('E31', {
        items: [basicItem({
          additionalTaxCode: '006',
          additionalTaxRate: 10,
          alcoholDegrees: 40,
          referenceQuantity: 1,
          subQuantity: 0.75,
          referenceUnitPrice: 100,
        })],
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');
      // Check ISC fields exist in Totales (not just in Item)
      const totalesSection = xml.substring(xml.indexOf('<Totales>'), xml.indexOf('</Totales>'));
      expect(totalesSection).toContain('MontoImpuestoAdicional');
    });

    it('should NOT emit TotalDescuento (does not exist in any XSD Totales section)', () => {
      const input = makeInput('E31', {
        items: [basicItem({ discount: 50 })],
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');
      const totalesSection = xml.substring(xml.indexOf('<Totales>'), xml.indexOf('</Totales>'));
      expect(totalesSection).not.toContain('TotalDescuento');
    });

    it('should emit retention fields for E41', () => {
      const input = makeInput('E41', {
        retention: { itbisRetenido: 180, isrRetencion: 100 },
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E410000000001');
      expect(tagContent(xml, 'TotalITBISRetenido')).toBe('180.00');
      expect(tagContent(xml, 'TotalISRRetencion')).toBe('100.00');
    });

    it('should NOT emit retention fields when value is 0 (no retention performed)', () => {
      const input = makeInput('E41', {
        retention: { itbisRetenido: 0, isrRetencion: 0 },
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E410000000001');
      expect(hasTag(xml, 'TotalITBISRetenido')).toBe(false);
      expect(hasTag(xml, 'TotalISRRetencion')).toBe(false);
    });

    it('should format amounts with exactly 2 decimals', () => {
      const input = makeInput('E31', {
        items: [basicItem({ unitPrice: 1000.5 })],
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');
      const total = tagContent(xml, 'MontoTotal');
      expect(total).toMatch(/^\d+\.\d{2}$/);
    });
  });

  // ============================================================
  // F. DETALLES ITEMS TESTS
  // ============================================================

  describe('DetallesItems Section', () => {
    it('should wrap items in DetallesItems (with s)', () => {
      const input = makeInput('E31');
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');
      expect(xml).toContain('<DetallesItems>');
      expect(xml).toContain('</DetallesItems>');
    });

    it('should emit NumeroLinea starting from 1', () => {
      const input = makeInput('E31', {
        items: [basicItem(), basicItem({ description: 'Item 2' })],
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');
      const items = getItems(xml);
      expect(items.length).toBe(2);
      expect(items[0]).toContain('<NumeroLinea>1</NumeroLinea>');
      expect(items[1]).toContain('<NumeroLinea>2</NumeroLinea>');
    });

    it('should emit TablaCodigosItem with TipoCodigo and CodigoItem', () => {
      const input = makeInput('E31', { items: [basicItem({ code: 'ABC-123' })] });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');
      expect(xml).toContain('<TablaCodigosItem>');
      expect(xml).toContain('<TipoCodigo>');
      expect(xml).toContain('<CodigoItem>ABC-123</CodigoItem>');
    });

    it('should emit IndicadorBienoServicio', () => {
      const input = makeInput('E31');
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');
      expect(hasTag(xml, 'IndicadorBienoServicio')).toBe(true);
    });

    it('should emit DescripcionItem when longDescription is provided', () => {
      const input = makeInput('E31', {
        items: [basicItem({ longDescription: 'Descripción extendida del servicio de consultoría' })],
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');
      expect(hasTag(xml, 'DescripcionItem')).toBe(true);
    });

    it('should NOT emit TasaITBIS/MontoITBIS for E41 items (XSD restriction)', () => {
      const input = makeInput('E41');
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E410000000001');
      const items = getItems(xml);
      expect(items[0]).not.toContain('<TasaITBIS>');
      expect(items[0]).not.toContain('<MontoITBIS>');
    });

    it('should NOT emit TasaITBIS/MontoITBIS for E43 items', () => {
      const input = makeInput('E43', { buyer: consumerBuyer });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E430000000001');
      const items = getItems(xml);
      expect(items[0]).not.toContain('<TasaITBIS>');
    });

    it('should NOT emit TasaITBIS/MontoITBIS for E47 items', () => {
      const input = makeInput('E47', {
        buyer: { name: 'Foreign Co', type: 3, foreignId: 'FC-001' },
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E470000000001');
      const items = getItems(xml);
      expect(items[0]).not.toContain('<TasaITBIS>');
    });

    it('should NOT emit TasaITBIS/MontoITBIS for any items (not in XSD Item section)', () => {
      const input = makeInput('E31');
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');
      const items = getItems(xml);
      expect(items[0]).not.toContain('<TasaITBIS>');
      expect(items[0]).not.toContain('<MontoITBIS>');
    });

    it('should emit Retencion block for E41 items', () => {
      const input = makeInput('E41', {
        items: [basicItem({
          retencionIndicador: 1,
          montoItbisRetenido: 180,
          montoIsrRetenido: 100,
        })],
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E410000000001');
      const items = getItems(xml);
      expect(items[0]).toContain('<Retencion>');
      expect(items[0]).toContain('<IndicadorAgenteRetencionoPercepcion>');
    });

    it('should follow XSD item field order', () => {
      const input = makeInput('E31', {
        items: [basicItem({ longDescription: 'Extended description' })],
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');
      const items = getItems(xml);
      const item = items[0];

      // XSD order: NumeroLinea → TablaCodigosItem → IndicadorFacturacion → NombreItem →
      //            IndicadorBienoServicio → DescripcionItem → CantidadItem → UnidadMedida →
      //            PrecioUnitarioItem → DescuentoMonto → TasaITBIS → MontoITBIS → MontoItem
      expect(tagBefore(item, 'NumeroLinea', 'NombreItem')).toBe(true);
      expect(tagBefore(item, 'NombreItem', 'CantidadItem')).toBe(true);
      expect(tagBefore(item, 'CantidadItem', 'PrecioUnitarioItem')).toBe(true);
      expect(tagBefore(item, 'PrecioUnitarioItem', 'MontoItem')).toBe(true);
    });

    it('should format PrecioUnitarioItem with EXACTLY 4 decimals (DGII cert strict)', () => {
      // DGII certification requires fixed 4 decimals (not "up to 4"). Stripping
      // trailing zeros leads to "5.00" vs DGII's expected "5.0000" mismatch.
      const input = makeInput('E31', {
        items: [basicItem({ unitPrice: 100 })],
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');
      expect(tagContent(xml, 'PrecioUnitarioItem')).toBe('100.0000');
    });

    it('should format PrecioUnitarioItem 1500 as 1500.0000', () => {
      const input = makeInput('E31', { items: [basicItem({ unitPrice: 1500 })] });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');
      expect(tagContent(xml, 'PrecioUnitarioItem')).toBe('1500.0000');
    });

    it('should preserve actual decimals when present (123.4567 → 123.4567)', () => {
      const input = makeInput('E31', { items: [basicItem({ unitPrice: 123.4567 })] });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');
      expect(tagContent(xml, 'PrecioUnitarioItem')).toBe('123.4567');
    });

    it('should format CantidadItem with EXACTLY 2 decimals (DGII cert strict)', () => {
      const input = makeInput('E31', { items: [basicItem({ quantity: 20 })] });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');
      expect(tagContent(xml, 'CantidadItem')).toBe('20.00');
    });

    it('should format CantidadItem 100 as 100.00', () => {
      const input = makeInput('E31', { items: [basicItem({ quantity: 100 })] });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');
      expect(tagContent(xml, 'CantidadItem')).toBe('100.00');
    });
  });

  // ============================================================
  // G. OTRAMONEDA TESTS
  // ============================================================

  describe('OtraMoneda Section', () => {
    it('should NOT emit OtraMoneda for DOP', () => {
      const input = makeInput('E31');
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');
      expect(hasTag(xml, 'OtraMoneda')).toBe(false);
    });

    it('should emit OtraMoneda with full breakdown for USD', () => {
      const input = makeInput('E31', {
        currency: { code: 'USD', exchangeRate: 58.50 },
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');

      expect(hasTag(xml, 'OtraMoneda')).toBe(true);
      expect(tagContent(xml, 'TipoMoneda')).toBe('USD');
      expect(hasTag(xml, 'TipoCambio')).toBe(true);
      expect(hasTag(xml, 'MontoGravadoTotalOtraMoneda')).toBe(true);
      expect(hasTag(xml, 'MontoGravado1OtraMoneda')).toBe(true);
      expect(hasTag(xml, 'TotalITBISOtraMoneda')).toBe(true);
      expect(hasTag(xml, 'TotalITBIS1OtraMoneda')).toBe(true);
      expect(hasTag(xml, 'MontoTotalOtraMoneda')).toBe(true);
    });

    it('should emit MontoExentoOtraMoneda when exempt items exist', () => {
      const input = makeInput('E31', {
        items: [exemptItem()],
        currency: { code: 'USD', exchangeRate: 58.50 },
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');
      expect(hasTag(xml, 'MontoExentoOtraMoneda')).toBe(true);
    });

    it('should format TipoCambio with EXACTLY 4 decimals (DGII cert strict)', () => {
      // DGII rejected "56.3" expecting "56.3000"
      const input = makeInput('E31', {
        currency: { code: 'USD', exchangeRate: 56.3 },
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');
      expect(tagContent(xml, 'TipoCambio')).toBe('56.3000');
    });
  });

  // ============================================================
  // H. DESCUENTOS O RECARGOS TESTS
  // ============================================================

  describe('DescuentosORecargos Section', () => {
    it('should emit DescuentosORecargos when discounts exist', () => {
      const input = makeInput('E31', {
        discountsOrSurcharges: [{
          isDiscount: true,
          description: 'Descuento por volumen',
          amount: 100,
          percentage: 10,
        }],
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');
      expect(xml).toContain('<DescuentosORecargos>');
      expect(xml).toContain('<DescuentoORecargo>');
    });

    it('should NOT emit DescuentosORecargos when none exist', () => {
      const input = makeInput('E31');
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');
      expect(hasTag(xml, 'DescuentosORecargos')).toBe(false);
    });
  });

  // ============================================================
  // I. INFORMACION REFERENCIA TESTS
  // ============================================================

  describe('InformacionReferencia Section', () => {
    it('should emit InformacionReferencia for E33 (Nota Débito)', () => {
      const input = makeInput('E33', {
        reference: { encf: 'E310000000001', date: '15-01-2025', modificationCode: 3 },
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E330000000001');
      expect(xml).toContain('<InformacionReferencia>');
      expect(tagContent(xml, 'NCFModificado')).toBe('E310000000001');
      expect(tagContent(xml, 'CodigoModificacion')).toBe('3');
    });

    it('should emit InformacionReferencia for E34 (Nota Crédito)', () => {
      const input = makeInput('E34', {
        reference: {
          encf: 'E310000000099',
          date: '10-01-2025',
          modificationCode: 1,
        },
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E340000000001');
      expect(xml).toContain('<InformacionReferencia>');
      expect(tagContent(xml, 'CodigoModificacion')).toBe('1');
    });

    it('should emit RNCOtroContribuyente when provided', () => {
      const input = makeInput('E34', {
        reference: {
          encf: 'E310000000001',
          date: '01-01-2025',
          modificationCode: 1,
          rncOtroContribuyente: '987654321',
        },
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E340000000001');
      expect(tagContent(xml, 'RNCOtroContribuyente')).toBe('987654321');
    });

    it('should NOT emit InformacionReferencia for E31', () => {
      const input = makeInput('E31');
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');
      expect(hasTag(xml, 'InformacionReferencia')).toBe(false);
    });
  });

  // ============================================================
  // J. E46 EXPORTACIONES TESTS
  // ============================================================

  describe('E46 Exportaciones', () => {
    it('Fix 4i: omits empty <InformacionesAdicionales> wrapper entirely', () => {
      // Pre-Fix 4i bug: when additionalInfo was an empty object (or all its
      // values were falsy), the builder still emitted
      //   <InformacionesAdicionales>\n    </InformacionesAdicionales>
      // which is XSD-invalid. DGII rejected E460000000009/10 with the
      // generic "El formato del XML no es válido". The wrapper must be
      // skipped when there's nothing to put in it.
      const input = makeInput('E46', {
        buyer: { ...basicBuyer, country: 'US' },
        additionalInfo: {} as any, // all fields empty
        transport: {
          viaTransporte: 1,
          countryDestination: 'US',
        },
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E460000000001');
      expect(xml).not.toContain('<InformacionesAdicionales>');
      expect(xml).not.toContain('</InformacionesAdicionales>');
    });

    it('should emit InformacionesAdicionales with export fields', () => {
      const input = makeInput('E46', {
        buyer: { ...basicBuyer, country: 'United States' },
        additionalInfo: {
          portOfShipment: 'Puerto Caucedo',
          deliveryConditions: 'FOB',
          totalFob: 5000,
          insurance: 200,
          freight: 500,
          totalCif: 5700,
          customsRegime: 'Exportación Definitiva',
        },
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E460000000001');

      expect(hasTag(xml, 'InformacionesAdicionales')).toBe(true);
      expect(tagContent(xml, 'NombrePuertoEmbarque')).toBe('Puerto Caucedo');
      expect(tagContent(xml, 'CondicionesEntrega')).toBe('FOB');
      expect(tagContent(xml, 'TotalFob')).toBe('5000.00');
      expect(tagContent(xml, 'Seguro')).toBe('200.00');
      expect(tagContent(xml, 'Flete')).toBe('500.00');
      expect(tagContent(xml, 'TotalCif')).toBe('5700.00');
    });

    it('should emit Transporte with via and destination', () => {
      const input = makeInput('E46', {
        buyer: { ...basicBuyer, country: 'US' },
        transport: {
          viaTransporte: 2, // Marítimo
          countryOrigin: 'República Dominicana',
          countryDestination: 'United States',
          carrierName: 'Maersk Line',
        },
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E460000000001');

      expect(hasTag(xml, 'Transporte')).toBe(true);
      expect(tagContent(xml, 'ViaTransporte')).toBe('02');
      expect(tagContent(xml, 'PaisOrigen')).toBe('República Dominicana');
      expect(tagContent(xml, 'PaisDestino')).toBe('United States');
    });

    it('should pad ViaTransporte to 2 digits', () => {
      const input = makeInput('E46', {
        buyer: { ...basicBuyer, country: 'US' },
        transport: { viaTransporte: 3 }, // Aérea
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E460000000001');
      expect(tagContent(xml, 'ViaTransporte')).toBe('03');
    });
  });

  // ============================================================
  // K. TOTALS CALCULATION TESTS
  // ============================================================

  describe('Totals Calculation', () => {
    it('should calculate correct totals for single 18% item', () => {
      const input = makeInput('E31', {
        items: [basicItem({ quantity: 2, unitPrice: 500, itbisRate: 18 })],
      });
      const { totals } = service.buildEcfXml(input, mockEmitter, 'E310000000001');

      expect(totals.taxableAmount18).toBe(1000);
      expect(totals.itbis18).toBe(180);
      expect(totals.totalItbis).toBe(180);
      expect(totals.totalAmount).toBe(1180);
    });

    it('should calculate correct totals for mixed taxable/exempt items', () => {
      const input = makeInput('E31', {
        items: [
          basicItem({ quantity: 1, unitPrice: 1000, itbisRate: 18 }),
          exemptItem({ quantity: 1, unitPrice: 500, indicadorFacturacion: 4 }),
        ],
      });
      const { totals } = service.buildEcfXml(input, mockEmitter, 'E310000000001');

      expect(totals.taxableAmount18).toBe(1000);
      expect(totals.exemptAmount).toBe(500);
      expect(totals.itbis18).toBe(180);
      expect(totals.totalAmount).toBe(1680);
    });

    it('should handle items with discount', () => {
      const input = makeInput('E31', {
        items: [basicItem({ quantity: 1, unitPrice: 1000, itbisRate: 18, discount: 100 })],
      });
      const { totals } = service.buildEcfXml(input, mockEmitter, 'E310000000001');

      expect(totals.taxableAmount18).toBe(900); // 1000 - 100
      expect(totals.itbis18).toBe(162); // 900 * 0.18
      expect(totals.totalAmount).toBe(1062); // 900 + 162
    });

    it('should return totals in result object', () => {
      const input = makeInput('E31');
      const result = service.buildEcfXml(input, mockEmitter, 'E310000000001');

      expect(result).toHaveProperty('xml');
      expect(result).toHaveProperty('totals');
      expect(typeof result.xml).toBe('string');
      expect(typeof result.totals.totalAmount).toBe('number');
    });
  });

  // ============================================================
  // L. XML ESCAPING TESTS
  // ============================================================

  describe('XML Escaping', () => {
    it('should escape ampersand in buyer name', () => {
      const input = makeInput('E31', {
        buyer: { ...basicBuyer, name: 'Johnson & Johnson SRL' },
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');
      expect(xml).toContain('Johnson &amp; Johnson SRL');
      expect(xml).not.toContain('Johnson & Johnson SRL</');
    });

    it('should escape < and > in descriptions', () => {
      const input = makeInput('E31', {
        items: [basicItem({ description: 'Item <special>' })],
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');
      expect(xml).toContain('Item &lt;special&gt;');
    });
  });

  // ============================================================
  // M. ALL 10 E-CF TYPES SMOKE TEST
  // ============================================================

  describe('All 10 e-CF Types Smoke Test', () => {
    const typeConfigs: Array<{
      type: string;
      buyer: BuyerInput;
      reference?: any;
      extra?: Partial<InvoiceInput>;
    }> = [
      { type: 'E31', buyer: basicBuyer },
      { type: 'E32', buyer: consumerBuyer },
      { type: 'E33', buyer: basicBuyer, reference: { encf: 'E310000000001', date: '01-01-2025', modificationCode: 3 } },
      { type: 'E34', buyer: basicBuyer, reference: { encf: 'E310000000001', date: '01-01-2025', modificationCode: 1 } },
      { type: 'E41', buyer: basicBuyer },
      { type: 'E43', buyer: consumerBuyer },
      { type: 'E44', buyer: { ...basicBuyer, type: 2, foreignId: 'DIPL-001' } },
      { type: 'E45', buyer: basicBuyer },
      { type: 'E46', buyer: { ...basicBuyer, country: 'US' } },
      { type: 'E47', buyer: { name: 'Foreign LLC', type: 3, foreignId: 'FC-999' } },
    ];

    for (const config of typeConfigs) {
      it(`should generate valid XML for ${config.type}`, () => {
        const input = makeInput(config.type, {
          buyer: config.buyer,
          reference: config.reference,
          ...config.extra,
        });
        const encf = `${config.type.replace('E', 'E')}0000000001`;

        expect(() => {
          const { xml, totals } = service.buildEcfXml(input, mockEmitter, encf);
          // Basic validity checks
          expect(xml).toContain('<?xml');
          expect(xml).toContain('<ECF');
          expect(xml).toContain('</ECF>');
          expect(xml).toContain('<Version>1.0</Version>');
          expect(tagContent(xml, 'TipoeCF')).toBe(config.type.replace('E', ''));
          expect(totals.totalAmount).toBeGreaterThan(0);
        }).not.toThrow();
      });
    }
  });

  // ============================================================
  // N. RFCE TESTS
  // ============================================================

  describe('RFCE (Resumen Factura Consumo < 250K)', () => {
    const mockEmitterRfce = {
      rnc: '133158744',
      businessName: 'TEST EMPRESA SRL',
      address: 'Calle Test #1',
    };
    const baseTotals = {
      taxableAmount18: 1000,
      taxableAmount16: 0,
      taxableAmount0: 0,
      exemptAmount: 0,
      itbis18: 180,
      itbis16: 0,
      itbis0: 0,
      totalItbis: 180,
      totalIsc: 0,
      totalOtrosImpuestos: 0,
      totalAmount: 1180,
      montoNoFacturable: 0,
      additionalTaxEntries: [],
      toleranciaGlobal: 1,
    };

    it('should have buildRfceXml method available', () => {
      expect(typeof service.buildRfceXml).toBe('function');
    });

    it('Fix 4i: emits full RFCE structure with Encabezado/IdDoc/Emisor/Totales', () => {
      const input = makeInput('E32', {
        buyer: { rnc: '131880681', name: 'Cliente SRL' },
      });
      const xml = service.buildRfceXml(input, mockEmitterRfce, 'E320000000011', baseTotals as any, 'F5E5DE');

      // Top-level structure
      expect(xml).toContain('<RFCE');
      expect(xml).toContain('<Encabezado>');
      expect(xml).toContain('<Version>1.0</Version>');
      expect(xml).toContain('<IdDoc>');
      expect(xml).toContain('<Emisor>');
      expect(xml).toContain('<Totales>');
      expect(xml).toContain('<CodigoSeguridadeCF>F5E5DE</CodigoSeguridadeCF>');
      expect(xml).toContain('<CantidadeNCF>1</CantidadeNCF>');
      expect(xml).toContain('</RFCE>');
    });

    it('Fix 4i: emits TipoeCF, eNCF, TipoIngresos, TipoPago in IdDoc', () => {
      const input = makeInput('E32', {
        buyer: { rnc: '131880681', name: 'X' },
      });
      const xml = service.buildRfceXml(input, mockEmitterRfce, 'E320000000011', baseTotals as any, 'ABC123');
      expect(xml).toContain('<TipoeCF>32</TipoeCF>');
      expect(xml).toContain('<eNCF>E320000000011</eNCF>');
      expect(xml).toContain('<TipoIngresos>01</TipoIngresos>');
      expect(xml).toContain('<TipoPago>1</TipoPago>');
    });

    it('Fix 4i: emits TablaFormasPago for TipoPago=1', () => {
      const input = makeInput('E32', {
        buyer: { rnc: '131880681', name: 'X' },
        payment: { type: 1, method: 1 },
      });
      const xml = service.buildRfceXml(input, mockEmitterRfce, 'E320000000011', baseTotals as any, 'ABC');
      expect(xml).toContain('<TablaFormasPago>');
      expect(xml).toContain('<FormaPago>1</FormaPago>');
      expect(xml).toContain('<MontoPago>1180.00</MontoPago>');
    });

    it('Fix 4i: respects payment.forms[] for multi-form payments', () => {
      const input = makeInput('E32', {
        buyer: { rnc: '131880681', name: 'X' },
        payment: {
          type: 1,
          forms: [
            { method: 1, amount: 500, rawText: { MontoPago: '500.00' } },
            { method: 3, amount: 680, rawText: { MontoPago: '680.00' } },
          ],
        },
      } as any);
      const xml = service.buildRfceXml(input, mockEmitterRfce, 'E320000000011', baseTotals as any, 'ABC');
      const formaCount = (xml.match(/<FormaDePago>/g) || []).length;
      expect(formaCount).toBe(2);
      expect(xml).toContain('<MontoPago>500.00</MontoPago>');
      expect(xml).toContain('<MontoPago>680.00</MontoPago>');
    });

    it('Fix 4i: emits Comprador when buyer.rnc is present', () => {
      const input = makeInput('E32', {
        buyer: { rnc: '131880681', name: 'Cliente Final' },
      });
      const xml = service.buildRfceXml(input, mockEmitterRfce, 'E320000000011', baseTotals as any, 'ABC');
      expect(xml).toContain('<Comprador>');
      expect(xml).toContain('<RNCComprador>131880681</RNCComprador>');
      expect(xml).toContain('<RazonSocialComprador>Cliente Final</RazonSocialComprador>');
    });

    it('Fix 4i: omits Comprador when buyer has neither rnc nor foreignId nor name', () => {
      const input = makeInput('E32', {
        buyer: {} as any,
      });
      const xml = service.buildRfceXml(input, mockEmitterRfce, 'E320000000011', baseTotals as any, 'ABC');
      expect(xml).not.toContain('<Comprador>');
    });

    it('Fix 4i: honors totalsRawText for verbatim total emission', () => {
      const input = makeInput('E32', {
        buyer: { rnc: '131880681', name: 'X' },
        totalsRawText: {
          MontoGravadoTotal: '34000.00',
          MontoGravadoI1: '34000.00',
          ITBIS1: '18',
          TotalITBIS: '6120.00',
          TotalITBIS1: '6120.00',
          MontoTotal: '40120.00',
        },
      } as any);
      const xml = service.buildRfceXml(input, mockEmitterRfce, 'E320000000011', baseTotals as any, 'ABC');
      expect(tagContent(xml, 'MontoGravadoTotal')).toBe('34000.00');
      expect(tagContent(xml, 'MontoGravadoI1')).toBe('34000.00');
      expect(tagContent(xml, 'TotalITBIS')).toBe('6120.00');
      expect(tagContent(xml, 'MontoTotal')).toBe('40120.00');
    });

    it('Fix 4i: MontoTotal is always emitted (XSD obligatorio)', () => {
      const input = makeInput('E32', { buyer: { rnc: '131880681', name: 'X' } });
      const xml = service.buildRfceXml(input, mockEmitterRfce, 'E320000000011', baseTotals as any, 'ABC');
      expect(xml).toContain('<MontoTotal>');
    });

    it('Fix 4i: RFCE XML lacks the old pre-Fix 4i flat structure', () => {
      // Regression guard: ensure we did NOT keep the previous incomplete shape.
      const input = makeInput('E32', { buyer: { rnc: '131880681', name: 'X' } });
      const xml = service.buildRfceXml(input, mockEmitterRfce, 'E320000000011', baseTotals as any, 'ABC');
      // Old RFCE had RNCEmisor as a top-level child of <RFCE> (no <Encabezado>).
      // The new schema-compliant version places it inside <Encabezado>/<Emisor>.
      const matchTop = xml.match(/<RFCE[^>]*>\s*<RNCEmisor>/);
      expect(matchTop).toBeNull();
    });

    it('Fix 4i: emits Emisor with all three required fields', () => {
      const input = makeInput('E32', { buyer: { rnc: '131880681', name: 'X' } });
      const xml = service.buildRfceXml(input, mockEmitterRfce, 'E320000000011', baseTotals as any, 'ABC');
      expect(xml).toContain('<RNCEmisor>133158744</RNCEmisor>');
      expect(xml).toContain('<RazonSocialEmisor>TEST EMPRESA SRL</RazonSocialEmisor>');
      expect(xml).toContain('<FechaEmision>');
    });
  });

  // ============================================================
  // O. E47 XSD COMPLIANCE (certification fixes)
  // ============================================================

  describe('E47 XSD Compliance', () => {
    const e47Buyer: BuyerInput = { name: 'Foreign Corp Ltd', foreignId: 'US-TAX-123456' };

    const e47Item = (overrides?: Partial<InvoiceItemInput>): InvoiceItemInput => ({
      description: 'Honorarios profesionales al exterior',
      quantity: 1,
      unitPrice: 5000,
      itbisRate: 0,
      indicadorFacturacion: 4, // Exento
      retencionIndicador: 1,
      goodService: 2,
      ...overrides,
    });

    function makeE47(overrides?: Partial<InvoiceInput>): InvoiceInput {
      return {
        companyId: 'test-company-id',
        ecfType: 'E47',
        buyer: e47Buyer,
        items: [e47Item()],
        payment: { type: 1 },
        ...overrides,
      };
    }

    // -- FIX 1: buildTransporte --

    it('E47 Transporte with countryDestination → emits only <PaisDestino>', () => {
      const input = makeE47({
        transport: {
          countryDestination: 'United States',
          conductor: 'Juan Perez',        // must NOT appear in E47
          placa: 'ABC-1234',              // must NOT appear in E47
          numeroAlbaran: 'ALBN-001',      // must NOT appear in E47
        },
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E470000000001');

      expect(hasTag(xml, 'Transporte')).toBe(true);
      expect(tagContent(xml, 'PaisDestino')).toBe('United States');
      expect(xml).not.toContain('<Conductor>');
      expect(xml).not.toContain('<Placa>');
      expect(xml).not.toContain('<NumeroAlbaran>');
      expect(xml).not.toContain('<RutaTransporte>');
      expect(xml).not.toContain('<ZonaTransporte>');
    });

    it('E47 Transporte without countryDestination → no <Transporte> emitted', () => {
      const input = makeE47({
        transport: {
          conductor: 'Juan Perez', // only field but NOT PaisDestino
        },
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E470000000001');
      expect(xml).not.toContain('<Transporte>');
    });

    it('E47 without transport in DTO → no <Transporte> emitted', () => {
      const input = makeE47(); // no transport field
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E470000000001');
      expect(xml).not.toContain('<Transporte>');
    });

    // -- FIX 2: MontoISRRetenido always emitted for E47 --

    it('E47 Retencion without montoIsrRetenido → emits <MontoISRRetenido>0</MontoISRRetenido>', () => {
      const input = makeE47({
        items: [e47Item({ retencionIndicador: 1 })], // no montoIsrRetenido
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E470000000001');

      expect(xml).toContain('<Retencion>');
      expect(xml).toContain('<MontoISRRetenido>0.00</MontoISRRetenido>');
    });

    it('E47 Retencion with montoIsrRetenido → emits the actual value', () => {
      const input = makeE47({
        items: [e47Item({ retencionIndicador: 1, montoIsrRetenido: 750 })],
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E470000000001');

      expect(xml).toContain('<MontoISRRetenido>750.00</MontoISRRetenido>');
    });

    it('E47 Retencion does NOT emit MontoITBISRetenido (not allowed per XSD)', () => {
      const input = makeE47({
        items: [e47Item({ retencionIndicador: 1, montoItbisRetenido: 100, montoIsrRetenido: 750 })],
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E470000000001');

      expect(xml).not.toContain('<MontoITBISRetenido>');
      expect(xml).toContain('<MontoISRRetenido>750.00</MontoISRRetenido>');
    });

    // -- FIX 3: buildOtraMoneda restricted to 4 fields for E47 --

    it('E47 OtraMoneda emits ONLY TipoMoneda, TipoCambio, MontoExentoOtraMoneda, MontoTotalOtraMoneda', () => {
      const input = makeE47({
        currency: { code: 'USD', exchangeRate: 59.5 },
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E470000000001');

      expect(hasTag(xml, 'OtraMoneda')).toBe(true);
      expect(tagContent(xml, 'TipoMoneda')).toBe('USD');
      expect(tagContent(xml, 'TipoCambio')).toBeTruthy();

      // Must NOT have ITBIS, gravado, or ImpuestosAdicionales fields in OtraMoneda
      expect(xml).not.toContain('<MontoGravadoTotalOtraMoneda>');
      expect(xml).not.toContain('<TotalITBISOtraMoneda>');
      expect(xml).not.toContain('<MontoGravado1OtraMoneda>');
      expect(xml).not.toContain('<ImpuestosAdicionalesOtraMoneda>');

      // Must have MontoTotalOtraMoneda
      expect(hasTag(xml, 'MontoTotalOtraMoneda')).toBe(true);
    });

    it('E47 OtraMoneda with exempt items → emits MontoExentoOtraMoneda', () => {
      const input = makeE47({
        items: [e47Item({ unitPrice: 5000, indicadorFacturacion: 4 })], // exento
        currency: { code: 'USD', exchangeRate: 59.5 },
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E470000000001');

      expect(hasTag(xml, 'MontoExentoOtraMoneda')).toBe(true);
    });

    it('E32 OtraMoneda (control) → still emits gravado and ITBIS fields', () => {
      const input = makeInput('E32', {
        buyer: consumerBuyer,
        items: [basicItem({ itbisRate: 18, unitPrice: 1000 })],
        currency: { code: 'USD', exchangeRate: 59.5 },
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E320000000001');

      expect(hasTag(xml, 'OtraMoneda')).toBe(true);
      expect(hasTag(xml, 'MontoGravadoTotalOtraMoneda')).toBe(true);
      expect(hasTag(xml, 'TotalITBISOtraMoneda')).toBe(true);
    });

    // -- FIX 5 (Paginacion complex element) --

    it('Paginacion SubtotalImpuestoAdicional emits complex element when ISC fields provided', () => {
      const input = makeInput('E31', {
        paginacion: [{
          paginaNo: 1,
          noLineaDesde: 1,
          noLineaHasta: 5,
          montoSubtotalPagina: 5000,
          subtotalIscEspecificoPagina: 150,
          subtotalOtrosImpuestoPagina: 80,
        }],
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');

      expect(hasTag(xml, 'SubtotalImpuestoAdicional')).toBe(true);
      expect(xml).toContain('<SubtotalImpuestoSelectivoConsumoEspecificoPagina>150.00</SubtotalImpuestoSelectivoConsumoEspecificoPagina>');
      expect(xml).toContain('<SubtotalOtrosImpuesto>80.00</SubtotalOtrosImpuesto>');
    });

    it('Paginacion without ISC fields → no SubtotalImpuestoAdicional complex element', () => {
      const input = makeInput('E31', {
        paginacion: [{
          paginaNo: 1,
          noLineaDesde: 1,
          noLineaHasta: 5,
          montoSubtotalPagina: 5000,
        }],
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');

      expect(hasTag(xml, 'SubtotalImpuestoAdicional')).toBe(false);
    });

    it('Paginacion SubtotalImpuestoAdicionalPagina (simple) still emits correctly', () => {
      const input = makeInput('E31', {
        paginacion: [{
          paginaNo: 1,
          noLineaDesde: 1,
          noLineaHasta: 5,
          montoSubtotalPagina: 5000,
          subtotalImpuestoAdicionalPagina: 250,
        }],
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');

      expect(xml).toContain('<SubtotalImpuestoAdicionalPagina>250.00</SubtotalImpuestoAdicionalPagina>');
    });
  });

  // ─────────────────────────────────────────────────────────────
  // indicadorFacturacion flows from DTO item → XML <IndicadorFacturacion>
  // ─────────────────────────────────────────────────────────────
  describe('indicadorFacturacion in items', () => {
    it('emits <IndicadorFacturacion>4</IndicadorFacturacion> when item has indicadorFacturacion=4', () => {
      const input = makeInput('E32', {
        items: [
          basicItem({ indicadorFacturacion: 4, itbisRate: 0 }),
        ],
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E320000000001');
      expect(xml).toContain('<IndicadorFacturacion>4</IndicadorFacturacion>');
    });

    it('emits <IndicadorFacturacion>1</IndicadorFacturacion> when item has indicadorFacturacion=1', () => {
      const input = makeInput('E32', {
        items: [basicItem({ indicadorFacturacion: 1, itbisRate: 18 })],
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E320000000002');
      expect(xml).toContain('<IndicadorFacturacion>1</IndicadorFacturacion>');
    });
  });
});
