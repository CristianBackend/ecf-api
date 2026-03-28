import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SigningService } from '../signing/signing.service';
import { DgiiService } from '../dgii/dgii.service';
import { CertificatesService } from '../certificates/certificates.service';
import { XmlBuilderService, EmitterData } from '../xml-builder/xml-builder.service';
import { CreateSequenceDto } from './dto/sequence.dto';
import { EcfType } from '@prisma/client';

/**
 * Maps EcfType enum to the 2-digit prefix used in eNCF.
 * eNCF format: E + 2 digit type + 10 digit sequence = 13 chars total
 * Example: E310000000001
 */
const ECF_TYPE_PREFIX: Record<EcfType, string> = {
  E31: 'E31',
  E32: 'E32',
  E33: 'E33',
  E34: 'E34',
  E41: 'E41',
  E43: 'E43',
  E44: 'E44',
  E45: 'E45',
  E46: 'E46',
  E47: 'E47',
};

@Injectable()
export class SequencesService {
  private readonly logger = new Logger(SequencesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly signingService: SigningService,
    private readonly dgiiService: DgiiService,
    private readonly certificatesService: CertificatesService,
    private readonly xmlBuilder: XmlBuilderService,
  ) {}

  /**
   * Register a new sequence range authorized by the DGII.
   */
  async create(tenantId: string, dto: CreateSequenceDto) {
    // Verify company belongs to tenant
    const company = await this.prisma.company.findFirst({
      where: { id: dto.companyId, tenantId },
    });

    if (!company) {
      throw new NotFoundException('Company not found');
    }

    if (dto.startNumber >= dto.endNumber) {
      throw new BadRequestException('startNumber must be less than endNumber');
    }

    if (dto.startNumber < 1) {
      throw new BadRequestException('startNumber debe ser mayor a 0');
    }

    if (dto.endNumber < 1) {
      throw new BadRequestException('endNumber debe ser mayor a 0');
    }

    if (dto.endNumber - dto.startNumber > 10000000) {
      throw new BadRequestException('El rango no puede exceder 10,000,000 de secuencias');
    }

    // Check for overlapping sequences of same type (active OR inactive — prevents reuse)
    const overlapping = await this.prisma.sequence.findFirst({
      where: {
        companyId: dto.companyId,
        ecfType: dto.ecfType,
        OR: [
          // New range starts inside existing range
          { startNumber: { lte: dto.startNumber }, endNumber: { gte: dto.startNumber } },
          // New range ends inside existing range
          { startNumber: { lte: dto.endNumber }, endNumber: { gte: dto.endNumber } },
          // New range completely contains existing range
          { startNumber: { gte: dto.startNumber }, endNumber: { lte: dto.endNumber } },
        ],
      },
    });

    if (overlapping) {
      throw new ConflictException(
        `El rango ${dto.startNumber}-${dto.endNumber} se solapa con secuencia existente ` +
        `${overlapping.startNumber}-${overlapping.endNumber} (${overlapping.ecfType}). ` +
        `Los rangos de secuencia no pueden reutilizarse.`,
      );
    }

    // Check for overlapping active sequences of same type
    const existing = await this.prisma.sequence.findFirst({
      where: {
        companyId: dto.companyId,
        ecfType: dto.ecfType,
        isActive: true,
      },
    });

    if (existing) {
      throw new ConflictException(
        `Ya existe una secuencia activa para tipo ${dto.ecfType}. ` +
        `Desactívela primero o espere a que se agote.`,
      );
    }

    const prefix = ECF_TYPE_PREFIX[dto.ecfType];

    const sequence = await this.prisma.sequence.create({
      data: {
        tenantId,
        companyId: dto.companyId,
        ecfType: dto.ecfType,
        prefix,
        startNumber: dto.startNumber,
        currentNumber: dto.startNumber - 1, // Will be incremented on first use
        endNumber: dto.endNumber,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null,
        isActive: true,
      },
    });

    this.logger.log(
      `Sequence created: ${prefix} [${dto.startNumber}-${dto.endNumber}] for company ${dto.companyId}`,
    );

    return sequence;
  }

  /**
   * Get next eNCF number atomically.
   * Uses SELECT FOR UPDATE to prevent race conditions under concurrent load.
   * Returns the full eNCF string (e.g., "E310000000001")
   */
  async getNextEncf(tenantId: string, companyId: string, ecfType: EcfType): Promise<string> {
    return this.prisma.$transaction(async (tx) => {
      // S7 fix: Use raw SELECT FOR UPDATE to lock the row, preventing concurrent
      // reads from getting the same currentNumber
      const sequences: any[] = await tx.$queryRawUnsafe(
        `SELECT * FROM "Sequence" WHERE "tenantId" = $1 AND "companyId" = $2 AND "ecfType" = $3 AND "isActive" = true LIMIT 1 FOR UPDATE`,
        tenantId,
        companyId,
        ecfType,
      );

      const sequence = sequences[0] || null;

      if (!sequence) {
        throw new NotFoundException(
          `No hay secuencia activa para tipo ${ecfType} en esta empresa. ` +
          `Registre una secuencia primero.`,
        );
      }

      // Check expiration
      if (sequence.expiresAt && sequence.expiresAt < new Date()) {
        await tx.sequence.update({
          where: { id: sequence.id },
          data: { isActive: false },
        });
        throw new BadRequestException(
          `La secuencia para tipo ${ecfType} ha expirado. Solicite una nueva a la DGII.`,
        );
      }

      const nextNumber = sequence.currentNumber + 1;

      // Check if sequence is exhausted
      if (nextNumber > sequence.endNumber) {
        await tx.sequence.update({
          where: { id: sequence.id },
          data: { isActive: false },
        });
        throw new BadRequestException(
          `La secuencia para tipo ${ecfType} se ha agotado. Solicite más secuencias a la DGII.`,
        );
      }

      // Update current number (row is locked, safe from concurrent access)
      await tx.sequence.update({
        where: { id: sequence.id },
        data: { currentNumber: nextNumber },
      });

      // Format: E31 + 10 digit padded number = 13 chars total
      const encf = `${sequence.prefix}${String(nextNumber).padStart(10, '0')}`;

      // Log warning if running low (< 10% remaining)
      const total = sequence.endNumber - sequence.startNumber;
      const remaining = sequence.endNumber - nextNumber;
      if (remaining < total * 0.1) {
        this.logger.warn(
          `⚠️ Sequence ${ecfType} for company ${companyId} running low: ${remaining} remaining`,
        );
      }

      return encf;
    });
  }

  /**
   * Get all sequences for a company
   */
  async findAll(tenantId: string, companyId: string) {
    const sequences = await this.prisma.sequence.findMany({
      where: { tenantId, companyId },
      orderBy: [{ ecfType: 'asc' }, { createdAt: 'desc' }],
    });

    return sequences.map((seq) => ({
      ...seq,
      used: seq.currentNumber - seq.startNumber + 1,
      remaining: seq.endNumber - seq.currentNumber,
      total: seq.endNumber - seq.startNumber + 1,
      percentUsed: Math.round(
        ((seq.currentNumber - seq.startNumber + 1) / (seq.endNumber - seq.startNumber + 1)) * 100,
      ),
    }));
  }

  /**
   * Get available sequence info for a specific type
   */
  async getAvailable(tenantId: string, companyId: string, ecfType: EcfType) {
    const sequence = await this.prisma.sequence.findFirst({
      where: { tenantId, companyId, ecfType, isActive: true },
    });

    if (!sequence) {
      return { available: false, message: `No hay secuencia activa para tipo ${ecfType}` };
    }

    const remaining = sequence.endNumber - sequence.currentNumber;

    return {
      available: true,
      remaining,
      nextNumber: sequence.currentNumber + 1,
      nextEncf: `${sequence.prefix}${String(sequence.currentNumber + 1).padStart(10, '0')}`,
      expiresAt: sequence.expiresAt,
    };
  }

  /**
   * Annul unused eNCF sequences (ANECF).
   * Stores annulment records for later DGII submission.
   */
  async annulSequences(
    tenantId: string,
    companyId: string,
    ranges: Array<{ encfFrom: string; encfTo: string }>,
  ) {
    const company = await this.prisma.company.findFirst({
      where: { id: companyId, tenantId, isActive: true },
    });

    if (!company) {
      throw new NotFoundException('Empresa no encontrada');
    }

    if (!ranges || ranges.length === 0) {
      throw new BadRequestException('Debe incluir al menos un rango de eNCF para anular');
    }

    for (const range of ranges) {
      if (!range.encfFrom || !range.encfTo) {
        throw new BadRequestException('Cada rango debe tener encfFrom y encfTo');
      }
      if (range.encfFrom.length !== 13 || range.encfTo.length !== 13) {
        throw new BadRequestException('eNCF inválido. Formato: E + 2 tipo + 10 secuencial (13 chars)');
      }
    }

    // Build ANECF XML
    const emitterData: EmitterData = {
      rnc: company.rnc,
      businessName: company.businessName,
      tradeName: company.tradeName || undefined,
      address: company.address || undefined,
    };

    const anecfXml = this.xmlBuilder.buildAnecfXml(
      emitterData,
      ranges.map(r => ({ encfDesde: r.encfFrom, encfHasta: r.encfTo })),
    );

    // Sign the ANECF XML
    const { p12Buffer, passphrase } = await this.certificatesService.getDecryptedCertificate(
      tenantId, companyId,
    );
    const { privateKey, certificate } = this.signingService.extractFromP12(p12Buffer, passphrase);
    const { signedXml } = this.signingService.signXml(anecfXml, privateKey, certificate);

    // Authenticate with DGII
    const token = await this.dgiiService.getToken(
      tenantId, companyId, privateKey, certificate, company.dgiiEnv,
    );

    // S6 fix: DGII requires filename = {RNCEmisor}{eNCF}.xml
    // For ANECF, use {RNCEmisor}ANECF.xml as there's no single eNCF
    const anecfFileName = `${company.rnc}ANECF.xml`;
    const result = await this.dgiiService.submitAnecf(signedXml, token, company.dgiiEnv, anecfFileName);

    // Store annulment records
    const annulments = [];
    for (const range of ranges) {
      const annulment = await this.prisma.sequenceAnnulment.create({
        data: {
          tenantId,
          companyId,
          encfFrom: range.encfFrom,
          encfTo: range.encfTo,
          status: result.success ? 'SENT' : 'ERROR',
        },
      });
      annulments.push(annulment);
    }

    this.logger.log(
      `ANECF submitted for company ${companyId}: ${ranges.length} range(s), result: ${result.success ? 'OK' : 'FAILED'}`,
    );

    return {
      message: `${ranges.length} rango(s) de secuencias anulados y enviados a DGII`,
      trackId: result.trackId,
      dgiiStatus: result.status,
      annulments,
    };
  }
}
