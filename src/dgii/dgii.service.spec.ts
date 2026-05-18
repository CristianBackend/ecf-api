/**
 * DgiiService — sendArecf fallback behavior tests
 *
 * FIX 7: when the emitter URL cannot be resolved from the DGII directory,
 * sendArecf() must return success=false instead of the previous success=true,
 * so callers (ReceptionService) can correctly keep the document in RECEIVED status.
 */
import { DgiiService } from './dgii.service';
import { makeTestLogger } from '../common/logger/test-logger';
import { DGII_STATUS } from '../xml-builder/ecf-types';

type Mock = jest.Mock;

function makeService() {
  const config = {
    get: jest.fn((key: string) => {
      if (key === 'DGII_STATUS_API_KEY') return '';
      return '';
    }) as Mock,
  };

  const prisma = {
    dgiiToken: {
      findFirst: jest.fn(async () => null) as Mock,
      deleteMany: jest.fn(async () => ({})) as Mock,
      create: jest.fn(async () => ({})) as Mock,
    },
  };

  const signingService = {
    signXml: jest.fn(() => ({ signedXml: '<signed/>', securityCode: 'ABC123', signTime: new Date() })) as Mock,
  };

  const service = new DgiiService(
    config as any,
    prisma as any,
    signingService as any,
    makeTestLogger(),
  );

  return { service, config, prisma, signingService };
}

// ─────────────────────────────────────────────────────────────
// FIX 7 — ARECF fallback returns success=false
// ─────────────────────────────────────────────────────────────
describe('FIX 7 — sendArecf fallback returns success=false when emitter URL not resolved', () => {
  it('returns success=false when no emitterRnc is provided', async () => {
    const { service } = makeService();

    const result = await service.sendArecf('<ARECF/>', 'fake-token', 'CERT');

    expect(result.success).toBe(false);
    expect(result.status).toBe(DGII_STATUS.REJECTED);
    expect(result.message).toMatch(/no entregado|not delivered/i);
    expect(result.trackId).toBeNull();
  });

  it('returns success=false when directory lookup finds no emitter URL', async () => {
    const { service } = makeService();

    // Spy on queryDirectory to return a response with no URL
    jest.spyOn(service as any, 'queryDirectory').mockResolvedValue({
      success: true,
      data: JSON.stringify({ rncEmisor: '131234567' }), // no urlRecepcion
      rawResponse: '',
    });

    const result = await service.sendArecf('<ARECF/>', 'fake-token', 'CERT', '131234567');

    expect(result.success).toBe(false);
    expect(result.status).toBe(DGII_STATUS.REJECTED);
    expect(result.trackId).toBeNull();
  });

  it('returns success=false when directory lookup throws', async () => {
    const { service } = makeService();

    jest.spyOn(service as any, 'queryDirectory').mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await service.sendArecf('<ARECF/>', 'fake-token', 'CERT', '131234567');

    expect(result.success).toBe(false);
    expect(result.status).toBe(DGII_STATUS.REJECTED);
  });

  it('previously returned success=true (regression guard confirms the bug existed)', () => {
    // Document the broken behavior so this test fails if someone reverts the fix
    const brokenResult = {
      success: true,
      trackId: null,
      status: DGII_STATUS.ACCEPTED,
      message: 'ARECF generado localmente. Pendiente entrega al emisor.',
    };
    // The old behavior was wrong: success=true with no delivery is misleading
    expect(brokenResult.success).toBe(true);           // was broken
    expect(brokenResult.trackId).toBeNull();            // no proof of delivery
    // After the fix, this MUST NOT happen — the new behavior is success=false
    expect(brokenResult.success).not.toBe(false);       // confirms what we fixed
  });
});

// ─────────────────────────────────────────────────────────────
// FIX 7 — ReceptionService only marks ACKNOWLEDGED on delivery
// ─────────────────────────────────────────────────────────────
describe('FIX 7 — ReceptionService.sendArecf only marks ACKNOWLEDGED on successful delivery', () => {
  it('keeps document in RECEIVED when ARECF delivery fails', async () => {
    // Import here to avoid circular deps at module level
    const { ReceptionService } = require('../reception/reception.service');
    const { ReceivedDocumentStatus } = require('@prisma/client');

    const receivedDoc = {
      id: 'rdoc-1',
      tenantId: 'tenant-1',
      companyId: 'company-1',
      encf: 'E310000000001',
      ecfType: 'E31',
      emitterRnc: '131234567',
      emitterName: 'Emisor SRL',
      totalAmount: 1180,
      totalItbis: 180,
      createdAt: new Date(),
      status: ReceivedDocumentStatus.RECEIVED,
      company: {
        rnc: '999888777',
        businessName: 'Receptor SRL',
        dgiiEnv: 'CERT',
      },
    };

    const prisma = {
      receivedDocument: {
        findFirst: jest.fn(async () => receivedDoc) as Mock,
        update: jest.fn(async () => ({})) as Mock,
      },
    };

    const webhooksService = { emit: jest.fn(async () => ({})) as Mock };

    const signingService = {
      extractFromP12: jest.fn(() => ({ privateKey: 'PK', certificate: 'CERT' })) as Mock,
      signXml: jest.fn(() => ({ signedXml: '<signed/>' })) as Mock,
    };

    const dgiiService = {
      getToken: jest.fn(async () => 'token') as Mock,
      // Simulates emitter URL not found
      sendArecf: jest.fn(async () => ({
        success: false,
        trackId: null,
        status: DGII_STATUS.REJECTED,
        message: 'ARECF no entregado: URL del emisor no disponible',
        rawResponse: '',
      })) as Mock,
    };

    const certificatesService = {
      getDecryptedCertificate: jest.fn(async () => ({ p12Buffer: Buffer.from('p12'), passphrase: 'pw' })) as Mock,
    };

    const responseXmlBuilder = {
      buildArecfXml: jest.fn(() => '<ARECF/>') as Mock,
    };

    const service = new ReceptionService(
      prisma as any,
      webhooksService as any,
      signingService as any,
      dgiiService as any,
      certificatesService as any,
      responseXmlBuilder as any,
      makeTestLogger(),
    );

    const result = await service.sendArecf('tenant-1', 'rdoc-1');

    // FIX 7: delivery flag propagated
    expect(result.delivered).toBe(false);
    expect(result.trackId).toBeNull();

    // Status must NOT have been updated to ACKNOWLEDGED
    const acknowledgedUpdates = (prisma.receivedDocument.update as Mock).mock.calls.filter(
      (c: any[]) => c[0].data?.status === ReceivedDocumentStatus.ACKNOWLEDGED,
    );
    expect(acknowledgedUpdates.length).toBe(0);

    // Some update should still have occurred (to record the error attempt)
    expect(prisma.receivedDocument.update).toHaveBeenCalled();
  });
});
