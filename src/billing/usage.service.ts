import { ForbiddenException, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { CompanyPlanStatus, DgiiEnvironment, Prisma } from '@prisma/client';
import { BillingNotificationsService } from './notifications/billing-notifications.service';

/** Shape of the RETURNING clause on the atomic counter updates. */
type UsageRow = { base_used: number; topup_used: number; total_quota: number };

@Injectable()
export class UsageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: BillingNotificationsService,
    @InjectPinoLogger(UsageService.name)
    private readonly logger: PinoLogger,
  ) {}

  /**
   * Atomically consume one invoice of quota for the company's current cycle.
   *
   * FIX D/F (P2): the consumption is a SINGLE conditional UPDATE gated on
   * `(base_used + topup_used) < total_quota`, so concurrent emissions can NEVER
   * push the counter past the quota (no read-check-then-write race). Base quota
   * is charged first, then the topup pool (FIFO accounting on topup_purchases).
   *
   * Throws ForbiddenException when the quota is exhausted (0 rows updated) so the
   * caller — which runs this INSIDE the emission transaction (FIX E) — rolls back
   * and the over-quota invoice is never created. DEV companies and companies
   * without an active plan are not metered (early return, no throw).
   *
   * @param tx optional transaction client; pass the emission tx for atomicity.
   */
  async incrementUsage(companyId: string, tx?: Prisma.TransactionClient): Promise<void> {
    const db = tx ?? this.prisma;

    const company = await db.company.findUnique({ where: { id: companyId } });
    if (!company) return;
    if (company.dgiiEnv === DgiiEnvironment.DEV) return; // DEV sandbox — not metered

    const companyPlan = await db.companyPlan.findUnique({
      where: { companyId },
      include: { plan: true },
    });
    if (!companyPlan || companyPlan.status === CompanyPlanStatus.EXPIRED) return;

    const cycleStart = companyPlan.cycleStartDate;
    const planBase = companyPlan.plan.includedInvoices;

    // 1) Try to consume BASE quota atomically (only if there is base room AND
    //    the overall quota is not yet reached).
    const baseRows = await db.$queryRaw<UsageRow[]>(Prisma.sql`
      UPDATE company_usages
      SET base_used = base_used + 1, updated_at = NOW()
      WHERE company_id = ${companyId}::uuid
        AND cycle_start_date = ${cycleStart}
        AND base_used < ${planBase}
        AND (base_used + topup_used) < total_quota
      RETURNING base_used, topup_used, total_quota`);

    let row = baseRows[0];
    let chargedTopup = false;

    if (!row) {
      // 2) Base full (or no base room) → consume from the TOPUP pool atomically,
      //    still gated on the overall quota.
      const topupRows = await db.$queryRaw<UsageRow[]>(Prisma.sql`
        UPDATE company_usages
        SET topup_used = topup_used + 1, updated_at = NOW()
        WHERE company_id = ${companyId}::uuid
          AND cycle_start_date = ${cycleStart}
          AND (base_used + topup_used) < total_quota
        RETURNING base_used, topup_used, total_quota`);
      row = topupRows[0];
      chargedTopup = !!row;
    }

    if (!row) {
      // Neither branch consumed. Distinguish a missing usage row (data error)
      // from a genuinely exhausted quota — FAIL VISIBLY either way so the
      // emission transaction rolls back instead of silently emitting uncounted.
      const existing = await db.companyUsage.findUnique({
        where: { companyId_cycleStartDate: { companyId, cycleStartDate: cycleStart } },
      });
      if (!existing) {
        throw new Error(
          `company_usages row missing for company ${companyId} cycle ` +
            `${cycleStart.toISOString()} — cannot meter usage`,
        );
      }
      if (companyPlan.status !== CompanyPlanStatus.EXHAUSTED) {
        await db.companyPlan.update({
          where: { companyId },
          data: { status: CompanyPlanStatus.EXHAUSTED },
        });
      }
      throw new ForbiddenException(
        'Cuota de comprobantes agotada para el plan actual. ' +
          'Adquiera un top-up para continuar emitiendo.',
      );
    }

    if (chargedTopup) {
      // FIFO accounting: charge the oldest still-active topup purchase.
      await db.$executeRaw(Prisma.sql`
        UPDATE topup_purchases
        SET invoices_used = invoices_used + 1, updated_at = NOW()
        WHERE id = (
          SELECT id FROM topup_purchases
          WHERE company_id = ${companyId}::uuid
            AND cycle_start_date = ${cycleStart}
            AND cycle_end_date > NOW()
          ORDER BY created_at ASC
          LIMIT 1
        )`);
    }

    // Flip plan to EXHAUSTED when this consumption hit the ceiling.
    if (
      row.base_used + row.topup_used >= row.total_quota &&
      companyPlan.status !== CompanyPlanStatus.EXHAUSTED
    ) {
      await db.companyPlan.update({
        where: { companyId },
        data: { status: CompanyPlanStatus.EXHAUSTED },
      });
    }
  }

  /**
   * Atomically refund one invoice of quota for the company's current cycle.
   * Reverses topup first (last consumed), then base, never dropping below 0.
   * Re-activates an EXHAUSTED plan once there is room again.
   *
   * Used only by {@link revertUsage}; not called directly from emission paths.
   */
  async decrementUsage(companyId: string, tx?: Prisma.TransactionClient): Promise<void> {
    const db = tx ?? this.prisma;

    const company = await db.company.findUnique({ where: { id: companyId } });
    if (!company) return;
    if (company.dgiiEnv === DgiiEnvironment.DEV) return;

    const companyPlan = await db.companyPlan.findUnique({ where: { companyId } });
    if (!companyPlan) return;
    const cycleStart = companyPlan.cycleStartDate;

    // Refund topup first (reverse of consumption order); fall back to base.
    const topupRows = await db.$queryRaw<{ topup_used: number }[]>(Prisma.sql`
      UPDATE company_usages
      SET topup_used = topup_used - 1, updated_at = NOW()
      WHERE company_id = ${companyId}::uuid
        AND cycle_start_date = ${cycleStart}
        AND topup_used > 0
      RETURNING topup_used`);

    if (topupRows[0]) {
      // LIFO refund on the most-recently-charged topup purchase.
      await db.$executeRaw(Prisma.sql`
        UPDATE topup_purchases
        SET invoices_used = invoices_used - 1, updated_at = NOW()
        WHERE id = (
          SELECT id FROM topup_purchases
          WHERE company_id = ${companyId}::uuid
            AND cycle_start_date = ${cycleStart}
            AND invoices_used > 0
          ORDER BY created_at DESC
          LIMIT 1
        )`);
    } else {
      await db.$executeRaw(Prisma.sql`
        UPDATE company_usages
        SET base_used = base_used - 1, updated_at = NOW()
        WHERE company_id = ${companyId}::uuid
          AND cycle_start_date = ${cycleStart}
          AND base_used > 0`);
    }

    // A refund frees capacity → re-activate a plan that was EXHAUSTED.
    if (companyPlan.status === CompanyPlanStatus.EXHAUSTED) {
      await db.companyPlan.update({
        where: { companyId },
        data: { status: CompanyPlanStatus.ACTIVE },
      });
    }
  }

  /**
   * FIX G (P2): refund the quota a single invoice consumed, EXACTLY ONCE.
   *
   * Policy: an emitted e-CF reserves quota at QUEUED. Quota is refunded only for
   * terminal NON-VALID outcomes — REJECTED (DGII rejected the data) and VOIDED
   * (annulled before acceptance). ERROR/CONTINGENCY are transient and may still
   * be retried into ACCEPTED (markForRetry), so they keep the quota reserved to
   * avoid under-counting; ACCEPTED/CONDITIONAL keep the quota (valid document).
   *
   * Idempotency: the `usageReverted` flag is flipped false→true atomically; only
   * the winner decrements, so REJECTED→VOIDED (or concurrent calls) never
   * double-refund.
   */
  async revertUsage(
    invoiceId: string,
    companyId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const db = tx ?? this.prisma;
    const claim = await db.invoice.updateMany({
      where: { id: invoiceId, usageReverted: false },
      data: { usageReverted: true },
    });
    if (claim.count !== 1) return; // already reverted (or gone) → no double refund
    await this.decrementUsage(companyId, tx);
    this.logger.info(`Usage reverted for invoice ${invoiceId} (company ${companyId})`);
  }

  /**
   * Best-effort threshold notifications (70/85/95/100%). Runs OUTSIDE the
   * emission transaction (called after commit) so a notification failure can
   * never roll back or block an emission. Safe to fire-and-forget.
   */
  async notifyThresholds(companyId: string): Promise<void> {
    const company = await this.prisma.company.findUnique({ where: { id: companyId } });
    if (!company || company.dgiiEnv === DgiiEnvironment.DEV) return;

    const companyPlan = await this.prisma.companyPlan.findUnique({ where: { companyId } });
    if (!companyPlan) return;

    const usage = await this.prisma.companyUsage.findUnique({
      where: {
        companyId_cycleStartDate: {
          companyId,
          cycleStartDate: companyPlan.cycleStartDate,
        },
      },
    });
    if (usage) {
      await this.notifications.evaluateThresholds(
        companyId,
        companyPlan.cycleStartDate,
        usage,
      );
    }
  }
}
