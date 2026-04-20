import {
  Controller,
  Get,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { SigningService } from '../signing/signing.service';
import { ReceptionService } from './reception.service';
import { ResponseXmlBuilder, ArecfInput } from '../xml-builder/response-xml-builder';
import { getTypeFromEncf, isValidEncf, ACECF_EXCLUDED_TYPES } from '../xml-builder/ecf-types';
import { CertificatesService } from '../certificates/certificates.service';

/**
 * FE Receptor Controller
 *
 * Exposes the DGII-mandated inter-taxpayer communication endpoints.
 * Per Descripción Técnica v1.6 p.52-58, every e-CF participant must expose:
 *
 * - GET  /fe/autenticacion/api/semilla          → Returns a seed XML
 * - POST /fe/autenticacion/api/validacioncertificado → Validates signed seed, returns token
 * - POST /fe/recepcion/api/ecf                  → Receives e-CF, returns signed ARECF
 * - POST /fe/aprobacioncomercial/api/ecf         → Receives ACECF
 *
 * Requirements:
 * - HTTPS obligatorio
 * - REST API
 * - Case-insensitive paths
 * - Always available via internet
 */
@ApiTags('fe-receptor')
@Controller('fe')
export class FeReceptorController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly signingService: SigningService,
    private readonly receptionService: ReceptionService,
    private readonly responseXmlBuilder: ResponseXmlBuilder,
    private readonly certificatesService: CertificatesService,
    @InjectPinoLogger(FeReceptorController.name)
    private readonly logger: PinoLogger,
  ) {}

  // ============================================================
  // AUTHENTICATION: Semilla
  // ============================================================

  /**
   * GET /fe/autenticacion/api/semilla
   *
   * Returns a seed XML that the emitter must sign with their certificate
   * to authenticate before sending e-CF documents.
   */
  @Get('autenticacion/api/semilla')
  @ApiOperation({ summary: 'Obtener semilla para autenticación emisor-receptor (DGII p.52)' })
  getSemilla(): string {
    const valor = crypto.randomBytes(32).toString('hex');
    const fecha = new Date().toISOString();

    return [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<SemillaModel>',
      `  <valor>${valor}</valor>`,
      `  <fecha>${fecha}</fecha>`,
      '</SemillaModel>',
    ].join('\n');
  }

  // ============================================================
  // AUTHENTICATION: Validación de certificado
  // ============================================================

  /**
   * POST /fe/autenticacion/api/validacioncertificado
   *
   * Receives the signed seed and validates it.
   * Returns a JWT-like token for subsequent requests.
   */
  @Post('autenticacion/api/validacioncertificado')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Validar semilla firmada y obtener token (DGII p.52)' })
  async validarCertificado(@Body() body: any): Promise<{ token: string; expira: string }> {
    const xmlContent = typeof body === 'string' ? body : body?.xml;
    if (!xmlContent) {
      throw new BadRequestException('Se requiere la semilla firmada en el campo xml');
    }

    // Cryptographically verify the signed seed:
    // 1. Check Signature element and X509Certificate exist
    // 2. Verify DigestValue matches document hash
    // 3. Verify SignatureValue with certificate public key
    try {
      this.signingService.verifySignedXml(xmlContent);
    } catch (error: any) {
      throw new BadRequestException(`Firma digital inválida: ${error.message}`);
    }

    // Signature verified — generate a session token for the authenticated emitter
    const token = crypto.randomBytes(48).toString('base64url');
    const expira = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    this.logger.info('Emitter authenticated via verified signed semilla');

    return { token, expira };
  }

  // ============================================================
  // RECEPTION: Receive e-CF → Return signed ARECF
  // ============================================================

  /**
   * POST /fe/recepcion/api/ecf
   *
   * Receives an e-CF from another emitter and returns a signed ARECF.
   * Per DGII spec, the ARECF is the response to this endpoint.
   */
  @Post('recepcion/api/ecf')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Recibir e-CF de emisor y retornar ARECF firmado (DGII p.53)' })
  async receiveEcf(@Body() body: any): Promise<string> {
    const xmlContent = typeof body === 'string' ? body : body?.xml;
    if (!xmlContent) {
      throw new BadRequestException('Se requiere el XML del e-CF');
    }

    // Extract key fields from the incoming e-CF XML
    const rncEmisor = this.extractXmlField(xmlContent, 'RNCEmisor');
    const rncComprador = this.extractXmlField(xmlContent, 'RNCComprador');
    const encf = this.extractXmlField(xmlContent, 'eNCF');

    // ----------------------------------------------------------------
    // STEP 1: Look up the receiving company FIRST (before validation)
    // so we can sign error ARECFs with the receiver's certificate.
    // Per DGII protocol, ALL ARECFs should be signed when possible.
    // ----------------------------------------------------------------
    let company: any = null;
    let signingMaterial: { privateKey: any; certificate: any } | null = null;

    if (rncComprador) {
      company = await this.prisma.company.findFirst({
        where: { rnc: rncComprador },
      });

      if (company) {
        try {
          const { p12Buffer, passphrase } = await this.certificatesService.getDecryptedCertificate(
            company.tenantId, company.id,
          );
          signingMaterial = this.signingService.extractFromP12(p12Buffer, passphrase);
        } catch (err: any) {
          this.logger.warn(`Could not load certificate for company ${company.id}: ${err.message}`);
        }
      }
    }

    // ----------------------------------------------------------------
    // STEP 2: Validate the incoming e-CF — return signed error ARECFs
    // ----------------------------------------------------------------
    if (!rncEmisor || !encf) {
      return this.buildSignedErrorArecf(rncEmisor || '', rncComprador || '', encf || '', 1, signingMaterial);
    }

    if (!isValidEncf(encf)) {
      return this.buildSignedErrorArecf(rncEmisor, rncComprador, encf, 1, signingMaterial);
    }

    // Per DGII Descripción Técnica: ACECF applies to E31, E33, E34, E44, E45
    const typeCode = getTypeFromEncf(encf);
    if (ACECF_EXCLUDED_TYPES.includes(typeCode)) {
      return this.buildSignedErrorArecf(rncEmisor, rncComprador, encf, 1, signingMaterial);
    }

    if (!company) {
      this.logger.warn(`Received e-CF for unknown RNC: ${rncComprador}`);
      // RNC Comprador no corresponde: code 4 (cannot sign — no company found)
      return this.buildSignedErrorArecf(rncEmisor, rncComprador, encf, 4, null);
    }

    // ----------------------------------------------------------------
    // STEP 3: Store the received document
    // ----------------------------------------------------------------
    const emitterName = this.extractXmlField(xmlContent, 'RazonSocialEmisor') || rncEmisor;
    const totalAmount = parseFloat(this.extractXmlField(xmlContent, 'MontoTotal') || '0');

    try {
      await this.receptionService.storeReceived(company.tenantId, {
        companyId: company.id,
        emitterRnc: rncEmisor,
        emitterName,
        encf,
        ecfType: `E${typeCode}`,
        totalAmount,
        issueDate: new Date().toISOString(),
        xmlContent,
      });
    } catch (error: any) {
      // If document already received, still return ARECF (idempotent)
      if (!error.message?.includes('ya fue recibido')) {
        throw error;
      }
    }

    // ----------------------------------------------------------------
    // STEP 4: Build and sign success ARECF (Estado=0)
    // ----------------------------------------------------------------
    const arecfInput: ArecfInput = {
      receiverRnc: company.rnc,
      receiverName: company.businessName,
      emitterRnc: rncEmisor,
      emitterName,
      ecfType: `E${typeCode}`,
      encf,
      totalAmount,
      totalItbis: 0,
      receivedDate: new Date(),
    };

    const arecfXml = this.responseXmlBuilder.buildArecfXml(arecfInput);

    if (signingMaterial) {
      const { signedXml } = this.signingService.signXml(arecfXml, signingMaterial.privateKey, signingMaterial.certificate);
      this.logger.info(`Signed ARECF returned for ${encf} from ${rncEmisor}`);
      return signedXml;
    }

    // Fallback: return unsigned if certificate could not be loaded (should not happen for success path)
    this.logger.warn(`Unsigned ARECF returned for ${encf} — certificate unavailable`);
    return arecfXml;
  }

  // ============================================================
  // COMMERCIAL APPROVAL: Receive ACECF
  // ============================================================

  /**
   * POST /fe/aprobacioncomercial/api/ecf
   *
   * Receives an ACECF (commercial approval/rejection) from a receiver
   * of an e-CF that this company emitted.
   */
  @Post('aprobacioncomercial/api/ecf')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Recibir ACECF de aprobación/rechazo comercial (DGII p.54)' })
  async receiveAcecf(@Body() body: any): Promise<{ mensaje: string }> {
    const xmlContent = typeof body === 'string' ? body : body?.xml;
    if (!xmlContent) {
      throw new BadRequestException('Se requiere el XML del ACECF');
    }

    const encf = this.extractXmlField(xmlContent, 'eNCF');
    const estado = this.extractXmlField(xmlContent, 'Estado');

    this.logger.info(`ACECF received for ${encf}: Estado=${estado}`);

    // Update the invoice with the commercial approval status
    if (encf) {
      const invoice = await this.prisma.invoice.findFirst({
        where: { encf },
      });

      if (invoice) {
        await this.prisma.invoice.update({
          where: { id: invoice.id },
          data: {
            metadata: {
              ...(typeof invoice.metadata === 'object' && invoice.metadata !== null ? invoice.metadata as any : {}),
              acecfRecibido: xmlContent,
              acecfEstado: estado === '1' ? 'Aprobado' : 'Rechazado',
              acecfFecha: new Date().toISOString(),
            },
          },
        });
      }
    }

    return { mensaje: 'ACECF recibido correctamente' };
  }

  // ============================================================
  // HELPERS
  // ============================================================

  /**
   * Build an ARECF with Estado=1 (No Recibido) for validation errors,
   * signed with the receiver's certificate when available.
   * Per DGII protocol, ALL ARECFs should be digitally signed.
   */
  private buildSignedErrorArecf(
    rncEmisor: string,
    rncComprador: string,
    encf: string,
    errorCode: number,
    signingMaterial: { privateKey: any; certificate: any } | null,
  ): string {
    const arecfXml = this.responseXmlBuilder.buildArecfErrorXml({
      emitterRnc: rncEmisor,
      receiverRnc: rncComprador,
      encf,
      errorCode,
    });

    if (signingMaterial) {
      const { signedXml } = this.signingService.signXml(
        arecfXml, signingMaterial.privateKey, signingMaterial.certificate,
      );
      this.logger.warn(`Signed ARECF error returned for ${encf}: code ${errorCode}`);
      return signedXml;
    }

    this.logger.warn(`Unsigned ARECF error returned for ${encf}: code ${errorCode} (no certificate available)`);
    return arecfXml;
  }

  private extractXmlField(xml: string, field: string): string {
    const regex = new RegExp(`<${field}>([\\s\\S]*?)</${field}>`, 'i');
    const match = xml.match(regex);
    return match ? match[1].trim() : '';
  }
}
