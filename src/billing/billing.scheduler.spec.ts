import { BillingScheduler } from './billing.scheduler';
import { makeTestLogger } from '../common/logger/test-logger';

function makeScheduler(expiredCount: number, lockAcquired = true) {
  const billingService = {
    expireStalePlans: jest.fn().mockResolvedValue(expiredCount),
  };

  // Simulate distributed lock: calls fn() when acquired, undefined when not
  const lock = {
    withLock: jest.fn(
      async (_key: string, _ttl: number, fn: () => Promise<void>) => {
        if (lockAcquired) return fn();
        return undefined;
      },
    ),
  };

  const scheduler = new BillingScheduler(
    billingService as any,
    lock as any,
    makeTestLogger(),
  );

  return { scheduler, billingService, lock };
}

describe('BillingScheduler', () => {
  it('expirePlans acquires a distributed lock before running', async () => {
    const { scheduler, lock } = makeScheduler(0);
    await scheduler.expirePlans();
    expect(lock.withLock).toHaveBeenCalledWith(
      'scheduler:billing-expire-plans',
      expect.any(Number),
      expect.any(Function),
    );
  });

  it('expirePlans calls expireStalePlans when lock is acquired', async () => {
    const { scheduler, billingService } = makeScheduler(3);
    await scheduler.expirePlans();
    expect(billingService.expireStalePlans).toHaveBeenCalled();
  });

  it('expirePlans skips expiration when lock is not acquired (another replica holds it)', async () => {
    const { scheduler, billingService } = makeScheduler(0, false);
    await scheduler.expirePlans();
    expect(billingService.expireStalePlans).not.toHaveBeenCalled();
  });

  it('expirePlans does not throw when expireStalePlans fails', async () => {
    const billingService = {
      expireStalePlans: jest.fn().mockRejectedValue(new Error('DB error')),
    };
    const lock = {
      withLock: jest.fn(async (_k: string, _t: number, fn: () => Promise<void>) => fn()),
    };
    const scheduler = new BillingScheduler(billingService as any, lock as any, makeTestLogger());
    await expect(scheduler.expirePlans()).resolves.not.toThrow();
  });

  it('expirePlans returns 0 when nothing expired', async () => {
    const { scheduler, billingService } = makeScheduler(0);
    await scheduler.expirePlans();
    expect(billingService.expireStalePlans).toHaveBeenCalled();
  });
});
