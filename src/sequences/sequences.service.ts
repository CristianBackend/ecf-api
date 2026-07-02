import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  BadGatewayException,
} from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { SigningService } from '../signing/signing.service';
import { DgiiService } from '../dgii/dgii.service';
import { CertificatesService } from '../certificates/certificates.service';
import { XmlBuilderService, EmitterData } from '../xml-builder/xml-builder.service';
import { isValidEncf } from '../xml-builder/ecf-types';
import { CreateSequenceDto } from './dto/sequence.dto';
import { ActorContext } from '../common/decorators/actor.decorator';
import { EcfType, InvoiceStatus, Prisma } from '@prisma/client';

/**
 * Terminal, never-valid states of an e-CF whose eNCF MAY still be annulled via
 * ANECF. Per DGII Norma General 01-2020 (y respuesta oficial de la Comunidad de
 * Ayuda DGII), se pueden anular por rango las secuencias NO utilizadas y los
 * comprobantes que nunca llegaron a ser válidos (rechazados / con error, nunca
 * firmados-aceptados). Un e-CF ACEPTADO/CONDICIONAL NO es anulable: requiere Nota
 * de Crédito (E34). Ver FIX 2 en annulSequences y FIX 4 en getAnnulableEncfs.
 */
const ANNULLABLE_INVOICE_STATES: InvoiceStatus[] = [
  InvoiceStatus.REJECTED,
  InvoiceStatus.ERROR,
];

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly signingService: SigningService,
    private readonly dgiiService: DgiiService,
    private readonly certificatesService: CertificatesService,
    private readonly xmlBuilder: XmlBuilderService,
    @InjectPinoLogger(SequencesService.name)
    private readonly logger: PinoLogger,
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

    this.logger.info(
      `Sequence created: ${prefix} [${dto.startNumber}-${dto.endNumber}] for company ${dto.companyId}`,
    );

    return sequence;
  }

  /**
   * Get next eNCF number atomically, in a self-contained transaction.
   * Returns the full eNCF string (e.g., "E310000000001").
   *
   * Prefer {@link getNextEncfInTx} from callers that already hold a transaction
   * (e.g. invoice creation) so the sequence increment and the invoice INSERT
   * commit or roll back together — see FIX 1 (C1) below.
   */
  async getNextEncf(tenantId: string, companyId: string, ecfType: EcfType, overrideNumber?: number): Promise<string> {
    const { encf } = await this.prisma.$transaction((tx) =>
      this.assignNextEncf(tx, tenantId, companyId, ecfType, overrideNumber),
    );
    return encf;
  }

  /**
   * FIX 1 (C1) — Consume the next eNCF WITHIN a caller-provided transaction.
   *
   * The old flow committed the sequence increment in its OWN transaction before
   * the invoice INSERT ran in a separate one; any failure in between (quota
   * exhaustion, idempotency clash, XML build error, DB error) left a consumed
   * secuencial with NO invoice row — an eNCF hueco that the ANECF path itself
   * could not annul (AUDITORIA-2026-07, hallazgo C1). By threading the emission's
   * transaction here, the increment and the INSERT are atomic: if anything fails,
   * the secuencial is rolled back too and never orphaned.
   *
   * Returns both the eNCF and the sequence `expiresAt` so the caller can build the
   * XML without an extra query (the row is already locked here).
   */
  async getNextEncfInTx(
    tx: Prisma.TransactionClient,
    tenantId: string,
    companyId: string,
    ecfType: EcfType,
    overrideNumber?: number,
  ): Promise<{ encf: string; expiresAt: Date | null }> {
    return this.assignNextEncf(tx, tenantId, companyId, ecfType, overrideNumber);
  }

  /**
   * Core eNCF assignment. Uses SELECT ... FOR UPDATE on the sequence row to
   * serialize concurrent emissions (no two callers can read the same
   * currentNumber). Operates strictly on the provided transaction client `tx`.
   */
  private async assignNextEncf(
    tx: Prisma.TransactionClient,
    tenantId: string,
    companyId: string,
    ecfType: EcfType,
    overrideNumber?: number,
  ): Promise<{ encf: string; expiresAt: Date | null }> {
    // SELECT FOR UPDATE locks the row to prevent concurrent reads from getting
    // the same currentNumber. Column aliases map snake_case DB columns (via
    // @map in schema) back to camelCase for the rest of this method.
    const sequences: any[] = await tx.$queryRawUnsafe(
      `SELECT id,
              tenant_id        AS "tenantId",
              company_id       AS "companyId",
              ecf_type         AS "ecfType",
              prefix,
              current_number   AS "currentNumber",
              start_number     AS "startNumber",
              end_number       AS "endNumber",
              expires_at       AS "expiresAt",
              is_active        AS "isActive"
       FROM   sequences
       WHERE  tenant_id  = $1::uuid
         AND  company_id = $2::uuid
         AND  ecf_type   = $3::"EcfType"
         AND  is_active  = true
       LIMIT 1 FOR UPDATE`,
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

    if (overrideNumber !== undefined) {
      if (overrideNumber < sequence.startNumber || overrideNumber > sequence.endNumber) {
        throw new BadRequestException(
          `encfOverride ${overrideNumber} fuera del rango de secuencia [${sequence.startNumber}-${sequence.endNumber}]`,
        );
      }
      const newCurrent = Math.max(sequence.currentNumber, overrideNumber);
      await tx.sequence.update({
        where: { id: sequence.id },
        data: { currentNumber: newCurrent },
      });
      return {
        encf: `${sequence.prefix}${String(overrideNumber).padStart(10, '0')}`,
        expiresAt: sequence.expiresAt ?? null,
      };
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

    return { encf, expiresAt: sequence.expiresAt ?? null };
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
   * FIX 4 — List eNCF that are candidates for ANECF annulment for a company.
   *
   * Policy (DGII Norma General 01-2020, Art. 3): un e-CF RECHAZADO conserva su
   * eNCF y NUNCA se reutiliza en la reemisión corregida — la corrección sale como
   * un e-CF NUEVO con un secuencial NUEVO (ver política documentada en
   * invoices.service.ts / ecf-types MODIFICATION_CODES). Ese eNCF rechazado (y
   * cualquier hueco de secuencial) queda entonces disponible para regularizarse
   * ante DGII vía ANECF. Este método los expone:
   *   - `rejected`: e-CF en estado REJECTED/ERROR (nunca fueron válidos).
   *   - `gaps`: secuenciales <= currentNumber sin fila invoice (huecos).
   * Todos son anulables por {@link annulSequences} (FIX 2).
   */
  async getAnnulableEncfs(tenantId: string, companyId: string, ecfType?: EcfType) {
    const sequences = await this.prisma.sequence.findMany({
      where: { tenantId, companyId, isActive: true, ...(ecfType ? { ecfType } : {}) },
    });

    const result: Array<{
      ecfType: EcfType;
      rejected: string[];
      gaps: string[];
    }> = [];

    for (const seq of sequences) {
      const upTo = seq.currentNumber; // only already-consumed numbers can be gaps
      // Terminally-failed e-CF (REJECTED/ERROR) whose eNCF may be annulled.
      const failed = await this.prisma.invoice.findMany({
        where: {
          tenantId,
          companyId,
          ecfType: seq.ecfType,
          status: { in: ANNULLABLE_INVOICE_STATES },
        },
        select: { encf: true },
      });
      const rejected = failed.map((f) => f.encf).filter((e): e is string => !!e);

      // Gaps: consumed secuenciales [startNumber..currentNumber] with NO invoice
      // row. Bounded scan; skip enumeration on pathologically large ranges.
      const gaps: string[] = [];
      const span = upTo - seq.startNumber + 1;
      if (span > 0 && span <= 100_000) {
        const invoices = await this.prisma.invoice.findMany({
          where: { tenantId, companyId, ecfType: seq.ecfType },
          select: { encf: true },
        });
        const used = new Set(invoices.map((i) => i.encf));
        for (let n = seq.startNumber; n <= upTo; n++) {
          const encf = `${seq.prefix}${String(n).padStart(10, '0')}`;
          if (!used.has(encf)) gaps.push(encf);
        }
      }

      result.push({ ecfType: seq.ecfType, rejected, gaps });
    }

    return result;
  }

  /**
   * Annul unused eNCF sequences (ANECF).
   *
   * Per DGII Norma 01-2020 se pueden anular por rango: (a) secuencias NO
   * utilizadas y (b) e-CF que nunca fueron válidos (REJECTED/ERROR) o huecos de
   * secuencial. Un e-CF ACEPTADO requiere Nota de Crédito (E34), no ANECF. Cada
   * rango se valida contra las secuencias registradas y — para la parte ya
   * consumida — contra el estado del invoice (FIX 2). El ANECF firmado se envía a
   * DGII y, al ACEPTAR, la secuencia local se recorta/desactiva de forma que
   * getNextEncf jamás emita dentro de un rango anulado.
   */
  async annulSequences(
    tenantId: string,
    companyId: string,
    ranges: Array<{ encfFrom: string; encfTo: string }>,
    actorCtx?: ActorContext,
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

    // ---------------------------------------------------------------
    // Validate ranges against registered sequences and plan the local
    // adjustment to apply if DGII accepts. Simulated state handles
    // multiple ranges over the same sequence within one request.
    // ---------------------------------------------------------------
    type SimState = {
      id: string;
      prefix: string;
      startNumber: number;
      endNumber: number;
      currentNumber: number;
      active: boolean;
      touched: boolean;
    };
    const simByType = new Map<string, SimState>();

    for (const range of ranges) {
      if (!range.encfFrom || !range.encfTo) {
        throw new BadRequestException('Cada rango debe tener encfFrom y encfTo');
      }
      if (!isValidEncf(range.encfFrom) || !isValidEncf(range.encfTo)) {
        throw new BadRequestException(
          `eNCF inválido en rango ${range.encfFrom}-${range.encfTo}. Formato: E + 2 tipo + 10 secuencial (13 chars)`,
        );
      }

      const prefix = range.encfFrom.substring(0, 3);
      if (range.encfTo.substring(0, 3) !== prefix) {
        throw new BadRequestException(
          `Rango ${range.encfFrom}-${range.encfTo}: ambos extremos deben ser del mismo tipo de e-CF`,
        );
      }

      const fromNum = parseInt(range.encfFrom.substring(3), 10);
      const toNum = parseInt(range.encfTo.substring(3), 10);
      if (fromNum > toNum) {
        throw new BadRequestException(
          `Rango ${range.encfFrom}-${range.encfTo}: encfFrom debe ser menor o igual a encfTo`,
        );
      }

      let sim = simByType.get(prefix);
      if (!sim) {
        const sequence = await this.prisma.sequence.findFirst({
          where: { tenantId, companyId, ecfType: prefix as EcfType, isActive: true },
        });
        if (!sequence) {
          throw new BadRequestException(
            `No hay secuencia activa registrada para tipo ${prefix} en esta empresa. ` +
            `Solo se pueden anular rangos de secuencias registradas.`,
          );
        }
        sim = {
          id: sequence.id,
          prefix,
          startNumber: sequence.startNumber,
          endNumber: sequence.endNumber,
          currentNumber: sequence.currentNumber,
          active: true,
          touched: false,
        };
        simByType.set(prefix, sim);
      }

      if (!sim.active) {
        throw new BadRequestException(
          `Rango ${range.encfFrom}-${range.encfTo}: la secuencia ${prefix} ya queda desactivada por un rango anterior de esta misma solicitud`,
        );
      }

      if (fromNum < sim.startNumber || toNum > sim.endNumber) {
        throw new BadRequestException(
          `Rango ${range.encfFrom}-${range.encfTo} fuera de la secuencia registrada ` +
          `${prefix} [${sim.startNumber}-${sim.endNumber}]`,
        );
      }

      // FIX 2 (C1b) — Split the range at currentNumber. Numbers already "passed"
      // (<= currentNumber) can now be annulled too, provided every eNCF in that
      // sub-range is either a GAP (no invoice at all — e.g. a secuencial consumed
      // by an aborted emission before FIX 1) or a terminally-failed invoice
      // (REJECTED/ERROR). DGII Norma 01-2020 permite anular por rango secuencias
      // no usadas y documentos nunca válidos; un e-CF ACEPTADO/CONDICIONAL exige
      // Nota de Crédito (E34), no ANECF.
      const belowTo = Math.min(toNum, sim.currentNumber);
      if (fromNum <= belowTo) {
        const belowFromEncf = `${sim.prefix}${String(fromNum).padStart(10, '0')}`;
        const belowToEncf = `${sim.prefix}${String(belowTo).padStart(10, '0')}`;
        // zero-padded 10-digit eNCF ⇒ lexicographic order == numeric order.
        const blocking = await this.prisma.invoice.findMany({
          where: {
            tenantId,
            companyId,
            encf: { gte: belowFromEncf, lte: belowToEncf },
            status: { notIn: ANNULLABLE_INVOICE_STATES },
          },
          select: { encf: true, status: true },
        });
        if (blocking.length > 0) {
          const sample = blocking
            .slice(0, 5)
            .map((b) => `${b.encf}=${b.status}`)
            .join(', ');
          throw new BadRequestException(
            `Rango ${range.encfFrom}-${range.encfTo}: incluye e-CF que NO pueden anularse ` +
            `vía ANECF (${sample}${blocking.length > 5 ? ', …' : ''}). ` +
            `Solo se anulan secuencias no utilizadas o e-CF en estado REJECTED/ERROR; ` +
            `para un e-CF ACEPTADO corresponde una Nota de Crédito (E34).`,
          );
        }
        // Below-current annulments need no counter change (getNextEncf already
        // moved past them) — but we still submit the ANECF and record it.
        sim.touched = true;
      }

      // Plan the local adjustment for the still-FUTURE part (> currentNumber).
      // Supported shapes on the linear currentNumber/endNumber model:
      //   [currentNumber+1 .. endNumber]  → deactivate the sequence
      //   [x .. endNumber]                → tail cut: endNumber = x-1
      //   [currentNumber+1 .. y]          → advance: currentNumber = y
      // Non-contiguous middle segments (a hole strictly inside the future range)
      // are rejected: the linear model cannot represent them.
      const aboveFrom = Math.max(fromNum, sim.currentNumber + 1);
      if (aboveFrom <= toNum) {
        if (aboveFrom === sim.currentNumber + 1 && toNum === sim.endNumber) {
          sim.active = false;
        } else if (toNum === sim.endNumber) {
          sim.endNumber = aboveFrom - 1;
        } else if (aboveFrom === sim.currentNumber + 1) {
          sim.currentNumber = toNum;
        } else {
          throw new BadRequestException(
            `Rango ${range.encfFrom}-${range.encfTo}: tramo intermedio no contiguo. ` +
            `Solo se soportan rangos que comiencen en la siguiente secuencia disponible ` +
            `(${sim.prefix}${String(sim.currentNumber + 1).padStart(10, '0')}) o que lleguen hasta el final del rango registrado.`,
          );
        }
        sim.touched = true;
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

    // Audit trail: persist PENDING records (with both XMLs) before submitting,
    // so a crash mid-flight leaves a visible trace of what was sent.
    const annulments = [];
    for (const range of ranges) {
      const annulment = await this.prisma.sequenceAnnulment.create({
        data: {
          tenantId,
          companyId,
          encfFrom: range.encfFrom,
          encfTo: range.encfTo,
          xmlAnecf: anecfXml,
          xmlSigned: signedXml,
          status: 'PENDING',
        },
      });
      annulments.push(annulment);
    }
    const annulmentIds = annulments.map(a => a.id);

    // S6 fix: DGII requires filename = {RNCEmisor}{eNCF}.xml
    // For ANECF, use {RNCEmisor}ANECF.xml as there's no single eNCF
    const anecfFileName = `${company.rnc}ANECF.xml`;
    let result;
    try {
      result = await this.dgiiService.submitAnecf(signedXml, token, company.dgiiEnv, anecfFileName);
    } catch (error: any) {
      // Network-level failure: actual DGII state unknown — keep PENDING with the error
      await this.prisma.sequenceAnnulment.updateMany({
        where: { id: { in: annulmentIds } },
        data: { dgiiResponse: `Error de red al enviar ANECF: ${error.message}` },
      });
      throw new BadGatewayException(
        `No se pudo enviar el ANECF a DGII: ${error.message}. La anulación quedó PENDIENTE y no se aplicó localmente.`,
      );
    }

    if (!result.success) {
      await this.prisma.sequenceAnnulment.updateMany({
        where: { id: { in: annulmentIds } },
        data: { status: 'REJECTED', dgiiResponse: result.rawResponse || result.message },
      });
      this.logger.warn(`ANECF rejected by DGII for company ${companyId}: ${result.message}`);
      throw new BadGatewayException(
        `DGII no aceptó la anulación de secuencias: ${(result.message || 'error desconocido').slice(0, 300)}`,
      );
    }

    // DGII accepted: mark ACCEPTED and apply the local adjustment atomically
    // so getNextEncf can never emit inside an annulled range.
    await this.prisma.$transaction(async (tx) => {
      await tx.sequenceAnnulment.updateMany({
        where: { id: { in: annulmentIds } },
        data: { status: 'ACCEPTED', dgiiResponse: result.rawResponse || result.message },
      });

      for (const sim of simByType.values()) {
        if (!sim.touched) continue;

        // Lock the row (same pattern as getNextEncf) — emissions may have
        // advanced currentNumber during the DGII round-trip.
        const rows: any[] = await tx.$queryRawUnsafe(
          `SELECT current_number AS "currentNumber" FROM sequences WHERE id = $1::uuid FOR UPDATE`,
          sim.id,
        );
        const liveCurrent = rows[0]?.currentNumber ?? sim.currentNumber;

        if (!sim.active) {
          await tx.sequence.update({
            where: { id: sim.id },
            data: { isActive: false },
          });
        } else {
          if (liveCurrent > sim.currentNumber) {
            this.logger.warn(
              `Sequence ${sim.prefix} advanced to ${liveCurrent} during ANECF round-trip ` +
              `(annulment planned from ${sim.currentNumber + 1})`,
            );
          }
          await tx.sequence.update({
            where: { id: sim.id },
            data: {
              endNumber: sim.endNumber,
              currentNumber: Math.max(liveCurrent, sim.currentNumber),
            },
          });
        }
      }
    });

    this.logger.info(
      `ANECF accepted by DGII for company ${companyId}: ${ranges.length} range(s) annulled and applied locally`,
    );

    await this.prisma.auditLog.create({
      data: {
        tenantId,
        entityType: 'sequence',
        entityId: companyId,
        action: 'sequences_annulled',
        actor: actorCtx?.actor ?? 'api',
        ipAddress: actorCtx?.ipAddress ?? null,
        metadata: {
          companyId,
          ranges: ranges.map((r) => ({ encfFrom: r.encfFrom, encfTo: r.encfTo })),
          trackId: result.trackId ?? null,
        },
      },
    });

    return {
      message: `${ranges.length} rango(s) de secuencias anulados ante DGII y bloqueados localmente`,
      trackId: result.trackId,
      dgiiStatus: result.status,
      annulments: annulments.map(a => ({ ...a, status: 'ACCEPTED' })),
    };
  }
}
