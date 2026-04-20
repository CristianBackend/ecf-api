import {
  Injectable, NotFoundException, BadRequestException, ConflictException,
} from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { RncValidationService, DgiiTaxpayerInfo } from '../common/services/rnc-validation.service';
import { CreateBuyerDto, UpdateBuyerDto } from './dto/buyer.dto';
import { resolveEcfType } from './ecf-type.resolver';

/**
 * Módulo de Clientes — contribuyentes registrados en DGII.
 *
 * Regla DGII actual:
 *  - Contribuyente activo → E31 (Crédito Fiscal)
 *  - No contribuyente → E32 (Consumo), no se registra aquí
 *
 * El tipo de e-CF se resuelve centralmente en ecf-type.resolver.ts
 * Para habilitar E44/E45/E46 en el futuro, solo activar reglas allí.
 */
@Injectable()
export class BuyersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rncValidation: RncValidationService,
    @InjectPinoLogger(BuyersService.name)
    private readonly logger: PinoLogger,
  ) {}

  /**
   * Crear cliente: solo RNC → consulta DGII → auto-llena todo → siempre E31.
   */
  async create(tenantId: string, dto: CreateBuyerDto) {
    if (!dto.rnc) {
      throw new BadRequestException(
        'RNC es obligatorio. Los consumidores finales (sin RNC) no necesitan registrarse — se les emite E32 directamente.',
      );
    }

    // Check duplicates
    const existing = await this.prisma.buyer.findFirst({
      where: { tenantId, rnc: dto.rnc },
    });
    if (existing) {
      throw new ConflictException(
        `Ya existe un cliente con RNC ${dto.rnc}: ${existing.name} (ID: ${existing.id})`,
      );
    }

    // DGII lookup — must be registered as taxpayer
    let dgiiInfo: DgiiTaxpayerInfo | null = null;
    try {
      dgiiInfo = await this.rncValidation.validateAndLookup(dto.rnc);
    } catch (err: any) {
      if (err instanceof BadRequestException) throw err;
      this.logger.warn(`DGII lookup failed: ${err.message}`);
    }

    if (!dgiiInfo) {
      throw new BadRequestException(
        'No se pudo verificar el RNC con DGII. Verifique que el RNC es correcto e intente de nuevo.',
      );
    }

    // Resolve e-CF type (currently E31, extensible via ecf-type.resolver.ts)
    const resolution = resolveEcfType(dto.rnc, dgiiInfo);

    const buyer = await this.prisma.buyer.create({
      data: {
        tenantId,
        rnc: dto.rnc,
        name: dgiiInfo.name,
        commercialName: dgiiInfo.commercialName || null,
        buyerType: resolution.buyerType as any,
        defaultEcfType: resolution.ecfType as any,
        email: dto.email || null,
        phone: dto.phone || null,
        contactPerson: dto.contactPerson || null,
        notes: dto.notes || null,
        dgiiStatus: dgiiInfo.status,
        dgiiPaymentRegime: dgiiInfo.paymentRegime,
        dgiiEconomicActivity: dgiiInfo.economicActivity,
        dgiiIsElectronicInvoicer: dgiiInfo.isElectronicInvoicer,
        dgiiLastVerified: new Date(),
      },
    });

    this.logger.info(`Client created: ${buyer.name} [${buyer.rnc}] → ${resolution.ecfType} (${resolution.reason})`);
    return this.format(buyer);
  }

  async findAll(tenantId: string, filters?: {
    search?: string; buyerType?: string; isActive?: boolean; page?: number; limit?: number;
  }) {
    const page = filters?.page || 1;
    const limit = Math.min(filters?.limit || 20, 100);
    const skip = (page - 1) * limit;
    const where: any = { tenantId };

    if (filters?.buyerType) where.buyerType = filters.buyerType;
    if (filters?.isActive !== undefined) where.isActive = filters.isActive;
    if (filters?.search) {
      where.OR = [
        { name: { contains: filters.search, mode: 'insensitive' } },
        { commercialName: { contains: filters.search, mode: 'insensitive' } },
        { rnc: { contains: filters.search } },
      ];
    }

    const [buyers, total] = await Promise.all([
      this.prisma.buyer.findMany({
        where, orderBy: { name: 'asc' }, skip, take: limit,
        include: { _count: { select: { invoices: true } } },
      }),
      this.prisma.buyer.count({ where }),
    ]);

    return {
      data: buyers.map((b) => ({
        ...this.format(b),
        invoiceCount: (b as any)._count?.invoices || 0,
      })),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(tenantId: string, id: string) {
    const buyer = await this.prisma.buyer.findFirst({
      where: { id, tenantId },
      include: {
        _count: { select: { invoices: true } },
        invoices: {
          take: 5, orderBy: { createdAt: 'desc' },
          select: { id: true, encf: true, ecfType: true, totalAmount: true, status: true, createdAt: true },
        },
      },
    });
    if (!buyer) throw new NotFoundException('Cliente no encontrado');
    return {
      ...this.format(buyer),
      invoiceCount: (buyer as any)._count?.invoices || 0,
      recentInvoices: buyer.invoices,
    };
  }

  async update(tenantId: string, id: string, dto: UpdateBuyerDto) {
    const buyer = await this.prisma.buyer.findFirst({ where: { id, tenantId } });
    if (!buyer) throw new NotFoundException('Cliente no encontrado');
    const updated = await this.prisma.buyer.update({
      where: { id },
      data: {
        ...(dto.name && { name: dto.name }),
        ...(dto.commercialName !== undefined && { commercialName: dto.commercialName }),
        ...(dto.email !== undefined && { email: dto.email }),
        ...(dto.phone !== undefined && { phone: dto.phone }),
        ...(dto.contactPerson !== undefined && { contactPerson: dto.contactPerson }),
        ...(dto.notes !== undefined && { notes: dto.notes }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      },
    });
    return this.format(updated);
  }

  async refreshDgiiData(tenantId: string, id: string) {
    const buyer = await this.prisma.buyer.findFirst({ where: { id, tenantId } });
    if (!buyer) throw new NotFoundException('Cliente no encontrado');
    if (!buyer.rnc) throw new BadRequestException('Este cliente no tiene RNC');

    const dgiiInfo = await this.rncValidation.validateAndLookup(buyer.rnc);
    if (!dgiiInfo) throw new BadRequestException(`RNC ${buyer.rnc} ya no se encuentra en DGII`);

    const updated = await this.prisma.buyer.update({
      where: { id },
      data: {
        name: dgiiInfo.name || buyer.name,
        commercialName: dgiiInfo.commercialName || buyer.commercialName,
        dgiiStatus: dgiiInfo.status,
        dgiiPaymentRegime: dgiiInfo.paymentRegime,
        dgiiEconomicActivity: dgiiInfo.economicActivity,
        dgiiIsElectronicInvoicer: dgiiInfo.isElectronicInvoicer,
        dgiiLastVerified: new Date(),
      },
    });
    return this.format(updated);
  }

  private format(buyer: any) {
    return {
      id: buyer.id,
      rnc: buyer.rnc,
      name: buyer.name,
      commercialName: buyer.commercialName,
      buyerType: buyer.buyerType,
      email: buyer.email,
      phone: buyer.phone,
      contactPerson: buyer.contactPerson,
      defaultEcfType: buyer.defaultEcfType,
      notes: buyer.notes,
      isActive: buyer.isActive,
      dgii: buyer.dgiiStatus ? {
        status: buyer.dgiiStatus,
        paymentRegime: buyer.dgiiPaymentRegime,
        economicActivity: buyer.dgiiEconomicActivity,
        isElectronicInvoicer: buyer.dgiiIsElectronicInvoicer,
        lastVerified: buyer.dgiiLastVerified,
      } : null,
      createdAt: buyer.createdAt,
      updatedAt: buyer.updatedAt,
    };
  }
}
