import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { CertificationStep3Controller } from './certification-step3.controller';
import { CertificationStep3Service } from './certification-step3.service';
import { AcecfExcelParser } from './services/acecf-excel-parser.service';
import { AcecfXmlBuilder } from './services/acecf-xml-builder.service';
import { PrismaModule } from '../prisma/prisma.module';
import { SigningModule } from '../signing/signing.module';
import { DgiiModule } from '../dgii/dgii.module';
import { CertificatesModule } from '../certificates/certificates.module';

@Module({
  imports: [
    PrismaModule,
    SigningModule,
    DgiiModule,
    CertificatesModule,
    MulterModule.register({ limits: { fileSize: 10 * 1024 * 1024 } }),
  ],
  controllers: [CertificationStep3Controller],
  providers: [
    CertificationStep3Service,
    AcecfExcelParser,
    AcecfXmlBuilder,
  ],
  exports: [CertificationStep3Service],
})
export class CertificationStep3Module {}
