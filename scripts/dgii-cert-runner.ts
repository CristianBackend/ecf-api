#!/usr/bin/env ts-node
/**
 * DGII Certification Test Set Runner
 * ====================================
 *
 * Itera los 25 casos ECF + 4 casos RFCE del Excel oficial de DGII y los emite
 * contra el ambiente de Certificación (CERT) de DGII.
 *
 * Estrategia:
 *   - Continúa aunque algún caso falle (reporta al final).
 *   - Por cada caso descarga el XML firmado a cert-output/.
 *   - Hace poll del status hasta tener resultado de DGII (max 60s por caso).
 *   - Al final escribe results.json, summary.csv y la tabla en consola.
 *
 * Uso:
 *   npm run cert:run                    (con ts-node)
 *   ts-node scripts/dgii-cert-runner.ts
 *
 * Variables de entorno requeridas:
 *   CERT_API_BASE      ej: https://node-a2.newplain.com
 *   CERT_EMAIL         ej: cristian@newplain.com
 *   CERT_PASSWORD      ej: EcfAdmin2026!
 *   CERT_COMPANY_ID    ej: d749d508-c5e4-4449-838c-03b3471e83a0
 */

import * as fs from 'fs';
import * as path from 'path';
import { mapEcfCase, extractEncfNumber } from './dgii-cert-mapper';

// ───────────────────────────────────────────────────────────
// Config
// ───────────────────────────────────────────────────────────
const API_BASE = process.env.CERT_API_BASE || 'https://node-a2.newplain.com';
const EMAIL = process.env.CERT_EMAIL || '';
const PASSWORD = process.env.CERT_PASSWORD || '';
const COMPANY_ID = process.env.CERT_COMPANY_ID || '';

const DATA_DIR = path.join(__dirname, 'cert-data');
const OUTPUT_DIR = path.join(process.cwd(), 'cert-output');
const POLL_INTERVAL_MS = 3000;
const POLL_MAX_ATTEMPTS = 20; // 20 × 3s = 60s
const DELAY_BETWEEN_CASES_MS = 1500;

// Colores para terminal
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

interface CaseResult {
  caso: string;
  encf: string;
  ecfType: string;
  invoiceId?: string;
  trackId?: string;
  finalStatus: string;
  dgiiMessage?: string;
  xmlSaved: boolean;
  error?: string;
  elapsedMs: number;
}

// ───────────────────────────────────────────────────────────
// HTTP helper (fetch nativo de Node 18+)
// ───────────────────────────────────────────────────────────
async function http<T = any>(
  method: string,
  url: string,
  body?: any,
  token?: string,
): Promise<{ status: number; data: T; raw: string }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${url}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = await res.text();
  let data: any;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = { _raw: raw };
  }
  return { status: res.status, data, raw };
}

async function downloadXml(invoiceId: string, token: string): Promise<string | null> {
  try {
    const res = await fetch(`${API_BASE}/api/v1/invoices/${invoiceId}/xml`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

// ───────────────────────────────────────────────────────────
// Flujo principal
// ───────────────────────────────────────────────────────────
async function login(): Promise<string> {
  console.log(`${C.cyan}[1/3]${C.reset} Login en ${API_BASE}...`);
  const r = await http<any>('POST', '/api/v1/auth/login', {
    email: EMAIL,
    password: PASSWORD,
  });
  if (r.status !== 200 || !r.data?.data?.token) {
    throw new Error(`Login falló: HTTP ${r.status} - ${r.raw}`);
  }
  console.log(`${C.green}✓${C.reset} Token obtenido (tenant: ${r.data.data.tenant?.name})`);
  return r.data.data.token;
}

async function pollUntilFinal(
  invoiceId: string,
  token: string,
): Promise<{ status: string; trackId?: string; message?: string }> {
  for (let i = 0; i < POLL_MAX_ATTEMPTS; i++) {
    await sleep(POLL_INTERVAL_MS);
    const r = await http<any>('POST', `/api/v1/invoices/${invoiceId}/poll`, undefined, token);
    if (r.status === 200) {
      const cur = r.data?.data?.currentStatus || r.data?.currentStatus;
      const trackId = r.data?.data?.trackId || r.data?.trackId;
      const msg = r.data?.data?.dgiiMessage || r.data?.dgiiMessage;
      if (cur && !['QUEUED', 'PROCESSING', 'SENT'].includes(cur)) {
        return { status: cur, trackId, message: msg };
      }
    }
  }
  return { status: 'TIMEOUT' };
}

async function processCase(
  c: any,
  token: string,
  index: number,
  total: number,
): Promise<CaseResult> {
  const t0 = Date.now();
  const caso = c.CasoPrueba;
  const encf = c.ENCF;
  const ecfType = `E${c.TipoeCF}`;

  console.log(`\n${C.bold}[${index + 1}/${total}]${C.reset} ${caso} (${ecfType}) → ENCF ${encf}`);

  const result: CaseResult = {
    caso,
    encf,
    ecfType,
    finalStatus: 'PENDING',
    xmlSaved: false,
    elapsedMs: 0,
  };

  try {
    // 1. Mapear y enviar
    const payload = mapEcfCase(c, COMPANY_ID);
    console.log(
      `  ${C.gray}└─${C.reset} payload: items=${payload.items.length}, override=${payload.encfOverride}`,
    );

    const createRes = await http<any>('POST', '/api/v1/invoices', payload, token);

    if (createRes.status !== 202 && createRes.status !== 201) {
      result.finalStatus = 'CREATE_FAILED';
      result.error = `HTTP ${createRes.status}: ${createRes.raw.slice(0, 500)}`;
      console.log(`  ${C.red}✗${C.reset} POST falló: ${result.error}`);
      result.elapsedMs = Date.now() - t0;
      return result;
    }

    const invoice = createRes.data?.data || createRes.data;
    result.invoiceId = invoice.id;
    console.log(`  ${C.gray}└─${C.reset} invoice creado: ${invoice.id}`);

    // 2. Esperar y poll
    const finalState = await pollUntilFinal(invoice.id, token);
    result.finalStatus = finalState.status;
    result.trackId = finalState.trackId;
    result.dgiiMessage = finalState.message;

    // 3. Descargar XML firmado
    const xml = await downloadXml(invoice.id, token);
    if (xml) {
      const filename = `${encf}.xml`;
      fs.writeFileSync(path.join(OUTPUT_DIR, filename), xml, 'utf-8');
      result.xmlSaved = true;
    }

    const color =
      finalState.status === 'ACCEPTED' ? C.green :
      finalState.status === 'REJECTED' ? C.red :
      C.yellow;
    console.log(`  ${color}└─${C.reset} status: ${finalState.status}${finalState.trackId ? ` | trackId: ${finalState.trackId}` : ''}`);
    if (finalState.message) console.log(`  ${C.gray}└─${C.reset} ${finalState.message}`);
  } catch (e: any) {
    result.finalStatus = 'EXCEPTION';
    result.error = e?.message || String(e);
    console.log(`  ${C.red}✗${C.reset} excepción: ${result.error}`);
  }

  result.elapsedMs = Date.now() - t0;
  return result;
}

async function main() {
  // Validar config
  if (!EMAIL || !PASSWORD || !COMPANY_ID) {
    console.error(`${C.red}ERROR:${C.reset} faltan variables de entorno.`);
    console.error('Requeridas: CERT_EMAIL, CERT_PASSWORD, CERT_COMPANY_ID');
    console.error('Opcional:   CERT_API_BASE (default: https://node-a2.newplain.com)');
    process.exit(1);
  }

  // Crear carpeta de salida
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // Cargar casos
  console.log(`\n${C.bold}═══════════════════════════════════════════════════${C.reset}`);
  console.log(`${C.bold}  DGII CERTIFICATION TEST SET RUNNER${C.reset}`);
  console.log(`${C.bold}═══════════════════════════════════════════════════${C.reset}\n`);
  console.log(`API:      ${API_BASE}`);
  console.log(`Company:  ${COMPANY_ID}`);
  console.log(`Output:   ${OUTPUT_DIR}\n`);

  const ecfCases = JSON.parse(
    fs.readFileSync(path.join(DATA_DIR, 'casos_ecf.json'), 'utf-8'),
  );
  console.log(`Casos ECF cargados: ${ecfCases.length}`);

  // Login
  const token = await login();

  // Procesar ECF
  console.log(`\n${C.cyan}[2/3]${C.reset} Procesando casos ECF...`);
  const results: CaseResult[] = [];
  for (let i = 0; i < ecfCases.length; i++) {
    results.push(await processCase(ecfCases[i], token, i, ecfCases.length));
    if (i < ecfCases.length - 1) await sleep(DELAY_BETWEEN_CASES_MS);
  }

  // TODO: RFCE — el flujo es diferente (endpoint /resumen-fc). Lo agregamos
  // como segundo loop cuando confirmemos el endpoint exacto de la API.

  // Reporte final
  console.log(`\n${C.cyan}[3/3]${C.reset} Generando reportes...`);
  const accepted = results.filter((r) => r.finalStatus === 'ACCEPTED').length;
  const rejected = results.filter((r) => r.finalStatus === 'REJECTED').length;
  const failed = results.filter(
    (r) => !['ACCEPTED', 'REJECTED'].includes(r.finalStatus),
  ).length;

  // JSON detallado
  fs.writeFileSync(
    path.join(OUTPUT_DIR, 'results.json'),
    JSON.stringify({ runAt: new Date().toISOString(), accepted, rejected, failed, results }, null, 2),
  );

  // CSV
  const csv = [
    'CasoPrueba,ENCF,Tipo,InvoiceId,TrackId,Status,XmlGuardado,TiempoMs,Error',
    ...results.map((r) =>
      [
        r.caso,
        r.encf,
        r.ecfType,
        r.invoiceId || '',
        r.trackId || '',
        r.finalStatus,
        r.xmlSaved ? 'sí' : 'no',
        r.elapsedMs,
        (r.error || r.dgiiMessage || '').replace(/[\r\n,]/g, ' '),
      ].join(','),
    ),
  ].join('\n');
  fs.writeFileSync(path.join(OUTPUT_DIR, 'summary.csv'), csv);

  // Tabla en consola
  console.log(`\n${C.bold}══════════════════ RESUMEN ══════════════════${C.reset}\n`);
  console.log(
    `${'ENCF'.padEnd(16)} ${'Tipo'.padEnd(6)} ${'Status'.padEnd(15)} ${'XML'.padEnd(5)} TrackId`,
  );
  console.log(`${'─'.repeat(80)}`);
  for (const r of results) {
    const color =
      r.finalStatus === 'ACCEPTED' ? C.green :
      r.finalStatus === 'REJECTED' ? C.red :
      C.yellow;
    console.log(
      `${r.encf.padEnd(16)} ${r.ecfType.padEnd(6)} ${color}${r.finalStatus.padEnd(15)}${C.reset} ${(r.xmlSaved ? 'sí' : 'no').padEnd(5)} ${r.trackId || ''}`,
    );
  }
  console.log(`\n${C.green}Aceptados: ${accepted}${C.reset}   ${C.red}Rechazados: ${rejected}${C.reset}   ${C.yellow}Otros: ${failed}${C.reset}`);
  console.log(`\nArchivos generados en: ${OUTPUT_DIR}\n`);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((e) => {
  console.error(`\n${C.red}FATAL:${C.reset}`, e);
  process.exit(1);
});
