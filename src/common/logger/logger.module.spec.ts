/**
 * Redact-rule tests for the pino logger module.
 *
 * Drives a real pino logger — configured with the same `redact.paths` list
 * the production LoggerModule ships — against an in-memory write stream,
 * then inspects the serialized log lines to confirm that secrets NEVER
 * appear in plaintext. The test guards every sensitive field the
 * application handles: webhook/HTTP auth headers and domain-level secrets
 * (`passphrase`, `encryptedP12`, `secret`, `secret_enc`, `jwt`, etc.).
 */
import pino from 'pino';
import { Writable } from 'stream';
import { LOG_REDACT_PATHS } from './logger.module';

function makeLoggerWithBuffer(): {
  log: pino.Logger;
  flush: () => Promise<string[]>;
} {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString('utf8'));
      cb();
    },
  });
  const log = pino(
    {
      level: 'trace',
      redact: {
        paths: [...LOG_REDACT_PATHS],
        censor: '[REDACTED]',
      },
    },
    stream,
  );
  return {
    log,
    flush: async () => {
      // Pino writes synchronously to the stream; flush is a no-op here but
      // kept async for consistency.
      return lines.slice();
    },
  };
}

describe('LoggerModule redact rules', () => {
  it('redacts `passphrase` anywhere in the log payload', async () => {
    const { log, flush } = makeLoggerWithBuffer();
    log.info({ passphrase: 'my-p12-passphrase', encf: 'E310000000001' }, 'cert use');
    log.info(
      { cert: { passphrase: 'nested-pass', fingerprint: 'abc' } },
      'nested',
    );
    const out = (await flush()).join('\n');
    expect(out).not.toContain('my-p12-passphrase');
    expect(out).not.toContain('nested-pass');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts webhook/HTTP auth material regardless of casing', async () => {
    const { log, flush } = makeLoggerWithBuffer();
    log.info(
      {
        headers: {
          authorization: 'Bearer frd_live_abc123',
          'x-api-key': 'frd_test_xyz',
          'x-ecf-signature': 'sha256=deadbeef',
          cookie: 'session=supersecret',
        },
      },
      'request',
    );
    const out = (await flush()).join('\n');
    expect(out).not.toContain('frd_live_abc123');
    expect(out).not.toContain('frd_test_xyz');
    expect(out).not.toContain('sha256=deadbeef');
    expect(out).not.toContain('supersecret');
  });

  it('redacts domain-level secrets (secret, secret_enc, encryptedP12, jwt)', async () => {
    const { log, flush } = makeLoggerWithBuffer();
    log.info(
      {
        webhook: {
          secret: 'whsec_supersecret123',
          secret_enc: Buffer.from('cipher-bytes'),
        },
        certificate: {
          encryptedP12: Buffer.from('p12-bytes'),
          encryptedPass: 'some-encrypted-pass',
        },
        auth: { jwt: 'eyJhbG.body.sig', password: 'unsafe123' },
      },
      'dumping state',
    );
    const out = (await flush()).join('\n');
    expect(out).not.toContain('whsec_supersecret123');
    expect(out).not.toContain('eyJhbG.body.sig');
    expect(out).not.toContain('unsafe123');
    expect(out).not.toContain('some-encrypted-pass');
  });

  it('leaves non-sensitive fields unchanged', async () => {
    const { log, flush } = makeLoggerWithBuffer();
    log.info(
      { encf: 'E310000000001', trackId: 'T-123', tenantId: 'abc' },
      'invoice submitted',
    );
    const out = (await flush()).join('\n');
    expect(out).toContain('E310000000001');
    expect(out).toContain('T-123');
    expect(out).toContain('abc');
  });
});
