/**
 * scripts/test-dgii-ecf-signing.ts
 *
 * Compares OLD signing (xml-crypto only, no attr sorting) vs NEW signing
 * (dgii-ecf with DGII-compliant attr-sorted Digest) side by side.
 *
 * Outputs:
 *  1. DigestValue difference (the root-cause of DGII rejection)
 *  2. Transform count difference (old: 2, new: 1)
 *  3. validateXMLCertificate results for both XMLs
 *
 * Usage:
 *   npx ts-node scripts/test-dgii-ecf-signing.ts
 *   npx ts-node scripts/test-dgii-ecf-signing.ts --p12 /path/to/cert.p12 --pass mypassphrase
 */

/* eslint-disable no-console */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const forge = require('node-forge');
import { SignedXml } from 'xml-crypto';
import { Signature as DgiiSignature, validateXMLCertificate } from 'dgii-ecf';
import * as fs from 'fs';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const p12Path = args[args.indexOf('--p12') + 1];
const p12Pass = args[args.indexOf('--pass') + 1] || '';

// ---------------------------------------------------------------------------
// Test XML (minimal real-world ECF structure)
// ---------------------------------------------------------------------------
const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ECF xmlns="http://dgii.gov.do/eCF">
  <Encabezado>
    <Version>1.0</Version>
    <IdDoc>
      <TipoeCF>32</TipoeCF>
      <eNCF>E320000000011</eNCF>
      <FechaEmision>01-04-2020</FechaEmision>
      <FechaVencimientoSecuencia>31-12-2027</FechaVencimientoSecuencia>
      <TipoPago>1</TipoPago>
    </IdDoc>
    <Emisor>
      <RNCEmisor>133158744</RNCEmisor>
      <RazonSocialEmisor>Empresa Ejemplo SRL</RazonSocialEmisor>
    </Emisor>
    <Comprador>
      <RazonSocialComprador>Consumidor Final</RazonSocialComprador>
    </Comprador>
    <Totales>
      <MontoGravadoI1>1000.00</MontoGravadoI1>
      <TotalITBIS1>180.00</TotalITBIS1>
      <MontoTotal>1180.00</MontoTotal>
    </Totales>
  </Encabezado>
</ECF>`;

// ---------------------------------------------------------------------------
// Build a test keypair (or load from P12)
// ---------------------------------------------------------------------------
function buildTestKeyPair(): { privateKey: string; certificate: string } {
  if (p12Path && fs.existsSync(p12Path)) {
    console.log(`\n📄 Loading P12 from: ${p12Path}`);
    const p12b64 = fs.readFileSync(p12Path, 'base64');
    const der = forge.util.decode64(p12b64);
    const asn1 = forge.asn1.fromDer(der);
    const p12 = forge.pkcs12.pkcs12FromAsn1(asn1, p12Pass);

    const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
    const keyBag = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag]![0];
    const privateKey = forge.pki.privateKeyToPem(keyBag.key);

    const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
    const certBag = certBags[forge.pki.oids.certBag]![0];
    const certificate = forge.pki.certificateToPem(certBag.cert);

    return { privateKey, certificate };
  }

  // Generate ephemeral test key
  console.log('\n🔑 No --p12 provided — generating ephemeral RSA-2048 test key...');
  const keypair = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keypair.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
  const attrs = [{ name: 'commonName', value: 'Test Signer' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keypair.privateKey, forge.md.sha256.create());

  return {
    privateKey: forge.pki.privateKeyToPem(keypair.privateKey),
    certificate: forge.pki.certificateToPem(cert),
  };
}

// ---------------------------------------------------------------------------
// OLD signing (our previous implementation — the one DGII rejected)
// ---------------------------------------------------------------------------
function signWithOldImpl(xml: string, privateKey: string, cert: string): string {
  const C14N = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
  const ENVELOPED = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';
  const RSA_SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
  const SHA256 = 'http://www.w3.org/2001/04/xmlenc#sha256';

  const rootTag = 'ECF';
  const now = new Date();
  const signTime = `${pad(now.getDate())}-${pad(now.getMonth() + 1)}-${now.getFullYear()} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  const xmlWithFirma = xml.replace(
    '</ECF>',
    `<FechaHoraFirma>${signTime}</FechaHoraFirma></ECF>`,
  );

  const sig = new SignedXml({
    privateKey,
    publicCert: cert,
    signatureAlgorithm: RSA_SHA256,
    canonicalizationAlgorithm: C14N,
  });

  sig.addReference({
    xpath: '/*',
    transforms: [ENVELOPED, C14N],
    digestAlgorithm: SHA256,
    uri: '',
    isEmptyUri: true,
  });

  sig.computeSignature(xmlWithFirma, {
    location: { reference: '/*', action: 'append' },
  });

  return sig.getSignedXml();
}

// ---------------------------------------------------------------------------
// NEW signing (dgii-ecf — DGII-compliant)
// ---------------------------------------------------------------------------
function signWithNewImpl(xml: string, privateKey: string, cert: string): string {
  const now = new Date();
  const signTime = `${pad(now.getDate())}-${pad(now.getMonth() + 1)}-${now.getFullYear()} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  const xmlWithFirma = xml.replace(
    '</ECF>',
    `<FechaHoraFirma>${signTime}</FechaHoraFirma></ECF>`,
  );

  const signer = new DgiiSignature(privateKey, cert);
  return signer.signXml(xmlWithFirma, 'ECF');
}

function pad(n: number): string { return String(n).padStart(2, '0'); }

// ---------------------------------------------------------------------------
// Extract specific fields for comparison
// ---------------------------------------------------------------------------
function extract(signedXml: string, tag: string): string {
  const re = new RegExp(`<(?:[A-Za-z]+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z]+:)?${tag}>`, 'i');
  const m = re.exec(signedXml);
  return m ? m[1].trim().replace(/\s+/g, ' ').substring(0, 80) + '...' : '(not found)';
}

function countOccurrences(str: string, needle: string): number {
  return (str.match(new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('='.repeat(70));
  console.log(' DGII Signing Comparison: OLD (xml-crypto) vs NEW (dgii-ecf)');
  console.log('='.repeat(70));

  const { privateKey, certificate } = buildTestKeyPair();

  console.log('\n📝 Input XML (truncated):');
  console.log(SAMPLE_XML.substring(0, 200) + '...');

  // Sign with both implementations
  console.log('\n⏳ Signing with OLD implementation (xml-crypto only)...');
  const oldSigned = signWithOldImpl(SAMPLE_XML, privateKey, certificate);

  console.log('⏳ Signing with NEW implementation (dgii-ecf)...');
  const newSigned = signWithNewImpl(SAMPLE_XML, privateKey, certificate);

  // ---------------------------------------------------------------------------
  // Comparison table
  // ---------------------------------------------------------------------------
  console.log('\n' + '─'.repeat(70));
  console.log(' COMPARISON');
  console.log('─'.repeat(70));

  const oldDigest = extract(oldSigned, 'DigestValue');
  const newDigest = extract(newSigned, 'DigestValue');

  console.log(`\n🔑 DigestValue (first 80 chars):`);
  console.log(`  OLD: ${oldDigest}`);
  console.log(`  NEW: ${newDigest}`);
  console.log(`  Same: ${oldDigest === newDigest ? '✅ YES (unexpected!)' : '❌ NO (expected — different Digest algorithms)'}`);

  const oldTransforms = countOccurrences(oldSigned, '<Transform ');
  const newTransforms = countOccurrences(newSigned, '<Transform ');
  console.log(`\n🔄 Transform count:`);
  console.log(`  OLD: ${oldTransforms} (enveloped + C14N) — DGII may reject 2 transforms`);
  console.log(`  NEW: ${newTransforms} (enveloped only)   — Compliant with DGII spec`);

  const oldC14nTransform = oldSigned.includes('REC-xml-c14n-20010315') &&
    oldSigned.match(/Transform.*REC-xml-c14n/);
  const newC14nTransform = newSigned.match(/Transform.*REC-xml-c14n/);
  console.log(`\n📋 C14N as Transform:`);
  console.log(`  OLD: ${oldC14nTransform ? '✓ present (extra transform)' : '✗ absent'}`);
  console.log(`  NEW: ${newC14nTransform ? '✓ present' : '✗ absent (correct — C14N only in CanonicalizationMethod)'}`);

  // ---------------------------------------------------------------------------
  // validateXMLCertificate
  // ---------------------------------------------------------------------------
  console.log('\n' + '─'.repeat(70));
  console.log(' validateXMLCertificate (dgii-ecf)');
  console.log('─'.repeat(70));

  const oldValidation = validateXMLCertificate(oldSigned, { silent: true });
  const newValidation = validateXMLCertificate(newSigned, { silent: true });

  console.log(`\n  OLD signed XML: isValid=${oldValidation.isValid}`);
  if (!oldValidation.isValid) {
    console.log(`    Error: ${oldValidation.error}`);
    console.log(`    ↑ This is why DGII rejects our old signatures!`);
  }

  console.log(`\n  NEW signed XML: isValid=${newValidation.isValid}`);
  if (newValidation.isValid) {
    console.log(`    ✅ Passes dgii-ecf validation — should pass DGII's server too`);
  } else {
    console.log(`    Error: ${newValidation.error}`);
  }

  // ---------------------------------------------------------------------------
  // Summary
  // ---------------------------------------------------------------------------
  console.log('\n' + '='.repeat(70));
  console.log(' SUMMARY');
  console.log('='.repeat(70));
  console.log(`  ❌ OLD (xml-crypto only): validateXMLCertificate=${oldValidation.isValid}`);
  console.log(`  ✅ NEW (dgii-ecf):        validateXMLCertificate=${newValidation.isValid}`);
  console.log(`\n  Root cause of DGII rejection:`);
  console.log(`    dgii-ecf's Digest sorts xmlns:* attributes alphabetically before`);
  console.log(`    computing SHA-256. DGII's C# server expects this sorted order.`);
  console.log(`    Without sorting, DigestValue mismatches → "La firma no es válida".`);
  console.log('='.repeat(70) + '\n');
}

main().catch(console.error);
