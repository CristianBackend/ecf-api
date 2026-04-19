/**
 * env.validation tests
 *
 * Exercises the Joi schema directly (no NestJS boot). The live boot path
 * wires this schema into `ConfigModule.forRoot({ validationSchema })`, which
 * applies the same rules and aborts process start if any check fails.
 */
import { envValidationSchema } from './env.validation';

const VALID_BASE = {
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
  REDIS_HOST: 'localhost',
  REDIS_PORT: 6379,
  JWT_SECRET: 'a'.repeat(32),
  CERT_ENCRYPTION_KEY: 'a'.repeat(64),
  DGII_ENVIRONMENT: 'DEV',
};

function validate(env: Record<string, unknown>) {
  return envValidationSchema.validate(env, { abortEarly: false });
}

describe('envValidationSchema', () => {
  it('accepts a fully-specified minimal environment and applies defaults', () => {
    const { error, value } = validate(VALID_BASE);
    expect(error).toBeUndefined();
    expect(value.NODE_ENV).toBe('development');
    expect(value.PORT).toBe(3000);
    expect(value.JWT_EXPIRATION).toBe('24h');
    expect(value.API_PREFIX).toBe('api/v1');
    expect(value.DGII_HTTP_TIMEOUT_MS).toBe(30000);
  });

  it('fails when DATABASE_URL is missing', () => {
    const { error } = validate({ ...VALID_BASE, DATABASE_URL: undefined });
    expect(error?.message).toMatch(/DATABASE_URL/);
  });

  it('rejects a non-postgres DATABASE_URL', () => {
    const { error } = validate({
      ...VALID_BASE,
      DATABASE_URL: 'mysql://u:p@localhost/db',
    });
    expect(error?.message).toMatch(/DATABASE_URL/);
  });

  it('fails when JWT_SECRET is shorter than 32 chars', () => {
    const { error } = validate({ ...VALID_BASE, JWT_SECRET: 'shorty' });
    expect(error?.message).toMatch(/JWT_SECRET must be at least 32 characters/);
  });

  it('fails when CERT_ENCRYPTION_KEY is missing', () => {
    const { error } = validate({ ...VALID_BASE, CERT_ENCRYPTION_KEY: undefined });
    expect(error?.message).toMatch(/CERT_ENCRYPTION_KEY is required/);
  });

  it('fails when CERT_ENCRYPTION_KEY is not exactly 64 hex chars', () => {
    const { error: tooShort } = validate({
      ...VALID_BASE,
      CERT_ENCRYPTION_KEY: 'abc',
    });
    expect(tooShort?.message).toMatch(/CERT_ENCRYPTION_KEY must be exactly 64/);

    const { error: nonHex } = validate({
      ...VALID_BASE,
      CERT_ENCRYPTION_KEY: 'z'.repeat(64),
    });
    expect(nonHex?.message).toMatch(/hex/);
  });

  it('rejects an invalid DGII_ENVIRONMENT', () => {
    const { error } = validate({
      ...VALID_BASE,
      DGII_ENVIRONMENT: 'SANDBOX',
    });
    expect(error?.message).toMatch(/DGII_ENVIRONMENT/);
  });

  it('reports multiple errors at once (abortEarly:false)', () => {
    const { error } = validate({
      DATABASE_URL: 'not-a-url',
      // REDIS_* missing
      JWT_SECRET: 'short',
      CERT_ENCRYPTION_KEY: 'wrong',
      DGII_ENVIRONMENT: 'NOPE',
    });
    expect(error).toBeDefined();
    expect(error!.details.length).toBeGreaterThanOrEqual(4);
    const messages = error!.details.map((d) => d.message).join(' | ');
    expect(messages).toMatch(/JWT_SECRET/);
    expect(messages).toMatch(/CERT_ENCRYPTION_KEY/);
    expect(messages).toMatch(/DGII_ENVIRONMENT/);
    expect(messages).toMatch(/REDIS_HOST/);
  });

  it('tolerates unknown variables (allowUnknown:true is set at call site)', () => {
    const { error } = envValidationSchema.validate(
      { ...VALID_BASE, SOMETHING_ELSE: 'x' },
      { abortEarly: false, allowUnknown: true },
    );
    expect(error).toBeUndefined();
  });
});
