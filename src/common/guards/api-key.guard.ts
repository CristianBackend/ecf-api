import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthService } from '../../auth/auth.service';
import { SCOPES_KEY } from '../decorators/scopes.decorator';
import { ApiKeyScope } from '@prisma/client';
import * as bcrypt from 'bcrypt';

/**
 * FULL_ACCESS grants every scope EXCEPT ADMIN.
 * ADMIN must always be explicitly present on the key / derived from JWT context.
 *
 * Exported for unit testing.
 */
export function checkScopes(grantedScopes: ApiKeyScope[], requiredScopes: ApiKeyScope[]): void {
  if (!requiredScopes.length) return;

  const isAdminRequired = requiredScopes.includes(ApiKeyScope.ADMIN);
  if (isAdminRequired) {
    if (!grantedScopes.includes(ApiKeyScope.ADMIN)) {
      throw new ForbiddenException('Insufficient permissions. Admin access required.');
    }
    return;
  }

  // Non-ADMIN check: FULL_ACCESS covers everything except ADMIN.
  const hasFullAccess = grantedScopes.includes(ApiKeyScope.FULL_ACCESS);
  if (hasFullAccess) return;

  const missing = requiredScopes.filter((s) => !grantedScopes.includes(s));
  if (missing.length > 0) {
    throw new ForbiddenException(
      `Insufficient permissions. Required: ${missing.join(', ')}`,
    );
  }
}

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
    private readonly authService: AuthService,
    @InjectPinoLogger(ApiKeyGuard.name)
    private readonly logger: PinoLogger,
  ) {}

  /**
   * Accepts credentials from either `Authorization: Bearer <token>` or
   * `X-API-Key: <token>`. A legacy query-string fallback used to exist
   * for browser download links — it was removed because the credential
   * ended up in reverse-proxy access logs and browser history.
   * Download flows now use the single-use token endpoint:
   *   POST /invoices/:id/download-token  →  opaque UUID
   *   GET  /downloads/invoice-xml/:token →  burns the token server-side
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();

    const authHeader = request.headers.authorization;
    const apiKeyHeader =
      (request.headers['x-api-key'] as string | undefined) ?? undefined;

    let token: string;
    if (authHeader) {
      const [scheme, headerToken] = authHeader.split(' ');
      if (scheme?.toLowerCase() !== 'bearer' || !headerToken) {
        throw new UnauthorizedException(
          'Invalid Authorization format. Use: Bearer {token} or the X-API-Key header.',
        );
      }
      token = headerToken;
    } else if (apiKeyHeader) {
      token = apiKeyHeader;
    } else {
      throw new UnauthorizedException(
        'Missing credentials. Supply Authorization: Bearer <token> or X-API-Key: <token>.',
      );
    }

    // Detect JWT (3 dot-separated parts) vs API key (frd_live_xxx / frd_test_xxx).
    if (token.includes('.') && token.split('.').length === 3) {
      await this.validateJwt(token, request);
    } else {
      await this.validateApiKey(token, request);
    }

    // Scope check runs after either auth path, with the uniform checkScopes() logic.
    const requiredScopes = this.reflector.getAllAndOverride<ApiKeyScope[]>(
      SCOPES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (requiredScopes?.length) {
      checkScopes(request.tenant.scopes as ApiKeyScope[], requiredScopes);
    }

    return true;
  }

  /**
   * Validate JWT token (dashboard login).
   *
   * Effective scopes = union of all active API keys' scopes for this tenant,
   * plus FULL_ACCESS as a baseline so JWT users can reach regular endpoints
   * even if the tenant has no keys yet. ADMIN is only included when at least
   * one active key explicitly carries it.
   */
  private async validateJwt(token: string, request: any): Promise<void> {
    const payload = this.authService.verifyJwt(token);

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        plan: true,
        isActive: true,
        apiKeys: {
          where: { isActive: true },
          select: { scopes: true },
        },
      },
    });

    if (!tenant || !tenant.isActive) {
      throw new UnauthorizedException('Cuenta inactiva o no encontrada');
    }

    // Derive effective scopes from the union of all active API keys.
    const scopeSet = new Set<ApiKeyScope>([ApiKeyScope.FULL_ACCESS]);
    for (const key of tenant.apiKeys) {
      for (const scope of key.scopes) {
        scopeSet.add(scope);
      }
    }

    request.tenant = {
      id: tenant.id,
      plan: tenant.plan,
      isLive: false,
      scopes: [...scopeSet],
      authType: 'jwt',
    };
  }

  /**
   * Validate API key (programmatic access).
   */
  private async validateApiKey(apiKey: string, request: any): Promise<void> {
    const keyParts = apiKey.split('_');
    if (keyParts.length < 3) {
      throw new UnauthorizedException('Invalid API key format');
    }

    const keyPrefix = `${keyParts[0]}_${keyParts[1]}_${keyParts[2].substring(0, 8)}`;
    const isLive = keyParts[1] === 'live';

    const apiKeyRecord = await this.prisma.apiKey.findFirst({
      where: { keyPrefix, isActive: true },
      include: { tenant: true },
    });

    if (!apiKeyRecord) {
      throw new UnauthorizedException('Invalid API key');
    }

    const isValidKey = await bcrypt.compare(apiKey, apiKeyRecord.keyHash);
    if (!isValidKey) {
      throw new UnauthorizedException('Invalid API key');
    }

    if (apiKeyRecord.expiresAt && apiKeyRecord.expiresAt < new Date()) {
      throw new UnauthorizedException('API key has expired');
    }

    if (!apiKeyRecord.tenant.isActive) {
      throw new UnauthorizedException('Tenant account is inactive');
    }

    // Fire-and-forget last-used update.
    this.prisma.apiKey
      .update({
        where: { id: apiKeyRecord.id },
        data: { lastUsedAt: new Date() },
      })
      .catch((err) => this.logger.warn(`Failed to update lastUsedAt: ${err.message}`));

    request.tenant = {
      id: apiKeyRecord.tenantId,
      plan: apiKeyRecord.tenant.plan,
      isLive,
      scopes: apiKeyRecord.scopes,
      apiKeyId: apiKeyRecord.id,
      authType: 'apikey',
    };
  }
}
