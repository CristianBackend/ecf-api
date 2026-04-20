import { Global, Module } from '@nestjs/common';
import { DistributedLockModule } from './distributed-lock.module';
import { DownloadTokenService } from './download-token.service';

/**
 * Global module exposing {@link DownloadTokenService}. Reuses the
 * ioredis client provided by DistributedLockModule (LOCK_REDIS_CLIENT
 * token) so we don't open yet another connection just for
 * short-lived download tokens.
 */
@Global()
@Module({
  imports: [DistributedLockModule],
  providers: [DownloadTokenService],
  exports: [DownloadTokenService],
})
export class DownloadTokenModule {}
