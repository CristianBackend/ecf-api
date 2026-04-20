import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule as PinoLoggerModule } from 'nestjs-pino';
import { IncomingMessage } from 'http';
import { randomUUID } from 'crypto';

/**
 * Fields that must never appear in logs, in plaintext. Applied as a pino
 * redact filter at the root logger, so every child logger (HTTP request,
 * BullMQ job, per-class contexts) inherits the masking.
 */
export const LOG_REDACT_PATHS: ReadonlyArray<string> = [
  // Request/response headers carrying auth material
  'req.headers.authorization',
  'req.headers["x-api-key"]',
  'req.headers["x-ecf-signature"]',
  'req.headers.cookie',
  'headers.authorization',
  'headers["x-api-key"]',
  'headers["x-ecf-signature"]',
  'headers.cookie',
  // Domain-level secrets
  '*.passphrase',
  'passphrase',
  '*.password',
  'password',
  '*.encryptedP12',
  'encryptedP12',
  '*.encryptedPass',
  'encryptedPass',
  '*.secret_enc',
  'secret_enc',
  '*.secretEnc',
  'secretEnc',
  '*.secret',
  'secret',
  '*.jwt',
  'jwt',
  '*.apiKey',
  'apiKey',
  // Nested inside request bodies
  'req.body.passphrase',
  'req.body.p12Base64',
];

/**
 * Global pino-backed logger.
 *
 * - Dev (NODE_ENV !== 'production'): pino-pretty with colors, single-line,
 *   human readable for `npm run start:dev`.
 * - Prod: JSON lines, one object per log, parseable by CloudWatch / Datadog
 *   / Loki out-of-the-box.
 *
 * Every inbound HTTP request gets an `x-request-id` header assigned (or
 * reused if the client sent one) and the id is stapled to every subsequent
 * log inside the request lifecycle via `customProps`.
 */
@Module({
  imports: [
    PinoLoggerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const isProd = config.get<string>('NODE_ENV') === 'production';
        const level = config.get<string>('LOG_LEVEL', isProd ? 'info' : 'debug');

        return {
          pinoHttp: {
            level,
            transport: isProd
              ? undefined
              : {
                  target: 'pino-pretty',
                  options: {
                    colorize: true,
                    singleLine: true,
                    translateTime: 'SYS:HH:MM:ss.l',
                    ignore: 'pid,hostname,req,res,responseTime,context',
                    messageFormat: '[{context}] {msg}',
                  },
                },
            genReqId: (req: IncomingMessage) => {
              const existing = req.headers['x-request-id'];
              if (typeof existing === 'string' && existing.length > 0) {
                return existing;
              }
              return randomUUID();
            },
            customProps: (req: IncomingMessage) => {
              const tenant = (req as any).tenant;
              return tenant?.id ? { tenantId: tenant.id } : {};
            },
            // Standard HTTP log line on every request completion.
            customLogLevel: (_req, res, err) => {
              if (err || (res.statusCode ?? 0) >= 500) return 'error';
              if ((res.statusCode ?? 0) >= 400) return 'warn';
              return 'info';
            },
            customSuccessMessage: (req, res) =>
              `${req.method} ${(req as any).originalUrl ?? req.url} ${res.statusCode}`,
            customErrorMessage: (req, res, err) =>
              `${req.method} ${(req as any).originalUrl ?? req.url} ${res.statusCode} — ${err.message}`,
            redact: {
              paths: [...LOG_REDACT_PATHS],
              censor: '[REDACTED]',
            },
          },
        };
      },
    }),
  ],
  exports: [PinoLoggerModule],
})
export class LoggerModule {}
