/**
 * CreateInvoiceDto — class-validator integration tests
 *
 * Covers:
 * FIX 3 — transport is required for E46, optional for other types
 * FIX 4 — foreignBeneficiary is required for E47, optional for other types
 */
import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateInvoiceDto } from './invoice.dto';

function basePayload(overrides: Partial<any> = {}): any {
  return {
    companyId: '123e4567-e89b-12d3-a456-426614174000',
    ecfType: 'E31',
    buyer: { rnc: '131234567', name: 'Comprador Test SRL', type: 1 },
    items: [{ description: 'Item', quantity: 1, unitPrice: 1000, itbisRate: 18 }],
    payment: { type: 1 },
    ...overrides,
  };
}

async function validateDto(plain: object) {
  const instance = plainToInstance(CreateInvoiceDto, plain);
  return validate(instance, { whitelist: true });
}

function errorMessages(errors: any[]): string[] {
  const msgs: string[] = [];
  function collect(errs: any[]) {
    for (const e of errs) {
      if (e.constraints) msgs.push(...Object.values(e.constraints as Record<string, string>));
      if (e.children?.length) collect(e.children);
    }
  }
  collect(errors);
  return msgs;
}

// ─────────────────────────────────────────────────────────────
// FIX 3 — transport required for E46
// ─────────────────────────────────────────────────────────────
describe('FIX 3 — transport is required for E46, optional for other types', () => {
  it('E46 without transport → validation error mentioning transport', async () => {
    const errors = await validateDto(basePayload({ ecfType: 'E46', buyer: { name: 'Exportador', type: 1 } }));
    const msgs = errorMessages(errors);
    const hasTransportError = msgs.some(m => m.toLowerCase().includes('transport'));
    expect(hasTransportError).toBe(true);
  });

  it('E46 without additionalInfo → validation error mentioning additionalInfo', async () => {
    const errors = await validateDto(basePayload({
      ecfType: 'E46',
      buyer: { name: 'Exportador', type: 1 },
      transport: { viaTransporte: 2 }, // transport present, additionalInfo absent
    }));
    const msgs = errorMessages(errors);
    const hasAdditionalInfoError = msgs.some(m => m.toLowerCase().includes('additionalinfo'));
    expect(hasAdditionalInfoError).toBe(true);
  });

  it('E46 with both transport and additionalInfo → no transport/additionalInfo errors', async () => {
    const errors = await validateDto(basePayload({
      ecfType: 'E46',
      buyer: { name: 'Exportador', type: 1 },
      transport: { viaTransporte: 2 },
      additionalInfo: { deliveryConditions: 'FOB' },
    }));
    const msgs = errorMessages(errors);
    const hasTransportError = msgs.some(m => m.toLowerCase().includes('transport'));
    const hasAdditionalInfoError = msgs.some(m => m.toLowerCase().includes('additionalinfo'));
    expect(hasTransportError).toBe(false);
    expect(hasAdditionalInfoError).toBe(false);
  });

  it('E31 without transport → no transport validation error', async () => {
    const errors = await validateDto(basePayload({ ecfType: 'E31' }));
    const msgs = errorMessages(errors);
    expect(msgs.some(m => m.toLowerCase().includes('transport'))).toBe(false);
  });

  it('E32 without transport → no transport validation error', async () => {
    const errors = await validateDto(basePayload({
      ecfType: 'E32',
      buyer: { name: 'Consumidor', type: 2 },
    }));
    const msgs = errorMessages(errors);
    expect(msgs.some(m => m.toLowerCase().includes('transport'))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// FIX 4 — foreignBeneficiary required for E47
// ─────────────────────────────────────────────────────────────
describe('FIX 4 — foreignBeneficiary is required for E47, optional for other types', () => {
  it('E47 without foreignBeneficiary → validation error mentioning foreignBeneficiary', async () => {
    const errors = await validateDto(basePayload({
      ecfType: 'E47',
      buyer: { name: 'Pagador', type: 1 },
    }));
    const msgs = errorMessages(errors);
    const hasBeneficiaryError = msgs.some(m => m.toLowerCase().includes('foreignbeneficiary'));
    expect(hasBeneficiaryError).toBe(true);
  });

  it('E47 with foreignBeneficiary → no foreignBeneficiary error', async () => {
    const errors = await validateDto(basePayload({
      ecfType: 'E47',
      buyer: { name: 'Pagador', type: 1 },
      foreignBeneficiary: {
        name: 'Foreign Supplier Inc.',
        country: 'US',
      },
    }));
    const msgs = errorMessages(errors);
    expect(msgs.some(m => m.toLowerCase().includes('foreignbeneficiary'))).toBe(false);
  });

  it('E31 without foreignBeneficiary → no foreignBeneficiary error', async () => {
    const errors = await validateDto(basePayload({ ecfType: 'E31' }));
    const msgs = errorMessages(errors);
    expect(msgs.some(m => m.toLowerCase().includes('foreignbeneficiary'))).toBe(false);
  });

  it('E32 without foreignBeneficiary → no foreignBeneficiary error', async () => {
    const errors = await validateDto(basePayload({
      ecfType: 'E32',
      buyer: { name: 'Consumidor', type: 2 },
    }));
    const msgs = errorMessages(errors);
    expect(msgs.some(m => m.toLowerCase().includes('foreignbeneficiary'))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// indicadorFacturacion field on items
// ─────────────────────────────────────────────────────────────
describe('InvoiceItemDto.indicadorFacturacion', () => {
  it('accepts valid values 0-4 without validation errors', async () => {
    for (const v of [0, 1, 2, 3, 4]) {
      const errors = await validateDto(basePayload({
        items: [{ description: 'X', quantity: 1, unitPrice: 100, indicadorFacturacion: v }],
      }));
      const msgs = errorMessages(errors);
      expect(msgs.some(m => m.toLowerCase().includes('indicadorfacturacion'))).toBe(false);
    }
  });

  it('rejects values outside 0-4', async () => {
    const errors = await validateDto(basePayload({
      items: [{ description: 'X', quantity: 1, unitPrice: 100, indicadorFacturacion: 5 }],
    }));
    const msgs = errorMessages(errors);
    expect(msgs.some(m => m.toLowerCase().includes('indicadorfacturacion'))).toBe(true);
  });

  it('is optional — omitting it produces no error', async () => {
    const errors = await validateDto(basePayload({
      items: [{ description: 'X', quantity: 1, unitPrice: 100 }],
    }));
    const msgs = errorMessages(errors);
    expect(msgs.some(m => m.toLowerCase().includes('indicadorfacturacion'))).toBe(false);
  });
});
