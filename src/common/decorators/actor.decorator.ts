import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * Identity captured for the audit trail: WHO did an action and from WHERE.
 * - `actor`: the API key id (programmatic access) or `jwt:<tenantId>` (dashboard
 *   JWT) or `'api'` as a last-resort fallback.
 * - `ipAddress`: the request IP (honours the proxy via Express `trust proxy`).
 */
export interface ActorContext {
  actor: string;
  ipAddress?: string;
}

/**
 * Build the {@link ActorContext} from the request populated by ApiKeyGuard.
 * Use in controllers and pass down to services that write AuditLog rows, so the
 * audit records the real operator/IP instead of a hardcoded `'api'`.
 */
export const Actor = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ActorContext => {
    const request = ctx.switchToHttp().getRequest();
    const tenant = request?.tenant;
    const actor =
      tenant?.apiKeyId ??
      (tenant?.authType === 'jwt' && tenant?.id ? `jwt:${tenant.id}` : 'api');
    const ipAddress: string | undefined =
      request?.ip ??
      (typeof request?.headers?.['x-forwarded-for'] === 'string'
        ? request.headers['x-forwarded-for'].split(',')[0].trim()
        : undefined);
    return { actor, ipAddress };
  },
);
