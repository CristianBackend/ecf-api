import { PrismaClient } from '@prisma/client';
import { PRICING_RANGES } from '../billing/pricing';

const prisma = new PrismaClient();

/**
 * Billing-v2 seed: a single PER_EMISSION plan (US$60/month flat fee) plus its 7
 * configurable pricing tiers (mirrors the canonical PRICING_RANGES). Plans are
 * assigned to companies manually; this only seeds the catalog.
 */
const PER_EMISSION_PLAN = {
  code: 'PER_EMISSION',
  name: 'Pago por Emisión',
  monthlyFee: 60,
  description: 'US$60/mes fijo + emisiones aceptadas × precio del rango (mínimo 500).',
  sortOrder: 1,
};

async function main() {
  console.log('Seeding per-emission billing plan...');
  const plan = await prisma.billingPlan.upsert({
    where: { code: PER_EMISSION_PLAN.code },
    create: PER_EMISSION_PLAN,
    update: {
      name: PER_EMISSION_PLAN.name,
      monthlyFee: PER_EMISSION_PLAN.monthlyFee,
      description: PER_EMISSION_PLAN.description,
      sortOrder: PER_EMISSION_PLAN.sortOrder,
    },
  });
  console.log(`  ✓ ${plan.code} — ${plan.name} ($${plan.monthlyFee}/mes fijo)`);

  console.log('\nSeeding pricing tiers...');
  // Replace the plan's tiers wholesale so re-seeding is deterministic.
  await prisma.pricingTier.deleteMany({ where: { planCode: plan.code } });
  for (let i = 0; i < PRICING_RANGES.length; i++) {
    const r = PRICING_RANGES[i];
    await prisma.pricingTier.create({
      data: {
        planCode: plan.code,
        fromQty: r.fromQty,
        toQty: r.toQty,
        pricePerEmission: r.pricePerEmission,
        requiresQuote: r.requiresQuote,
        sortOrder: i + 1,
      },
    });
    const label = r.requiresQuote
      ? 'REQUIERE_COTIZACIÓN'
      : `$${r.pricePerEmission}/emisión`;
    console.log(`  ✓ ${r.fromQty}–${r.toQty ?? '∞'} → ${label}`);
  }

  console.log('\nSeed completado: 1 plan PER_EMISSION + 7 pricing tiers.');
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
