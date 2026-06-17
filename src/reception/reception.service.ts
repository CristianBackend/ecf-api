import { Injectable, NotFoundException, BadRequestException, BadGatewayException } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { SigningService } from '../signing/signing.service';
import { DgiiService } from '../dgii/dgii.service';
import { CertificatesService } from '../certificates/certificates.service';
import { ResponseXmlBuilder, ArecfInput } from '../xml-builder/response-xml-builder';
import {
  AcecfXmlBuilder,
  Step3AcecfInput,
  formatDateTimeDdMmYyyy,
} from '../certification-step3/services/acecf-xml-builder.service';
import { ACECF_EXCLUDED_TYPES, getTypeFromEncf } from '../xml-builder/ecf-types';
import { ActorContext } from '../common/decorators/actor.decorator';
import { WebhookEvent, EcfType, ReceivedDocumentStatus } from '@prisma/client';

/**
 * FechaEmision for the ACECF must match the original e-CF. issueDate is stored
 * as a UTC-midnight Date parsed from the incoming XML's dd-MM-yyyy, so it must
 * be formatted back with UTC getters — a GMT-4 formatter would shift it one day.
 */
function formatIssueDateDdMmYyyy(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}-${mm}-${d.getUTCFullYear()}`;
}

@Injectable()
export class ReceptionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly webhooksService: WebhooksService,
    private readonly signingService: SigningService,
    private readonly dgiiService: DgiiService,
    private readonly certificatesService: CertificatesService,
    private readonly responseXmlBuilder: ResponseXmlBuilder,
    private readonly acecfXmlBuilder: AcecfXmlBuilder,
    @InjectPinoLogger(ReceptionService.name)
    private readonly logger: PinoLogger,
  ) {}

  async storeReceived(tenantId: string, data: {
    companyId: string;
    emitterRnc: string;
    emitterName: string;
    encf: string;
    ecfType: string;
    totalAmount: number;
    totalItbis?: number;
    issueDate: string;
    xmlContent?: string;
  }) {
    const company = await this.prisma.company.findFirst({
      where: { id: data.companyId, tenantId },
    });
    if (!company) throw new NotFoundException('Company not found');

    const existing = await this.prisma.receivedDocument.findUnique({
      where: { companyId_encf: { companyId: data.companyId, encf: data.encf } },
    });
    if (existing) {
      throw new BadRequestException(`Documento ${data.encf} ya fue recibido anteriormente`);
    }

    const received = await this.prisma.receivedDocument.create({
      data: {
        tenantId,
        companyId: data.companyId,
        encf: data.encf,
        ecfType: data.ecfType as EcfType,
        emitterRnc: data.emitterRnc,
        emitterName: data.emitterName,
        totalAmount: data.totalAmount,
        totalItbis: data.totalItbis,
        issueDate: new Date(data.issueDate),
        originalXml: data.xmlContent,
        status: ReceivedDocumentStatus.RECEIVED,
      },
    });

    try {
      await this.sendArecf(tenantId, received.id);
    } catch (error: any) {
      this.logger.warn(`ARECF send failed for ${data.encf}: ${error.message}`);
    }

    await this.webhooksService.emit(tenantId, WebhookEvent.DOCUMENT_RECEIVED, {
      id: received.id,
      encf: data.encf,
      emitterRnc: data.emitterRnc,
      emitterName: data.emitterName,
      ecfType: data.ecfType,
      totalAmount: data.totalAmount,
    });

    this.logger.info(`Document received: ${data.encf} from ${data.emitterRnc}`);

    return {
      id: received.id,
      encf: data.encf,
      status: received.status,
      message: 'Documento recibido. ARECF generado. Pendiente de aprobación comercial.',
    };
  }

  async sendArecf(tenantId: string, receivedDocId: string) {
    const doc = await this.prisma.receivedDocument.findFirst({
      where: { id: receivedDocId, tenantId },
      include: { company: true },
    });
    if (!doc) throw new NotFoundException('Received document not found');

    const arecfInput: ArecfInput = {
      receiverRnc: doc.company.rnc,
      receiverName: doc.company.businessName,
      emitterRnc: doc.emitterRnc,
      emitterName: doc.emitterName,
      ecfType: doc.ecfType,
      encf: doc.encf,
      totalAmount: Number(doc.totalAmount),
      totalItbis: Number(doc.totalItbis || 0),
      receivedDate: doc.createdAt,
    };

    const arecfXml = this.responseXmlBuilder.buildArecfXml(arecfInput);

    const { p12Buffer, passphrase } = await this.certificatesService.getDecryptedCertificate(
      tenantId, doc.companyId,
    );
    const { privateKey, certificate } = this.signingService.extractFromP12(p12Buffer, passphrase);
    const { signedXml } = this.signingService.signXml(arecfXml, privateKey, certificate);

    const token = await this.dgiiService.getToken(
      tenantId, doc.companyId, privateKey, certificate, doc.company.dgiiEnv,
    );

    // Per DGII p.59: ARECF filename = {RNCComprador}{eNCF}.xml
    const arecfFileName = `${doc.company.rnc}${doc.encf}.xml`;
    const result = await this.dgiiService.sendArecf(signedXml, token, doc.company.dgiiEnv, doc.emitterRnc, arecfFileName);

    // FIX 7: only mark ACKNOWLEDGED when the ARECF was actually delivered.
    // If sendArecf() returns success=false (emitter URL not resolved), keep
    // status=RECEIVED so operators know the acknowledgment is still pending.
    if (result.success) {
      await this.prisma.receivedDocument.update({
        where: { id: receivedDocId },
        data: {
          status: ReceivedDocumentStatus.ACKNOWLEDGED,
          arecfXml: signedXml,
          arecfSentAt: new Date(),
          arecfTrackId: result.trackId,
        },
      });
      this.logger.info(`ARECF sent for ${doc.encf}: TrackId ${result.trackId}`);
    } else {
      await this.prisma.receivedDocument.update({
        where: { id: receivedDocId },
        data: {
          arecfXml: signedXml,
          metadata: { arecfDeliveryError: result.message, arecfAttemptedAt: new Date().toISOString() } as any,
        },
      });
      this.logger.warn(`ARECF not delivered for ${doc.encf}: ${result.message}`);
    }

    return { trackId: result.trackId, delivered: result.success };
  }

  async processApproval(
    tenantId: string,
    documentId: string,
    approved: boolean,
    rejectionReason?: string,
    actorCtx?: ActorContext,
  ) {
    const doc = await this.prisma.receivedDocument.findFirst({
      where: { id: documentId, tenantId },
      include: { company: true },
    });

    if (!doc) throw new NotFoundException('Documento recibido no encontrado');

    // Per DGII Descripción Técnica p.28-29:
    // ACECF does NOT apply to types E32, E41, E43, E46, E47
    const typeCode = getTypeFromEncf(doc.encf);
    if (ACECF_EXCLUDED_TYPES.includes(typeCode)) {
      throw new BadRequestException(
        `Aprobación comercial (ACECF) no aplica para tipo E${typeCode}. ` +
        `Solo aplica a: E31, E33, E34, E44, E45.`,
      );
    }

    if (doc.status === ReceivedDocumentStatus.APPROVED || doc.status === ReceivedDocumentStatus.REJECTED) {
      throw new BadRequestException(`Documento ya fue ${doc.status === ReceivedDocumentStatus.APPROVED ? 'aprobado' : 'rechazado'}`);
    }

    if (!approved && !rejectionReason) {
      throw new BadRequestException('Motivo de rechazo es obligatorio');
    }

    // Single ACECF builder for the whole system: the step3 builder validated
    // in live DGII certification (official xs:sequence, FechaEmision, no MontoITBIS).
    const acecfInput: Step3AcecfInput = {
      emitterRnc: doc.emitterRnc,
      receiverRnc: doc.company.rnc,
      encf: doc.encf,
      issueDate: formatIssueDateDdMmYyyy(doc.issueDate),
      totalAmount: Number(doc.totalAmount),
      approved,
      rejectionReason,
      approvalDatetime: formatDateTimeDdMmYyyy(new Date()),
    };

    const acecfXml = this.acecfXmlBuilder.buildXml(acecfInput);

    const { p12Buffer, passphrase } = await this.certificatesService.getDecryptedCertificate(
      tenantId, doc.companyId,
    );
    const { privateKey, certificate } = this.signingService.extractFromP12(p12Buffer, passphrase);
    const { signedXml } = this.signingService.signXml(acecfXml, privateKey, certificate);

    const token = await this.dgiiService.getToken(
      tenantId, doc.companyId, privateKey, certificate, doc.company.dgiiEnv,
    );

    // Per DGII p.59: ACECF filename = {RNCComprador}{eNCF}.xml
    // Per DGII Informe Técnico p.14: send to emitter AND to DGII
    const acecfFileName = `${doc.company.rnc}${doc.encf}.xml`;
    const result = await this.dgiiService.sendAcecf(signedXml, token, doc.company.dgiiEnv, doc.emitterRnc, acecfFileName);

    const existingMetadata = (doc.metadata as Record<string, any>) || {};

    // Same pattern as ARECF above: only mark APPROVED/REJECTED when DGII
    // actually accepted the ACECF. On failure, persist the attempt (signed XML
    // + per-destination delivery result) and surface the error to the caller.
    if (!result.success) {
      await this.prisma.receivedDocument.update({
        where: { id: documentId },
        data: {
          acecfXml: signedXml,
          acecfStatus: 'Error',
          metadata: {
            ...existingMetadata,
            acecfDeliveryError: (result.message || '').slice(0, 1000),
            acecfAttemptedAt: new Date().toISOString(),
            acecfEmitterDelivery: result.emitterDelivery,
          } as any,
        },
      });
      this.logger.warn(`ACECF rejected/failed at DGII for ${doc.encf}: ${result.message}`);
      throw new BadGatewayException(
        `DGII no aceptó el ACECF para ${doc.encf}: ${(result.message || 'error desconocido').slice(0, 300)}`,
      );
    }

    const newStatus = approved ? ReceivedDocumentStatus.APPROVED : ReceivedDocumentStatus.REJECTED;

    await this.prisma.receivedDocument.update({
      where: { id: documentId },
      data: {
        status: newStatus,
        acecfXml: signedXml,
        acecfSentAt: new Date(),
        acecfTrackId: result.trackId,
        acecfStatus: approved ? 'Aprobado' : 'Rechazado',
        rejectionReason: approved ? null : rejectionReason || null,
        // Traceability of the emitter leg (DELIVERED / FAILED / NOT_IN_DIRECTORY / SKIPPED)
        metadata: {
          ...existingMetadata,
          acecfEmitterDelivery: result.emitterDelivery,
        } as any,
      },
    });

    // Audit trail: a commercial approval/rejection (ACECF) is a sensitive,
    // outward fiscal action sent to DGII + the emitter. Record WHO/WHAT/WHEN.
    await this.prisma.auditLog.create({
      data: {
        tenantId,
        entityType: 'received_document',
        entityId: documentId,
        action: approved ? 'commercial_approval_sent' : 'commercial_rejection_sent',
        actor: actorCtx?.actor ?? 'api',
        ipAddress: actorCtx?.ipAddress ?? null,
        metadata: {
          encf: doc.encf,
          emitterRnc: doc.emitterRnc,
          receiverRnc: doc.company.rnc,
          approved,
          rejectionReason: approved ? null : rejectionReason || null,
          trackId: result.trackId ?? null,
        },
      },
    });

    await this.webhooksService.emit(
      tenantId,
      WebhookEvent.COMMERCIAL_APPROVAL_RECEIVED,
      { encf: doc.encf, emitterRnc: doc.emitterRnc, approved, rejectionReason },
    );

    this.logger.info(`Document ${doc.encf} ${approved ? 'approved' : 'rejected'} commercially`);

    return {
      encf: doc.encf,
      status: newStatus,
      trackId: result.trackId,
      message: approved
        ? 'Documento aprobado comercialmente (ACECF enviado a DGII)'
        : `Documento rechazado (ACECF enviado a DGII): ${rejectionReason}`,
    };
  }

  async findAll(tenantId: string, companyId?: string, status?: string) {
    const where: any = { tenantId };
    if (companyId) where.companyId = companyId;
    if (status) where.status = status;

    return this.prisma.receivedDocument.findMany({
      where,
      include: { company: { select: { rnc: true, businessName: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async findOne(tenantId: string, id: string) {
    const doc = await this.prisma.receivedDocument.findFirst({
      where: { id, tenantId },
      include: { company: { select: { rnc: true, businessName: true } } },
    });
    if (!doc) throw new NotFoundException('Documento recibido no encontrado');
    return doc;
  }
}
