import { Injectable, CanActivate, ExecutionContext, HttpException, HttpStatus } from '@nestjs/common';
import { BillingService } from '../billing.service';

/**
 * Guard applied to invoice-creation endpoints.
 * Returns HTTP 402 Payment Required when the tenant has no active billing plan
 * or has exhausted its included-invoices quota for the current period.
 *
 * Must run after ApiKeyGuard (which populates request.tenant).
 */
@Injectable()
export class ActivePlanGuard implements CanActivate {
  constructor(private readonly billingService: BillingService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
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
