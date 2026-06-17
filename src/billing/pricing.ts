/**
 * Billing-v2 pricing engine — PURE, no side effects, no I/O.
 *
 * Model: monthly charge per company = US$60 fixed + (accepted emissions × flat
 * per-range price). FLAT BY RANGE: the TOTAL billed emissions pick exactly one
 * range and ALL of them bill at that range's price. Minimum 500 emissions: a
 * company that emits fewer is billed as if it emitted 500.
 *
 * Only DGII-ACCEPTED emissions count (ACCEPTED + CONDITIONAL); the counting
 * happens elsewhere (UsageService.countAcceptedEmission). This module only turns
 * a final accepted-count into money.
 *
 * The canonical ranges live in {@link PRICING_RANGES} and are mirrored as
 * PricingTier rows in the DB (seed) for configurability/display. The engine
 * accepts ranges as a parameter so it can be driven by DB rows, but defaults to
 * the canonical constant so unit tests are deterministic.
 */

/** Fixed monthly platform fee, in USD. */
export const MONTHLY_FEE_USD = 60;

/** Minimum billed emissions: emit fewer and you still pay for 500. */
export const MIN_BILLED_EMISSIONS = 500;

export interface PricingRange {
  /** Inclusive lower bound of the range. */
  fromQty: number;
  /** Inclusive upper bound; `null` means unbounded (∞). */
  toQty: number | null;
  /** Flat price per emission for this range; `null` when requiresQuote. */
  pricePerEmission: number | null;
  /** When true the range must be quoted manually — no auto price/total. */
  requiresQuote: boolean;
}

/**
 * Canonical flat-by-range table (US$ per emission):
 *   1–500 → 0.06 | 501–1000 → 0.05 | 1001–3000 → 0.04 | 3001–5000 → 0.04
 *   5001–10000 → 0.03 | 10001–100000 → REQUIERE_COTIZACION | 100001+ → 0.02
 */
export const PRICING_RANGES: PricingRange[] = [
  { fromQty: 1, toQty: 500, pricePerEmission: 0.06, requiresQuote: false },
  { fromQty: 501, toQty: 1000, pricePerEmission: 0.05, requiresQuote: false },
  { fromQty: 1001, toQty: 3000, pricePerEmission: 0.04, requiresQuote: false },
  { fromQty: 3001, toQty: 5000, pricePerEmission: 0.04, requiresQuote: false },
  { fromQty: 5001, toQty: 10000, pricePerEmission: 0.03, requiresQuote: false },
  { fromQty: 10001, toQty: 100000, pricePerEmission: null, requiresQuote: true },
  { fromQty: 100001, toQty: null, pricePerEmission: 0.02, requiresQuote: false },
];

export interface MonthlyCharge {
  /** Emissions actually accepted by DGII this cycle. */
  acceptedCount: number;
  /** Quantity actually billed = max(acceptedCount, 500). Picks the range. */
  billedCount: number;
  /** The range billedCount fell into, or null if none matched. */
  tier: PricingRange | null;
  /** Flat price per emission applied, or null when requiresQuote. */
  pricePerEmission: number | null;
  /** billedCount × pricePerEmission (2-dp), or null when requiresQuote. */
  emissionsCost: number | null;
  /** Fixed monthly fee (always {@link MONTHLY_FEE_USD}). */
  monthlyFee: number;
  /** monthlyFee + emissionsCost (2-dp), or null when requiresQuote. */
  total: number | null;
  /** True when the billed range needs a manual quote (total is null). */
  requiresQuote: boolean;
}

/** Round to 2 decimal places (cents), avoiding binary-float drift. */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Compute the monthly charge for a company given how many emissions DGII
 * accepted this cycle. Pure: same input → same output, no I/O.
 *
 * Note the intentional "flat anomaly": because the WHOLE billed quantity is
 * priced at the range it lands in, 1000 accepted → 1000×0.05 = $50, but 1001
 * accepted → 1001×0.04 = $40.04 — emitting ONE more costs LESS. This is the
 * defined behaviour of the flat-by-range model, not a bug.
 */
export function calculateMonthlyCharge(
  acceptedCount: number,
  ranges: PricingRange[] = PRICING_RANGES,
): MonthlyCharge {
  const safeAccepted = Math.max(0, Math.floor(acceptedCount));
  const billedCount = Math.max(safeAccepted, MIN_BILLED_EMISSIONS);

  const tier =
    ranges.find(
      (r) => billedCount >= r.fromQty && (r.toQty === null || billedCount <= r.toQty),
    ) ?? null;

  if (!tier || tier.requiresQuote || tier.pricePerEmission === null) {
    return {
      acceptedCount: safeAccepted,
      billedCount,
      tier,
      pricePerEmission: null,
      emissionsCost: null,
      monthlyFee: MONTHLY_FEE_USD,
      total: null,
      requiresQuote: tier ? tier.requiresQuote : false,
    };
  }

  const emissionsCost = round2(billedCount * tier.pricePerEmission);
  return {
    acceptedCount: safeAccepted,
    billedCount,
    tier,
    pricePerEmission: tier.pricePerEmission,
    emissionsCost,
    monthlyFee: MONTHLY_FEE_USD,
    total: round2(MONTHLY_FEE_USD + emissionsCost),
    requiresQuote: false,
  };
}
