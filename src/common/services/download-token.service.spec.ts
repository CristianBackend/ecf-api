/**
 * DownloadTokenService tests — single-use short-lived download tokens.
 *
 * Like distributed-lock.service.spec.ts, this uses an in-memory fake Redis
 * that implements exactly the surface the service calls (SET … NX PX and
 * the EVAL used for atomic GET+DEL). No Redis container required.
 */
import {
  DownloadTokenService,
  DownloadTokenRedisClient,
} from './download-token.service';
import { makeTestLogger } from '../logger/test-logger';

interface StoredEntry {
  value: string;
  expiresAt: number;
}

class FakeRedis implements DownloadTokenRedisClient {
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
    const existing = this.store.get(key);
    if (existing && existing.expiresAt > this.now) {
      return null;
    }
    this.store.set(key, { value, expiresAt: this.now + ttlMs });
    return 'OK';
  }

  async eval(
    _script: string,
    _numKeys: 1,
    key: string,
  ): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry || entry.expiresAt <= this.now) {
      this.store.delete(key);
      return null;
    }
    // Atomic GET+DEL: the issued value is returned and the key is wiped.
    this.store.delete(key);
    return entry.value;
  }
}

describe('DownloadTokenService', () => {
  let redis: FakeRedis;
  let service: DownloadTokenService;

  beforeEach(() => {
    redis = new FakeRedis();
    service = new DownloadTokenService(redis, makeTestLogger());
  });

  it('issues a UUID v4 token with the requested TTL and payload', async () => {
    const { token, expiresInMs } = await service.issue(
      { type: 'invoice-xml', tenantId: 't-1', invoiceId: 'inv-1' },
      60_000,
    );
    expect(token).toMatch(/^[0-9a-f-]{36}$/i);
    expect(expiresInMs).toBe(60_000);
  });

  it('consume() returns the original payload once and then null on replay', async () => {
    const { token } = await service.issue({
      type: 'invoice-xml',
      tenantId: 't-1',
      invoiceId: 'inv-1',
    });

    const first = await service.consume(token);
    expect(first).toEqual({
      type: 'invoice-xml',
      tenantId: 't-1',
      invoiceId: 'inv-1',
    });

    // A replay — must not leak the payload again.
    const second = await service.consume(token);
    expect(second).toBeNull();
  });

  it('consume() returns null after the TTL elapses', async () => {
    const { token } = await service.issue(
      { type: 'invoice-xml', tenantId: 't-1', invoiceId: 'inv-1' },
      1_000,
    );
    redis.advance(1_500);
    expect(await service.consume(token)).toBeNull();
  });

  it('consume() rejects malformed tokens without touching Redis', async () => {
    const badSet = jest.spyOn(redis, 'eval');
    expect(await service.consume('')).toBeNull();
    expect(await service.consume('not-a-uuid')).toBeNull();
    expect(badSet).not.toHaveBeenCalled();
  });

  it('issue() rejects non-positive TTLs', async () => {
    await expect(
      service.issue({ type: 'invoice-xml', tenantId: 't', invoiceId: 'i' }, 0),
    ).rejects.toThrow(/ttlMs/);
  });

  it('two concurrent issues produce distinct tokens', async () => {
    const [a, b] = await Promise.all([
      service.issue({ type: 'invoice-xml', tenantId: 't', invoiceId: 'i' }),
      service.issue({ type: 'invoice-xml', tenantId: 't', invoiceId: 'i' }),
    ]);
    expect(a.token).not.toBe(b.token);
    // Both should independently be consumable.
    expect(await service.consume(a.token)).not.toBeNull();
    expect(await service.consume(b.token)).not.toBeNull();
  });
});
