import { Inject, Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';

/**
 * Minimal shape of the Redis client used by {@link DistributedLockService}.
 * Exposing just `set` and `eval` keeps the unit tests honest — the fake in
 * `distributed-lock.service.spec.ts` implements exactly this surface.
 */
export interface LockRedisClient {
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
    arg: string,
  ): Promise<number | string | null>;
}

export const LOCK_REDIS_CLIENT = Symbol('LOCK_REDIS_CLIENT');

/**
 * Lua script for safe lock release: only delete the key if the value still
 * matches the caller's holder token. Without this check, a caller whose
 * work outran the lock TTL could accidentally release a lock now held by
 * another worker.
 */
const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`.trim();

export interface AcquiredLock {
  key: string;
  token: string;
}

/**
 * Redis-backed distributed lock for scheduled jobs. Every pod runs its cron
 * triggers on the same schedule; the lock makes sure only one of them
 * actually does the work per tick, so we don't double-process contingency
 * invoices, clean the same tokens twice, or trigger duplicate certificate
 * checks.
 *
 * Semantics:
 * - `acquire(key, ttl)` does a `SET key token NX PX ttl` — atomic, returns
 *   the holder token on success and `null` on contention.
 * - `release(lock)` uses a Lua `GET/compare/DEL` so another worker that
 *   grabbed the same key after our TTL cannot be accidentally evicted.
 * - If the holder dies before releasing, the TTL expires the lock
 *   automatically — pick a TTL comfortably larger than the job's expected
 *   duration.
 */
@Injectable()
export class DistributedLockService {
  private readonly logger = new Logger(DistributedLockService.name);

  constructor(
    @Inject(LOCK_REDIS_CLIENT) private readonly redis: LockRedisClient,
  ) {}

  /**
   * Try to acquire the lock. Returns an {@link AcquiredLock} (the key + the
   * generated holder token) on success, or null if someone else already
   * holds it.
   */
  async acquire(key: string, ttlMs: number): Promise<AcquiredLock | null> {
    if (ttlMs <= 0) throw new Error('ttlMs must be positive');
    const token = crypto.randomUUID();
    const ok = await this.redis.set(key, token, 'PX', ttlMs, 'NX');
    if (ok !== 'OK') {
      return null;
    }
    return { key, token };
  }

  /**
   * Release a previously acquired lock. Safe to call with any {@link
   * AcquiredLock} — if the TTL already expired (or another holder is in
   * place) the Lua script leaves the key alone and reports false.
   *
   * Returns true when the caller's token matched and the key was deleted.
   */
  async release(lock: AcquiredLock): Promise<boolean> {
    const result = await this.redis.eval(
      RELEASE_SCRIPT,
      1,
      lock.key,
      lock.token,
    );
    const deleted = Number(result) === 1;
    if (!deleted) {
      this.logger.debug(
        `Lock ${lock.key} was not released by its token — expired or taken over`,
      );
    }
    return deleted;
  }

  /**
   * Convenience wrapper: acquire, run `fn`, release. Returns undefined when
   * the lock is already held elsewhere (caller decides whether to log/skip).
   */
  async withLock<T>(
    key: string,
    ttlMs: number,
    fn: () => Promise<T>,
  ): Promise<T | undefined> {
    const lock = await this.acquire(key, ttlMs);
    if (!lock) return undefined;
    try {
      return await fn();
    } finally {
      await this.release(lock).catch((err) =>
        this.logger.error(`Release failed for ${key}: ${err.message}`),
      );
    }
  }
}
