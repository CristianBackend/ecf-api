/**
 * AppModule DI smoke test — regression guard for dependency injection errors.
 *
 * WHY THIS TEST EXISTS:
 * Unit tests mock all services, so missing provider exports only surface when
 * NestJS boots the real DI container. This test compiles the full module graph
 * with NO overrides and catches "Nest can't resolve dependencies of XService"
 * before it reaches production.
 *
 * HOW IT WORKS:
 * • Uses the REAL LoggerModule (no overrideModule). All per-class
 *   PinoLogger tokens are registered correctly because app.module.ts now
 *   imports LoggerModule LAST — after all feature modules have loaded and
 *   their @InjectPinoLogger decorators have registered in nestjs-pino's
 *   global decoratedLoggers Set.
 * • Env vars are seeded by src/test/env-setup.ts (jest setupFiles) so
 *   ConfigModule.forRoot({ validationSchema }) passes at import time.
 * • compile() does NOT invoke onModuleInit hooks, so no real DB/Redis
 *   connections are made during the test.
 */
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from './app.module';
import { LOCK_REDIS_CLIENT } from './common/services/distributed-lock.service';

describe('AppModule (DI smoke test)', () => {
  let module: TestingModule;

  it('compiles the full module graph with real providers — no DI errors', async () => {
    // Any unresolved token (missing export, missing LoggerModule import, etc.)
    // causes compile() to throw immediately — caught as a test failure.
    module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    expect(module).toBeDefined();
  }, 30_000);

  afterAll(async () => {
    if (!module) return;

    // Quit the ioredis client to release its reconnect timer so Jest exits
    // cleanly without open-handle warnings.
    try {
      const redis: any = module.get(LOCK_REDIS_CLIENT, { strict: false });
      if (redis && typeof redis.quit === 'function') await redis.quit();
    } catch {
      // Redis may be unreachable in CI — ignore connection errors
    }

    await module.close();
  });
});
