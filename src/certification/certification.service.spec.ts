/**
 * CertificationService — unit tests
 *
 * Tests the upload orchestration, status polling, and download flows
 * using fully mocked dependencies.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CertificationService } from './certification.service';
import { makeTestLogger } from '../common/logger/test-logger';
import * as XLSX from 'xlsx';

type Mock = jest.Mock;

function buildXlsx(rows: Record<string, unknown>[]): Buffer {
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'ECF');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

function makeService() {
  const prisma = {
    certificationUpload: {
      create: jest.fn() as Mock,
      findFirst: jest.fn() as Mock,
    },
    certificationUploadItem: {
      create: jest.fn(async () => ({})) as Mock,
      findMany: jest.fn() as Mock,
    },
    invoice: {
      findFirst: jest.fn() as Mock,
      findMany: jest.fn() as Mock,
    },
  };

  const invoicesService = {
    create: jest.fn() as Mock,
  };

  const excelParser = {
    parseBuffer: jest.fn() as Mock,
  };

  const service = new CertificationService(
    prisma as any,
    invoicesService as any,
    excelParser as any,
    makeTestLogger() as any,
  );

  return { service, prisma, invoicesService, excelParser };
}

// ─────────────────────────────────────────────────────────────
// uploadExcel
// ─────────────────────────────────────────────────────────────
describe('CertificationService.uploadExcel', () => {
  it('creates upload record and returns created invoices', async () => {
    const { service, prisma, invoicesService, excelParser } = makeService();

    excelParser.parseBuffer.mockReturnValue([
      {
        TipoeCF: 32, eNCF: 'E320000000001', TipoPago: 1,
        RazonSocialComprador: 'Test', FechaEmision: '01-04-2020',
        _items: { 1: { NombreItem: 'X', CantidadItem: 1, PrecioUnitarioItem: 100 } },
      },
    ]);

    prisma.certificationUpload.create.mockResolvedValue({
      id: 'upload-1',
      totalRows: 1,
    });

    invoicesService.create.mockResolvedValue({
      id: 'invoice-1',
      encf: 'E320000000001',
      ecfType: 'E32',
      totalAmount: 118,
    });

    const result = await service.uploadExcel('tenant-1', 'company-1', Buffer.from(''), 'test.xlsx');

    expect(result.uploadId).toBe('upload-1');
    expect(result.created).toBe(1);
    expect(result.invoices[0].encf).toBe('E320000000001');
    expect(result.errors).toHaveLength(0);
  });

  it('records row errors and continues with other rows', async () => {
    const { service, prisma, invoicesService, excelParser } = makeService();

    excelParser.parseBuffer.mockReturnValue([
      { TipoeCF: 32, eNCF: 'E320000000001', TipoPago: 1, RazonSocialComprador: 'A', _items: { 1: { NombreItem: 'X', CantidadItem: 1, PrecioUnitarioItem: 100 } } },
      { TipoeCF: 32, eNCF: 'E320000000002', TipoPago: 1, RazonSocialComprador: 'B', _items: { 1: { NombreItem: 'Y', CantidadItem: 1, PrecioUnitarioItem: 200 } } },
    ]);

    prisma.certificationUpload.create.mockResolvedValue({ id: 'upload-2', totalRows: 2 });

    invoicesService.create
      .mockRejectedValueOnce(new Error('Secuencia agotada'))
      .mockResolvedValueOnce({ id: 'inv-2', encf: 'E320000000002', ecfType: 'E32', totalAmount: 236 });

    const result = await service.uploadExcel('tenant-1', 'company-1', Buffer.from(''), 'test.xlsx');

    expect(result.created).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].row).toBe(2);
    expect(result.errors[0].error).toContain('Secuencia agotada');
  });

  it('throws BadRequestException when Excel has no rows', async () => {
    const { service, excelParser, prisma } = makeService();
    excelParser.parseBuffer.mockReturnValue([]);
    prisma.certificationUpload.create.mockResolvedValue({ id: 'u', totalRows: 0 });

    await expect(
      service.uploadExcel('t', 'c', Buffer.from(''), 'empty.xlsx'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // ───────────────────────────────────────────────────────────
  // Fix 4q: skip specific eNCFs from the upload (for sequences
  // already consumed in prior DGII certification attempts)
  // ───────────────────────────────────────────────────────────
  describe('Fix 4q — skipEncfs filter', () => {
    it('skips rows whose eNCF is in the skip set', async () => {
      const { service, prisma, invoicesService, excelParser } = makeService();

      excelParser.parseBuffer.mockReturnValue([
        { TipoeCF: 31, eNCF: 'E310000000001', TipoPago: 1, RazonSocialComprador: 'A',
          _items: { 1: { NombreItem: 'X', CantidadItem: 1, PrecioUnitarioItem: 100 } } },
        { TipoeCF: 32, eNCF: 'E320000000006', TipoPago: 1, RazonSocialComprador: 'B',
          _items: { 1: { NombreItem: 'Y', CantidadItem: 1, PrecioUnitarioItem: 200 } } }, // skip
        { TipoeCF: 46, eNCF: 'E460000000009', TipoPago: 1, RazonSocialComprador: 'C',
          _items: { 1: { NombreItem: 'Z', CantidadItem: 1, PrecioUnitarioItem: 300 } } }, // skip
        { TipoeCF: 41, eNCF: 'E410000000001', TipoPago: 1, RazonSocialComprador: 'D',
          _items: { 1: { NombreItem: 'W', CantidadItem: 1, PrecioUnitarioItem: 400 } } },
      ]);

      prisma.certificationUpload.create.mockResolvedValue({ id: 'upload-skip', totalRows: 2 });

      invoicesService.create
        .mockResolvedValueOnce({ id: 'i1', encf: 'E310000000001', ecfType: 'E31', totalAmount: 118 })
        .mockResolvedValueOnce({ id: 'i4', encf: 'E410000000001', ecfType: 'E41', totalAmount: 472 });

      const skipSet = new Set(['E320000000006', 'E460000000009']);
      const result = await service.uploadExcel('t', 'c', Buffer.from(''), 'set.xlsx', skipSet);

      // Only the 2 non-skipped rows reached invoicesService.create
      expect(invoicesService.create).toHaveBeenCalledTimes(2);
      expect(result.created).toBe(2);
      expect(result.invoices.map(i => i.encf)).toEqual([
        'E310000000001', 'E410000000001',
      ]);
      // totalRows on the upload record reflects what we processed, not raw
      expect(prisma.certificationUpload.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ totalRows: 2 }) }),
      );
    });

    it('does nothing when skipSet is empty (default)', async () => {
      const { service, prisma, invoicesService, excelParser } = makeService();

      excelParser.parseBuffer.mockReturnValue([
        { TipoeCF: 31, eNCF: 'E310000000001', TipoPago: 1, RazonSocialComprador: 'A',
          _items: { 1: { NombreItem: 'X', CantidadItem: 1, PrecioUnitarioItem: 100 } } },
      ]);
      prisma.certificationUpload.create.mockResolvedValue({ id: 'u', totalRows: 1 });
      invoicesService.create.mockResolvedValue({
        id: 'i', encf: 'E310000000001', ecfType: 'E31', totalAmount: 118,
      });

      // No skipSet argument — default empty
      const result = await service.uploadExcel('t', 'c', Buffer.from(''), 'set.xlsx');
      expect(result.created).toBe(1);
      expect(invoicesService.create).toHaveBeenCalledTimes(1);
    });

    it('skip is case-insensitive (controller normalizes; service compares uppercase)', async () => {
      const { service, prisma, invoicesService, excelParser } = makeService();

      excelParser.parseBuffer.mockReturnValue([
        // Excel could feasibly contain lowercase or mixed-case eNCFs
        { TipoeCF: 32, eNCF: 'e320000000006', TipoPago: 1, RazonSocialComprador: 'B',
          _items: { 1: { NombreItem: 'Y', CantidadItem: 1, PrecioUnitarioItem: 200 } } },
        { TipoeCF: 31, eNCF: 'E310000000001', TipoPago: 1, RazonSocialComprador: 'A',
          _items: { 1: { NombreItem: 'X', CantidadItem: 1, PrecioUnitarioItem: 100 } } },
      ]);
      prisma.certificationUpload.create.mockResolvedValue({ id: 'u', totalRows: 1 });
      invoicesService.create.mockResolvedValue({
        id: 'i', encf: 'E310000000001', ecfType: 'E31', totalAmount: 118,
      });

      const skipSet = new Set(['E320000000006']); // uppercase as the controller would pass
      const result = await service.uploadExcel('t', 'c', Buffer.from(''), 's.xlsx', skipSet);
      expect(result.created).toBe(1);
      expect(result.invoices[0].encf).toBe('E310000000001');
    });

    it('throws BadRequestException when skipEncfs filters out ALL rows', async () => {
      const { service, excelParser } = makeService();

      excelParser.parseBuffer.mockReturnValue([
        { TipoeCF: 32, eNCF: 'E320000000006', TipoPago: 1, RazonSocialComprador: 'X',
          _items: { 1: { NombreItem: 'Y', CantidadItem: 1, PrecioUnitarioItem: 100 } } },
      ]);

      const skipSet = new Set(['E320000000006']);
      await expect(
        service.uploadExcel('t', 'c', Buffer.from(''), 's.xlsx', skipSet),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  it('records error for unknown TipoeCF', async () => {
    const { service, prisma, invoicesService, excelParser } = makeService();

    excelParser.parseBuffer.mockReturnValue([
      { TipoeCF: 99, eNCF: 'E990000000001', TipoPago: 1, RazonSocialComprador: 'X', _items: {} },
    ]);

    prisma.certificationUpload.create.mockResolvedValue({ id: 'upload-3', totalRows: 1 });

    const result = await service.uploadExcel('t', 'c', Buffer.from(''), 'bad.xlsx');

    expect(result.created).toBe(0);
    expect(result.errors[0].error).toMatch(/Tipo e-CF desconocido/);
    expect(invoicesService.create).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────
// getUploadStatus
// ─────────────────────────────────────────────────────────────
describe('CertificationService.getUploadStatus', () => {
  it('returns NotFoundException for unknown uploadId', async () => {
    const { service, prisma } = makeService();
    prisma.certificationUpload.findFirst.mockResolvedValue(null);

    await expect(service.getUploadStatus('t', 'bad-id')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('counts invoices by status correctly', async () => {
    const { service, prisma } = makeService();

    prisma.certificationUpload.findFirst.mockResolvedValue({
      id: 'upload-1',
      totalRows: 3,
      items: [
        { invoiceId: 'i1', rowError: null },
        { invoiceId: 'i2', rowError: null },
        { invoiceId: null, rowError: 'failed row' },
      ],
    });

    prisma.invoice.findMany.mockResolvedValue([
      { status: 'ACCEPTED' },
      { status: 'QUEUED' },
    ]);

    const status = await service.getUploadStatus('t', 'upload-1');

    expect(status.total).toBe(3);
    expect(status.signed).toBe(1);
    expect(status.queued).toBe(1);
    expect(status.failed).toBe(1); // from rowError
  });
});

// ─────────────────────────────────────────────────────────────
// getSignedXml
// ─────────────────────────────────────────────────────────────
describe('CertificationService.getSignedXml', () => {
  it('returns signed XML when available', async () => {
    const { service, prisma } = makeService();
    prisma.invoice.findFirst.mockResolvedValue({
      xmlSigned: '<ECF><Signature/></ECF>',
      xmlUnsigned: null,
      encf: 'E320000000001',
      status: 'ACCEPTED',
    });

    const result = await service.getSignedXml('t', 'inv-1');
    expect(result.xml).toContain('<ECF>');
    expect(result.encf).toBe('E320000000001');
  });

  it('falls back to unsigned XML when signed is null', async () => {
    const { service, prisma } = makeService();
    prisma.invoice.findFirst.mockResolvedValue({
      xmlSigned: null,
      xmlUnsigned: '<ECF>unsigned</ECF>',
      encf: 'E320000000001',
      status: 'QUEUED',
    });

    const result = await service.getSignedXml('t', 'inv-1');
    expect(result.xml).toContain('unsigned');
  });

  it('throws NotFoundException when invoice not found', async () => {
    const { service, prisma } = makeService();
    prisma.invoice.findFirst.mockResolvedValue(null);

    await expect(service.getSignedXml('t', 'bad')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws BadRequestException when neither XML is available', async () => {
    const { service, prisma } = makeService();
    prisma.invoice.findFirst.mockResolvedValue({
      xmlSigned: null, xmlUnsigned: null, encf: 'E320000000001', status: 'QUEUED',
    });

    await expect(service.getSignedXml('t', 'inv-1')).rejects.toBeInstanceOf(BadRequestException);
  });
});
