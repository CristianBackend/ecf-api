import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { XmlBuilderService, EmitterData } from '../xml-builder/xml-builder.service';
import { SigningService } from '../signing/signing.service';
import { DgiiService } from '../dgii/dgii.service';
import { CertificatesService } from '../certificates/certificates.service';
import { SequencesService } from '../sequences/sequences.service';
import { ValidationService } from '../validation/validation.service';
import { XsdValidationService } from '../validation/xsd-validation.service';
import { RncValidationService } from '../common/services/rnc-validation.service';
import { QueueService } from '../queue/queue.service';
import { CreateInvoiceDto, TYPES_REQUIRING_RNC } from './dto/invoice.dto';
import { InvoiceStatus, EcfType } from '@prisma/client';
import {
  DGII_STATUS,
  FC_FULL_SUBMISSION_THRESHOLD,
  ECF_TYPE_CODES,
} from '../xml-builder/ecf-types';

@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly xmlBuilder: XmlBuilderService,
    private readonly signingService: SigningService,
    private readonly dgiiService: DgiiService,
    private readonly certificatesService: CertificatesService,
    private readonly sequencesService: SequencesService,
    private readonly validationService: ValidationService,
    private readonly xsdValidation: XsdValidationService,
    private readonly rncValidation: RncValidationService,
    private readonly queueService: QueueService,
  ) {}

  /**
   * Accept an invoice request, persist it as QUEUED, and enqueue the async
   * pipeline.
   *
   * Synchronous work kept here (must reject invalid input before any side
   * effects or async job are created):
   * 1. Idempotency check
   * 2. Company lookup + DGII business validations (RNC, E33/E34 reference,
   *    discount-per-line, E32 250K threshold, credit term-days)
   * 3. eNCF assignment from sequences
   * 4. Unsigned XML build + local XSD validation
   * 5. INSERT invoice (status=QUEUED) + invoice lines
   * 6. Audit log
   * 7. Enqueue EcfProcessingProcessor — the processor owns signing, DGII
   *    submission, status polling, webhook delivery and retry/contingency.
   *
   * The controller returns HTTP 202 Accepted with { id, eNCF, status:
   * 'QUEUED' }. All DGII interaction happens out-of-request.
   */
  async create(tenantId: string, dto: CreateInvoiceDto) {
    if (dto.idempotencyKey) {
      const existing = await this.prisma.invoice.findUnique({
        where: { idempotencyKey: dto.idempotencyKey },
      });
      if (existing) {
        this.logger.debug(`Idempotency hit: ${dto.idempotencyKey}`);
        return this.formatInvoiceResponse(existing);
      }
    }

    const company = await this.prisma.company.findFirst({
      where: { id: dto.companyId, tenantId, isActive: true },
    });
    if (!company) {
      throw new NotFoundException('Empresa no encontrada o inactiva');
    }

    if (TYPES_REQUIRING_RNC.includes(dto.ecfType) && !dto.buyer.rnc) {
      throw new BadRequestException(
        `RNC del comprador es obligatorio para tipo ${dto.ecfType}. ` +
        `Solo E32 (Consumo), E46 (Exportaciones) y E47 (Pagos Exterior) permiten omitir RNC.`,
      );
    }

    if (dto.buyer.rnc) {
      const rncCheck = this.rncValidation.validateFormat(dto.buyer.rnc);
      if (!rncCheck.valid) {
        throw new BadRequestException(
          `RNC/Cédula del comprador inválido: ${rncCheck.error}`,
        );
      }
      if (rncCheck.warning) {
        this.logger.warn(`Buyer RNC ${dto.buyer.rnc}: ${rncCheck.warning}`);
      }
    }

    if ((dto.ecfType === 'E33' || dto.ecfType === 'E34') && !dto.reference) {
      throw new BadRequestException(
        `Referencia al documento original es obligatoria para ${dto.ecfType === 'E33' ? 'Nota de Débito (E33)' : 'Nota de Crédito (E34)'}. ` +
        `Incluya el campo "reference" con el eNCF original.`,
      );
    }

    for (let i = 0; i < dto.items.length; i++) {
      const item = dto.items[i];
      const lineSubtotal = item.quantity * item.unitPrice;
      if (item.discount && item.discount > lineSubtotal) {
        throw new BadRequestException(
          `Item ${i + 1}: descuento (${item.discount}) no puede exceder subtotal de línea (${lineSubtotal})`,
        );
      }
    }

    if (dto.payment.type === 2 && !dto.payment.termDays) {
      throw new BadRequestException(
        'Pago a crédito (TipoPago=2) requiere especificar "termDays" (días de crédito).',
      );
    }

    const ecfType = dto.ecfType as EcfType;
    const typeCode = ECF_TYPE_CODES[dto.ecfType as keyof typeof ECF_TYPE_CODES];

    const encf = await this.sequencesService.getNextEncf(tenantId, dto.companyId, ecfType);
    this.logger.log(`eNCF assigned: ${encf}`);

    const activeSequence = await this.prisma.sequence.findFirst({
      where: { tenantId, companyId: dto.companyId, ecfType, isActive: true },
      select: { expiresAt: true },
    });

    const emitterData: EmitterData = {
      rnc: company.rnc,
      businessName: company.businessName,
      tradeName: company.tradeName || undefined,
      branchCode: company.branchCode || undefined,
      address: company.address || undefined,
      municipality: company.municipality || undefined,
      province: company.province || undefined,
      economicActivity: company.economicActivity || undefined,
    };

    const inputWithSequence = {
      ...(dto as any),
      sequenceExpiresAt: activeSequence?.expiresAt?.toISOString(),
    };

    const { xml: unsignedXml, totals } = this.xmlBuilder.buildEcfXml(
      inputWithSequence,
      emitterData,
      encf,
    );

    if (this.xsdValidation.isAvailable()) {
      const xsdResult = await this.xsdValidation.validateXml(unsignedXml, typeCode);
      if (!xsdResult.valid) {
        this.logger.error(`XSD validation failed for ${encf}: ${xsdResult.errors.join('; ')}`);
        throw new BadRequestException(
          `XML no pasa validación XSD de DGII: ${xsdResult.errors.slice(0, 3).join('; ')}`,
        );
      }
    } else {
      this.logger.warn(`XSD validation unavailable for ${encf} — xmllint not installed`);
    }

    const isRfce = typeCode === 32 && totals.totalAmount < FC_FULL_SUBMISSION_THRESHOLD;

    const invoice = await this.prisma.invoice.create({
      data: {
        tenantId,
        companyId: dto.companyId,
        ecfType,
        encf,
        status: InvoiceStatus.QUEUED,
        buyerRnc: dto.buyer.rnc,
        buyerName: dto.buyer.name,
        buyerEmail: dto.buyer.email,
        subtotal: totals.subtotalBeforeTax,
        totalDiscount: totals.totalDiscount,
        totalItbis: totals.totalItbis,
        totalIsc: totals.totalIsc,
        totalAmount: totals.totalAmount,
        paymentType: dto.payment.type,
        referenceEncf: dto.reference?.encf,
        referenceDate: dto.reference?.date ? new Date(dto.reference.date) : undefined,
        referenceModCode: dto.reference?.modificationCode,
        isRfce,
        currency: dto.currency?.code || 'DOP',
        exchangeRate: dto.currency?.exchangeRate,
        xmlUnsigned: unsignedXml,
        idempotencyKey: dto.idempotencyKey,
        metadata: { ...dto.metadata, _originalDto: dto } as any,
      },
    });

    await this.prisma.invoiceLine.createMany({
      data: dto.items.map((item, index) => {
        const lineSubtotal = item.quantity * item.unitPrice - (item.discount || 0) + (item.surcharge || 0);
        const rate = item.itbisRate ?? 18;
        const itbisAmount = lineSubtotal * (rate / 100);

        return {
          tenantId,
          invoiceId: invoice.id,
          lineNumber: index + 1,
          description: item.description,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          discount: item.discount || 0,
          itbisRate: rate,
          itbisAmount: Math.round(itbisAmount * 100) / 100,
          iscAmount: 0,
          subtotal: Math.round(lineSubtotal * 100) / 100,
          additionalTaxCode: item.additionalTaxCode || null,
          additionalTaxRate: item.additionalTaxRate || null,
          goodService: item.goodService || 1,
        };
      }),
    });

    await this.createAuditLog(tenantId, 'invoice', invoice.id, 'queued', {
      encf,
      ecfType,
      isRfce,
      totalAmount: totals.totalAmount,
    });

    await this.queueService.enqueueEcfProcessing({
      invoiceId: invoice.id,
      tenantId,
      companyId: dto.companyId,
    });

    return this.findOne(tenantId, invoice.id);
  }

  /**
   * Poll DGII for invoice status update.
   */
  async pollStatus(tenantId: string, invoiceId: string) {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, tenantId },
      include: { company: true },
    });

    if (!invoice) throw new NotFoundException('Factura no encontrada');
    if (!invoice.trackId) {
      throw new BadRequestException('Factura sin TrackId para consultar');
    }

    const { p12Buffer, passphrase } = await this.certificatesService.getDecryptedCertificate(
      tenantId, invoice.companyId,
    );
    const { privateKey, certificate } = this.signingService.extractFromP12(p12Buffer, passphrase);
    const token = await this.dgiiService.getToken(
      tenantId, invoice.companyId, privateKey, certificate, invoice.company.dgiiEnv,
    );

    const result = await this.dgiiService.queryStatus(
      invoice.trackId, token, invoice.company.dgiiEnv,
    );

    const newStatus = this.mapDgiiStatus(result.status);

    if (newStatus !== invoice.status) {
      await this.prisma.invoice.update({
        where: { id: invoice.id },
        data: {
          status: newStatus,
          dgiiResponse: result as any,
          dgiiMessage: result.message,
          dgiiTimestamp: new Date(),
        },
      });

      await this.createAuditLog(tenantId, 'invoice', invoice.id, 'status_updated', {
        previousStatus: invoice.status,
        newStatus,
        dgiiMessage: result.message,
      });
    }

    return {
      invoiceId: invoice.id,
      encf: invoice.encf,
      previousStatus: invoice.status,
      currentStatus: newStatus,
      dgiiMessage: result.message,
      trackId: invoice.trackId,
    };
  }

  async findOne(tenantId: string, invoiceId: string) {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, tenantId },
      include: {
        lines: { orderBy: { lineNumber: 'asc' } },
        company: { select: { rnc: true, businessName: true } },
      },
    });

    if (!invoice) throw new NotFoundException('Factura no encontrada');
    return this.formatInvoiceResponse(invoice);
  }

  async findAll(
    tenantId: string,
    filters: {
      companyId?: string;
      ecfType?: string;
      status?: string;
      dateFrom?: string;
      dateTo?: string;
      page?: number;
      limit?: number;
    },
  ) {
    const page = filters.page || 1;
    const limit = Math.min(filters.limit || 20, 100);
    const skip = (page - 1) * limit;

    const where: any = { tenantId };
    if (filters.companyId) where.companyId = filters.companyId;
    if (filters.ecfType) where.ecfType = filters.ecfType;
    if (filters.status) where.status = filters.status;
    if (filters.dateFrom || filters.dateTo) {
      where.createdAt = {};
      if (filters.dateFrom) where.createdAt.gte = new Date(filters.dateFrom);
      if (filters.dateTo) where.createdAt.lte = new Date(filters.dateTo);
    }

    const [invoices, total] = await Promise.all([
      this.prisma.invoice.findMany({
        where,
        include: { company: { select: { rnc: true, businessName: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.invoice.count({ where }),
    ]);

    return {
      data: invoices,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async getXml(tenantId: string, invoiceId: string): Promise<string> {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, tenantId },
      select: { xmlSigned: true, xmlUnsigned: true, xmlRfce: true },
    });
    if (!invoice) throw new NotFoundException('Factura no encontrada');
    return invoice.xmlSigned || invoice.xmlUnsigned || '';
  }

  // ============================================================
  // PRIVATE HELPERS
  // ============================================================

  /**
   * Void/cancel an invoice.
   * - DRAFT, ERROR, CONTINGENCY: Can be voided directly (never reached DGII successfully)
   * - ACCEPTED: Cannot void directly — must issue a Credit Note (E34) instead
   * - PROCESSING, SENT: Cannot void while in transit to DGII
   * - VOIDED: Already voided
   */
  async voidInvoice(tenantId: string, invoiceId: string, reason?: string) {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, tenantId },
      include: { company: true },
    });

    if (!invoice) throw new NotFoundException('Factura no encontrada');

    // Check what statuses allow voiding
    const voidableStatuses: InvoiceStatus[] = [
      InvoiceStatus.DRAFT,
      InvoiceStatus.ERROR,
      InvoiceStatus.CONTINGENCY,
      InvoiceStatus.REJECTED,
    ];

    if (invoice.status === InvoiceStatus.VOIDED) {
      throw new BadRequestException('La factura ya está anulada');
    }

    if (invoice.status === InvoiceStatus.ACCEPTED || invoice.status === InvoiceStatus.CONDITIONAL) {
      throw new BadRequestException(
        'No se puede anular una factura aceptada por DGII. ' +
        'Debe emitir una Nota de Crédito (E34) para anular el comprobante.',
      );
    }

    if (invoice.status === InvoiceStatus.PROCESSING || invoice.status === InvoiceStatus.SENT) {
      throw new BadRequestException(
        'No se puede anular una factura en proceso de envío a DGII. ' +
        'Espere a que se complete el envío o consulte el estado primero.',
      );
    }

    if (!voidableStatuses.includes(invoice.status)) {
      throw new BadRequestException(`No se puede anular una factura en estado ${invoice.status}`);
    }

    // Void the invoice
    const updated = await this.prisma.invoice.update({
      where: { id: invoice.id },
      data: {
        status: InvoiceStatus.VOIDED,
        dgiiMessage: reason || 'Anulada por el usuario',
        metadata: {
          ...(invoice.metadata as any || {}),
          voidedAt: new Date().toISOString(),
          voidReason: reason || 'Anulada por el usuario',
          previousStatus: invoice.status,
        },
      },
      include: {
        lines: { orderBy: { lineNumber: 'asc' } },
        company: { select: { id: true, rnc: true, businessName: true } },
      },
    });

    await this.createAuditLog(tenantId, 'invoice', invoice.id, 'voided', {
      encf: invoice.encf,
      ecfType: invoice.ecfType,
      previousStatus: invoice.status,
      reason: reason || 'Anulada por el usuario',
    });

    this.logger.log(`Invoice ${invoice.encf || invoice.id} voided (was ${invoice.status})`);

    return updated;
  }

  private mapDgiiStatus(dgiiStatus: number): InvoiceStatus {
    switch (dgiiStatus) {
      case DGII_STATUS.ACCEPTED: return InvoiceStatus.ACCEPTED;
      case DGII_STATUS.REJECTED: return InvoiceStatus.REJECTED;
      case DGII_STATUS.IN_PROCESS: return InvoiceStatus.PROCESSING;
      case DGII_STATUS.CONDITIONAL: return InvoiceStatus.CONDITIONAL;
      default: return InvoiceStatus.SENT;
    }
  }

  private formatInvoiceResponse(invoice: any) {
    const { xmlUnsigned, xmlSigned, xmlRfce, signatureValue, ...rest } = invoice;
    return {
      ...rest,
      hasXml: !!(xmlUnsigned || xmlSigned),
      hasSignedXml: !!xmlSigned,
      isRfce: rest.isRfce || false,
    };
  }

  private async createAuditLog(
    tenantId: string, entityType: string, entityId: string,
    action: string, metadata?: any,
  ) {
    await this.prisma.auditLog.create({
      data: { tenantId, entityType, entityId, action, actor: 'api', metadata },
    });
  }
}
