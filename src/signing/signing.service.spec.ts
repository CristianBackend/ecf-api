/**
 * SigningService tests — XMLDSig via xml-crypto
 *
 * Covers: signing, verification, round-trips for every e-CF document root type
 * DGII uses (ECF, SemillaModel, ARECF, ACECF, ANECF, RFCE), certificate SN
 * validation, special characters, multiple namespaces, and KeyInfo structure.
 */
import { SigningService } from './signing.service';
import { buildTestP12, TestP12 } from './test-fixtures';
import { makeTestLogger } from '../common/logger/test-logger';

describe('SigningService', () => {
  let service: SigningService;
  let testP12: TestP12;
  let otherP12: TestP12;

  beforeAll(() => {
    testP12 = buildTestP12({ rnc: '00000000000' });
    otherP12 = buildTestP12({ rnc: '99999999999' });
  });

  beforeEach(() => {
    service = new SigningService(makeTestLogger());
  });

  // ----------------------------------------------------------
  // signXml — happy paths for all document root types
  // ----------------------------------------------------------

  describe('signXml', () => {
    it('signs an e-CF E31 (Crédito Fiscal) XML', () => {
      const xml = buildE31Xml();
      const result = service.signXml(xml, testP12.privateKeyPem, testP12.certificatePem);

      expect(result.signedXml).toContain('<Signature');
      expect(result.signedXml).toContain('<SignedInfo');
      expect(result.signedXml).toContain('<SignatureValue');
      expect(result.signedXml).toContain('<X509Certificate');
      expect(result.securityCode).toMatch(/^[0-9A-F]{6}$/);
      expect(result.signatureValue.length).toBeGreaterThan(0);
      expect(result.signTime).toBeInstanceOf(Date);
    });

    it('inserts FechaHoraFirma inside <ECF> root (signing order)', () => {
      const xml = buildE31Xml();
      const { signedXml } = service.signXml(
        xml,
        testP12.privateKeyPem,
        testP12.certificatePem,
      );
      expect(signedXml).toMatch(/<FechaHoraFirma>\d{2}-\d{2}-\d{4} \d{2}:\d{2}:\d{2}<\/FechaHoraFirma>/);
      // FechaHoraFirma must come BEFORE the Signature element per DGII
      const firmaIdx = signedXml.indexOf('<FechaHoraFirma>');
      const sigIdx = signedXml.indexOf('<Signature');
      expect(firmaIdx).toBeGreaterThan(0);
      expect(sigIdx).toBeGreaterThan(firmaIdx);
    });

    it('signs an RFCE (E32 consumo bajo umbral)', () => {
      const xml = buildRfceXml();
      const result = service.signXml(xml, testP12.privateKeyPem, testP12.certificatePem);
      expect(result.signedXml).toContain('<Signature');
      expect(result.signedXml).toMatch(/<\/Signature>\s*<\/RFCE>$/);
    });

    it('signs a SemillaModel (autenticación DGII) without FechaHoraFirma', () => {
      const xml =
        '<SemillaModel><Valor>abcd1234</Valor><Fecha>2026-04-19T12:00:00</Fecha></SemillaModel>';
      const { signedXml } = service.signXml(
        xml,
        testP12.privateKeyPem,
        testP12.certificatePem,
      );
      expect(signedXml).not.toContain('<FechaHoraFirma>');
      expect(signedXml).toMatch(/<\/Signature>\s*<\/SemillaModel>$/);
    });

    it('signs an ARECF (recepción) without FechaHoraFirma', () => {
      const xml =
        '<ARECF><DetalleAcuseRecibo><RNCEmisor>131234567</RNCEmisor><Estado>0</Estado></DetalleAcuseRecibo></ARECF>';
      const { signedXml } = service.signXml(
        xml,
        testP12.privateKeyPem,
        testP12.certificatePem,
      );
      expect(signedXml).not.toContain('<FechaHoraFirma>');
      expect(signedXml).toMatch(/<\/Signature>\s*<\/ARECF>$/);
    });

    it('signs an ACECF (aprobación comercial) without FechaHoraFirma', () => {
      const xml =
        '<ACECF><DetalleAprobacionComercial><RNCEmisor>131234567</RNCEmisor><Estado>1</Estado></DetalleAprobacionComercial></ACECF>';
      const { signedXml } = service.signXml(
        xml,
        testP12.privateKeyPem,
        testP12.certificatePem,
      );
      expect(signedXml).not.toContain('<FechaHoraFirma>');
      expect(signedXml).toMatch(/<\/Signature>\s*<\/ACECF>$/);
    });

    it('signs an ANECF (anulación) without FechaHoraFirma', () => {
      const xml =
        '<ANECF><Encabezado><RNCEmisor>131234567</RNCEmisor></Encabezado></ANECF>';
      const { signedXml } = service.signXml(
        xml,
        testP12.privateKeyPem,
        testP12.certificatePem,
      );
      expect(signedXml).not.toContain('<FechaHoraFirma>');
      expect(signedXml).toMatch(/<\/Signature>\s*<\/ANECF>$/);
    });

    it('places <Signature> as the LAST child of the root element', () => {
      const xml = buildE31Xml();
      const { signedXml } = service.signXml(
        xml,
        testP12.privateKeyPem,
        testP12.certificatePem,
      );
      expect(signedXml.trim()).toMatch(/<\/Signature>\s*<\/ECF>$/);
    });

    it('produces a KeyInfo with X509Data/X509Certificate (base64 DER, no PEM headers)', () => {
      const xml = buildE31Xml();
      const { signedXml } = service.signXml(
        xml,
        testP12.privateKeyPem,
        testP12.certificatePem,
      );
      const m = signedXml.match(
        /<KeyInfo>[\s\S]*?<X509Data>[\s\S]*?<X509Certificate>([\s\S]*?)<\/X509Certificate>[\s\S]*?<\/X509Data>[\s\S]*?<\/KeyInfo>/,
      );
      expect(m).toBeTruthy();
      const certBody = m![1].replace(/\s/g, '');
      expect(certBody).not.toMatch(/BEGIN CERTIFICATE/);
      expect(certBody).not.toMatch(/END CERTIFICATE/);
      // Pure base64 (alphanumeric + /+=)
      expect(certBody).toMatch(/^[A-Za-z0-9+/=]+$/);
      expect(certBody.length).toBeGreaterThan(100);
    });

    it('uses C14N 1.0, enveloped + C14N transforms, SHA-256 and RSA-SHA256', () => {
      const xml = buildE31Xml();
      const { signedXml } = service.signXml(
        xml,
        testP12.privateKeyPem,
        testP12.certificatePem,
      );
      expect(signedXml).toContain(
        'Algorithm="http://www.w3.org/TR/2001/REC-xml-c14n-20010315"',
      );
      expect(signedXml).toContain(
        'Algorithm="http://www.w3.org/2000/09/xmldsig#enveloped-signature"',
      );
      expect(signedXml).toContain(
        'Algorithm="http://www.w3.org/2001/04/xmlenc#sha256"',
      );
      expect(signedXml).toContain(
        'Algorithm="http://www.w3.org/2001/04/xmldsig-more#rsa-sha256"',
      );
      expect(signedXml).toMatch(/<Reference\s+URI=""/);
    });

    it('handles XML with accents, ñ, and escaped characters (&amp; &lt; &gt; &quot;)', () => {
      const xml =
        '<ECF><Emisor><RazonSocial>Ñoño &amp; Asociados S.R.L. &lt;Dom&gt;</RazonSocial><Direccion>Avenida Ñ, Ciudad &quot;X&quot;</Direccion></Emisor></ECF>';
      const result = service.signXml(
        xml,
        testP12.privateKeyPem,
        testP12.certificatePem,
      );
      expect(result.signedXml).toContain('<Signature');
      // Round-trip must still validate
      const verified = service.verifySignedXml(result.signedXml);
      expect(verified.certificatePem).toContain('BEGIN CERTIFICATE');
    });

    it('handles XML with multiple namespaces on descendant elements', () => {
      const xml =
        '<ECF xmlns="http://dgii.gov.do/ecf" xmlns:ext="http://example.com/ext">' +
        '<ext:Data>value</ext:Data><Encabezado><Item>x</Item></Encabezado></ECF>';
      const result = service.signXml(
        xml,
        testP12.privateKeyPem,
        testP12.certificatePem,
      );
      expect(result.signedXml).toContain('<Signature');
      const verified = service.verifySignedXml(result.signedXml);
      expect(verified.certificatePem).toContain('BEGIN CERTIFICATE');
    });
  });

  // ----------------------------------------------------------
  // Round-trip: sign + verify
  // ----------------------------------------------------------

  describe('round-trip signXml + verifySignedXml', () => {
    it('verifies an unmodified signed XML', () => {
      const xml = buildE31Xml();
      const { signedXml } = service.signXml(
        xml,
        testP12.privateKeyPem,
        testP12.certificatePem,
      );
      const verified = service.verifySignedXml(signedXml);
      expect(verified.certificatePem).toContain('BEGIN CERTIFICATE');
    });

    it('fails verification when a byte of the signed body is mutated', () => {
      const xml = buildE31Xml();
      const { signedXml } = service.signXml(
        xml,
        testP12.privateKeyPem,
        testP12.certificatePem,
      );
      // Tamper with a business-data element before the Signature block
      const tampered = signedXml.replace(
        '<RNCEmisor>131234567</RNCEmisor>',
        '<RNCEmisor>131234568</RNCEmisor>',
      );
      expect(tampered).not.toEqual(signedXml);
      expect(() => service.verifySignedXml(tampered)).toThrow();
    });

    it('fails verification when SignatureValue is mutated', () => {
      const xml = buildE31Xml();
      const { signedXml, signatureValue } = service.signXml(
        xml,
        testP12.privateKeyPem,
        testP12.certificatePem,
      );
      // Flip the first char of the signature value
      const flipped =
        signatureValue[0] === 'A' ? 'B' + signatureValue.slice(1) : 'A' + signatureValue.slice(1);
      const tampered = signedXml.replace(signatureValue, flipped);
      expect(tampered).not.toEqual(signedXml);
      expect(() => service.verifySignedXml(tampered)).toThrow();
    });

    it('getSecurityCode extracts the same code from a signed XML', () => {
      const xml = buildE31Xml();
      const { signedXml, securityCode } = service.signXml(
        xml,
        testP12.privateKeyPem,
        testP12.certificatePem,
      );
      expect(service.getSecurityCode(signedXml)).toEqual(securityCode);
    });
  });

  // ----------------------------------------------------------
  // extractFromP12 — passphrase, RNC mismatch, SN==RNC validation
  // ----------------------------------------------------------

  describe('extractFromP12', () => {
    it('extracts privateKey + certificate from a valid .p12', () => {
      const { privateKey, certificate } = service.extractFromP12(
        testP12.p12Buffer,
        testP12.passphrase,
      );
      expect(privateKey).toContain('BEGIN');
      expect(certificate).toContain('BEGIN CERTIFICATE');
    });

    it('rejects a wrong passphrase', () => {
      expect(() =>
        service.extractFromP12(testP12.p12Buffer, 'wrong-passphrase'),
      ).toThrow();
    });

    it('throws when the certificate SN does not match the expected RNC', () => {
      // testP12 has RNC 00000000000; ask for a different one
      expect(() =>
        service.extractFromP12(
          testP12.p12Buffer,
          testP12.passphrase,
          '99999999999',
        ),
      ).toThrow(/RNC esperado/);
    });

    it('succeeds when the certificate SN matches the expected RNC', () => {
      const { certificate } = service.extractFromP12(
        testP12.p12Buffer,
        testP12.passphrase,
        testP12.rnc,
      );
      expect(certificate).toContain('BEGIN CERTIFICATE');
    });

    it('rejects a signed XML made with the wrong emitter certificate at the SN==RNC check', () => {
      // Sign an XML with `otherP12` keys, but assume emitter RNC is testP12.rnc
      const xml = buildE31Xml();
      const signed = service.signXml(
        xml,
        otherP12.privateKeyPem,
        otherP12.certificatePem,
      );
      // Verification should still pass (cert chains to its own key)...
      service.verifySignedXml(signed.signedXml);
      // ...but extractFromP12 for the emitter would reject
      expect(() =>
        service.extractFromP12(otherP12.p12Buffer, otherP12.passphrase, testP12.rnc),
      ).toThrow();
    });
  });
});

// ============================================================
// Test fixtures — minimal e-CF XMLs for signing
// ============================================================

function buildE31Xml(): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<ECF>' +
    '<Encabezado>' +
    '<Emisor><RNCEmisor>131234567</RNCEmisor></Emisor>' +
    '<Comprador><RNCComprador>101234567</RNCComprador></Comprador>' +
    '<Totales><MontoTotal>1180.00</MontoTotal></Totales>' +
    '</Encabezado>' +
    '<DetallesItems><Item><NumeroLinea>1</NumeroLinea></Item></DetallesItems>' +
    '</ECF>'
  );
}

function buildRfceXml(): string {
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<RFCE>' +
    '<Encabezado><Emisor><RNCEmisor>131234567</RNCEmisor></Emisor></Encabezado>' +
    '</RFCE>'
  );
}
