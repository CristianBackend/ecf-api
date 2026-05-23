import { Module } from '@nestjs/common';
import { RepresentacionImpresaController } from './representacion-impresa.controller';
import { RepresentacionImpresaService } from './representacion-impresa.service';
import { PdfBuilder } from './services/pdf-builder.service';
import { QrBuilder } from './services/qr-builder.service';
import { InvoiceDataService } from './services/invoice-data.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [PrismaModule],
  controllers: [RepresentacionImpresaController],
  providers: [
    RepresentacionImpresaService,
    PdfBuilder,
    QrBuilder,
    InvoiceDataService,
  ],
})
export class RepresentacionImpresaModule {}
