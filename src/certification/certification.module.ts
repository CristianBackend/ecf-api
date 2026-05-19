import { Module } from '@nestjs/common';
import { MulterModule } from '@nestjs/platform-express';
import { CertificationController } from './certification.controller';
import { CertificationService } from './certification.service';
import { ExcelParserService } from './services/excel-parser.service';
import { PrismaModule } from '../prisma/prisma.module';
import { InvoicesModule } from '../invoices/invoices.module';

@Module({
  imports: [
    PrismaModule,
    InvoicesModule,
    // In-memory storage (no disk writes) — limit 10 MB
    MulterModule.register({ limits: { fileSize: 10 * 1024 * 1024 } }),
  ],
  controllers: [CertificationController],
  providers: [CertificationService, ExcelParserService],
  exports: [CertificationService],
})
export class CertificationModule {}
