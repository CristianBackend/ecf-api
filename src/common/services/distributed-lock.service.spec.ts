/**
 * DistributedLockService tests
 *
 * Drives the service against an in-memory Redis stub that implements just
 * enough of the client surface (SET … NX PX and EVAL of the release script)
 * for unit testing — no network, no container. This mirrors the real
 * behavior precisely because the only primitives in play are `SET NX PX`
 * atomicity and the Lua GET/compare/DEL.
 */
import { DistributedLockService, LockRedisClient } from './distributed-lock.service';

interface StoredEntry {
  value: string;
  /** Absolute epoch ms at which the key expires. */
  expiresAt: number;
}

/**
 * Minimal fake Redis client implementing SET NX PX and EVAL for the
 * release script. Honors TTL based on the stubbed "now" clock so tests can
 * simulate expiration without sleeping.
 */
class FakeRedis implements LockRedisClient {
  private store = new Map<string, StoredEntry>();
  public now = 0;

  advance(ms: number) {
    this.now += ms;
  }

  async set(
    key: string,
    value: string,
    _mode: 'PX',
    ttlMs: number,
    _nx: 'NX',
  ): Promise<'OK' | null> {
    const entry = this.store.get(key);
    if (entry && entry.expiresAt > this.now) {
      return null; // NX failed — key held
    }
    this.store.set(key, { value, expiresAt: this.now + ttlMs });
    return 'OK';
  }

  async eval(
    _script: string,
    _numKeys: 1,
    key: string,
    arg: string,
  ): Promise<number> {
    const entry = this.store.get(key);
    if (!entry || entry.expiresAt <= this.now) {
      return 0;
    }
    if (entry.value !== arg) {
      return 0;
    }
    this.store.delete(key);
    return 1;
  }
}

describe('DistributedLockService', () => {
  let redis: FakeRedis;
  let service: DistributedLockService;

  beforeEach(() => {
    redis = new FakeRedis();
    service = new DistributedLockService(redis);
  });

  it('acquires a lock with a unique holder token', async () => {
    const lock = await service.acquire('jobs:contingency', 5000);
    expect(lock).not.toBeNull();
    expect(lock!.key).toBe('jobs:contingency');
    expect(lock!.token).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('2 concurrent acquires on the same key — only one wins', async () => {
    const [a, b] = await Promise.all([
      service.acquire('jobs:cleanup', 5000),
      service.acquire('jobs:cleanup', 5000),
    ]);
    const winners = [a, b].filter((l) => l !== null);
    const losers = [a, b].filter((l) => l === null);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
  });

  it('acquires different keys independently', async () => {
    const a = await service.acquire('k1', 5000);
    const b = await service.acquire('k2', 5000);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
  });

  it('lock expires after TTL — next acquire succeeds', async () => {
    const first = await service.acquire('k', 1000);
    expect(first).not.toBeNull();

    // Before TTL: second acquire still blocked
    redis.advance(900);
    const blocked = await service.acquire('k', 1000);
    expect(blocked).toBeNull();

    // After TTL: a fresh acquire wins
    redis.advance(200);
    const regained = await service.acquire('k', 1000);
    expect(regained).not.toBeNull();
    expect(regained!.token).not.toBe(first!.token);
  });

  it('release only deletes when the caller is the current holder', async () => {
    const lock = await service.acquire('k', 5000);
    expect(lock).not.toBeNull();

    // A forged lock with the right key but a wrong token MUST NOT release
    const forged = { key: 'k', token: 'not-the-real-token' };
    const forgedDeleted = await service.release(forged);
    expect(forgedDeleted).toBe(false);

    // Legitimate release works
    const realDeleted = await service.release(lock!);
    expect(realDeleted).toBe(true);

    // And now someone else can acquire
    const next = await service.acquire('k', 5000);
    expect(next).not.toBeNull();
  });

  it('release is a no-op if the TTL already expired', async () => {
    const lock = await service.acquire('k', 500);
    redis.advance(1000);
    const deleted = await service.release(lock!);
    expect(deleted).toBe(false);
  });

  it('withLock: runs fn only when lock is acquired, releases after', async () => {
    const result = await service.withLock('k', 5000, async () => 'done');
    expect(result).toBe('done');

    // Lock was released — a subsequent acquire must win
    const again = await service.acquire('k', 5000);
    expect(again).not.toBeNull();
  });

  it('withLock: returns undefined (and skips fn) when lock is held', async () => {
    await service.acquire('k', 5000);
    const ran = jest.fn(async () => 'should-not-run');
    const result = await service.withLock('k', 5000, ran);
    expect(result).toBeUndefined();
    expect(ran).not.toHaveBeenCalled();
  });

  it('withLock: releases the lock even if fn throws', async () => {
    const boom = jest.fn(async () => {
      throw new Error('boom');
    });
    await expect(service.withLock('k', 5000, boom)).rejects.toThrow(/boom/);
    // Lock was released by the finally block
    const afterFailure = await service.acquire('k', 5000);
    expect(afterFailure).not.toBeNull();
  });

  it('rejects non-positive TTLs', async () => {
    await expect(service.acquire('k', 0)).rejects.toThrow(/ttlMs/);
    await expect(service.acquire('k', -1)).rejects.toThrow(/ttlMs/);
  });
});
