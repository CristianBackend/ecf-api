# ECF-API — Análisis Técnico Brutal y Honesto

**Repo:** `ecf-api` (v0.1.0) — NestJS 10 + Prisma 5 + PostgreSQL 16 + Redis 7 + BullMQ
**Alcance:** Facturación electrónica DGII-compliant para New Plain EIRL (RNC 133158744), 10 tipos e-CF (E31–E47)
**Fecha análisis:** 2026-04-18
**Método:** revisión directa del código, ejecución de tests, sin suposiciones

---

## TL;DR (máx 10 bullets)

1. **Tests: 84/84 pasan, pero todos viven en UN SOLO archivo** (`src/xml-builder/xml-builder.service.spec.ts`). Cero tests para firma, cero para cliente DGII, cero para webhooks, cero para colas, cero e2e. La carpeta `test/` está vacía.
2. **El pipeline asíncrono con BullMQ está DESCONECTADO**: `EcfProcessingProcessor` existe como worker, pero **nadie llama a `queueService.enqueueEcfProcessing()`** en todo el código. El flujo real del controlador (`POST /invoices`) es 100% síncrono vía `InvoicesService.create()`.
3. **Los webhooks NO se disparan desde el flujo principal de facturación.** `InvoicesService.create()` y `InvoicesService.pollStatus()` actualizan estados en BD pero jamás invocan `fireWebhookEvent` ni `WebhooksService.dispatch`. Los webhooks sólo se emiten desde `contingency.service.ts` y `reception.service.ts`, y desde el processor BullMQ que **es código muerto**.
4. **Status polling automático casi inexistente en el camino feliz.** Una factura creada vía API que queda en `PROCESSING` no se auto-consulta. El cliente tiene que pegarle a `POST /invoices/:id/poll` manualmente. `StatusPollProcessor` sí funciona, pero solo se enqueua tras re-envíos de contingencia y desde el processor muerto.
5. **XMLDSig C14N es una implementación casera a base de regex** (`src/signing/signing.service.ts:333-378`), NO una librería probada (`xml-crypto`, `xmldsigjs`). Funciona para el XML auto-generado pero es frágil ante cualquier variación: namespaces prefijados, whitespace inesperado, atributos con caracteres especiales. DGII rechaza firmas con un byte de diferencia en el canonicalizado.
6. **`.env.example` está prácticamente vacío** (2 líneas de basura con BOM UTF-8, `src/.env.example:1-2`). Todas las variables se descubren leyendo `.env` y `configuration.ts`. Hay variables referenciadas en código (`CORS_ORIGIN`, `DGII_STATUS_API_KEY`, `JWT_EXPIRES_IN`) que no aparecen en ningún `.env`.
7. **Sin logging estructurado.** `pino` y `pino-pretty` están en `package.json` pero NUNCA se importan; se usa el `Logger` por defecto de NestJS. No hay métricas (Prometheus), no hay tracing.
8. **Sin `@nestjs/schedule`; el scheduler usa `setInterval`** (`src/scheduler/scheduler.service.ts:30-33`) — no hay jitter, no hay lock, si corren múltiples instancias duplican trabajo. El cleanup de tokens y el reintento de contingencia corren en TODAS las réplicas.
8a. **Conflicto "doble polling" parcialmente resuelto**: el scheduler ya NO hace polling de invoices individuales (ver el NOTE en `scheduler.service.ts:12-15`), pero el `StatusPollProcessor` queda huérfano en el camino síncrono (ver punto 4).
9. **Certificados `.p12` viven en PostgreSQL cifrados con AES-256-GCM**, clave derivada del `JWT_SECRET` (`src/certificates/certificates.service.ts:33-44`). **NO hay integración KMS/S3** pese a las variables `AWS_KMS_KEY_ID`/`AWS_S3_BUCKET`. El comentario "In production, this would use AWS KMS" (cert service L29 y L50) es una promesa, no una implementación. Rotación: se desactiva la previa y se sube nueva, pero sin workflow automatizado ni alerta proactiva (solo warning L158).
10. **Validación XSD depende de `xmllint` binario en el host.** Si no está instalado → **no se valida** pero se deja pasar (antes con `true`, ahora bloquea explícitamente: `xsd-validation.service.ts:108-118`, *bien*). Dockerfile L37 instala `libxml2-utils` correctamente. Fuera de Docker el riesgo es real.

---

## 1. Inventario de la arquitectura

### 1.1 Árbol de módulos (registrados en `src/app.module.ts:27-94`)

| Fase | Módulo | Archivos clave |
|---|---|---|
| Global | `PrismaModule` (@Global) | `src/prisma/prisma.service.ts` |
| Global | `RncModule` (@Global) | `src/common/services/rnc-validation.service.ts` |
| Global | `ValidationModule` (@Global) | `src/validation/{validation,xsd-validation}.service.ts` |
| 1 Foundation | `AuthModule` | `src/auth/auth.{service,controller}.ts`, `src/common/guards/api-key.guard.ts` |
| 1 | `TenantsModule`, `CompaniesModule`, `BuyersModule` | CRUD multi-tenant |
| 1 | `CertificatesModule` | `src/certificates/certificates.service.ts` |
| 1 | `SequencesModule` | control de eNCF (`getNextEncf`) |
| 2 Core | `XmlBuilderModule` | `src/xml-builder/xml-builder.service.ts` (1447 LoC) |
| 2 | `SigningModule` | `src/signing/signing.service.ts` (521 LoC) |
| 2 | `DgiiModule` | `src/dgii/dgii.service.ts` (838 LoC) |
| 2 | `InvoicesModule` | `src/invoices/{invoices.controller,invoices.service}.ts` |
| 3 Async | `QueueModule` | 4 processors BullMQ |
| 4 Comp. | `WebhooksModule`, `PdfModule`, `ContingencyModule`, `ReceptionModule`, `SchedulerModule` | |
| Utils | `HealthModule` | `/api/v1/health` |

### 1.2 Flujo end-to-end de una factura (flujo síncrono, el único realmente conectado)

Evidencia paso a paso:

```
POST /api/v1/invoices                        invoices.controller.ts:38-43
 └─ InvoicesService.create(tenantId, dto)    invoices.service.ts:55
    1. idempotency                           L57-65
    2. company lookup                        L68-74
    3. business validations (RNC/ref/etc)    L78-123
    4. getNextEncf                           L129  (sequences.service)
    5. buildEcfXml                           L155-159  (xml-builder.service)
    6. XSD validate (if xmllint available)   L162-172
    7. INSERT invoice (status=PROCESSING)    L178-204
    8. certificatesService.getDecryptedCert  L235
    9. signingService.extractFromP12 (+RNC)  L242  (incl. SN==RNC check)
   10. signingService.signXml (XMLDSig)      L249-253
   11. dgiiService.getToken (semilla→JWT)    L268
   12. dgiiService.submitEcf  OR  submitRfce L298-313
   13. UPDATE invoice con trackId+status     L318-327
   14. createAuditLog                        L332-338
```

**Tracking post-submit:**
- Sólo manual: `POST /invoices/:id/poll` → `InvoicesService.pollStatus` (`invoices.service.ts:368-419`). No hay enqueue a BullMQ desde el flujo síncrono.
- El camino automático (BullMQ) existe en `src/queue/ecf-processing.processor.ts:187` pero ese processor nunca recibe jobs porque nadie llama `enqueueEcfProcessing` (verificación: `grep -r enqueueEcfProcessing src/` → 1 match, la definición en `queue.service.ts:32`).

**Webhook:**
- Solo se dispara desde `EcfProcessingProcessor` (código muerto) y `StatusPollProcessor` (solo alcanzable vía contingencia).
- `InvoicesService.create` (`invoices.service.ts:55-363`) no tiene ninguna llamada a `fireWebhookEvent` o `webhooksService.dispatch`.

### 1.3 Integraciones externas

| Sistema | Dónde | Cómo |
|---|---|---|
| DGII TesteCF / CertECF / Prod | `src/xml-builder/ecf-types.ts:175-191` | URLs hardcoded por ambiente |
| DGII status service | `ecf-types.ts:221` | `https://statusecf.dgii.gov.do/...`, autenticación con `Authorization: Apikey ${DGII_STATUS_API_KEY}` (dgii.service.ts:478) |
| Certificados .p12 | `certificates.service.ts:187-208` | Carga desde PostgreSQL cifrada AES-256-GCM. NO filesystem, NO KMS real |
| BullMQ | `app.module.ts:48-62`, `queue.module.ts` | 4 queues: `ECF_PROCESSING`, `ECF_STATUS_POLL`, `WEBHOOK_DELIVERY`, `CERTIFICATE_CHECK` |
| Scheduler | `scheduler.service.ts:28-36` | `setInterval` (5min contingencia, 1h cleanup tokens) — **no `@nestjs/schedule`** |

---

## 2. Estado de cumplimiento DGII

### 2.1 Los 10 tipos e-CF

Todos los tipos están **implementados realmente** en `src/xml-builder/xml-builder.service.ts` con reglas específicas por tipo, no son mocks:

| Tipo | Código | Implementado | Evidencia |
|---|---|---|---|
| E31 Factura Crédito Fiscal | 31 | ✅ | xml-builder.service.ts:94-99, 431, 775 |
| E32 Factura Consumo | 32 | ✅ + RFCE <250K | xml-builder.service.ts:158-195 (`buildRfceXml`), invoices.service.ts:279-303 |
| E33 Nota Débito | 33 | ✅ reference required | invoices.service.ts:100-105 |
| E34 Nota Crédito | 34 | ✅ reference required | idem |
| E41 Compras | 41 | ✅ Retención obligatoria | xml-builder.service.ts:771-773 |
| E43 Gastos Menores | 43 | ✅ Comprador opcional | xml-builder.service.ts:554-556 |
| E44 Regímenes Especiales | 44 | ✅ | xml-builder.service.ts:440 |
| E45 Gubernamental | 45 | ✅ | smoke test en spec L910 |
| E46 Exportaciones | 46 | ✅ transport/info export específica | xml-builder.service.ts:1228-1340 |
| E47 Pagos Exterior | 47 | ✅ Comprador código 3, sin RNC | xml-builder.service.ts:561-597 |

**Smoke tests** "All 10 e-CF Types Smoke Test" (spec L910-L918): los 10 generan XML sin tirar. Tests de **profundidad real** sobre reglas específicas por tipo son muchos pero concentrados en E31/E32/E41/E46; E33, E34, E43, E44, E45, E47 tienen solo los smoke tests.

**Cobertura ACECF:** definida en `ecf-types.ts:56` (`ACECF_EXCLUDED_TYPES = [32,41,43,46,47]`), lo cual implica que E31, E33, E34, E44, E45 sí aplican aprobación comercial. Hay soporte de envío en `dgii.service.ts:407-432` pero **no hay endpoint público en el API para generar un ACECF outbound**; solo el endpoint inbound `POST /fe/aprobacioncomercial/api/ecf` (fe-receptor.controller.ts:247).

### 2.2 Validación XSD

- **10 XSD oficiales presentes** en `xsd/` (e-CF-31..47). No hay schemas para ARECF/ACECF/ANECF en el directorio.
- **Carga:** `src/validation/xsd-validation.service.ts:241-248` detecta schemas presentes en `process.cwd() + /xsd`. En Docker se copian vía `Dockerfile:45`.
- **Herramienta:** `xmllint` subprocess (`execFile`). Detectado en `/usr/bin/xmllint` o PATH (`xsd-validation.service.ts:228-239`).
- **Dónde se usa:** sólo en `invoices.service.ts:162-172` antes de INSERT. No se valida ARECF/ACECF/ANECF.
- **Patch bug DGII:** `xsd-validation.service.ts:254-273` parchea en caliente el bug ` IndicadorServicioTodoIncluidoType` (espacio extra).
- **Stripping namespaces:** `xsd-validation.service.ts:280-282` elimina `xmlns` antes de validar (los XSD oficiales no tienen targetNamespace). Correcto.
- **Gap:** si `xmllint` no existe, antes silenciaba; ahora **devuelve `valid: false`** con error claro (L108-118). ✅ correcto. Pero `invoices.service.ts:162` solo valida `if (this.xsdValidation.isAvailable())` — si no hay xmllint, simplemente se salta con un warning (L171). Inconsistencia entre la promesa defensiva de `XsdValidationService` y el uso débil en `InvoicesService`.

### 2.3 Firma XMLDSig

- **Librería:** **NINGUNA** dedicada. Usa `crypto` nativo de Node y una implementación casera de C14N 1.0 en `signing.service.ts:333-378`.
- **Algoritmo:** RSA-SHA256 (`signing.service.ts:243-244, 259`). Conforme a DGII ("Firmado de e-CF.pdf").
- **Digest:** SHA-256 del documento sin Signature y sin XML declaration, con "enveloped transform" regex (`signing.service.ts:232-238`).
- **Canonicalización:** regex + normalización manual (normalize line endings, expand self-closing, sort attributes, convert `'` → `"`). **No implementa:**
  - Normalización de referencias de caracteres
  - Manejo de CDATA
  - Prefix rewriting correcto si hay namespaces declarados en ancestros
  - Namespace inheritance completa
- **Key/cert:** extraídos de `.p12` con `node-forge` (`signing.service.ts:388-428`). Valida que el Subject contenga el RNC del emisor (L435-471, **error duro**). Bueno.
- **Security code:** primeros 6 hex chars del SHA-256 del `SignatureValue` base64 (L298-305).
- **FechaHoraFirma:** sólo se inserta si root es `<ECF>` (L64-69), no en `SemillaModel`, `ARECF`, `ACECF`, `ANECF` — correcto.
- **Verificación:** `verifySignedXml` (L165-222) verifica digest y RSA-SHA256. Existe pero no hay tests.

**Riesgo:** DGII rechazará cualquier XML cuyo canonicalizado difiera por un byte. La implementación casera cubre el subset usado hoy por el propio builder (auto-consistente). Pero si se recibe XML de terceros (reception flow) o cambian pequeños detalles del builder, una diferencia sutil en C14N puede invalidar la firma sin que ningún test lo detecte — **no hay test de firma contra un vector conocido de DGII**.

---

## 3. Cobertura de tests

### 3.1 Ejecución real

```
$ npm test
Test Suites: 1 passed, 1 total
Tests:       84 passed, 84 total
Time:        3.744 s
```

Confirmado: 84/84 pasan. **Pero**:

### 3.2 ¿Qué está cubierto?

Único spec: `src/xml-builder/xml-builder.service.spec.ts` (941 LoC). Cubre:
- Estructura XSD del `<ECF>` (Encabezado, Totales, DetallesItems, OtraMoneda, DescuentosORecargos, InformacionReferencia)
- E46 Exportaciones (secciones específicas)
- Cálculo de totales
- XML escaping
- RFCE `buildRfceXml` presencia de método
- Smoke test "puede generar" los 10 tipos

### 3.3 ¿Qué NO está cubierto? (gaps críticos)

| Área | Cobertura | Riesgo |
|---|---|---|
| `SigningService` (firma, C14N, P12, verificación) | 0 tests | 🔴 Alto — si C14N está mal, todo se rompe |
| `DgiiService` (HTTP, retries, parse respuestas, FC endpoints) | 0 tests | 🔴 Alto — zero unit tests, zero mocks |
| `XsdValidationService` | 0 tests | 🟡 Medio |
| `WebhooksService` / `WebhookDeliveryProcessor` (HMAC, retry, desactivación) | 0 tests | 🔴 Alto |
| Queue processors (`EcfProcessing`, `StatusPoll`, `WebhookDelivery`, `CertificateCheck`) | 0 tests | 🔴 Alto |
| `InvoicesService.create` (pipeline end-to-end) | 0 tests | 🔴 Alto — es el camino crítico |
| `ContingencyService` | 0 tests | 🟡 Medio |
| `CertificatesService` (cifrado AES-256-GCM) | 0 tests | 🟡 Medio |
| `AuthService` / `ApiKeyGuard` / JWT | 0 tests | 🔴 Alto — seguridad |
| Multi-tenancy (aislamiento por `tenantId`) | 0 tests | 🔴 Alto |
| Reception (ARECF generation, fe-receptor controller) | 0 tests | 🔴 Alto |

**No hay tests e2e.** La carpeta `test/` existe pero está vacía (`ls test/` → nada). `package.json:19` define `test:e2e` apuntando a `./test/jest-e2e.json` que no existe.

---

## 4. Deuda técnica y riesgos

### 4.1 TODOs / FIXMEs
- `grep TODO|FIXME|XXX|HACK src/` → **0 matches**. ✅

### 4.2 `any` y `@ts-ignore`
- `as any` aparece en 12 archivos (23 ocurrencias). Anotaciones `: any` / `<any>` en 22 archivos (69 ocurrencias). Los más concentrados: `reception/fe-receptor.controller.ts`, `invoices.service.ts` (6x `as any`), `dgii.service.ts` (2x `as any` + 7x `any`), `queue/certificate-check.processor.ts`.
- Hotspots a endurecer: el cast `dgiiResponse: submissionResult as any` aparece 4+ veces; tipar `DgiiSubmissionResult` en Prisma JSON elimina clase entera de bugs.

### 4.3 Cliente HTTP DGII (`src/dgii/dgii.service.ts`)

| Control | ¿Existe? | Dónde |
|---|---|---|
| Timeout | ✅ 30s | `DgiiService.HTTP_TIMEOUT_MS = 30_000` L701; `AbortController` en L710, L752, L779 |
| Retry con backoff | ⚠️ Parcial | **Solo para autenticación** (3 intentos, 2s/4s) L513-563. `submitEcf`, `submitRfce`, `queryStatus`, `sendAcecf` NO tienen retry propio. BullMQ no los envuelve (el processor es código muerto). Si DGII devuelve 502, el endpoint síncrono falla de una |
| Circuit breaker | ❌ | No existe |
| Idempotency key al DGII | ❌ | Solo idempotency local vía `idempotencyKey` (invoices.service.ts:57-65) |
| Response parsing con fallback XML↔JSON | ✅ | L586-678, múltiples formas |
| Caching token | ✅ | 55 min (expiresAt), tabla `DgiiToken` L50-87 |

**Riesgo fuerte:** el camino síncrono no reintenta el submit. Un 5xx transitorio deja la factura en `CONTINGENCY` (invoices.service.ts:349-355) y queda esperando al scheduler (5min).

### 4.4 Doble polling scheduler/BullMQ — estado

✅ **Resuelto parcialmente**. El comentario en `scheduler.service.ts:12-15` dice:
> "Individual invoice status polling is handled exclusively by BullMQ (StatusPollProcessor) with exponential backoff delays. This scheduler only handles periodic batch tasks."

El scheduler ya no consulta estados de facturas individuales. Solo corre 2 tareas: contingencia y cleanup de tokens. **Pero**:
- La afirmación "handled exclusively by BullMQ" es incorrecta en la práctica: `StatusPollProcessor` solo se enqueua desde (a) `ecf-processing.processor.ts:187` (código muerto) y (b) `contingency.service.ts:257` (solo tras re-envíos de contingencia).
- El flujo normal (`POST /invoices`) NO enqueua poll. Las facturas que retornan PROCESSING del DGII quedan huérfanas salvo que el cliente consulte manualmente.

### 4.5 Webhooks — estado

🔴 **Roto para el flujo principal.** Evidencia:
- `InvoicesService.create` (invoices.service.ts:55-363): ni `fireWebhookEvent` ni `webhooksService.dispatch` se invocan.
- `InvoicesService.pollStatus` (L368-419): ni `fireWebhookEvent` ni `webhooksService.dispatch`.
- `InvoicesService.voidInvoice` (L497-564): tampoco.

Webhooks SÍ se disparan desde:
- `reception.service.ts:69, 213` → `DOCUMENT_RECEIVED` (path inbound) vía `WebhooksService.dispatch`
- `contingency.service.ts:257` → `enqueueStatusPoll` (sin webhook directo)
- `ecf-processing.processor.ts:197-209` → `ACCEPTED/REJECTED/CONDITIONAL/ERROR` vía `queueService.fireWebhookEvent` — **pero este processor nunca recibe jobs**
- `status-poll.processor.ts:168-174` → webhooks finales — solo accesible tras contingencia

**Además: hay DUPLICACIÓN.** Dos caminos diferentes de delivery:
1. `WebhooksService.dispatch` / `WebhooksService.deliverWebhook` (`src/webhooks/webhooks.service.ts:118-151, 193-247`) — directo, headers `X-ECF-*`, retry por BD (`nextRetryAt`).
2. `QueueService.fireWebhookEvent` → `WebhookDeliveryProcessor` (`src/queue/webhook-delivery.processor.ts`) — via BullMQ, headers `X-Webhook-*`, retry por BullMQ.

Headers distintos significan que un consumidor que recibe ambos tipos tiene que implementar dos verificadores HMAC. Hay que unificarlos.

### 4.6 Secretos, credenciales, rutas hardcoded
- `DGII_ENDPOINTS` hardcodeados en `ecf-types.ts:175-191`. Correcto.
- `DGII_STATUS_SERVICE_URL` hardcodeado L221.
- `.env:19` `JWT_SECRET=your-super-secret-jwt-key-change-this-in-production` — **placeholder pegado en dev**. Además, esta misma clave encripta los .p12 (`certificates.service.ts:35-44`). Cambiar el JWT_SECRET en prod INVALIDA todos los certificados almacenados.
- `.env:11` password de DB `123` en texto plano (esperable en dev).
- No detecté rutas absolutas hardcoded a sistemas externos fuera de DGII.

---

## 5. Listo para producción — checklist real

### 5.1 Docker

- ✅ Multi-stage (deps → build → production) — `Dockerfile:7,20,33`
- ✅ Usuario no-root `ecfapi` uid/gid 1001 — `Dockerfile:39`
- ✅ Healthcheck — `Dockerfile:51`, `docker-compose.yml:92-97`
- ✅ `dumb-init` para manejo de señales — `Dockerfile:37,53`
- ✅ Node 22-slim
- ✅ `libxml2-utils` instalado (para xmllint) — `Dockerfile:37`
- ✅ XSD copiados — `Dockerfile:45`
- ✅ `npm ci` + `npm prune --production`
- ✅ Migrate en startup: `npx prisma migrate deploy && node dist/main` — `Dockerfile:54`
- ⚠️ `JWT_SECRET` con default `change-this-in-production` en compose L75 — sale a logs si se descuida
- ⚠️ PostgreSQL con `POSTGRES_PASSWORD: ${DB_PASSWORD:-postgres}` default débil

### 5.2 Variables de entorno

**`.env.example` esencialmente vacío** (`.env.example:1-2` — solo 2 líneas con BOM UTF-8 ininteligibles).

Variables reales referenciadas en código pero **faltantes de cualquier archivo ejemplo**:
| Var | Usada en |
|---|---|
| `CORS_ORIGIN` | main.ts:20 |
| `DGII_STATUS_API_KEY` | dgii.service.ts:478 |
| `JWT_EXPIRES_IN` | auth.service.ts:39 (nota: `.env` usa `JWT_EXPIRATION`) — **inconsistencia** |
| `AWS_REGION`/`AWS_KMS_KEY_ID`/`AWS_S3_BUCKET` | configuration.ts:45-47 — definidas pero sin uso real |
| `DB_PASSWORD`, `DB_PORT`, `NODE_ENV`, `PORT`, `API_PREFIX` | docker-compose.yml |

**Inconsistencia `JWT_EXPIRES_IN` vs `JWT_EXPIRATION`:**
- `.env:20` define `JWT_EXPIRATION=24h`
- `configuration.ts:18` lee `JWT_EXPIRATION`
- `auth.service.ts:39` lee **`JWT_EXPIRES_IN`** → siempre usa default `24h`

### 5.3 Observabilidad

| Item | Estado |
|---|---|
| Logging estructurado (pino/winston) | ❌ `pino` instalado, nunca importado. Usa `Logger` de NestJS (texto plano) |
| Métricas (Prometheus/OpenTelemetry) | ❌ |
| Tracing distribuido | ❌ |
| Healthcheck | ✅ `/api/v1/health` (solo pinguea DB) — `health.controller.ts` |
| Audit log en BD | ✅ `AuditLog` model, `createAuditLog` en invoices/contingency |
| Queue stats endpoint | ⚠️ `QueueService.getQueueStats` L108-117 existe pero no lo expone ningún controller |

### 5.4 Base de datos

Migraciones en `prisma/migrations/`:
- `20260207012649_init`
- `20260207045620_add_signing_rfce_anecf`
- `20260207045919_add_signing_rfce_anecf` ← **duplicado del anterior (mismo nombre, timestamp diferente)**
- `20260207162453_add_password_hash`
- `add_buyers` (sin timestamp prefix — NO sigue convención Prisma, va a fallar con `prisma migrate diff`)
- `add_received_documents` (idem)
- `migration_lock.toml`

🔴 **Problema real:** `add_buyers` y `add_received_documents` **no llevan timestamp de Prisma**. `prisma migrate deploy` los aplicará en orden lexicográfico, pero cualquier `migrate dev` los verá como "edited manually". Hay que renombrarlos al formato estándar.

Reversibilidad: **no hay down migrations** (Prisma no las genera por default). Rollback implica escribir SQL a mano.

### 5.5 Seguridad

- ✅ Helmet (main.ts:18)
- ⚠️ CORS `origin: '*'` por default (main.ts:20) — **en prod hay que fijarlo**
- ✅ `ValidationPipe` global con `whitelist + forbidNonWhitelisted + transform` (main.ts:30-37)
- ✅ Rate limiting `@nestjs/throttler` — 60 req/min default (app.module.ts:34-45)
- ✅ ApiKeyGuard + JWT dual (api-key.guard.ts:25-56). API keys con prefix + bcrypt hash + scopes (api-key.guard.ts:99-146)
- ✅ Multi-tenancy: todas las tablas tienen `tenantId` con índice (`schema.prisma:122, 154, 194, 219, 245, 323, 356, 380, 398, 424, 445, 466, 499`). Servicios filtran por `tenantId` correctamente.
- ⚠️ Clave de cifrado de certificados derivada del mismo `JWT_SECRET` — dos preocupaciones acopladas
- ⚠️ Autorización `?auth=` query param para descargas (api-key.guard.ts:30-46) — el token queda en logs de web servers/proxies y history del browser. **Riesgo de leak**.

---

## 6. Bloqueantes conocidos — verificación

### 6.1 Integración con certificado .p12 real

- **Carga:** base64 vía `POST /companies/:companyId/certificates` (`certificates.controller.ts`), NO filesystem ni KMS — `certificates.service.ts:52-126`.
- **Storage:** PostgreSQL `certificates.encryptedP12` (bytea en Prisma), AES-256-GCM con IV+authTag prefixes — `certificates.service.ts:296-318`.
- **Validación al cargar:** parsea con `node-forge`, extrae metadata real (fingerprint, issuer, subject, validity). Si la contraseña es mala, lanza `BadRequestException` con mensaje claro — `certificates.service.ts:222-230`.
- **Uso en firma:** `getDecryptedCertificate` devuelve `{p12Buffer, passphrase}` y pasa a `extractFromP12` que a su vez valida `SN/CN == RNC emisor` (signing.service.ts:435-471 — **error duro si no coincide**).
- **Rotación:** 
  - Manual: al subir nuevo, desactiva el anterior (`updateMany isActive: false` L90-93).
  - Alerta: solo warning si quedan ≤30 días (`getActive` L152-160). No hay job proactivo que avise por email/webhook.
  - **`CertificateCheckProcessor` existe (`src/queue/certificate-check.processor.ts`) pero `scheduleCertificateCheck` NO tiene llamador conocido fuera de la definición en `queue.service.ts:94`.** Otra pieza programada pero desconectada.
- **No hay integración real con KMS/S3**, a pesar de las vars `AWS_KMS_KEY_ID` en `configuration.ts:44-48`. Los comentarios "In production, this would use AWS KMS" en `certificates.service.ts:29, 50` son placeholders.

### 6.2 Endpoints públicos generando XML firmados válidos (para Step 1 certificación DGII)

Endpoints con guardas (`ApiKeyGuard` + scopes) que producen XML firmado:

| Método | Ruta | Scope | Qué hace |
|---|---|---|---|
| POST | `/api/v1/invoices` | `INVOICES_WRITE` | Firma + envía e-CF a DGII — invoices.controller.ts:38-43 |
| POST | `/api/v1/invoices/:id/poll` | `INVOICES_WRITE` | Consulta estado — pollStatus |
| POST | `/api/v1/invoices/:id/void` | `INVOICES_WRITE` | Anula (solo DRAFT/ERROR/CONTINGENCY/REJECTED) |
| GET | `/api/v1/invoices/:id/xml` | `INVOICES_READ` | Descarga XML firmado o sin firmar |
| POST | `/api/v1/sequences` | | Crea secuencias — sequences.controller.ts:25 |
| POST | `/api/v1/sequences/:companyId/annul` | | Genera y firma ANECF — sequences.controller.ts:57 |
| POST | `/api/v1/contingency/:invoiceId/retry` | | Re-envía — contingency.controller.ts:30 |
| POST | `/api/v1/fe/recepcion/api/ecf` | | **Entrada inbound** — fe-receptor.controller.ts:123 — genera ARECF firmado |
| POST | `/api/v1/fe/aprobacioncomercial/api/ecf` | | **Entrada inbound** — fe-receptor.controller.ts:247 |
| GET | `/api/v1/fe/autenticacion/api/semilla` | | Endpoint inbound de semilla — fe-receptor.controller.ts:60 |

El prefijo `api/v1` viene de `main.ts:26`. En Docker `EXPOSE 3000`.

---

## 7. Honestidad — cosas que parecen implementadas pero son frágiles

1. **BullMQ queues completas y documentadas → solo una ruta las usa (contingencia).** Los 4 processors existen, 4 queues registradas, `QueueService` con todos los métodos. Pero `EcfProcessing` y `CertificateCheck` no tienen productores en código. Es deuda fantasma: parece arquitectura asíncrona, es síncrona.
2. **Comentario en `EcfProcessingProcessor:30-31`** habla de "XAdES-BES" pero la firma es XMLDSig plain (sin `xades:QualifyingProperties`, sin `SigningTime`, sin `SigningCertificate` estructurado). DGII pide XMLDSig simple, correcto; el comentario confunde.
3. **`signingService.verifySignedXml`** (signing.service.ts:165-222) se escribe por completeness pero **no hay caller** en el código. Pura dependencia sin consumidor.
4. **`.env.example`** (1 línea con BOM + 1 espacio) es engañoso: sugiere que hay plantilla cuando no hay nada.
5. **`pino` / `pino-pretty` en `package.json`** (deps) — **nunca se importan**. Es un costo de build sin beneficio.
6. **`WebhooksService.dispatch` vs `WebhookDeliveryProcessor`** — dos implementaciones paralelas con headers distintos (`X-ECF-Signature` vs `X-Webhook-Signature`). Un receptor cliente tiene que verificar dos HMAC para ser robusto.
7. **`dgii.service.ts:772-799` define `httpPost`** genérico — **nunca usado**. Dead code.
8. **Migraciones Prisma mal nombradas:** `add_buyers` y `add_received_documents` carecen de timestamp prefix. Romperán `migrate dev` en CI.
9. **`extractTrackId` duplica lógica con `parseSubmissionResponse`** (dgii.service.ts:608-618 vs 586-606). Redundante.
10. **`JWT_EXPIRES_IN` vs `JWT_EXPIRATION`** — auth.service lee una, config y .env usan otra. Silently siempre usa default. Bug real.
11. **Scheduler usa `setInterval` sin lock distribuido.** Con 2+ réplicas, cleanup de tokens y retry de contingencia se duplicarán.

---

## 8. Recomendaciones priorizadas

### Top 5 ANTES de producción (ordenadas, con esfuerzo)

| # | Acción | Esfuerzo | Justificación |
|---|---|---|---|
| 1 | **Conectar el pipeline asíncrono real**: hacer que `POST /invoices` enqueue en `EcfProcessing` y responda 202 con status DRAFT/QUEUED; mover toda la lógica sincrónica de `InvoicesService.create` que hoy corre en request time al processor. Y disparar webhooks desde el processor, que ya tiene el código. | **3–5 días** | Hoy el camino feliz bloquea la petición HTTP por ~1–5s en firma+DGII+validación, sin retry automático y sin webhook |
| 2 | **Escribir tests de firma** con vectores conocidos (XML + `.p12` test de DGII) y tests de verificación round-trip (sign → verify). Mínimo 20 tests para `SigningService` cubriendo C14N, enveloped transform, certificate SN mismatch, key formats | **2–3 días** | La C14N casera es el punto más frágil del sistema; sin tests no hay forma de detectar regresiones sutiles |
| 3 | **Completar `.env.example`** con TODAS las variables reales y un `config.validation.ts` con `joi` o `zod` que falle al arranque si falta algo crítico (`JWT_SECRET`, `DATABASE_URL`, `REDIS_*`, `DGII_ENVIRONMENT`). Corregir `JWT_EXPIRES_IN`/`JWT_EXPIRATION` y renombrar migraciones rotas | **1 día** | Deploy seguro; hoy es un campo minado |
| 4 | **Unificar webhooks en UNA sola ruta (BullMQ `WebhookDeliveryProcessor`)** con headers consistentes. Eliminar `WebhooksService.dispatch` directo y redirigirlo también al queue. Tests HMAC + retry | **1–2 días** | Dos implementaciones paralelas garantizan divergencia y confusión del integrador |
| 5 | **Desacoplar cifrado de certificado del `JWT_SECRET`** — nueva var `CERT_ENCRYPTION_KEY` (32 bytes aleatorios, derivada o directa). Plan de migración: re-cifrar registros existentes. Documentar que rotar `CERT_ENCRYPTION_KEY` exige re-upload de certificados | **1 día** | Rotar `JWT_SECRET` (algo normal) hoy destruye toda la pila de certificados; acoplamiento peligroso |

### Top 5 riesgos si sale hoy tal cual

| # | Riesgo | Impacto | Probabilidad |
|---|---|---|---|
| 1 | **Cliente crea factura → DGII responde 503/timeout transitorio → factura queda en CONTINGENCY, usuario recibe error 500. El scheduler la reintenta en 5 min, pero no hay webhook avisando el estado final ni al cliente ni a NewPlain.** | 🔴 Alto | Muy alta — los 5xx de DGII son frecuentes |
| 2 | **Firma XMLDSig rechazada por DGII por diferencia de bytes en C14N** (ej.: char de namespace no manejado, atributo con comilla simple, orden inesperado). Sin tests con vectores reales no se detecta hasta producción. | 🔴 Alto | Media |
| 3 | **Rotación de `JWT_SECRET` en incident response → invalidar tokens también destruye acceso a todos los .p12 de todos los tenants.** Irrecuperable sin backup fuera de la BD. | 🔴 Alto | Baja pero catastrófica |
| 4 | **Scheduler duplicado con múltiples réplicas**: cada pod corre los `setInterval`, reprocesando contingencia en paralelo → race conditions sobre el mismo registro, posible re-envío doble a DGII, trackId duplicado, orden de estados comprometido. | 🟡 Medio | Alta apenas haya replicación |
| 5 | **`CORS: '*'` por default + descargas con `?auth=<token>` en query string** → tokens en logs de reverse proxy y history. Si se olvida setear `CORS_ORIGIN` (no está en `.env.example`), cualquier origen puede consumir el API desde el browser del atacante con un token fugado. | 🟡 Medio | Alta — omisión común |

---

## Apéndice — Comandos usados para este análisis

```bash
npm test                                                    # 84/84 passing
grep -r "TODO\|FIXME\|XXX\|HACK" src/                       # 0 matches
grep -r "enqueueEcfProcessing" src/                         # solo la definición
grep -r "fireWebhookEvent\|webhooksService.dispatch" src/   # mapeado en §4.5
ls prisma/migrations                                        # 6 dirs + migration_lock.toml
ls test/                                                    # (empty)
```
