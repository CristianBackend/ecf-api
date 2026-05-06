import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { ActivePlanGuard } from './active-plan.guard';

function makeCtx(tenantId: string): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ tenant: { id: tenantId } }),
    }),
  } as unknown as ExecutionContext;
}

function makeBillingService(canEmitResult: { allowed: boolean; reason?: string }) {
  return { canEmitInvoice: jest.fn().mockResolvedValue(canEmitResult) };
}

describe('ActivePlanGuard', () => {
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

  it('calls canEmitInvoice with the correct tenantId', async () => {
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
});
