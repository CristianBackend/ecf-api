import { PinoLogger } from 'nestjs-pino';

/**
 * No-op PinoLogger for unit tests that instantiate services directly (no
 * Nest DI). Prevents every `this.logger.info(...)` call from needing a
 * runtime Jest mock.
 */
export function makeTestLogger(): PinoLogger {
  const noop = () => undefined;
  return {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    setContext: noop,
    assign: noop,
    logger: {
      child: () => makeTestLogger(),
      trace: noop,
      debug: noop,
      info: noop,
      warn: noop,
      error: noop,
      fatal: noop,
    },
  } as unknown as PinoLogger;
}
