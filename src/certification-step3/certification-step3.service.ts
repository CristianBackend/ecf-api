import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { AcecfExcelParser } from './services/acecf-excel-parser.service';
import { AcecfXmlBuilder } from './services/acecf-xml-builder.service';
import { SigningService } from '../signing/signing.service';
import { DgiiService } from '../dgii/dgii.service';
import { CertificatesService } from '../certificates/certificates.service';
import { Step3AcecfStatus } from '@prisma/client';

/** e-CF types to which ACECF does NOT apply. */
const ACECF_EXCLUDED_TYPES = ['E32', 'E41', 'E43', 'E46', 'E47'];

@Injectable()
export class CertificationStep3Service {
  constructor(
    private readonly prisma: PrismaService,
    private readonly excelParser: AcecfExcelParser,
    private readonly xmlBuilder: AcecfXmlBuilder,
    private readonly signingService: SigningService,
    private readonly dgiiService: DgiiService,
    private readonly certificatesService: CertificatesService,
    @InjectPinoLogger(CertificationStep3Service.name)
    private readonly logger: PinoLogger,
  ) {}

  // -----------------------------------------------------------------------
  // Upload Excel
  // -----------------------------------------------------------------------

  async uploadExcel(tenantId: string, companyId: string, fileBuffer: Buffer) {
    const parsed = this.excelParser.parse(fileBuffer);

    if (parsed.length === 0) {
      throw new BadRequestException('El Excel no contiene filas válidas');
    }

    const valid = parsed.filter(p => !ACECF_EXCLUDED_TYPES.includes(p.ecfType));
    const excluded = parsed.filter(p => ACECF_EXCLUDED_TYPES.includes(p.ecfType));

    const created: Array<{ id: string; encf: string }> = [];
    const errors: Array<{ encf: string; error: string }> = [];

    for (const row of valid) {
      try {
        const doc = await this.prisma.step3AcecfDocument.upsert({
          where: { tenantId_companyId_encf: { tenantId, companyId, encf: row.encf } },
          create: {
            tenantId, companyId,
            encf: row.encf,
            ecfType: row.ecfType,
            emitterRnc: row.emitterRnc,
            receiverRnc: row.receiverRnc,
            totalAmount: row.totalAmount,
            issueDate: row.issueDate,
            intendedEstado: row.intendedEstado,
            rejectionReason: row.rejectionReason ?? null,
            status: Step3AcecfStatus.PENDING,
          },
          update: {
            totalAmount: row.totalAmount,
            issueDate: row.issueDate,
            intendedEstado: row.intendedEstado,
            rejectionReason: row.rejectionReason ?? null,
          },
        });
        created.push({ id: doc.id, encf: doc.encf });
      } catch (e: any) {
        errors.push({ encf: row.encf, error: e.message });
      }
    }

    this.logger.info(`Step3 upload: ${created.length} upserted, ${errors.length} errors, ${excluded.length} excluded by type`);

    return {
      total: parsed.length,
      created: created.length,
      excluded: excluded.length,
      excludedEncfs: excluded.map(e => e.encf),
      errors,
      documents: created,
    };
  }

  // -----------------------------------------------------------------------
  // List documents
  // -----------------------------------------------------------------------

  async listDocuments(tenantId: string, companyId: string) {
    return this.prisma.step3AcecfDocument.findMany({
      where: { tenantId, companyId },
      orderBy: { encf: 'asc' },
    });
  }

  // -----------------------------------------------------------------------
  // Process one document: build → sign → submit
  // -----------------------------------------------------------------------

  async processDocument(tenantId: string, documentId: string) {
    const doc = await this.prisma.step3AcecfDocument.findFirst({
      where: { id: documentId, tenantId },
    });
    if (!doc) throw new NotFoundException('Documento no encontrado');

    if (doc.status === Step3AcecfStatus.ACCEPTED) {
      return { id: doc.id, status: doc.status, trackId: doc.trackId, skipped: true };
    }

    const company = await this.prisma.company.findFirst({
      where: { id: doc.companyId, tenantId },
    });
    if (!company) throw new NotFoundException('Company no encontrada');

    try {
      // 1. BUILD
      await this.prisma.step3AcecfDocument.update({
        where: { id: doc.id },
        data: { status: Step3AcecfStatus.BUILDING },
      });

      const acecfXml = this.xmlBuilder.buildXml({
        emitterRnc: doc.emitterRnc,
        receiverRnc: doc.receiverRnc,
        encf: doc.encf,
        issueDate: doc.issueDate,
        totalAmount: Number(doc.totalAmount),
        approved: doc.intendedEstado === 1,
        rejectionReason: doc.rejectionReason ?? undefined,
      });

      // 2. SIGN
      await this.prisma.step3AcecfDocument.update({
        where: { id: doc.id },
        data: { status: Step3AcecfStatus.SIGNING, acecfXml },
      });

      const { p12Buffer, passphrase } =
        await this.certificatesService.getDecryptedCertificate(tenantId, doc.companyId);
      const { privateKey, certificate } =
        this.signingService.extractFromP12(p12Buffer, passphrase);
      const { signedXml } =
        this.signingService.signXml(acecfXml, privateKey, certificate);

      // 3. SUBMIT
      await this.prisma.step3AcecfDocument.update({
        where: { id: doc.id },
        data: { status: Step3AcecfStatus.SUBMITTING, signedXml },
      });

      const token = await this.dgiiService.getToken(
        tenantId, doc.companyId, privateKey, certificate, company.dgiiEnv,
      );

      const result = await this.dgiiService.sendAcecf(
        signedXml, token, company.dgiiEnv,
      );

      const newStatus = result.success ? Step3AcecfStatus.SENT : Step3AcecfStatus.ERROR;

      await this.prisma.step3AcecfDocument.update({
        where: { id: doc.id },
        data: {
          status: newStatus,
          trackId: result.trackId ?? null,
          dgiiResponse: result as any,
          errorMessage: result.success ? null : result.message,
          sentAt: new Date(),
        },
      });

      this.logger.info(`Step3 ${doc.encf}: ${newStatus} | trackId=${result.trackId}`);
      return { id: doc.id, encf: doc.encf, status: newStatus, trackId: result.trackId, message: result.message };

    } catch (e: any) {
      await this.prisma.step3AcecfDocument.update({
        where: { id: doc.id },
        data: { status: Step3AcecfStatus.ERROR, errorMessage: e.message },
      }).catch(() => {});
      throw e;
    }
  }

  // -----------------------------------------------------------------------
  // Process all PENDING / ERROR docs sequentially
  // -----------------------------------------------------------------------

  async processAll(tenantId: string, companyId: string) {
    const docs = await this.prisma.step3AcecfDocument.findMany({
      where: {
        tenantId, companyId,
        status: { in: [Step3AcecfStatus.PENDING, Step3AcecfStatus.ERROR] },
      },
      orderBy: { encf: 'asc' },
    });

    const results = [];
    for (const doc of docs) {
      try {
        const r = await this.processDocument(tenantId, doc.id);
        results.push(r);
      } catch (e: any) {
        results.push({ id: doc.id, encf: doc.encf, error: e.message });
      }
    }

    return { processed: results.length, results };
  }
}
