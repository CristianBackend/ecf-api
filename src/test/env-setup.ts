/**
 * Jest setupFiles entry — runs in each test worker BEFORE any spec file is
 * imported. Setting env vars here guarantees they are in process.env when
 * ConfigModule.forRoot({ validationSchema }) evaluates synchronously inside
 * the @Module decorator at class-definition (import) time.
 *
 * Values are filled only when the variable is absent or invalid so a real
 * .env file (or CI secrets) always takes precedence.
 */

// DATABASE_URL — required by Joi; any valid postgres URL passes format check
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL =
    'postgresql://test:test@localhost:5432/ecf_test';
}

// Redis — required by Joi
process.env.REDIS_HOST = process.env.REDIS_HOST || 'localhost';
process.env.REDIS_PORT = process.env.REDIS_PORT || '6379';

// JWT_SECRET — must be ≥ 32 chars
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  process.env.JWT_SECRET = 'jest-test-jwt-secret-padded-to-32-chars-xxxxx';
}

// CERT_ENCRYPTION_KEY — must be exactly 64 hex chars
if (!/^[0-9a-fA-F]{64}$/.test(process.env.CERT_ENCRYPTION_KEY || '')) {
  process.env.CERT_ENCRYPTION_KEY = 'a'.repeat(64);
}

// DGII_ENVIRONMENT — required by Joi enum
process.env.DGII_ENVIRONMENT = process.env.DGII_ENVIRONMENT || 'DEV';
