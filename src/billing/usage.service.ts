import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { DgiiEnvironment, Prisma } from '@prisma/client';

/**
 * Billing-v2 usage metering — COUNT AT ACCEPTANCE.
 *
 * The per-emission model bills only DGII-ACCEPTED emissions (ACCEPTED +
 * CONDITIONAL). Unlike billing-v1 (which incremented at creation and refunded on
 * rejection), v2 increments a single counter the moment an invoice reaches a
 * countable final state — so REJECTED/VOIDED/ERROR/CONTINGENCY/PROCESSING simply
 * never get counted, and there is no "refund" path to keep in sync.
 *
 * Idempotency is the whole game here (revenue correctness): the same invoice can
 * reach ACCEPTED through 4 independent code paths (poller, direct submit,
 * contingency, manual poll) and a re-poll can hit an already-ACCEPTED invoice.
 * {@link countAcceptedEmission} flips Invoice.usageCounted false→true atomically
 * and only the winner increments, so it counts AT MOST once per invoice.
 */
@Injectable()
export class UsageService {
  constructor(
    private readonly prisma: PrismaService,
    @InjectPinoLogger(UsageService.name)
    private readonly logger: PinoLogger,
  ) {}

  /**
   * Count one accepted emission for the company's current billing cycle, EXACTLY
   * ONCE. Call on every transition to ACCEPTED or CONDITIONAL.
   *
   * DEV companies and companies without a CompanyPlan are not metered (the flag
   * is still flipped so the no-op decision is recorded and never re-evaluated).
   *
   * @param tx optional transaction client (pass the emission/processor tx for
   *           atomicity with the status update).
   */
  async countAcceptedEmission(
    invoiceId: string,
    companyId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const db = tx ?? this.prisma;

    // Atomic idempotency claim: only the first caller for this invoice wins.
    const claim = await db.invoice.updateMany({
      where: { id: invoiceId, usageCounted: false },
      data: { usageCounted: true },
    });
    if (claim.count !== 1) return; // already counted (other path / re-poll) → no double count

    const company = await db.company.findUnique({ where: { id: companyId } });
    if (!company) return;
    if (company.dgiiEnv === DgiiEnvironment.DEV) return; // DEV sandbox — not metered

    const companyPlan = await db.companyPlan.findUnique({ where: { companyId } });
    if (!companyPlan) return; // no plan assigned → nothing to meter against

    // Increment the accepted counter for the plan's current cycle (upsert so the
    // first accepted emission of a cycle creates the row).
    await db.companyUsage.upsert({
      where: {
        companyId_cycleStartDate: {
          companyId,
          cycleStartDate: companyPlan.cycleStartDate,
        },
      },
      update: { acceptedCount: { increment: 1 } },
      create: {
        companyId,
        cycleStartDate: companyPlan.cycleStartDate,
        acceptedCount: 1,
      },
    });

    this.logger.info(
      `Accepted emission counted for invoice ${invoiceId} (company ${companyId})`,
    );
  }
}
