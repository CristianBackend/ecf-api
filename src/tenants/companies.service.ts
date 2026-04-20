import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { RncValidationService } from '../common/services/rnc-validation.service';
import { CreateCompanyDto, UpdateCompanyDto } from './dto/company.dto';

@Injectable()
export class CompaniesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rncValidation: RncValidationService,
    @InjectPinoLogger(CompaniesService.name)
    private readonly logger: PinoLogger,
  ) {}

  async create(tenantId: string, dto: CreateCompanyDto) {
    // Validate RNC format + check digit + DGII lookup
    const dgiiInfo = await this.rncValidation.validateAndLookup(dto.rnc);

    // Auto-fill business name from DGII if not provided or if matches
    if (dgiiInfo) {
      this.logger.info(
        `DGII lookup OK: ${dto.rnc} → ${dgiiInfo.name} (${dgiiInfo.status})`,
      );

      // If user didn't provide a name, use DGII's
      if (!dto.businessName || dto.businessName === dto.rnc) {
        dto.businessName = dgiiInfo.name;
      }

      // Auto-fill trade name if DGII has one and user didn't provide
      if (!dto.tradeName && dgiiInfo.commercialName) {
        dto.tradeName = dgiiInfo.commercialName;
      }
    }

    // Check if RNC already registered for this tenant
    const existing = await this.prisma.company.findFirst({
      where: { tenantId, rnc: dto.rnc },
    });

    if (existing) {
      throw new ConflictException(`RNC ${dto.rnc} ya está registrado en este tenant`);
    }

    const company = await this.prisma.company.create({
      data: {
        tenantId,
        rnc: dto.rnc,
        businessName: dto.businessName,
        tradeName: dto.tradeName,
        address: dto.address,
        phone: dto.phone,
        email: dto.email,
        municipality: dto.municipality,
        province: dto.province,
        activityCode: dto.activityCode,
        branchCode: dto.branchCode,
        economicActivity: dto.economicActivity,
        dgiiEnv: dto.dgiiEnv,
      },
    });

    this.logger.info(`Company created: ${company.id} (RNC: ${company.rnc})`);
    return company;
  }

  async findAll(tenantId: string) {
    return this.prisma.company.findMany({
      where: { tenantId },
      include: {
        _count: {
          select: {
            certificates: true,
            sequences: true,
            invoices: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(tenantId: string, companyId: string) {
    const company = await this.prisma.company.findFirst({
      where: { id: companyId, tenantId },
      include: {
        certificates: {
          select: {
            id: true,
            fingerprint: true,
            issuer: true,
            validFrom: true,
            validTo: true,
            isActive: true,
          },
        },
        sequences: {
          select: {
            id: true,
            ecfType: true,
            prefix: true,
            currentNumber: true,
            startNumber: true,
            endNumber: true,
            expiresAt: true,
            isActive: true,
          },
        },
        _count: {
          select: { invoices: true },
        },
      },
    });

    if (!company) {
      throw new NotFoundException('Company not found');
    }

    return company;
  }

  async update(tenantId: string, companyId: string, dto: UpdateCompanyDto) {
    const company = await this.prisma.company.findFirst({
      where: { id: companyId, tenantId },
    });

    if (!company) {
      throw new NotFoundException('Company not found');
    }

    return this.prisma.company.update({
      where: { id: companyId },
      data: dto,
    });
  }

  async deactivate(tenantId: string, companyId: string) {
    const company = await this.prisma.company.findFirst({
      where: { id: companyId, tenantId },
    });

    if (!company) {
      throw new NotFoundException('Company not found');
    }

    return this.prisma.company.update({
      where: { id: companyId },
      data: { isActive: false },
    });
  }
}
