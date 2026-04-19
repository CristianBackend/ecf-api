import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import IORedis from 'ioredis';
import {
  DistributedLockService,
  LOCK_REDIS_CLIENT,
} from './distributed-lock.service';

/**
 * Global module providing the Redis-backed {@link DistributedLockService}.
 *
 * Uses a dedicated ioredis connection (NOT the BullMQ connection) so lock
 * ops don't compete with the queue's pub/sub and blocking commands.
 */
@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: LOCK_REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new IORedis({
          host: config.get<string>('REDIS_HOST', 'localhost'),
          port: config.get<number>('REDIS_PORT', 6379),
          password: config.get<string>('REDIS_PASSWORD') || undefined,
          // Keep the client from spamming retries against a down Redis —
          // schedulers will just fail to acquire and try again next tick.
          maxRetriesPerRequest: 1,
          lazyConnect: false,
        }),
    },
    DistributedLockService,
  ],
  exports: [DistributedLockService],
})
export class DistributedLockModule {}
