import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext } from '@nestjs/common';
import { PdfController } from './pdf.controller';
import { PdfService } from './pdf.service';
import { ApiKeyGuard } from '../common/guards/api-key.guard';

const FAKE_HTML = '<html><body>Invoice HTML</body></html>';
const FAKE_PDF = Buffer.from('%PDF-1.4 \n%%EOF\n');

const mockTenant = { id: 'tenant-1' };

function mockResponse() {
  const res: any = {};
  res.set = jest.fn().mockReturnValue(res);
  res.send = jest.fn().mockReturnValue(res);
  return res;
}

describe('PdfController', () => {
  let controller: PdfController;
  let pdfService: {
    generateHtml: jest.Mock;
    generatePrintableHtml: jest.Mock;
    generatePdfBuffer: jest.Mock;
  };

  beforeEach(async () => {
    pdfService = {
      generateHtml: jest.fn().mockResolvedValue(FAKE_HTML),
      generatePrintableHtml: jest.fn().mockResolvedValue(FAKE_HTML + '<!-- PRINTABLE -->'),
      generatePdfBuffer: jest.fn().mockResolvedValue(FAKE_PDF),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [PdfController],
      providers: [{ provide: PdfService, useValue: pdfService }],
    })
      .overrideGuard(ApiKeyGuard)
      .useValue({ canActivate: (ctx: ExecutionContext) => {
        const req = ctx.switchToHttp().getRequest();
        req.tenant = mockTenant;
        return true;
      }})
      .compile();

    controller = module.get<PdfController>(PdfController);
  });

  // ── 37. ?format=pdf returns application/pdf ───────────────────

  it('GET /:id/pdf (no format) returns application/pdf binary (12.4)', async () => {
    const res = mockResponse();
    await controller.downloadPdf(mockTenant as any, 'inv-1', 'pdf', res);

    expect(pdfService.generatePdfBuffer).toHaveBeenCalledWith('tenant-1', 'inv-1');
    expect(res.set).toHaveBeenCalledWith(expect.objectContaining({ 'Content-Type': 'application/pdf' }));
    expect(res.send).toHaveBeenCalledWith(FAKE_PDF);
  });

  // ── 38. ?format=html returns text/html (backward compat) ──────

  it('GET /:id/pdf?format=html returns text/html (12.4 backward compat)', async () => {
    const res = mockResponse();
    await controller.downloadPdf(mockTenant as any, 'inv-1', 'html', res);

    expect(pdfService.generatePrintableHtml).toHaveBeenCalledWith('tenant-1', 'inv-1');
    expect(pdfService.generatePdfBuffer).not.toHaveBeenCalled();
    expect(res.set).toHaveBeenCalledWith('Content-Type', 'text/html');
  });

  // ── 39. Content-Disposition includes filename ─────────────────

  it('PDF response includes Content-Disposition with filename (12.4)', async () => {
    const res = mockResponse();
    await controller.downloadPdf(mockTenant as any, 'inv-001', 'pdf', res);

    const setCalls = res.set.mock.calls;
    const headers = setCalls.find((c: any[]) => typeof c[0] === 'object')?.[0] || {};
    expect(headers['Content-Disposition']).toContain('inv-001.pdf');
  });

  // ── 40. preview endpoint returns text/html ────────────────────

  it('GET /:id/preview returns text/html', async () => {
    const res = mockResponse();
    await controller.preview(mockTenant as any, 'inv-1', res);

    expect(pdfService.generateHtml).toHaveBeenCalledWith('tenant-1', 'inv-1');
    expect(res.set).toHaveBeenCalledWith('Content-Type', 'text/html');
    expect(res.send).toHaveBeenCalledWith(FAKE_HTML);
  });
});
