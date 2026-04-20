import * as Joi from 'joi';

/**
 * Joi schema for runtime environment validation.
 *
 * Wired into `ConfigModule.forRoot({ validationSchema, validationOptions })`
 * so that the process fails immediately at boot — before we start any queue
 * consumers, open DB connections, or accept HTTP traffic — when the env is
 * incomplete or malformed. `abortEarly: false` is set at the call-site so
 * operators see ALL the failures in one go instead of fixing them one at a
 * time.
 */
export const envValidationSchema = Joi.object({
  // App
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),
  PORT: Joi.number().integer().min(1).max(65535).default(3000),
  API_PREFIX: Joi.string().default('api/v1'),
  CORS_ORIGIN: Joi.string()
    .default('*')
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.string().invalid('*').required().messages({
        'any.invalid':
          'CORS_ORIGIN must be an exact origin (e.g. https://app.example.com) in production; "*" is not allowed.',
        'any.required': 'CORS_ORIGIN is required in production.',
      }),
    }),

  // Database — required, any valid postgres/postgresql URL.
  DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgres', 'postgresql'] })
    .required(),
  DB_PASSWORD: Joi.string().optional().allow(''),
  DB_PORT: Joi.number().integer().min(1).max(65535).optional(),

  // Redis — required so BullMQ can connect.
  REDIS_HOST: Joi.string().required(),
  REDIS_PORT: Joi.number().integer().min(1).max(65535).required(),
  REDIS_PASSWORD: Joi.string().optional().allow(''),

  // Auth / JWT — secret must be strong enough that brute-force is infeasible.
  JWT_SECRET: Joi.string().min(32).required().messages({
    'string.min': 'JWT_SECRET must be at least 32 characters.',
    'any.required': 'JWT_SECRET is required.',
  }),
  JWT_EXPIRATION: Joi.string().default('24h'),
  API_KEY_PREFIX: Joi.string().default('frd'),

  // Certificate keystore encryption — exactly 32 bytes of entropy.
  CERT_ENCRYPTION_KEY: Joi.string()
    .length(64)
    .pattern(/^[0-9a-fA-F]{64}$/)
    .required()
    .messages({
      'string.length':
        'CERT_ENCRYPTION_KEY must be exactly 64 hex characters (32 bytes).',
      'string.pattern.base':
        'CERT_ENCRYPTION_KEY must contain only hex characters (0-9, a-f).',
      'any.required': 'CERT_ENCRYPTION_KEY is required.',
    }),

  // DGII
  DGII_ENVIRONMENT: Joi.string().valid('DEV', 'CERT', 'PROD').required(),
  DGII_STATUS_API_KEY: Joi.string().optional().allow(''),
  DGII_HTTP_TIMEOUT_MS: Joi.number().integer().min(1000).default(30000),

  // Rate limiting
  THROTTLE_TTL: Joi.number().integer().min(1000).default(60000),
  THROTTLE_LIMIT: Joi.number().integer().min(1).default(60),

  // AWS (all optional; implementation placeholders)
  AWS_REGION: Joi.string().optional().allow(''),
  AWS_KMS_KEY_ID: Joi.string().optional().allow(''),
  AWS_S3_BUCKET: Joi.string().optional().allow(''),

  // Observability
  LOG_LEVEL: Joi.string()
    .valid('trace', 'debug', 'info', 'warn', 'error')
    .default('info'),
});
