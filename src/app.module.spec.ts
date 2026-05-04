/**
 * AppModule DI smoke test — regression guard for dependency injection errors.
 *
 * WHY THIS TEST EXISTS:
 * Unit tests mock all services. A missing provider export — like
 * LOCK_REDIS_CLIENT not exported from DistributedLockModule — only surfaces
 * when NestJS boots the real DI container. This test compiles the full module
 * graph and catches "Nest can't resolve dependencies of XService (?)" before
 * it reaches production.
 *
 * DESIGN DECISIONS:
 * • overrideModule(LoggerModule).useModule(TestLoggerModule): the real
 *   LoggerModule uses PinoLoggerModule.forRootAsync() which needs ConfigService.
 *   In the testing context, the async pino factory creates per-class
 *   "PinoLogger:<ClassName>" tokens that NestJS can't always resolve before
 *   dependent modules are instantiated. TestLoggerModule uses forRoot() (sync,
 *   no deps) and registers a silent global pino logger that satisfies all
 *   @InjectPinoLogger() injection points.
 * • Env vars are set by src/test/env-setup.ts via jest setupFiles so
 *   ConfigModule.forRoot({ validationSchema }) passes when app.module.ts is
 *   first imported.
 * • compile() does NOT call onModuleInit lifecycle hooks, so no real DB or
 *   Redis connections are attempted during the test.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from './app.module';
import { LoggerModule } from './common/logger/logger.module';
import { TestLoggerModule } from './common/logger/test-logger.module';
import { LOCK_REDIS_CLIENT } from './common/services/distributed-lock.service';

describe('AppModule (DI smoke test)', () => {
  let module: TestingModule;

  it('compiles the full module graph and resolves every provider dependency', async () => {
    // overrideModule replaces the real async pino logger with the synchronous
    // test variant so all @InjectPinoLogger() tokens resolve without needing
    // ConfigService to be initialized first.
    module = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideModule(LoggerModule)
      .useModule(TestLoggerModule)
      .compile();

    // If any token is unresolved (missing import/export) compile() throws.
    expect(module).toBeDefined();
  }, 30_000);

  afterAll(async () => {
    if (!module) return;

    // Quit the ioredis client to release its reconnect timer and let Jest exit.
    try {
      const redis: any = module.get(LOCK_REDIS_CLIENT, { strict: false });
      if (redis && typeof redis.quit === 'function') await redis.quit();
    } catch {
      // Redis may be unreachable in CI — ignore connection errors
    }

    await module.close();
  });
});
