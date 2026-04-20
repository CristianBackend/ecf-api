import { Injectable, ConflictException, UnauthorizedException } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { ApiKeyScope } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';

export interface GeneratedApiKey {
  id: string;
  name: string;
  key: string; // Only returned once at creation
  keyPrefix: string;
  scopes: ApiKeyScope[];
  isLive: boolean;
  createdAt: Date;
}

export interface JwtPayload {
  sub: string;       // tenant ID
  email: string;
  name: string;
  type: 'dashboard';  // distinguish from API key auth
}

@Injectable()
export class AuthService {
  private readonly keyPrefix: string;
  private readonly jwtSecret: string;
  private readonly jwtExpiresIn: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @InjectPinoLogger(AuthService.name)
    private readonly logger: PinoLogger,
  ) {
    this.keyPrefix = this.config.get('API_KEY_PREFIX', 'frd');
    // JWT_SECRET is required (Joi-enforced at boot); fall back is only for
    // defensive coding — if the Joi validator was somehow skipped, crash
    // rather than sign with a placeholder.
    const secret = this.config.get<string>('JWT_SECRET');
    if (!secret) {
      throw new Error('JWT_SECRET is required (should be caught by env validation).');
    }
    this.jwtSecret = secret;
    this.jwtExpiresIn = this.config.get('JWT_EXPIRATION', '24h');
  }

  /**
   * Login with email + password → JWT token for dashboard
   */
  async login(email: string, password: string): Promise<{ token: string; tenant: any }> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { email },
      select: {
        id: true,
        name: true,
        email: true,
        passwordHash: true,
        plan: true,
        isActive: true,
      },
    });

    if (!tenant || !tenant.passwordHash) {
      throw new UnauthorizedException('Email o contraseña incorrectos');
    }

    if (!tenant.isActive) {
      throw new UnauthorizedException('Cuenta desactivada');
    }

    const valid = await bcrypt.compare(password, tenant.passwordHash);
    if (!valid) {
      throw new UnauthorizedException('Email o contraseña incorrectos');
    }

    const payload: JwtPayload = {
      sub: tenant.id,
      email: tenant.email,
      name: tenant.name,
      type: 'dashboard',
    };

   const token = jwt.sign(payload, this.jwtSecret, {
      expiresIn: this.jwtExpiresIn,
    } as jwt.SignOptions);
    this.logger.info(`Dashboard login: ${tenant.email}`);

    return {
      token,
      tenant: {
        id: tenant.id,
        name: tenant.name,
        email: tenant.email,
        plan: tenant.plan,
      },
    };
  }

  /**
   * Verify a JWT token and return tenant info
   */
  verifyJwt(token: string): JwtPayload {
    try {
      return jwt.verify(token, this.jwtSecret) as JwtPayload;
    } catch {
      throw new UnauthorizedException('Token inválido o expirado');
    }
  }

  /**
   * Generate a new API key for a tenant.
   * Returns the full key only once - it's stored as a bcrypt hash.
   *
   * Key format: frd_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   *             frd_test_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   */
  async generateApiKey(
    tenantId: string,
    name: string,
    isLive: boolean,
    scopes: ApiKeyScope[] = [ApiKeyScope.FULL_ACCESS],
  ): Promise<GeneratedApiKey> {
    // Generate random key
    const randomPart = crypto.randomBytes(24).toString('hex'); // 48 hex chars
    const envPart = isLive ? 'live' : 'test';
    const fullKey = `${this.keyPrefix}_${envPart}_${randomPart}`;

    // Create prefix for lookup (first 8 chars of random part)
    const keyPrefix = `${this.keyPrefix}_${envPart}_${randomPart.substring(0, 8)}`;

    // Hash the full key
    const keyHash = await bcrypt.hash(fullKey, 12);

    const apiKey = await this.prisma.apiKey.create({
      data: {
        tenantId,
        name,
        keyHash,
        keyPrefix,
        scopes,
        isLive,
      },
    });

    this.logger.info(`API key created for tenant ${tenantId}: ${keyPrefix}...`);

    return {
      id: apiKey.id,
      name: apiKey.name,
      key: fullKey,
      keyPrefix,
      scopes,
      isLive,
      createdAt: apiKey.createdAt,
    };
  }

  /**
   * List API keys for a tenant (without the actual key value)
   */
  async listApiKeys(tenantId: string) {
    return this.prisma.apiKey.findMany({
      where: { tenantId },
      select: {
        id: true,
        name: true,
        keyPrefix: true,
        scopes: true,
        isLive: true,
        isActive: true,
        lastUsedAt: true,
        expiresAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Revoke (deactivate) an API key
   */
  async revokeApiKey(tenantId: string, apiKeyId: string) {
    const key = await this.prisma.apiKey.findFirst({
      where: { id: apiKeyId, tenantId },
    });

    if (!key) {
      throw new ConflictException('API key not found');
    }

    await this.prisma.apiKey.update({
      where: { id: apiKeyId },
      data: { isActive: false },
    });

    this.logger.info(`API key revoked: ${key.keyPrefix}...`);
    return { message: 'API key revoked successfully' };
  }

  /**
   * Rotate an API key: revoke old one and create new one with same config
   */
  async rotateApiKey(tenantId: string, apiKeyId: string): Promise<GeneratedApiKey> {
    const oldKey = await this.prisma.apiKey.findFirst({
      where: { id: apiKeyId, tenantId, isActive: true },
    });

    if (!oldKey) {
      throw new ConflictException('API key not found or already inactive');
    }

    // Revoke old
    await this.prisma.apiKey.update({
      where: { id: apiKeyId },
      data: { isActive: false },
    });

    // Generate new with same config
    return this.generateApiKey(tenantId, oldKey.name, oldKey.isLive, oldKey.scopes);
  }
}
