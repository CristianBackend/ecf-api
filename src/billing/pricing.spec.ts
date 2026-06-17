import {
  calculateMonthlyCharge,
  MONTHLY_FEE_USD,
  MIN_BILLED_EMISSIONS,
  PRICING_RANGES,
} from './pricing';

describe('pricing.calculateMonthlyCharge — flat-by-range, min 500, $60 fixed', () => {
  // Canonical table of mandatory edge cases. total/emissionsCost are null in the
  // quote-only range (10001..100000). monthlyFee is always 60.
  const cases: Array<{
    accepted: number;
    billed: number;
    price: number | null;
    emissionsCost: number | null;
    total: number | null;
    requiresQuote: boolean;
  }> = [
    { accepted: 0, billed: 500, price: 0.06, emissionsCost: 30, total: 90, requiresQuote: false },
    { accepted: 1, billed: 500, price: 0.06, emissionsCost: 30, total: 90, requiresQuote: false },
    { accepted: 499, billed: 500, price: 0.06, emissionsCost: 30, total: 90, requiresQuote: false },
    { accepted: 500, billed: 500, price: 0.06, emissionsCost: 30, total: 90, requiresQuote: false },
    { accepted: 501, billed: 501, price: 0.05, emissionsCost: 25.05, total: 85.05, requiresQuote: false },
    { accepted: 1000, billed: 1000, price: 0.05, emissionsCost: 50, total: 110, requiresQuote: false },
    { accepted: 1001, billed: 1001, price: 0.04, emissionsCost: 40.04, total: 100.04, requiresQuote: false },
    { accepted: 3000, billed: 3000, price: 0.04, emissionsCost: 120, total: 180, requiresQuote: false },
    { accepted: 3001, billed: 3001, price: 0.04, emissionsCost: 120.04, total: 180.04, requiresQuote: false },
    { accepted: 5000, billed: 5000, price: 0.04, emissionsCost: 200, total: 260, requiresQuote: false },
    { accepted: 5001, billed: 5001, price: 0.03, emissionsCost: 150.03, total: 210.03, requiresQuote: false },
    { accepted: 10000, billed: 10000, price: 0.03, emissionsCost: 300, total: 360, requiresQuote: false },
    { accepted: 10001, billed: 10001, price: null, emissionsCost: null, total: null, requiresQuote: true },
    { accepted: 99999, billed: 99999, price: null, emissionsCost: null, total: null, requiresQuote: true },
    { accepted: 100000, billed: 100000, price: null, emissionsCost: null, total: null, requiresQuote: true },
    { accepted: 100001, billed: 100001, price: 0.02, emissionsCost: 2000.02, total: 2060.02, requiresQuote: false },
  ];

  it.each(cases)(
    'accepted=$accepted → billed=$billed, total=$total (quote=$requiresQuote)',
    ({ accepted, billed, price, emissionsCost, total, requiresQuote }) => {
      const r = calculateMonthlyCharge(accepted);
      expect(r.acceptedCount).toBe(accepted);
      expect(r.billedCount).toBe(billed);
      expect(r.monthlyFee).toBe(MONTHLY_FEE_USD);
      expect(r.pricePerEmission).toBe(price);
      expect(r.emissionsCost).toBe(emissionsCost);
      expect(r.total).toBe(total);
      expect(r.requiresQuote).toBe(requiresQuote);
    },
  );

  it('the minimum is exactly 500 and the fixed fee is exactly 60', () => {
    expect(MIN_BILLED_EMISSIONS).toBe(500);
    expect(MONTHLY_FEE_USD).toBe(60);
    // below the minimum everyone pays the same floor: 500 × 0.06 + 60 = 90
    for (const n of [0, 1, 250, 499, 500]) {
      expect(calculateMonthlyCharge(n).total).toBe(90);
    }
  });

  it('FLAT ANOMALY (expected behaviour): emitting ONE more can cost LESS', () => {
    // 1000 lands in 501–1000 @ 0.05 → 1000×0.05 = $50 emissions.
    // 1001 lands in 1001–3000 @ 0.04 → 1001×0.04 = $40.04 emissions.
    // Because the WHOLE billed volume reprices at the lower flat rate, the
    // monthly total DROPS by ~$10 when crossing the boundary. This is the
    // defined flat-by-range behaviour, not a bug.
    const at1000 = calculateMonthlyCharge(1000);
    const at1001 = calculateMonthlyCharge(1001);
    expect(at1000.emissionsCost).toBe(50);
    expect(at1001.emissionsCost).toBe(40.04);
    expect(at1000.total).toBe(110);
    expect(at1001.total).toBe(100.04);
    expect(at1001.total!).toBeLessThan(at1000.total!);
  });

  it('negative / fractional accepted counts are floored to a safe non-negative integer', () => {
    expect(calculateMonthlyCharge(-5).acceptedCount).toBe(0);
    expect(calculateMonthlyCharge(-5).total).toBe(90);
    expect(calculateMonthlyCharge(750.9).acceptedCount).toBe(750);
    expect(calculateMonthlyCharge(750.9).billedCount).toBe(750);
  });

  it('the quote-only range exposes its tier but no auto price/total', () => {
    const r = calculateMonthlyCharge(50000);
    expect(r.requiresQuote).toBe(true);
    expect(r.total).toBeNull();
    expect(r.emissionsCost).toBeNull();
    expect(r.pricePerEmission).toBeNull();
    expect(r.tier).not.toBeNull();
    expect(r.tier!.fromQty).toBe(10001);
  });

  it('PRICING_RANGES is contiguous and covers 1..∞ with exactly the 7 official ranges', () => {
    expect(PRICING_RANGES).toHaveLength(7);
    expect(PRICING_RANGES[0].fromQty).toBe(1);
    expect(PRICING_RANGES[PRICING_RANGES.length - 1].toQty).toBeNull();
    for (let i = 1; i < PRICING_RANGES.length; i++) {
      expect(PRICING_RANGES[i].fromQty).toBe((PRICING_RANGES[i - 1].toQty ?? 0) + 1);
    }
  });
});
