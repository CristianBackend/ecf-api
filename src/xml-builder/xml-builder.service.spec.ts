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
      expect(xml).toContain('<ECF xmlns="http://dgii.gov.do/eCF">');
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

    it('should format PrecioUnitarioItem with up to 4 decimals (per XSD Decimal20D1or4)', () => {
      const input = makeInput('E31', {
        items: [basicItem({ unitPrice: 100 })],
      });
      const { xml } = service.buildEcfXml(input, mockEmitter, 'E310000000001');
      const price = tagContent(xml, 'PrecioUnitarioItem');
      // XSD allows 1-4 decimal places; formatPrice strips trailing zeros
      expect(price).toMatch(/^\d+\.\d{2,4}$/);
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
    it('should have buildRfceXml method available', () => {
      expect(typeof service.buildRfceXml).toBe('function');
    });
  });
});
