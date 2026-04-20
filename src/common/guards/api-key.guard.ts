import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthService } from '../../auth/auth.service';
import { SCOPES_KEY } from '../decorators/scopes.decorator';
import { ApiKeyScope } from '@prisma/client';
import * as bcrypt from 'bcrypt';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
    private readonly authService: AuthService,
    @InjectPinoLogger(ApiKeyGuard.name)
    private readonly logger: PinoLogger,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();

    // Extract token from Authorization header or ?auth= query param (for download links)
    const authHeader = request.headers.authorization;
    const queryAuth = request.query?.auth as string | undefined;

    if (!authHeader && !queryAuth) {
      throw new UnauthorizedException('Missing Authorization header');
    }

    let token: string;

    if (authHeader) {
      const [scheme, headerToken] = authHeader.split(' ');
      if (scheme?.toLowerCase() !== 'bearer' || !headerToken) {
        throw new UnauthorizedException('Invalid Authorization format. Use: Bearer {token}');
      }
      token = headerToken;
    } else {
      token = queryAuth!;
    }

    // Detect if it's a JWT or API key
    // JWT tokens have 3 parts separated by dots (header.payload.signature)
    // API keys have format: frd_live_xxx or frd_test_xxx
    if (token.includes('.') && token.split('.').length === 3) {
      return this.validateJwt(token, request);
    } else {
      return this.validateApiKey(token, request, context);
    }
  }

  /**
   * Validate JWT token (dashboard login)
   */
  private async validateJwt(token: string, request: any): Promise<boolean> {
    const payload = this.authService.verifyJwt(token);

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: payload.sub },
      select: { id: true, plan: true, isActive: true },
    });

    if (!tenant || !tenant.isActive) {
      throw new UnauthorizedException('Cuenta inactiva o no encontrada');
    }

    // Attach tenant info — JWT users get FULL_ACCESS
    request.tenant = {
      id: tenant.id,
      plan: tenant.plan,
      isLive: false,
      scopes: [ApiKeyScope.FULL_ACCESS],
      authType: 'jwt',
    };

    return true;
  }

  /**
   * Validate API key (programmatic access)
   */
  private async validateApiKey(apiKey: string, request: any, context: ExecutionContext): Promise<boolean> {
    // Validate API key format: frd_live_xxx or frd_test_xxx
    const keyParts = apiKey.split('_');
    if (keyParts.length < 3) {
      throw new UnauthorizedException('Invalid API key format');
    }

    const keyPrefix = `${keyParts[0]}_${keyParts[1]}_${keyParts[2].substring(0, 8)}`;
    const isLive = keyParts[1] === 'live';

    // Find API key by prefix (we store a hash, but use prefix for lookup)
    const apiKeyRecord = await this.prisma.apiKey.findFirst({
      where: {
        keyPrefix,
        isActive: true,
      },
      include: {
        tenant: true,
      },
    });

    if (!apiKeyRecord) {
      throw new UnauthorizedException('Invalid API key');
    }

    // Verify full key hash
    const isValidKey = await bcrypt.compare(apiKey, apiKeyRecord.keyHash);
    if (!isValidKey) {
      throw new UnauthorizedException('Invalid API key');
    }

    // Check expiration
    if (apiKeyRecord.expiresAt && apiKeyRecord.expiresAt < new Date()) {
      throw new UnauthorizedException('API key has expired');
    }

    // Check tenant is active
    if (!apiKeyRecord.tenant.isActive) {
      throw new UnauthorizedException('Tenant account is inactive');
    }

    // Check required scopes
    const requiredScopes = this.reflector.getAllAndOverride<ApiKeyScope[]>(
      SCOPES_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (requiredScopes && requiredScopes.length > 0) {
      const hasFullAccess = apiKeyRecord.scopes.includes(ApiKeyScope.FULL_ACCESS);
      const hasRequiredScopes = hasFullAccess || requiredScopes.every(
        (scope) => apiKeyRecord.scopes.includes(scope),
      );

      if (!hasRequiredScopes) {
        throw new UnauthorizedException(
          `Insufficient permissions. Required: ${requiredScopes.join(', ')}`,
        );
      }
    }

    // Update last used
    this.prisma.apiKey
      .update({
        where: { id: apiKeyRecord.id },
        data: { lastUsedAt: new Date() },
      })
      .catch((err) => this.logger.warn(`Failed to update lastUsedAt: ${err.message}`));

    // Attach tenant info to request
    request.tenant = {
      id: apiKeyRecord.tenantId,
      plan: apiKeyRecord.tenant.plan,
      isLive,
      scopes: apiKeyRecord.scopes,
      apiKeyId: apiKeyRecord.id,
      authType: 'apikey',
    };

    return true;
  }
}
