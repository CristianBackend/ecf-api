import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class InvoiceDataService {
  constructor(private readonly prisma: PrismaService) {}

  async getInvoiceForRi(tenantId: string, invoiceId: string) {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, tenantId },
      include: {
        company: true,
        buyer: true,
        lines: { orderBy: { lineNumber: 'asc' } },
      },
    });

    if (!invoice) {
      throw new NotFoundException(`Invoice ${invoiceId} not found for tenant`);
    }

    if (!invoice.encf) {
      throw new Error('Invoice has no eNCF — cannot generate RI');
    }

    if (!invoice.signedAt) {
      throw new Error('Invoice has no signedAt — invoice must be signed first');
    }

    if (!invoice.securityCode) {
      if (invoice.signatureValue) {
        const clean = invoice.signatureValue.replace(/\s/g, '');
        (invoice as any).securityCode = clean.substring(0, 6);
      } else {
        throw new Error(
          'Invoice has no securityCode nor signatureValue — invoice must be signed first',
        );
      }
    }

    return invoice;
  }
}
