import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { TenantsModule } from './tenants/tenants.module';
import { CompaniesModule } from './tenants/companies.module';
import { CertificatesModule } from './certificates/certificates.module';
import { SequencesModule } from './sequences/sequences.module';
import { XmlBuilderModule } from './xml-builder/xml-builder.module';
import { SigningModule } from './signing/signing.module';
import { DgiiModule } from './dgii/dgii.module';
import { InvoicesModule } from './invoices/invoices.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { PdfModule } from './pdf/pdf.module';
import { ContingencyModule } from './contingency/contingency.module';
import { ReceptionModule } from './reception/reception.module';
import { HealthModule } from './health/health.module';
import { ValidationModule } from './validation/validation.module';
import { RncModule } from './common/services/rnc.module';
import { EncryptionModule } from './common/services/encryption.module';
import { BuyersModule } from './buyers/buyers.module';
import { QueueModule } from './queue/queue.module';
import { SchedulerModule } from './scheduler/scheduler.module';
import configuration from './config/configuration';
import { envValidationSchema } from './config/env.validation';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validationSchema: envValidationSchema,
      validationOptions: {
        abortEarly: false, // surface ALL env errors at once, not one-by-one
        allowUnknown: true, // tolerate deployment-platform-injected variables
      },
    }),

    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        throttlers: [
          {
            ttl: config.get('THROTTLE_TTL', 60000),
            limit: config.get('THROTTLE_LIMIT', 60),
          },
        ],
      }),
    }),

    // BullMQ Redis connection (global)
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get('REDIS_HOST', 'localhost'),
          port: config.get('REDIS_PORT', 6379),
          password: config.get('REDIS_PASSWORD', '') || undefined,
        },
        defaultJobOptions: {
          removeOnComplete: { age: 86400 },
          removeOnFail: { age: 604800 },
        },
      }),
    }),

    // Phase 1 - Foundation
    PrismaModule,
    EncryptionModule,
    AuthModule,
    RncModule,
    TenantsModule,
    CompaniesModule,
    BuyersModule,
    CertificatesModule,
    SequencesModule,

    // Phase 2 - Core Billing
    ValidationModule,
    XmlBuilderModule,
    SigningModule,
    DgiiModule,
    InvoicesModule,

    // Phase 3 - Async Processing
    QueueModule,

    // Phase 4 - Complements
    WebhooksModule,
    PdfModule,
    ContingencyModule,
    ReceptionModule,
    SchedulerModule,

    // Utils
    HealthModule,
  ],
})
export class AppModule {}
