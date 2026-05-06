import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { ApiKeyScope } from '@prisma/client';
import { ActivePlanGuard } from './active-plan.guard';

function makeCtx(tenantId: string, scopes: string[] = []): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ tenant: { id: tenantId, scopes } }),
    }),
  } as unknown as ExecutionContext;
}

function makeBillingService(canEmitResult: { allowed: boolean; reason?: string }) {
  return { canEmitInvoice: jest.fn().mockResolvedValue(canEmitResult) };
}

describe('ActivePlanGuard', () => {
  // ── regular tenant (no ADMIN scope) ─────────────────────────────────────────

  it('allows when billing service returns allowed=true', async () => {
    const guard = new ActivePlanGuard(makeBillingService({ allowed: true }) as any);
    const result = await guard.canActivate(makeCtx('tenant-1'));
    expect(result).toBe(true);
  });

  it('throws 402 when tenant has no active plan', async () => {
    const guard = new ActivePlanGuard(
      makeBillingService({ allowed: false, reason: 'Sin plan activo' }) as any,
    );
    await expect(guard.canActivate(makeCtx('tenant-1'))).rejects.toThrow(HttpException);
    try {
      await guard.canActivate(makeCtx('tenant-1'));
    } catch (err: any) {
      expect(err.getStatus()).toBe(HttpStatus.PAYMENT_REQUIRED);
      expect(err.getResponse().message).toBe('Sin plan activo');
    }
  });

  it('throws 402 when plan quota is exhausted', async () => {
    const guard = new ActivePlanGuard(
      makeBillingService({ allowed: false, reason: 'Plan excedido' }) as any,
    );
    try {
      await guard.canActivate(makeCtx('tenant-1'));
    } catch (err: any) {
      expect(err.getStatus()).toBe(HttpStatus.PAYMENT_REQUIRED);
      expect(err.getResponse().message).toBe('Plan excedido');
    }
  });

  it('throws 402 with default message when reason is missing', async () => {
    const guard = new ActivePlanGuard(
      makeBillingService({ allowed: false }) as any,
    );
    try {
      await guard.canActivate(makeCtx('tenant-1'));
    } catch (err: any) {
      expect(err.getStatus()).toBe(HttpStatus.PAYMENT_REQUIRED);
      expect(err.getResponse().message).toBeTruthy();
    }
  });

  it('calls canEmitInvoice with the correct tenantId for non-admin tenant', async () => {
    const billingService = makeBillingService({ allowed: true });
    const guard = new ActivePlanGuard(billingService as any);
    await guard.canActivate(makeCtx('tenant-xyz'));
    expect(billingService.canEmitInvoice).toHaveBeenCalledWith('tenant-xyz');
  });

  it('throws 402 for expired plan (billing service returns no active plan)', async () => {
    const guard = new ActivePlanGuard(
      makeBillingService({ allowed: false, reason: 'Sin plan activo' }) as any,
    );
    await expect(guard.canActivate(makeCtx('tenant-1'))).rejects.toThrow(
      expect.objectContaining({ status: HttpStatus.PAYMENT_REQUIRED }),
    );
  });

  // ── super-admin bypass (ADMIN scope) ────────────────────────────────────────

  it('allows super-admin without an active plan (ADMIN scope bypasses billing)', async () => {
    // billingService would return denied, but guard should never call it
    const billingService = makeBillingService({ allowed: false, reason: 'Sin plan activo' });
    const guard = new ActivePlanGuard(billingService as any);
    const result = await guard.canActivate(makeCtx('admin-tenant', [ApiKeyScope.ADMIN]));
    expect(result).toBe(true);
    expect(billingService.canEmitInvoice).not.toHaveBeenCalled();
  });

  it('allows super-admin even when plan quota would be exceeded', async () => {
    const billingService = makeBillingService({ allowed: false, reason: 'Plan excedido' });
    const guard = new ActivePlanGuard(billingService as any);
    const result = await guard.canActivate(
      makeCtx('admin-tenant', [ApiKeyScope.ADMIN, ApiKeyScope.INVOICES_WRITE]),
    );
    expect(result).toBe(true);
    expect(billingService.canEmitInvoice).not.toHaveBeenCalled();
  });

  it('applies billing check for tenant with FULL_ACCESS but no ADMIN scope', async () => {
    const billingService = makeBillingService({ allowed: false, reason: 'Sin plan activo' });
    const guard = new ActivePlanGuard(billingService as any);
    // FULL_ACCESS does not grant ADMIN — billing still applies
    await expect(
      guard.canActivate(makeCtx('tenant-1', [ApiKeyScope.FULL_ACCESS])),
    ).rejects.toThrow(HttpException);
    expect(billingService.canEmitInvoice).toHaveBeenCalled();
  });

  it('applies billing check for tenant with INVOICES_WRITE but no ADMIN scope', async () => {
    const billingService = makeBillingService({ allowed: true });
    const guard = new ActivePlanGuard(billingService as any);
    const result = await guard.canActivate(
      makeCtx('tenant-1', [ApiKeyScope.INVOICES_WRITE]),
    );
    expect(result).toBe(true);
    expect(billingService.canEmitInvoice).toHaveBeenCalledWith('tenant-1');
  });
});
