/**
 * DownloadsController tests — /downloads/invoice-xml/:token
 *
 * Verifies:
 * - A valid token pulls the invoice XML via InvoicesService and the token
 *   gets burned in Redis.
 * - Invalid / expired / already-consumed tokens return 404 and never leak
 *   tenant data.
 * - The response carries the right Content-Type / Content-Disposition and
 *   a `Cache-Control: no-store` header so proxies don't cache the XML.
 */
import { NotFoundException } from '@nestjs/common';
import { DownloadsController } from './downloads.controller';
import { DownloadTokenService } from '../common/services/download-token.service';
import { InvoicesService } from '../invoices/invoices.service';

function makeRes() {
  const res: any = {
    set: jest.fn(),
    send: jest.fn(),
  };
  return res;
}

describe('DownloadsController', () => {
  it('streams the XML and sets download headers when the token is valid', async () => {
    const consume = jest.fn(async () => ({
      type: 'invoice-xml' as const,
      tenantId: 't-1',
      invoiceId: 'inv-1',
    }));
    const downloadTokens = { consume } as unknown as DownloadTokenService;
    const invoicesService = {
      getXml: jest.fn(async () => '<ECF/>'),
    } as unknown as InvoicesService;

    const controller = new DownloadsController(downloadTokens, invoicesService);
    const res = makeRes();
    await controller.getInvoiceXml('some-token', res);

    expect(consume).toHaveBeenCalledWith('some-token');
    expect(invoicesService.getXml).toHaveBeenCalledWith('t-1', 'inv-1');
    expect(res.set).toHaveBeenCalledWith(
      expect.objectContaining({
        'Content-Type': 'application/xml',
        'Content-Disposition': 'attachment; filename="inv-1.xml"',
        'Cache-Control': 'no-store',
      }),
    );
    expect(res.send).toHaveBeenCalledWith('<ECF/>');
  });

  it('returns 404 when the token is invalid / expired / already consumed', async () => {
    const downloadTokens = {
      consume: jest.fn(async () => null),
    } as unknown as DownloadTokenService;
    const invoicesService = {
      getXml: jest.fn(),
    } as unknown as InvoicesService;

    const controller = new DownloadsController(downloadTokens, invoicesService);
    await expect(
      controller.getInvoiceXml('bad', makeRes()),
    ).rejects.toBeInstanceOf(NotFoundException);
    // Critical: if the token's bad, we must never touch the invoice store.
    expect(invoicesService.getXml).not.toHaveBeenCalled();
  });

  it('refuses tokens of a different resource type (defense in depth)', async () => {
    const downloadTokens = {
      consume: jest.fn(async () => ({
        // Imagine a future token type — this controller must not serve it.
        type: 'not-an-invoice' as any,
        tenantId: 't-1',
        invoiceId: 'inv-1',
      })),
    } as unknown as DownloadTokenService;
    const invoicesService = {
      getXml: jest.fn(),
    } as unknown as InvoicesService;

    const controller = new DownloadsController(downloadTokens, invoicesService);
    await expect(
      controller.getInvoiceXml('t', makeRes()),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(invoicesService.getXml).not.toHaveBeenCalled();
  });
});
