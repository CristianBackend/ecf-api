/**
 * fe-receptor HTTP path integration tests — Tarea DGII path fix
 *
 * These tests verify that FeReceptorController routes are reachable at their
 * DGII-spec paths (/fe/...) and NOT at /api/v1/fe/... after applying the
 * setGlobalPrefix exclude list.
 *
 * A minimal NestJS app is bootstrapped with mocked dependencies so no real
 * DB/Redis connections are required.
 */

import { INestApplication, RequestMethod } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getLoggerToken } from 'nestjs-pino';
import * as request from 'supertest';
import { FeReceptorController } from './fe-receptor.controller';
import { PrismaService } from '../prisma/prisma.service';
import { SigningService } from '../signing/signing.service';
import { ReceptionService } from './reception.service';
import { ResponseXmlBuilder } from '../xml-builder/response-xml-builder';
import { CertificatesService } from '../certificates/certificates.service';

const MOCK_LOGGER = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

describe('FeReceptorController — path prefix exclusion', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [FeReceptorController],
      providers: [
        { provide: PrismaService,      useValue: { company: { findFirst: jest.fn() }, invoice: { findFirst: jest.fn(), update: jest.fn() } } },
        { provide: SigningService,      useValue: { verifySignedXml: jest.fn(), extractFromP12: jest.fn(), signXml: jest.fn() } },
        { provide: ReceptionService,   useValue: { storeReceived: jest.fn() } },
        { provide: ResponseXmlBuilder, useValue: { buildArecfXml: jest.fn(), buildArecfErrorXml: jest.fn() } },
        { provide: CertificatesService,useValue: { getDecryptedCertificate: jest.fn() } },
        { provide: getLoggerToken(FeReceptorController.name), useValue: MOCK_LOGGER },
      ],
    }).compile();

    app = module.createNestApplication();

    // Mirror the production setGlobalPrefix configuration from main.ts
    app.setGlobalPrefix('api/v1', {
      exclude: [
        { path: 'fe/autenticacion/api/semilla',               method: RequestMethod.GET },
        { path: 'fe/autenticacion/api/validacioncertificado', method: RequestMethod.POST },
        { path: 'fe/recepcion/api/ecf',                       method: RequestMethod.POST },
        { path: 'fe/aprobacioncomercial/api/ecf',             method: RequestMethod.POST },
      ],
    });

    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  // ── Positive path: routes exist WITHOUT /api/v1 prefix ─────────────────────

  it('GET /fe/autenticacion/api/semilla → 200 (DGII required path)', async () => {
    const res = await request(app.getHttpServer())
      .get('/fe/autenticacion/api/semilla');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<SemillaModel>');
    expect(res.text).toContain('<valor>');
  });

  // ── Negative path: /api/v1/fe/* must NOT exist ──────────────────────────────

  it('GET /api/v1/fe/autenticacion/api/semilla → 404 (prefix path must not exist)', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/fe/autenticacion/api/semilla');
    expect(res.status).toBe(404);
  });

  it('POST /api/v1/fe/autenticacion/api/validacioncertificado → 404', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/fe/autenticacion/api/validacioncertificado')
      .send({ xml: '<test/>' });
    expect(res.status).toBe(404);
  });

  it('POST /api/v1/fe/recepcion/api/ecf → 404', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/fe/recepcion/api/ecf')
      .send({ xml: '<test/>' });
    expect(res.status).toBe(404);
  });

  it('POST /api/v1/fe/aprobacioncomercial/api/ecf → 404', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/fe/aprobacioncomercial/api/ecf')
      .send({ xml: '<test/>' });
    expect(res.status).toBe(404);
  });

  // ── Semilla response shape ──────────────────────────────────────────────────

  it('GET /fe/autenticacion/api/semilla returns valid seed XML with random valor', async () => {
    const [r1, r2] = await Promise.all([
      request(app.getHttpServer()).get('/fe/autenticacion/api/semilla'),
      request(app.getHttpServer()).get('/fe/autenticacion/api/semilla'),
    ]);

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    // Each call must return a different random valor (64 hex chars)
    const extract = (body: string) => body.match(/<valor>([^<]+)<\/valor>/)?.[1];
    const v1 = extract(r1.text);
    const v2 = extract(r2.text);
    expect(v1).toMatch(/^[0-9a-f]{64}$/);
    expect(v2).toMatch(/^[0-9a-f]{64}$/);
    expect(v1).not.toBe(v2);
  });
});

// ============================================================
// receiveEcf — signature verification (FIX 4)
// ============================================================

describe('FeReceptorController — receiveEcf signature verification', () => {
  let app: INestApplication;
  let mockSigningService: { verifySignedXml: jest.Mock; extractFromP12: jest.Mock; signXml: jest.Mock };
  let mockResponseXmlBuilder: { buildArecfXml: jest.Mock; buildArecfErrorXml: jest.Mock };
  let mockPrisma: any;
  let mockReceptionService: { storeReceived: jest.Mock };
  let mockCertificatesService: { getDecryptedCertificate: jest.Mock };

  beforeEach(async () => {
    mockSigningService = {
      verifySignedXml: jest.fn(),
      extractFromP12: jest.fn(),
      signXml: jest.fn(),
    };
    mockResponseXmlBuilder = {
      buildArecfXml: jest.fn().mockReturnValue('<ARECF><Estado>0</Estado></ARECF>'),
      buildArecfErrorXml: jest.fn().mockReturnValue('<ARECF><Estado>1</Estado><CodigoMotivoNoRecibido>2</CodigoMotivoNoRecibido></ARECF>'),
    };
    mockPrisma = {
      company: { findFirst: jest.fn().mockResolvedValue(null) },
      invoice: { findFirst: jest.fn(), update: jest.fn() },
    };
    mockReceptionService = { storeReceived: jest.fn() };
    mockCertificatesService = { getDecryptedCertificate: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [FeReceptorController],
      providers: [
        { provide: PrismaService,       useValue: mockPrisma },
        { provide: SigningService,       useValue: mockSigningService },
        { provide: ReceptionService,    useValue: mockReceptionService },
        { provide: ResponseXmlBuilder,  useValue: mockResponseXmlBuilder },
        { provide: CertificatesService, useValue: mockCertificatesService },
        { provide: getLoggerToken(FeReceptorController.name), useValue: MOCK_LOGGER },
      ],
    }).compile();

    app = module.createNestApplication();
    app.setGlobalPrefix('api/v1', {
      exclude: [
        { path: 'fe/recepcion/api/ecf', method: RequestMethod.POST },
        { path: 'fe/aprobacioncomercial/api/ecf', method: RequestMethod.POST },
        { path: 'fe/autenticacion/api/semilla', method: RequestMethod.GET },
        { path: 'fe/autenticacion/api/validacioncertificado', method: RequestMethod.POST },
      ],
    });
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  const SIGNED_ARECF_ERROR = '<ARECF><Signature/><Estado>1</Estado></ARECF>';
  const UNSIGNED_ARECF_ERROR = '<ARECF><Estado>1</Estado></ARECF>';

  const ecfXmlWith = (rncEmisor: string, rncComprador: string, encf: string) =>
    [
      '<ECF>',
      '  <Encabezado>',
      `    <Emisor><RNCEmisor>${rncEmisor}</RNCEmisor></Emisor>`,
      `    <Comprador><RNCComprador>${rncComprador}</RNCComprador></Comprador>`,
      `    <IdDoc><eNCF>${encf}</eNCF></IdDoc>`,
      '  </Encabezado>',
      '  <Signature/>',
      '</ECF>',
    ].join('\n');

  // ── Case A: company found, cert available, emitter signature invalid ────────
  // Expected: ARECF Estado=1 Código=2, SIGNED with receiver's cert

  it('invalid emitter signature + company + cert → ARECF error code 2, SIGNED', async () => {
    mockSigningService.verifySignedXml.mockImplementation(() => {
      throw new Error('DigestValue mismatch');
    });
    mockPrisma.company.findFirst.mockResolvedValue({
      id: 'company-1', tenantId: 'tenant-1', rnc: '101234567',
      businessName: 'Receptor SRL', dgiiEnv: 'DEV',
    });
    mockCertificatesService.getDecryptedCertificate.mockResolvedValue({
      p12Buffer: Buffer.from('p12'), passphrase: 'pw',
    });
    mockSigningService.extractFromP12.mockReturnValue({
      privateKey: 'PRIV', certificate: 'CERT',
    });
    // signXml is called by buildSignedErrorArecf when signingMaterial is present
    mockSigningService.signXml.mockReturnValue({ signedXml: SIGNED_ARECF_ERROR });
    mockResponseXmlBuilder.buildArecfErrorXml.mockReturnValue(UNSIGNED_ARECF_ERROR);

    const res = await request(app.getHttpServer())
      .post('/fe/recepcion/api/ecf')
      .send({ xml: ecfXmlWith('131234567', '101234567', 'E310000000001') });

    expect(res.status).toBe(200);
    expect(mockResponseXmlBuilder.buildArecfErrorXml).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 2 }),
    );
    // signXml was called → ARECF is signed
    expect(mockSigningService.signXml).toHaveBeenCalled();
    // Response body is the signed version
    expect(res.text).toBe(SIGNED_ARECF_ERROR);
    // Did NOT store the document
    expect(mockReceptionService.storeReceived).not.toHaveBeenCalled();
  });

  // ── Case B: company found, cert unavailable, emitter signature invalid ──────
  // Expected: ARECF Estado=1 Código=2, UNSIGNED (no cert to sign with)

  it('invalid emitter signature + company without cert → ARECF error code 2, UNSIGNED', async () => {
    mockSigningService.verifySignedXml.mockImplementation(() => {
      throw new Error('SignatureValue mismatch');
    });
    mockPrisma.company.findFirst.mockResolvedValue({
      id: 'company-1', tenantId: 'tenant-1', rnc: '101234567',
      businessName: 'Receptor SRL', dgiiEnv: 'DEV',
    });
    // Certificate load fails (e.g. not uploaded yet)
    mockCertificatesService.getDecryptedCertificate.mockRejectedValue(
      new Error('No certificate found'),
    );
    mockResponseXmlBuilder.buildArecfErrorXml.mockReturnValue(UNSIGNED_ARECF_ERROR);

    const res = await request(app.getHttpServer())
      .post('/fe/recepcion/api/ecf')
      .send({ xml: ecfXmlWith('131234567', '101234567', 'E310000000001') });

    expect(res.status).toBe(200);
    expect(mockResponseXmlBuilder.buildArecfErrorXml).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 2 }),
    );
    // signXml NOT called — no cert available
    expect(mockSigningService.signXml).not.toHaveBeenCalled();
    expect(res.text).toBe(UNSIGNED_ARECF_ERROR);
    expect(mockReceptionService.storeReceived).not.toHaveBeenCalled();
  });

  // ── Case C: company not found, emitter signature invalid ───────────────────
  // Expected: ARECF Estado=1 Código=2, UNSIGNED (no receiver to get cert from)

  it('invalid emitter signature + company not found → ARECF error code 2, UNSIGNED', async () => {
    mockSigningService.verifySignedXml.mockImplementation(() => {
      throw new Error('XML no contiene elemento <Signature>');
    });
    mockPrisma.company.findFirst.mockResolvedValue(null);
    mockResponseXmlBuilder.buildArecfErrorXml.mockReturnValue(UNSIGNED_ARECF_ERROR);

    const res = await request(app.getHttpServer())
      .post('/fe/recepcion/api/ecf')
      .send({ xml: ecfXmlWith('131234567', 'UNKNOWN-RNC', 'E310000000001') });

    expect(res.status).toBe(200);
    expect(mockResponseXmlBuilder.buildArecfErrorXml).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: 2 }),
    );
    expect(mockSigningService.signXml).not.toHaveBeenCalled();
    expect(res.text).toBe(UNSIGNED_ARECF_ERROR);
    expect(mockReceptionService.storeReceived).not.toHaveBeenCalled();
  });

  // ── Happy path regression: valid signature → proceeds normally ─────────────

  it('valid emitter signature → verifySignedXml called, proceeds to company lookup', async () => {
    mockSigningService.verifySignedXml.mockReturnValue({ certificatePem: 'CERT' });
    // Company not found after valid sig → error code 4 (not code 2)
    mockPrisma.company.findFirst.mockResolvedValue(null);
    mockResponseXmlBuilder.buildArecfErrorXml.mockReturnValue(UNSIGNED_ARECF_ERROR);

    const res = await request(app.getHttpServer())
      .post('/fe/recepcion/api/ecf')
      .send({ xml: ecfXmlWith('131234567', 'UNKNOWN', 'E310000000001') });

    expect(res.status).toBe(200);
    expect(mockSigningService.verifySignedXml).toHaveBeenCalledTimes(1);
    // No code-2 error triggered
    const signatureErrors = mockResponseXmlBuilder.buildArecfErrorXml.mock.calls
      .filter((c: any[]) => c[0]?.errorCode === 2);
    expect(signatureErrors).toHaveLength(0);
    // Did not store (company not found)
    expect(mockReceptionService.storeReceived).not.toHaveBeenCalled();
  });
});
