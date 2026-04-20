import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { EncryptionService } from '../common/services/encryption.service';
import { UploadCertificateDto } from './dto/certificate.dto';

/**
 * Certificate info extracted from .p12 file
 */
interface CertificateInfo {
  fingerprint: string;
  issuer: string;
  subject: string;
  serialNumber: string;
  validFrom: Date;
  validTo: Date;
}

/**
 * Certificates are stored AES-256-GCM encrypted using the shared
 * {@link EncryptionService}, which is keyed off `CERT_ENCRYPTION_KEY` —
 * intentionally decoupled from the JWT signing secret so operators can
 * rotate that key during a security incident without destroying every
 * stored .p12 container. Key rotation for the certificate keystore itself
 * is done via `scripts/rotate-cert-encryption.ts`.
 */
@Injectable()
export class CertificatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    @InjectPinoLogger(CertificatesService.name)
    private readonly logger: PinoLogger,
  ) {}

  /**
   * Upload and store a .p12 certificate.
   * The certificate is encrypted at rest using AES-256-GCM.
   * In production, AWS KMS envelope encryption would be used instead.
   */
  async upload(tenantId: string, dto: UploadCertificateDto) {
    // Verify company belongs to tenant
    const company = await this.prisma.company.findFirst({
      where: { id: dto.companyId, tenantId },
    });

    if (!company) {
      throw new NotFoundException('Company not found');
    }

    // Decode base64
    let p12Buffer: Buffer;
    try {
      p12Buffer = Buffer.from(dto.p12Base64, 'base64');
    } catch {
      throw new BadRequestException('Invalid base64 encoding for .p12 file');
    }

    if (p12Buffer.length < 100) {
      throw new BadRequestException('File too small to be a valid .p12 certificate');
    }

    if (p12Buffer.length > 50 * 1024) {
      throw new BadRequestException('File too large (max 50KB for .p12)');
    }

    // Extract certificate info
    // Note: In production, use node-forge to properly parse the .p12
    // For now, generate a fingerprint from the file content
    const certInfo = this.extractCertInfo(p12Buffer, dto.passphrase);

    // Encrypt the .p12 file and the passphrase
    const encryptedP12 = this.encryption.encrypt(p12Buffer);
    const encryptedPass = this.encryption.encryptString(dto.passphrase);

    // Deactivate previous certificates for this company
    await this.prisma.certificate.updateMany({
      where: { companyId: dto.companyId, tenantId, isActive: true },
      data: { isActive: false },
    });

    // Store encrypted certificate
    const certificate = await this.prisma.certificate.create({
      data: {
        tenantId,
        companyId: dto.companyId,
        encryptedP12: encryptedP12,
        encryptedPass: encryptedPass,
        fingerprint: certInfo.fingerprint,
        issuer: certInfo.issuer,
        subject: certInfo.subject,
        serialNumber: certInfo.serialNumber,
        validFrom: certInfo.validFrom,
        validTo: certInfo.validTo,
        isActive: true,
      },
    });

    this.logger.info(
      `Certificate uploaded for company ${dto.companyId}: ${certInfo.fingerprint}`,
    );

    return {
      id: certificate.id,
      fingerprint: certificate.fingerprint,
      issuer: certificate.issuer,
      subject: certificate.subject,
      validFrom: certificate.validFrom,
      validTo: certificate.validTo,
      isActive: certificate.isActive,
      message: 'Certificado almacenado y encriptado exitosamente',
    };
  }

  /**
   * Get active certificate for a company (metadata only)
   */
  async getActive(tenantId: string, companyId: string) {
    const cert = await this.prisma.certificate.findFirst({
      where: { tenantId, companyId, isActive: true },
      select: {
        id: true,
        fingerprint: true,
        issuer: true,
        subject: true,
        serialNumber: true,
        validFrom: true,
        validTo: true,
        isActive: true,
        createdAt: true,
      },
    });

    if (!cert) {
      throw new NotFoundException('No active certificate found for this company');
    }

    // Add expiration warning
    const daysToExpiry = Math.ceil(
      (cert.validTo.getTime() - Date.now()) / (1000 * 60 * 60 * 24),
    );

    return {
      ...cert,
      daysToExpiry,
      expiryWarning: daysToExpiry <= 30 ? '⚠️ Certificado próximo a vencer' : null,
    };
  }

  /**
   * List all certificates for a company
   */
  async findAll(tenantId: string, companyId: string) {
    return this.prisma.certificate.findMany({
      where: { tenantId, companyId },
      select: {
        id: true,
        fingerprint: true,
        issuer: true,
        subject: true,
        validFrom: true,
        validTo: true,
        isActive: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * Decrypt and return the .p12 buffer + passphrase for signing.
   * Used internally by the signing module - never exposed to API.
   */
  async getDecryptedCertificate(
    tenantId: string,
    companyId: string,
  ): Promise<{ p12Buffer: Buffer; passphrase: string }> {
    const cert = await this.prisma.certificate.findFirst({
      where: { tenantId, companyId, isActive: true },
    });

    if (!cert) {
      throw new NotFoundException('No active certificate found');
    }

    // Check expiration
    if (cert.validTo < new Date()) {
      throw new BadRequestException('Certificate has expired');
    }

    const p12Buffer = this.encryption.decrypt(cert.encryptedP12);
    const passphrase = this.encryption.decryptString(cert.encryptedPass);

    return { p12Buffer, passphrase };
  }

  // ========================
  // Private helper methods
  // ========================

  /**
   * Extract certificate metadata from .p12 file using node-forge.
   * Parses the PKCS#12 to get real issuer, subject, serial, and validity dates.
   */
  private extractCertInfo(p12Buffer: Buffer, passphrase: string): CertificateInfo {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const forge = require('node-forge');

    let p12: any;
    try {
      const p12Asn1 = forge.asn1.fromDer(p12Buffer.toString('binary'));
      p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, passphrase);
    } catch (error: any) {
      throw new BadRequestException(
        `No se pudo abrir el certificado .p12. Verifique la contraseña. Error: ${error.message}`,
      );
    }

    // Extract certificate
    const certBags = p12.getBags({ bagType: forge.pki.oids.certBag });
    const certBag = certBags[forge.pki.oids.certBag];

    if (!certBag || certBag.length === 0) {
      throw new BadRequestException('El archivo .p12 no contiene un certificado válido');
    }

    const cert = certBag[0].cert;

    // Verify private key exists
    const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag });
    const keyBag = keyBags[forge.pki.oids.pkcs8ShroudedKeyBag];

    if (!keyBag || keyBag.length === 0) {
      throw new BadRequestException('El archivo .p12 no contiene una llave privada');
    }

    // Extract real metadata
    const fingerprint = forge.md.sha256
      .create()
      .update(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes())
      .digest()
      .toHex()
      .substring(0, 40);

    const getAttr = (attrs: any[], shortName: string): string => {
      const attr = attrs.find((a: any) => a.shortName === shortName);
      return attr ? attr.value : '';
    };

    const issuerAttrs = cert.issuer.attributes;
    const subjectAttrs = cert.subject.attributes;

    const issuer = [
      getAttr(issuerAttrs, 'CN'),
      getAttr(issuerAttrs, 'O'),
    ].filter(Boolean).join(', ') || 'Unknown Issuer';

    const subject = [
      getAttr(subjectAttrs, 'CN'),
      getAttr(subjectAttrs, 'O'),
    ].filter(Boolean).join(', ') || 'Unknown Subject';

    const serialNumber = cert.serialNumber || 'Unknown';

    this.logger.info(
      `Certificate parsed: subject="${subject}", issuer="${issuer}", ` +
      `valid ${cert.validity.notBefore.toISOString()} → ${cert.validity.notAfter.toISOString()}`,
    );

    return {
      fingerprint,
      issuer,
      subject,
      serialNumber,
      validFrom: cert.validity.notBefore,
      validTo: cert.validity.notAfter,
    };
  }

}
