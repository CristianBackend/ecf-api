import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import * as crypto from 'crypto';
import { LOCK_REDIS_CLIENT } from './distributed-lock.service';

/**
 * The subset of ioredis used by this service. Lets tests drop in an
 * in-memory stub without a real Redis.
 */
export interface DownloadTokenRedisClient {
  set(
    key: string,
    value: string,
    mode: 'PX',
    ttlMs: number,
    nx: 'NX',
  ): Promise<'OK' | null>;
  eval(
    script: string,
    numKeys: 1,
    key: string,
  ): Promise<string | null>;
}

export interface DownloadTokenPayload {
  /** Kind of resource the token unlocks. New resources should add a new literal. */
  type: 'invoice-xml';
  tenantId: string;
  invoiceId: string;
}

/**
 * Atomic GET+DEL Lua so the same download URL can't be replayed: the first
 * request reads the payload and simultaneously deletes the key.
 */
const CONSUME_SCRIPT = `
local v = redis.call("GET", KEYS[1])
if v then redis.call("DEL", KEYS[1]) end
return v
`.trim();

const KEY_PREFIX = 'download-token:';

/**
 * Short-lived single-use download tokens, persisted in Redis with a TTL.
 *
 * Why not signed URLs? A signed URL encodes the payload in the URL and can
 * be replayed until it expires. This service returns an opaque UUID; the
 * payload stays server-side and the very first request to
 * `/downloads/invoice-xml/<uuid>` deletes the row. Second request → 404.
 *
 * TTL is deliberately short (default 60s). The flow is always:
 *   1. Authenticated call:   POST /invoices/:id/download-token
 *   2. Browser download:     GET  /downloads/invoice-xml/<token>
 * If the second step is skipped, the token expires silently.
 */
@Injectable()
export class DownloadTokenService {
  static readonly DEFAULT_TTL_MS = 60_000;

  constructor(
    @Inject(LOCK_REDIS_CLIENT)
    private readonly redis: DownloadTokenRedisClient,
    @InjectPinoLogger(DownloadTokenService.name)
    private readonly logger: PinoLogger,
  ) {}

  async issue(
    payload: DownloadTokenPayload,
    ttlMs: number = DownloadTokenService.DEFAULT_TTL_MS,
  ): Promise<{ token: string; expiresInMs: number }> {
    if (ttlMs <= 0) throw new Error('ttlMs must be positive');
    const token = crypto.randomUUID();
    const key = KEY_PREFIX + token;
    const ok = await this.redis.set(key, JSON.stringify(payload), 'PX', ttlMs, 'NX');
    if (ok !== 'OK') {
      // Practically impossible (UUID collision); but surface loudly if it
      // ever happens because it usually means the Redis client is faked wrong.
      throw new Error('Failed to issue download token (unexpected Redis response).');
    }
    this.logger.info(
      { type: payload.type, tenantId: payload.tenantId, ttlMs },
      'download token issued',
    );
    return { token, expiresInMs: ttlMs };
  }

  /**
   * Read the payload and delete the token in a single round-trip. Returns
   * null when the token has expired, never existed, or was already consumed.
   */
  async consume(token: string): Promise<DownloadTokenPayload | null> {
    if (!token || !/^[0-9a-f-]{36}$/i.test(token)) {
      return null;
    }
    const raw = await this.redis.eval(CONSUME_SCRIPT, 1, KEY_PREFIX + token);
    if (!raw || typeof raw !== 'string') return null;
    try {
      return JSON.parse(raw) as DownloadTokenPayload;
    } catch {
      return null;
    }
  }
}
