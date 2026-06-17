import { Injectable, CanActivate, ExecutionContext, HttpException, HttpStatus, Optional } from '@nestjs/common';
import { ApiKeyScope } from '@prisma/client';
import { CompanyBillingService } from '../company-billing.service';

/**
 * Guard applied to invoice-creation endpoints (billing-v2, company-level only).
 *
 * Post-pay model: a company must have an ACTIVE plan assigned so we know its rate
 * — otherwise we'd emit with no idea what to bill. But it is NEVER blocked by
 * volume: there is no quota. Returns HTTP 402 ONLY when the company has no plan
 * (or the plan is cancelled/expired), never because of how many it has emitted.
 *
 * Super-admins (scope ADMIN) and DEV companies are exempt.
 *
 * Must run after ApiKeyGuard (which populates request.tenant with scopes).
 */
@Injectable()
export class ActivePlanGuard implements CanActivate {
  constructor(
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

    // No companyId on the request, or service not wired → nothing to gate on;
    // downstream validation handles a missing/invalid company.
    if (!companyId || !this.companyBillingService) {
      return true;
    }

    const result = await this.companyBillingService.canEmitInvoice(companyId, tenantId);
    if (!result.allowed) {
      throw new HttpException(
        { message: result.reason ?? 'Empresa sin plan asignado', error: 'Payment Required' },
        HttpStatus.PAYMENT_REQUIRED,
      );
    }
    return true;
  }
}
