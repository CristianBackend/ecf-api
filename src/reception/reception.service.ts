import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { SigningService } from '../signing/signing.service';
import { DgiiService } from '../dgii/dgii.service';
import { CertificatesService } from '../certificates/certificates.service';
import { ResponseXmlBuilder, ArecfInput, AcecfInput } from '../xml-builder/response-xml-builder';
import { ACECF_EXCLUDED_TYPES, getTypeFromEncf } from '../xml-builder/ecf-types';
import { WebhookEvent, EcfType, ReceivedDocumentStatus } from '@prisma/client';

@Injectable()
export class ReceptionService {
  private readonly logger = new Logger(ReceptionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly webhooksService: WebhooksService,
    private readonly signingService: SigningService,
    private readonly dgiiService: DgiiService,
    private readonly certificatesService: CertificatesService,
    private readonly responseXmlBuilder: ResponseXmlBuilder,
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

    this.logger.log(`Document received: ${data.encf} from ${data.emitterRnc}`);

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

    await this.prisma.receivedDocument.update({
      where: { id: receivedDocId },
      data: {
        status: ReceivedDocumentStatus.ACKNOWLEDGED,
        arecfXml: signedXml,
        arecfSentAt: new Date(),
        arecfTrackId: result.trackId,
      },
    });

    this.logger.log(`ARECF sent for ${doc.encf}: TrackId ${result.trackId}`);
    return { trackId: result.trackId };
  }

  async processApproval(
    tenantId: string,
    documentId: string,
    approved: boolean,
    rejectionReason?: string,
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

    const acecfInput: AcecfInput = {
      receiverRnc: doc.company.rnc,
      receiverName: doc.company.businessName,
      emitterRnc: doc.emitterRnc,
      emitterName: doc.emitterName,
      ecfType: doc.ecfType,
      encf: doc.encf,
      totalAmount: Number(doc.totalAmount),
      totalItbis: Number(doc.totalItbis || 0),
      approvalDate: new Date(),
      approved,
      rejectionReason,
    };

    const acecfXml = this.responseXmlBuilder.buildAcecfXml(acecfInput);

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

    const newStatus = approved ? ReceivedDocumentStatus.APPROVED : ReceivedDocumentStatus.REJECTED;

    await this.prisma.receivedDocument.update({
      where: { id: documentId },
      data: {
        status: newStatus,
        acecfXml: signedXml,
        acecfSentAt: new Date(),
        acecfTrackId: result.trackId,
        acecfStatus: approved ? 'Aprobado' : 'Rechazado',
        rejectionReason: rejectionReason || null,
      },
    });

    await this.webhooksService.emit(
      tenantId,
      WebhookEvent.COMMERCIAL_APPROVAL_RECEIVED,
      { encf: doc.encf, emitterRnc: doc.emitterRnc, approved, rejectionReason },
    );

    this.logger.log(`Document ${doc.encf} ${approved ? 'approved' : 'rejected'} commercially`);

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
