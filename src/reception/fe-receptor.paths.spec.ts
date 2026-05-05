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
