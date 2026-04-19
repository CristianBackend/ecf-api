import { Module } from '@nestjs/common';
import { InvoicesService } from './invoices.service';
import { InvoicesController } from './invoices.controller';
import { XmlBuilderModule } from '../xml-builder/xml-builder.module';
import { SigningModule } from '../signing/signing.module';
import { DgiiModule } from '../dgii/dgii.module';
import { CertificatesModule } from '../certificates/certificates.module';
import { SequencesModule } from '../sequences/sequences.module';
import { QueueModule } from '../queue/queue.module';

@Module({
  imports: [
    XmlBuilderModule,
    SigningModule,
    DgiiModule,
    CertificatesModule,
    SequencesModule,
    QueueModule,
  ],
  controllers: [InvoicesController],
  providers: [InvoicesService],
  exports: [InvoicesService],
})
export class InvoicesModule {}
