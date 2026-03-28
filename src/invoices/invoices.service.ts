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
  ) {}

  /**
   * Create and process an invoice — full DGII-compliant flow:
   *
   * 1. Validate + idempotency
   * 2. Get company data (emitter)
   * 3. Assign eNCF from sequences
   * 4. Build XML
   * 5. Extract key/cert from .p12 → sign XML
   * 6. Determine submission:
   *    - E32 < 250K → RFCE (summary only to DGII, full XML local)
   *    - All others → Full signed XML to DGII
   * 7. Authenticate → submit → get TrackId
   * 8. Store everything → return result
   */
  async create(tenantId: string, dto: CreateInvoiceDto) {
    // Step 0: Idempotency check
    if (dto.idempotencyKey) {
      const existing = await this.prisma.invoice.findUnique({
        where: { idempotencyKey: dto.idempotencyKey },
      });
      if (existing) {
        this.logger.debug(`Idempotency hit: ${dto.idempotencyKey}`);
        return this.formatInvoiceResponse(existing);
      }
    }

    // Step 1: Get company data
    const company = await this.prisma.company.findFirst({
      where: { id: dto.companyId, tenantId, isActive: true },
    });

    if (!company) {
      throw new NotFoundException('Empresa no encontrada o inactiva');
    }

    // ── Business Logic Validations ──

    // RNC required for certain ecfTypes
    if (TYPES_REQUIRING_RNC.includes(dto.ecfType) && !dto.buyer.rnc) {
      throw new BadRequestException(
        `RNC del comprador es obligatorio para tipo ${dto.ecfType}. ` +
        `Solo E32 (Consumo), E46 (Exportaciones) y E47 (Pagos Exterior) permiten omitir RNC.`,
      );
    }

    // Validate buyer RNC format if provided (check digit is soft, DGII lookup is authoritative)
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

    // Reference required for NC (E34) and ND (E33)
    if ((dto.ecfType === 'E33' || dto.ecfType === 'E34') && !dto.reference) {
      throw new BadRequestException(
        `Referencia al documento original es obligatoria para ${dto.ecfType === 'E33' ? 'Nota de Débito (E33)' : 'Nota de Crédito (E34)'}. ` +
        `Incluya el campo "reference" con el eNCF original.`,
      );
    }

    // Validate discount does not exceed line subtotal
    for (let i = 0; i < dto.items.length; i++) {
      const item = dto.items[i];
      const lineSubtotal = item.quantity * item.unitPrice;
      if (item.discount && item.discount > lineSubtotal) {
        throw new BadRequestException(
          `Item ${i + 1}: descuento (${item.discount}) no puede exceder subtotal de línea (${lineSubtotal})`,
        );
      }
    }

    // TipoPago 2 (Crédito) requires termDays
    if (dto.payment.type === 2 && !dto.payment.termDays) {
      throw new BadRequestException(
        'Pago a crédito (TipoPago=2) requiere especificar "termDays" (días de crédito).',
      );
    }

    const ecfType = dto.ecfType as EcfType;
    const typeCode = ECF_TYPE_CODES[dto.ecfType as keyof typeof ECF_TYPE_CODES];

    // Step 2: Assign eNCF
    const encf = await this.sequencesService.getNextEncf(tenantId, dto.companyId, ecfType);
    this.logger.log(`eNCF assigned: ${encf}`);

    // Get sequence expiry date for XML (E32/E34 don't include it in XML per DGII spec)
    const activeSequence = await this.prisma.sequence.findFirst({
      where: { tenantId, companyId: dto.companyId, ecfType, isActive: true },
      select: { expiresAt: true },
    });

    // Step 3: Build XML
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

    // Step 3b: Validate XML against XSD schema (only blocks if validation tool is available)
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

    // Determine if RFCE (Factura Consumo < 250K)
    const isRfce = typeCode === 32 && totals.totalAmount < FC_FULL_SUBMISSION_THRESHOLD;

    // Step 4: Create invoice record
    const invoice = await this.prisma.invoice.create({
      data: {
        tenantId,
        companyId: dto.companyId,
        ecfType,
        encf,
        status: InvoiceStatus.PROCESSING,
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

    // Create invoice lines
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

    // Step 5: Sign and submit
    try {
      // Get decrypted .p12 certificate
      const { p12Buffer, passphrase } = await this.certificatesService.getDecryptedCertificate(
        tenantId,
        dto.companyId,
      );

      // Extract private key and certificate from .p12
      // Per DGII p.60: validate that certificate SN matches company RNC
      const { privateKey, certificate } = this.signingService.extractFromP12(
        p12Buffer,
        passphrase,
        company.rnc,
      );

      // Sign the XML
      const { signedXml, securityCode, signTime } = this.signingService.signXml(
        unsignedXml,
        privateKey,
        certificate,
      );

      this.logger.log(`XML signed: ${encf} | Security code: ${securityCode}`);

      // Update invoice with signed data
      await this.prisma.invoice.update({
        where: { id: invoice.id },
        data: {
          xmlSigned: signedXml,
          securityCode,
          signedAt: signTime,
        },
      });

      // Step 6: Authenticate with DGII
      const token = await this.dgiiService.getToken(
        tenantId,
        dto.companyId,
        privateKey,
        certificate,
        company.dgiiEnv,
      );

      // Step 7: Submit to DGII
      let submissionResult;

      if (isRfce) {
        // ========== RFCE FLOW ==========
        // E32 < 250K: send only summary, store full XML locally
        this.logger.log(`RFCE flow: ${encf} (total: RD$${totals.totalAmount})`);

        const rfceXml = this.xmlBuilder.buildRfceXml(
          dto as any,
          emitterData,
          encf,
          totals,
          securityCode,
        );

        await this.prisma.invoice.update({
          where: { id: invoice.id },
          data: { xmlRfce: rfceXml },
        });

        // S6 fix: DGII requires filename = {RNCEmisor}{eNCF}.xml
        submissionResult = await this.dgiiService.submitRfce(
          rfceXml,
          token,
          company.dgiiEnv,
          `${company.rnc}${encf}.xml`,
        );
      } else {
        // ========== STANDARD FLOW ==========
        // File name per DGII spec: {RNCEmisor}{eNCF}.xml
        submissionResult = await this.dgiiService.submitEcf(
          signedXml,
          `${company.rnc}${encf}.xml`,
          token,
          company.dgiiEnv,
        );
      }

      // Step 8: Update with DGII response
      const newStatus = this.mapDgiiStatus(submissionResult.status);

      await this.prisma.invoice.update({
        where: { id: invoice.id },
        data: {
          status: newStatus,
          trackId: submissionResult.trackId,
          dgiiResponse: submissionResult as any,
          dgiiMessage: submissionResult.message,
          dgiiTimestamp: new Date(),
        },
      });

      this.logger.log(`${encf} → DGII: ${newStatus} | TrackId: ${submissionResult.trackId}`);

      // Audit log
      await this.createAuditLog(tenantId, 'invoice', invoice.id, 'submitted', {
        encf, ecfType, isRfce,
        totalAmount: totals.totalAmount,
        securityCode,
        dgiiStatus: newStatus,
        trackId: submissionResult.trackId,
      });

    } catch (error: any) {
      this.logger.error(`Error processing ${encf}: ${error.message}`);

      const isNetworkError =
        error.status === 503 ||
        error.message?.includes('DGII') ||
        error.message?.includes('ECONNREFUSED') ||
        error.message?.includes('ETIMEDOUT');

      await this.prisma.invoice.update({
        where: { id: invoice.id },
        data: {
          status: isNetworkError ? InvoiceStatus.CONTINGENCY : InvoiceStatus.ERROR,
          dgiiMessage: error.message,
        },
      });

      if (isNetworkError) {
        this.logger.warn(`${encf} saved in CONTINGENCY mode`);
      }
    }

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
