import { Global, Module } from '@nestjs/common';
import { EncryptionService } from './encryption.service';

/**
 * Global module so any injected `EncryptionService` resolves to the single
 * instance constructed from `process.env.CERT_ENCRYPTION_KEY`.
 */
@Global()
@Module({
  providers: [
    {
      provide: EncryptionService,
      useFactory: () => new EncryptionService(),
    },
  ],
  exports: [EncryptionService],
})
export class EncryptionModule {}
