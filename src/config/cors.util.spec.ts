import { parseCorsOrigins, buildCorsOriginOption } from './cors.util';

// ── parseCorsOrigins ────────────────────────────────────────────────────────

describe('parseCorsOrigins', () => {
  it('returns ["*"] for undefined input (dev default)', () => {
    expect(parseCorsOrigins(undefined)).toEqual(['*']);
  });

  it('returns ["*"] for empty string (dev default)', () => {
    expect(parseCorsOrigins('')).toEqual(['*']);
  });

  it('returns ["*"] for whitespace-only string', () => {
    expect(parseCorsOrigins('   ')).toEqual(['*']);
  });

  it('parses a single origin', () => {
    expect(parseCorsOrigins('https://app.example.com')).toEqual(['https://app.example.com']);
  });

  it('parses multiple comma-separated origins and trims whitespace', () => {
    expect(
      parseCorsOrigins('https://app.example.com , http://localhost:3000'),
    ).toEqual(['https://app.example.com', 'http://localhost:3000']);
  });

  it('filters out empty segments from double commas', () => {
    expect(
      parseCorsOrigins('https://a.com,,https://b.com'),
    ).toEqual(['https://a.com', 'https://b.com']);
  });

  it('handles trailing comma', () => {
    expect(parseCorsOrigins('https://a.com,')).toEqual(['https://a.com']);
  });
});

// ── buildCorsOriginOption ───────────────────────────────────────────────────

function call(
  fn: ReturnType<typeof buildCorsOriginOption>,
  origin: string | undefined,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    fn(origin, (err, allow) => {
      if (err) return reject(err);
      resolve(allow ?? false);
    });
  });
}

describe('buildCorsOriginOption', () => {
  describe('wildcard mode (default / dev)', () => {
    const fn = buildCorsOriginOption(undefined); // defaults to ['*']

    it('allows requests without Origin header', async () => {
      await expect(call(fn, undefined)).resolves.toBe(true);
    });

    it('allows any origin when list contains "*"', async () => {
      await expect(call(fn, 'https://any-origin.com')).resolves.toBe(true);
    });
  });

  describe('explicit allow-list', () => {
    const fn = buildCorsOriginOption(
      'https://app.example.com,http://localhost:3000',
    );

    it('allows requests without Origin (server-to-server)', async () => {
      await expect(call(fn, undefined)).resolves.toBe(true);
    });

    it('allows an origin that is in the list', async () => {
      await expect(call(fn, 'https://app.example.com')).resolves.toBe(true);
      await expect(call(fn, 'http://localhost:3000')).resolves.toBe(true);
    });

    it('rejects an origin not in the list', async () => {
      await expect(call(fn, 'https://attacker.com')).rejects.toThrow(/not allowed by CORS/);
    });

    it('rejects a partial match (prefix / suffix)', async () => {
      await expect(call(fn, 'https://evil-app.example.com')).rejects.toThrow();
      await expect(call(fn, 'http://localhost:3000.evil.com')).rejects.toThrow();
    });
  });

  describe('single explicit origin', () => {
    const fn = buildCorsOriginOption('https://node-a2.newplain.com');

    it('allows the configured origin', async () => {
      await expect(call(fn, 'https://node-a2.newplain.com')).resolves.toBe(true);
    });

    it('rejects any other origin', async () => {
      await expect(call(fn, 'https://other.com')).rejects.toThrow();
    });
  });
});
