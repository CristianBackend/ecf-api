import { Module } from '@nestjs/common';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';

/**
 * Minimal logger module for Jest specs. Silences every log and skips the
 * pino-pretty transport so tests don't need to mock pino or providers
 * per-class.
 *
 * Import this from any `Test.createTestingModule` that includes a provider
 * wired with `@InjectPinoLogger(...)`.
 */
@Module({
  imports: [
    PinoLoggerModule.forRoot({
      pinoHttp: {
        // `silent` is a real pino level higher than `fatal`; anything logged
        // is dropped before serialization.
        level: 'silent',
      },
    }),
  ],
  exports: [PinoLoggerModule],
})
export class TestLoggerModule {}
