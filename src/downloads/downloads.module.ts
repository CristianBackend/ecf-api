import { Module } from '@nestjs/common';
import { DownloadsController } from './downloads.controller';
import { InvoicesModule } from '../invoices/invoices.module';

@Module({
  imports: [InvoicesModule],
  controllers: [DownloadsController],
})
export class DownloadsModule {}
