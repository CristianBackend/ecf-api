import { ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { ApiKeyScope } from '@prisma/client';
import { ActivePlanGuard } from './active-plan.guard';

function makeCtx(
  tenantId: string,
  companyId?: string,
  scopes: string[] = [],
): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({
        tenant: { id: tenantId, scopes },
        body: companyId ? { companyId } : {},
      }),
    }),
  } as unknown as ExecutionContext;
}

function makeCompanyBillingService(
  result: { allowed: boolean; reason?: string },
) {
  return { canEmitInvoice: jest.fn().mockResolvedValue(result) };
}

describe('ActivePlanGuard — company-level billing (billing-v2)', () => {
  it('allows ADMIN scope without consulting the billing service', async () => {
    const companyBillingService = makeCompanyBillingService({ allowed: false });
    const guard = new ActivePlanGuard(companyBillingService as any);

    const result = await guard.canActivate(
      makeCtx('admin-tenant', 'company-1', [ApiKeyScope.ADMIN]),
    );

    expect(result).toBe(true);
    expect(companyBillingService.canEmitInvoice).not.toHaveBeenCalled();
  });

  it('allows when there is no companyId in the body', async () => {
    const companyBillingService = makeCompanyBillingService({ allowed: false });
    const guard = new ActivePlanGuard(companyBillingService as any);

    const result = await guard.canActivate(makeCtx('tenant-1'));

    expect(result).toBe(true);
    expect(companyBillingService.canEmitInvoice).not.toHaveBeenCalled();
  });

  it('allows when companyBillingService is not provided', async () => {
    const guard = new ActivePlanGuard(undefined);

    const result = await guard.canActivate(makeCtx('tenant-1', 'company-1'));

    expect(result).toBe(true);
  });

  it('allows when canEmitInvoice returns allowed=true', async () => {
    const companyBillingService = makeCompanyBillingService({ allowed: true });
    const guard = new ActivePlanGuard(companyBillingService as any);

    const result = await guard.canActivate(makeCtx('tenant-1', 'company-1'));

    expect(result).toBe(true);
    expect(companyBillingService.canEmitInvoice).toHaveBeenCalledWith(
      'company-1',
      'tenant-1',
    );
  });

  it('throws 402 when canEmitInvoice returns allowed=false', async () => {
    const companyBillingService = makeCompanyBillingService({
      allowed: false,
      reason: 'Empresa sin plan asignado',
    });
    const guard = new ActivePlanGuard(companyBillingService as any);

    await expect(
      guard.canActivate(makeCtx('tenant-1', 'company-1')),
    ).rejects.toThrow(HttpException);

    try {
      await guard.canActivate(makeCtx('tenant-1', 'company-1'));
    } catch (err: any) {
      expect(err.getStatus()).toBe(HttpStatus.PAYMENT_REQUIRED);
      expect(err.getStatus()).toBe(402);
      expect(err.getResponse().message).toBe('Empresa sin plan asignado');
      expect(err.getResponse().error).toBe('Payment Required');
    }
  });
});
