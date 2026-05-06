import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const PLANS = [
  {
    code: 'TIER_1',
    name: 'Tier 1 — Básico',
    monthlyFee: 60,
    includedInvoices: 1500,
    description: 'Hasta 1,500 facturas por período de 30 días',
    sortOrder: 1,
  },
  {
    code: 'TIER_2',
    name: 'Tier 2 — Estándar',
    monthlyFee: 120,
    includedInvoices: 3200,
    description: 'Hasta 3,200 facturas por período de 30 días',
    sortOrder: 2,
  },
  {
    code: 'TIER_3',
    name: 'Tier 3 — Profesional',
    monthlyFee: 240,
    includedInvoices: 6600,
    description: 'Hasta 6,600 facturas por período de 30 días',
    sortOrder: 3,
  },
  {
    code: 'TIER_4',
    name: 'Tier 4 — Empresarial',
    monthlyFee: 800,
    includedInvoices: 26000,
    description: 'Hasta 26,000 facturas por período de 30 días',
    sortOrder: 4,
  },
];

async function main() {
  console.log('Seeding billing plans...');
  for (const plan of PLANS) {
    const result = await prisma.billingPlan.upsert({
      where: { code: plan.code },
      create: plan,
      update: {
        name: plan.name,
        monthlyFee: plan.monthlyFee,
        includedInvoices: plan.includedInvoices,
        description: plan.description,
        sortOrder: plan.sortOrder,
      },
    });
    console.log(
      `  ✓ ${result.code} — ${result.name} ($${result.monthlyFee}/mes, ${result.includedInvoices} facturas)`,
    );
  }
  console.log('\nSeed completado: 4 planes creados/actualizados');
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
