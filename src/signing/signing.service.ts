import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import * as crypto from 'crypto';
import { SignedXml } from 'xml-crypto';
import { DOMParser } from '@xmldom/xmldom';
import {
  buildStandardQrUrl,
  buildFcUnder250kQrUrl,
  getAmbiente,
} from '../xml-builder/ecf-types';

const C14N_1_0 = 'http://www.w3.org/TR/2001/REC-xml-c14n-20010315';
const ENVELOPED_TRANSFORM = 'http://www.w3.org/2000/09/xmldsig#enveloped-signature';
const RSA_SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
const SHA256_DIGEST = 'http://www.w3.org/2001/04/xmlenc#sha256';
const DSIG_NS = 'http://www.w3.org/2000/09/xmldsig#';

/**
 * Digital signature service for e-CF documents.
 *
 * Implements W3C XML Digital Signature (XMLDSig) per DGII specifications:
 * - Algorithm: RSA-SHA256
 * - Digest: SHA-256
 * - Canonicalization: Canonical XML 1.0 (C14N, no comments)
 * - Transform: Enveloped Signature + C14N 1.0
 * - Reference URI: "" (signs entire document)
 * - KeyInfo: X509Data with base64 DER certificate
 * - Signature is placed as the last child of the document root
 *
 * FechaHoraFirma is inserted only for <ECF> documents (DGII XSD Section G/H);
 * other document types (SemillaModel, ARECF, ACECF, ANECF) don't use it.
 *
 * Security Code per DGII: first 6 hex digits of SHA-256(SignatureValue base64).
 */
@Injectable()
export class SigningService {
  constructor(
    @InjectPinoLogger(SigningService.name)
    private readonly logger: PinoLogger,
  ) {}

  /**
   * Sign an XML document using XMLDSig (enveloped, C14N 1.0, RSA-SHA256).
   */
  signXml(
    xml: string,
    privateKeyPem: string,
    certificatePem: string,
  ): SigningResult {
    const signTime = new Date();

    const rootTagMatch = xml.match(/<\/([A-Za-z][A-Za-z0-9]*)\s*>\s*$/);
    if (!rootTagMatch) {
      throw new Error('Cannot detect XML root closing tag for signing');
    }
    const rootTag = rootTagMatch[1];
    const closingTag = `</${rootTag}>`;

    let xmlPrepared = xml;
    if (rootTag === 'ECF') {
      xmlPrepared = xml.replace(
        closingTag,
        `<FechaHoraFirma>${formatDateTimeFirma(signTime)}</FechaHoraFirma>${closingTag}`,
      );
    }

    const sig = new SignedXml({
      privateKey: privateKeyPem,
      publicCert: certificatePem,
      signatureAlgorithm: RSA_SHA256,
      canonicalizationAlgorithm: C14N_1_0,
    });

    sig.addReference({
      xpath: '/*',
      transforms: [ENVELOPED_TRANSFORM, C14N_1_0],
      digestAlgorithm: SHA256_DIGEST,
      uri: '',
      isEmptyUri: true,
    });

    sig.computeSignature(xmlPrepared, {
      location: { reference: '/*', action: 'append' },
    });

    const signedXml = sig.getSignedXml();

    const signatureValue = this.extractSignatureValue(signedXml);
    const securityCode = this.generateSecurityCode(signatureValue);

    this.logger.debug(
      `XML signed (root: ${rootTag}). Security code: ${securityCode}`,
    );

    return {
      signedXml,
      securityCode,
      signatureValue,
      signTime,
    };
  }

  /**
   * Verify an XMLDSig-signed XML document.
   *
   * When to use this:
   * - Inter-taxpayer DGII endpoints exposed by this API where a *peer*
   *   emitter sends us their own signed XML and we must reject it unless
   *   the signature is cryptographically valid. Today the only caller is
   *   `POST /fe/autenticacion/api/validacioncertificado`
   *   ({@link FeReceptorController} — see fe-receptor.controller.ts), which
   *   uses it to validate a signed SemillaModel before issuing a
   *   short-lived session token to the remote emitter.
   *
   * Do NOT call this for our OWN outbound signed XMLs (e-CF / RFCE /
   * ANECF / ARECF / ACECF). DGII verifies those on its side; re-verifying
   * locally is redundant and would only catch tampering *we* introduced,
   * which should never happen.
   *
   * Returns the PEM certificate embedded in the KeyInfo on success, throws
   * with a specific Error on any failure (missing Signature, missing
   * X509Certificate, bad digest, bad SignatureValue).
   */
  verifySignedXml(signedXml: string): { certificatePem: string } {
    const doc = new DOMParser().parseFromString(signedXml, 'text/xml');

    const sig = new SignedXml();
    const signatures = sig.findSignatures(doc as unknown as Node);
    if (!signatures || signatures.length === 0) {
      throw new Error('XML no contiene elemento <Signature>');
    }
    if (signatures.length > 1) {
      throw new Error('XML contiene múltiples elementos <Signature>');
    }

    const certBase64 = this.extractCertBase64FromXml(signedXml);
    if (!certBase64) {
      throw new Error('Signature no contiene <X509Certificate>');
    }
    const certificatePem = this.derBase64ToPem(certBase64);

    sig.publicCert = certificatePem;
    sig.loadSignature(signatures[0]);

    const isValid = sig.checkSignature(signedXml);
    if (!isValid) {
      throw new Error('XML signature verification failed');
    }

    this.logger.debug('XML signature verified successfully');
    return { certificatePem };
  }

  /**
   * Extract security code from an already-signed XML (same algorithm as signXml).
   */
  getSecurityCode(signedXml: string): string {
    const match = signedXml.match(
      /<(?:[A-Za-z][A-Za-z0-9]*:)?SignatureValue[^>]*>([\s\S]*?)<\/(?:[A-Za-z][A-Za-z0-9]*:)?SignatureValue>/,
    );
    if (!match) return '';
    return this.generateSecurityCode(match[1].replace(/\s/g, ''));
  }

  /**
   * Build DGII-compliant QR URL for standard e-CF or FC under 250K.
   */
  buildQrUrl(params: {
    rncEmisor: string;
    rncComprador: string;
    encf: string;
    fechaEmision: Date;
    montoTotal: number;
    fechaFirma: Date;
    securityCode: string;
    isFcUnder250k: boolean;
    dgiiEnv: string;
  }): string {
    const ambiente = getAmbiente(params.dgiiEnv);

    if (params.isFcUnder250k) {
      return buildFcUnder250kQrUrl({
        rncEmisor: params.rncEmisor,
        encf: params.encf,
        montoTotal: params.montoTotal.toFixed(2),
        codigoSeguridad: params.securityCode,
        ambiente,
      });
    }

    return buildStandardQrUrl({
      rncEmisor: params.rncEmisor,
      rncComprador: params.rncComprador || '',
      encf: params.encf,
      fechaEmision: formatDateDgii(params.fechaEmision),
      montoTotal: params.montoTotal.toFixed(2),
      fechaFirma: formatDateTimeFirma(params.fechaFirma),
      codigoSeguridad: params.securityCode,
      ambiente,
    });
  }

  /**
   * Extract private key and certificate from a PKCS#12 (.p12) buffer.
   *
   * When `expectedRnc` is provided, validates that the certificate's Subject Name
   * contains the issuer RNC per DGII Descripción Técnica p.60.
   */
  extractFromP12(
    p12Buffer: Buffer,
    passphrase: string,
    expectedRnc?: string,
  ): { privateKey: string; certificate: string } {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const forge = require('node-forge');

    const p12Asn1 = forge.asn1.fromDer(p12Buffer.toString('binary'));
    const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, passphrase);

    const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
    const keyBag = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag];
    if (!keyBag || keyBag.length === 0) {
      throw new Error('No se encontró llave privada en el archivo .p12');
    }
    const privateKey = forge.pki.privateKeyToPem(keyBag[0].key);

    const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
    const certBag = certBags[forge.pki.oids.certBag];
    if (!certBag || certBag.length === 0) {
      throw new Error('No se encontró certificado en el archivo .p12');
    }
    const cert = certBag[0].cert;
    const certificate = forge.pki.certificateToPem(cert);

    if (expectedRnc) {
      this.validateCertificateRnc(cert, expectedRnc);
    }

    this.logger.debug('P12 extracted successfully: key + certificate');
    return { privateKey, certificate };
  }

  // ============================================================
  // PRIVATE HELPERS
  // ============================================================

  private generateSecurityCode(signatureValueBase64: string): string {
    const cleanSig = signatureValueBase64.replace(/\s/g, '');
    return crypto
      .createHash('sha256')
      .update(cleanSig)
      .digest('hex')
      .substring(0, 6)
      .toUpperCase();
  }

  private extractSignatureValue(signedXml: string): string {
    const match = signedXml.match(
      /<(?:[A-Za-z][A-Za-z0-9]*:)?SignatureValue[^>]*>([\s\S]*?)<\/(?:[A-Za-z][A-Za-z0-9]*:)?SignatureValue>/,
    );
    if (!match) {
      throw new Error('Signed XML does not contain <SignatureValue>');
    }
    return match[1].replace(/\s/g, '');
  }

  private extractCertBase64FromXml(signedXml: string): string | null {
    const match = signedXml.match(
      /<(?:[A-Za-z][A-Za-z0-9]*:)?X509Certificate[^>]*>([\s\S]*?)<\/(?:[A-Za-z][A-Za-z0-9]*:)?X509Certificate>/,
    );
    if (!match) return null;
    return match[1].replace(/\s/g, '');
  }

  private derBase64ToPem(derBase64: string): string {
    const chunks: string[] = [];
    for (let i = 0; i < derBase64.length; i += 64) {
      chunks.push(derBase64.substring(i, i + 64));
    }
    return `-----BEGIN CERTIFICATE-----\n${chunks.join('\n')}\n-----END CERTIFICATE-----\n`;
  }

  /**
   * Validate that a certificate's Subject Name contains the expected RNC.
   * Per DGII Descripción Técnica p.60: SN = RNC/Cédula/Pasaporte del propietario.
   */
  private validateCertificateRnc(cert: any, expectedRnc: string): void {
    const subject = cert.subject;
    if (!subject) {
      this.logger.warn('Certificate has no subject — cannot validate RNC');
      return;
    }

    const subjectStr = subject.attributes
      .map((attr: any) => `${attr.shortName || attr.name}=${attr.value}`)
      .join(', ');

    const snAttr = subject.getField('serialName') || subject.getField('SN');
    const cnAttr = subject.getField('CN');
    const snValue = snAttr?.value || '';
    const cnValue = cnAttr?.value || '';

    const rncNormalized = expectedRnc.replace(/[-\s]/g, '');
    const containsRnc =
      snValue.replace(/[-\s]/g, '').includes(rncNormalized) ||
      cnValue.replace(/[-\s]/g, '').includes(rncNormalized) ||
      subjectStr.replace(/[-\s]/g, '').includes(rncNormalized);

    if (!containsRnc) {
      throw new Error(
        `Certificado no corresponde al emisor. RNC esperado: ${expectedRnc}, ` +
          `Subject del certificado: ${subjectStr}. ` +
          `DGII rechazará e-CF firmados con certificado de otro contribuyente.`,
      );
    }
    this.logger.debug(`Certificate RNC validated: ${expectedRnc}`);
  }
}

// ============================================================
// RESULT TYPES
// ============================================================

export interface SigningResult {
  signedXml: string;
  securityCode: string;
  signatureValue: string;
  signTime: Date;
}

// ============================================================
// DATE FORMATTING (DGII-specific, GMT-4)
// ============================================================

function toGmt4(d: Date): {
  year: number;
  month: number;
  day: number;
  hours: number;
  minutes: number;
  seconds: number;
} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Santo_Domingo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(d);

  const get = (type: string) =>
    parseInt(parts.find((p) => p.type === type)?.value || '0', 10);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hours: get('hour'),
    minutes: get('minute'),
    seconds: get('second'),
  };
}

function formatDateDgii(d: Date): string {
  const t = toGmt4(d);
  return `${String(t.day).padStart(2, '0')}-${String(t.month).padStart(2, '0')}-${t.year}`;
}

function formatDateTimeFirma(d: Date): string {
  const t = toGmt4(d);
  const dd = String(t.day).padStart(2, '0');
  const mm = String(t.month).padStart(2, '0');
  const hh = String(t.hours).padStart(2, '0');
  const mi = String(t.minutes).padStart(2, '0');
  const ss = String(t.seconds).padStart(2, '0');
  return `${dd}-${mm}-${t.year} ${hh}:${mi}:${ss}`;
}
