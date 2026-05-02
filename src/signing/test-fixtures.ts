/**
 * Test-only fixtures for signing tests.
 *
 * Generates ephemeral RSA 2048 keypairs and self-signed certificates via
 * node-forge, then wraps them in a PKCS#12 buffer. Never commit real
 * certificates.
 *
 * NOTE: RSA 2048 generation is slow (~2-5s); always call `buildTestP12()`
 * inside `beforeAll` and reuse the result across tests in the same suite.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const forge = require('node-forge');

export interface TestP12 {
  p12Buffer: Buffer;
  passphrase: string;
  privateKeyPem: string;
  certificatePem: string;
  rnc: string;
}

export function buildTestP12(options: {
  rnc?: string;
  passphrase?: string;
  commonName?: string;
  /** OID 2.5.4.5 (SERIALNUMBER) value. Defaults to 'IDCDO-' + rnc (cédula format per DGII delegate model). */
  serialNumber?: string;
  /** Certificate notBefore date. Defaults to now. */
  notBefore?: Date;
  /** Certificate notAfter date. Defaults to notBefore + 1 year. */
  notAfter?: Date;
} = {}): TestP12 {
  const rnc = options.rnc ?? '00000000000';
  const passphrase = options.passphrase ?? 'test-passphrase';
  const commonName = options.commonName ?? `Test Firmante ${rnc}`;
  const serialNumberValue = options.serialNumber ?? `IDCDO-${rnc}`;

  const notBefore = options.notBefore ?? new Date();
  const notAfter = options.notAfter ?? (() => {
    const d = new Date(notBefore);
    d.setFullYear(d.getFullYear() + 1);
    return d;
  })();

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = notBefore;
  cert.validity.notAfter = notAfter;

  // Subject attribute 2.5.4.5 = serialNumber (SERIALNUMBER field per DGII delegate model)
  // For DGII-issued certs the value is 'IDCDO-XXXXXXXXXXX' (cédula of the signer person).
  const attrs = [
    { name: 'commonName', value: commonName },
    { name: 'countryName', value: 'DO' },
    { shortName: 'ST', value: 'Santo Domingo' },
    { name: 'organizationName', value: 'Test SRL' },
    { type: '2.5.4.5', value: serialNumberValue },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const p12Asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], passphrase, {
    algorithm: '3des',
  });
  const p12Der = forge.asn1.toDer(p12Asn1).getBytes();
  const p12Buffer = Buffer.from(p12Der, 'binary');

  return {
    p12Buffer,
    passphrase,
    privateKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
    certificatePem: forge.pki.certificateToPem(cert),
    rnc,
  };
}
