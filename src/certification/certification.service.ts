import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { PrismaService } from '../prisma/prisma.service';
import { InvoicesService } from '../invoices/invoices.service';
import { ExcelParserService } from './services/excel-parser.service';
import { getMapper } from './services/mappers/excel-mapper.registry';
import { s } from './services/mappers/base-excel.mapper';
import { CreateInvoiceDto } from '../invoices/dto/invoice.dto';
import { InvoiceStatus } from '@prisma/client';

export interface UploadResult {
  uploadId: string;
  totalRows: number;
  created: number;
  invoices: Array<{ id: string; encf: string | null; ecfType: string; totalAmount: number }>;
  errors: Array<{ row: number; encf?: string; error: string }>;
}

export interface UploadStatus {
  uploadId: string;
  total: number;
  queued: number;
  processing: number;
  signed: number;
  failed: number;
  contingency: number;
}

@Injectable()
export class CertificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly invoicesService: InvoicesService,
    private readonly excelParser: ExcelParserService,
    @InjectPinoLogger(CertificationService.name)
    private readonly logger: PinoLogger,
  ) {}

  // -----------------------------------------------------------------------
  // Upload Excel
  // -----------------------------------------------------------------------

  async uploadExcel(
    tenantId: string,
    companyId: string,
    fileBuffer: Buffer,
    fileName: string,
  ): Promise<UploadResult> {
    const rows = this.excelParser.parseBuffer(fileBuffer);

    if (rows.length === 0) {
      throw new BadRequestException('El Excel no contiene filas de datos');
    }

    // Create the upload record
    const upload = await this.prisma.certificationUpload.create({
      data: {
        tenantId,
        companyId,
        fileName,
        totalRows: rows.length,
      },
    });

    const createdInvoices: UploadResult['invoices'] = [];
    const errors: UploadResult['errors'] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2; // row 1 is headers
      const tipoEcf = row.TipoeCF ?? row.tipoecf;
      const encfRaw = s(row.eNCF ?? row.ENCF);
      const ecfType = tipoEcf ? `E${String(tipoEcf).replace(/^E/, '')}` : 'UNKNOWN';

      try {
        const mapper = getMapper(tipoEcf as string);
        if (!mapper) {
          throw new Error(`Tipo e-CF desconocido: ${tipoEcf}`);
        }

        const dto = mapper(row, companyId) as unknown as CreateInvoiceDto;
        const invoice = await this.invoicesService.create(tenantId, dto);

        await this.prisma.certificationUploadItem.create({
          data: {
            uploadId: upload.id,
            invoiceId: invoice.id,
            rowNumber: rowNum,
            encf: invoice.encf ?? null,
            ecfType,
          },
        });

        createdInvoices.push({
          id: invoice.id,
          encf: invoice.encf ?? null,
          ecfType,
          totalAmount: Number(invoice.totalAmount) ?? 0,
        });

        this.logger.info(`Row ${rowNum}: created invoice ${invoice.encf} (${ecfType})`);
      } catch (err: any) {
        this.logger.warn(`Row ${rowNum} [${encfRaw ?? ecfType}] failed: ${err.message}`);

        // Store the failed row so status endpoint can reflect it
        await this.prisma.certificationUploadItem.create({
          data: {
            uploadId: upload.id,
            invoiceId: null,
            rowNumber: rowNum,
            encf: encfRaw ?? null,
            ecfType,
            rowError: err.message?.slice(0, 1000) ?? 'Unknown error',
          },
        });

        errors.push({ row: rowNum, encf: encfRaw, error: err.message });
      }
    }

    return {
      uploadId: upload.id,
      totalRows: rows.length,
      created: createdInvoices.length,
      invoices: createdInvoices,
      errors,
    };
  }

  // -----------------------------------------------------------------------
  // Status polling
  // -----------------------------------------------------------------------

  async getUploadStatus(tenantId: string, uploadId: string): Promise<UploadStatus> {
    const upload = await this.prisma.certificationUpload.findFirst({
      where: { id: uploadId, tenantId },
      include: { items: { select: { invoiceId: true, rowError: true } } },
    });

    if (!upload) throw new NotFoundException('Upload no encontrado');

    const invoiceIds = upload.items
      .filter(i => i.invoiceId !== null)
      .map(i => i.invoiceId as string);

    const failedRows = upload.items.filter(i => i.rowError !== null).length;

    let statusCounts = {
      queued: 0,
      processing: 0,
      signed: 0,
      failed: failedRows,
      contingency: 0,
    };

    if (invoiceIds.length > 0) {
      const invoices = await this.prisma.invoice.findMany({
        where: { id: { in: invoiceIds } },
        select: { status: true },
      });

      for (const inv of invoices) {
        switch (inv.status) {
          case InvoiceStatus.QUEUED:
            statusCounts.queued++;
            break;
          case InvoiceStatus.PROCESSING:
          case InvoiceStatus.SENT:
            statusCounts.processing++;
            break;
          case InvoiceStatus.ACCEPTED:
          case InvoiceStatus.CONDITIONAL:
            statusCounts.signed++;
            break;
          case InvoiceStatus.ERROR:
          case InvoiceStatus.REJECTED:
            statusCounts.failed++;
            break;
          case InvoiceStatus.CONTINGENCY:
            statusCounts.contingency++;
            break;
        }
      }
    }

    return {
      uploadId,
      total: upload.totalRows,
      ...statusCounts,
    };
  }

  // -----------------------------------------------------------------------
  // Download single XML
  // -----------------------------------------------------------------------

  async getSignedXml(
    tenantId: string,
    invoiceId: string,
  ): Promise<{ xml: string; encf: string }> {
    const invoice = await this.prisma.invoice.findFirst({
      where: { id: invoiceId, tenantId },
      select: { xmlSigned: true, xmlUnsigned: true, encf: true, status: true },
    });

    if (!invoice) throw new NotFoundException('Factura no encontrada');

    const xml = invoice.xmlSigned ?? invoice.xmlUnsigned;
    if (!xml) {
      throw new BadRequestException(
        `La factura ${invoice.encf} aún no tiene XML generado (status: ${invoice.status})`,
      );
    }

    return { xml, encf: invoice.encf ?? invoiceId };
  }

  // -----------------------------------------------------------------------
  // Download ZIP of all signed XMLs for an upload
  // -----------------------------------------------------------------------

  async buildZip(tenantId: string, uploadId: string): Promise<Buffer> {
    const upload = await this.prisma.certificationUpload.findFirst({
      where: { id: uploadId, tenantId },
      include: { items: { select: { invoiceId: true } } },
    });

    if (!upload) throw new NotFoundException('Upload no encontrado');

    const invoiceIds = upload.items
      .filter(i => i.invoiceId !== null)
      .map(i => i.invoiceId as string);

    if (invoiceIds.length === 0) {
      throw new BadRequestException('No hay facturas en este upload');
    }

    const invoices = await this.prisma.invoice.findMany({
      where: { id: { in: invoiceIds }, tenantId },
      select: { encf: true, xmlSigned: true, xmlUnsigned: true },
    });

    const withXml = invoices.filter(inv => inv.xmlSigned ?? inv.xmlUnsigned);

    if (withXml.length === 0) {
      throw new BadRequestException('Ninguna factura tiene XML disponible todavía');
    }

    // Lazy-require: archiver uses ESM internally; loading it at module level
    // causes Jest to fail when parsing node_modules without an ESM transformer.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const archiver = require('archiver') as (f: string, o?: object) => import('archiver').Archiver;

    return new Promise<Buffer>((resolve, reject) => {
      const arc = archiver('zip', { zlib: { level: 6 } });
      const chunks: Buffer[] = [];

      arc.on('data', (chunk: Buffer) => chunks.push(chunk));
      arc.on('end', () => resolve(Buffer.concat(chunks)));
      arc.on('error', reject);

      for (const inv of withXml) {
        const xml = (inv.xmlSigned ?? inv.xmlUnsigned) as string;
        const name = `${inv.encf ?? 'unknown'}.xml`;
        arc.append(xml, { name });
      }

      arc.finalize();
    });
  }
}
