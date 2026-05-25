import { Injectable, CanActivate, ExecutionContext, HttpException, HttpStatus, Optional } from '@nestjs/common';
import { ApiKeyScope } from '@prisma/client';
import { BillingService } from '../billing.service';
import { CompanyBillingService } from '../company-billing.service';

/**
 * Guard applied to invoice-creation endpoints.
 * Returns HTTP 402 Payment Required when the tenant has no active billing plan
 * or has exhausted its included-invoices quota for the current period.
 *
 * Super-admins (scope ADMIN on the current request) are exempt — they can
 * always emit invoices regardless of plan status.
 *
 * When request.body.companyId is present and CompanyBillingService is wired,
 * company-level billing is checked first. If the company has no CompanyPlan
 * (fallback=true), the check falls through to the TenantPlan path.
 *
 * Must run after ApiKeyGuard (which populates request.tenant with scopes).
 */
@Injectable()
export class ActivePlanGuard implements CanActivate {
  constructor(
    private readonly billingService: BillingService,
    @Optional() private readonly companyBillingService?: CompanyBillingService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const scopes: string[] = request.tenant?.scopes ?? [];

    // Super-admins are exempt from billing restrictions.
    if (scopes.includes(ApiKeyScope.ADMIN)) {
      return true;
    }

    const tenantId: string = request.tenant?.id;
    const companyId: string | undefined = request.body?.companyId;

    // Company-level billing check (new path)
    if (companyId && this.companyBillingService) {
      const result = await this.companyBillingService.canEmitInvoice(companyId, tenantId);
      if (!result.fallback) {
        if (!result.allowed) {
          throw new HttpException(
            { message: result.reason ?? 'Plan inactivo o límite alcanzado', error: 'Payment Required' },
            HttpStatus.PAYMENT_REQUIRED,
          );
        }
        return true;
      }
      // fallback=true → fall through to tenant-level check
    }

    // Tenant-level billing check (legacy path)
    const { allowed, reason } = await this.billingService.canEmitInvoice(tenantId);

    if (!allowed) {
      throw new HttpException(
        { message: reason ?? 'Plan inactivo o límite alcanzado', error: 'Payment Required' },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    return true;
  }
}
