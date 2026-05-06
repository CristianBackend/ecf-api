import { Injectable, CanActivate, ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { ApiKeyScope } from '@prisma/client';
import { BillingService } from '../billing.service';

/**
 * Guard applied to invoice-creation endpoints.
 * Returns HTTP 402 Payment Required when the tenant has no active billing plan
 * or has exhausted its included-invoices quota for the current period.
 *
 * Super-admins (scope ADMIN on the current request) are exempt — they can
 * always emit invoices regardless of plan status.
 *
 * Must run after ApiKeyGuard (which populates request.tenant with scopes).
 */
@Injectable()
export class ActivePlanGuard implements CanActivate {
  constructor(private readonly billingService: BillingService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const scopes: string[] = request.tenant?.scopes ?? [];

    // Super-admins are exempt from billing restrictions.
    if (scopes.includes(ApiKeyScope.ADMIN)) {
      return true;
    }

    const tenantId: string = request.tenant?.id;
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
