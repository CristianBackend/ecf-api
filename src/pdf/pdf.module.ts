import { Module } from '@nestjs/common';
import { PdfService } from './pdf.service';
import { PdfController } from './pdf.controller';
import { QrBuilder } from '../representacion-impresa/services/qr-builder.service';

@Module({
  controllers: [PdfController],
  // FIX 8: QrBuilder (from representacion-impresa) replaces SigningModule's
  // buildQrUrl as the QR source. It is a stateless helper with no dependencies.
  providers: [PdfService, QrBuilder],
  exports: [PdfService],
})
export class PdfModule {}
