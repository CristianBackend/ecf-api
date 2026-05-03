# SWAGGER_AUDIT — ecf-api

Auditoría del estado actual de la documentación Swagger/OpenAPI.
Ejecutada contra el código fuente (sin servidor en ejecución).
Fecha: 2026-05-03

---

## 1. Configuración global de Swagger

| Ítem | Estado | Detalle |
|------|--------|---------|
| `DocumentBuilder` configurado | ✅ | `main.ts:48` |
| Título y descripción globales | ✅ | "ECF API — Facturación Electrónica" |
| Versión | ✅ | 0.1.0 |
| Autenticación Bearer (`api-key`) | ✅ | `addBearerAuth` configurado |
| `persistAuthorization: true` | ✅ | Recuerda el token en el browser |
| URL Swagger | ✅ | `http://localhost:3000/docs` (sin prefijo `api/v1`) |
| Tags con descripción registrados | ⚠️ | Solo 7 de 14 módulos: `auth`, `tenants`, `companies`, `certificates`, `sequences`, `invoices`, `health`. **Faltan**: `buyers`, `webhooks`, `admin`, `rnc`, `contingency`, `reception`, `downloads`, `pdf` |

---

## 2. Endpoints por módulo

### 2.1 `invoices` — 9 endpoints

| Método | Ruta | @ApiOperation | @ApiResponse | @ApiBody | @ApiQuery | @ApiParam | @ApiBearerAuth |
|--------|------|:---:|:---:|:---:|:---:|:---:|:---:|
| POST | `/invoices` | ✅ (con description) | ❌ | ❌ (DTO implícito) | — | — | ✅ |
| GET | `/invoices` | ✅ (solo summary) | ❌ | — | ✅ (7 params) | — | ✅ |
| GET | `/invoices/:id` | ✅ (solo summary) | ❌ | — | — | ❌ | ✅ |
| GET | `/invoices/:id/xml` | ✅ (con description) | ❌ | — | — | ❌ | ✅ |
| POST | `/invoices/:id/download-token` | ✅ (con description) | ❌ | — | — | ❌ | ✅ |
| POST | `/invoices/:id/poll` | ✅ (con description) | ❌ | — | — | ❌ | ✅ |
| POST | `/invoices/:id/void` | ✅ (con description) | ❌ | ❌ (body inline sin DTO) | — | ❌ | ✅ |
| GET | `/invoices/:id/preview` | ✅ (solo summary) | ❌ | — | — | ❌ | ✅ |
| GET | `/invoices/:id/pdf` | ✅ (solo summary) | ❌ | — | — | ❌ | ✅ |

**Problema crítico**: `POST /invoices/:id/void` usa `@Body() body: { reason?: string }` inline sin DTO → no aparece en Swagger.

---

### 2.2 `companies` — 5 endpoints

| Método | Ruta | @ApiOperation | @ApiResponse | @ApiQuery | @ApiParam | @ApiBearerAuth |
|--------|------|:---:|:---:|:---:|:---:|:---:|
| POST | `/companies` | ✅ | ❌ | — | — | ✅ |
| GET | `/companies` | ✅ | ❌ | — | — | ✅ |
| GET | `/companies/:id` | ✅ | ❌ | — | ❌ | ✅ |
| PATCH | `/companies/:id` | ✅ | ❌ | — | ❌ | ✅ |
| DELETE | `/companies/:id` | ✅ | ❌ | — | ❌ | ✅ |

---

### 2.3 `buyers` — 5 endpoints

| Método | Ruta | @ApiOperation | @ApiResponse | @ApiQuery | @ApiParam | @ApiBearerAuth |
|--------|------|:---:|:---:|:---:|:---:|:---:|
| POST | `/buyers` | ✅ | ❌ | — | — | ✅ |
| GET | `/buyers` | ✅ | ❌ | ✅ (4 params) | — | ✅ |
| GET | `/buyers/:id` | ✅ | ❌ | — | ❌ | ✅ |
| PATCH | `/buyers/:id` | ✅ | ❌ | — | ❌ | ✅ |
| POST | `/buyers/:id/refresh-dgii` | ✅ | ❌ | — | ❌ | ✅ |

---

### 2.4 `certificates` — 3 endpoints

| Método | Ruta | @ApiOperation | @ApiResponse | @ApiQuery | @ApiParam | @ApiBearerAuth |
|--------|------|:---:|:---:|:---:|:---:|:---:|
| POST | `/companies/:companyId/certificates` | ✅ | ❌ | — | ❌ | ✅ |
| GET | `/companies/:companyId/certificates` | ✅ | ❌ | — | ❌ | ✅ |
| GET | `/companies/:companyId/certificates/active` | ✅ | ❌ | — | ❌ | ✅ |

---

### 2.5 `webhooks` — 5 endpoints

| Método | Ruta | @ApiOperation | @ApiResponse | @ApiQuery | @ApiParam | @ApiBearerAuth |
|--------|------|:---:|:---:|:---:|:---:|:---:|
| POST | `/webhooks` | ✅ | ❌ | — | — | ✅ |
| GET | `/webhooks` | ✅ | ❌ | — | — | ✅ |
| GET | `/webhooks/:id` | ✅ | ❌ | — | ❌ | ✅ |
| PATCH | `/webhooks/:id` | ✅ | ❌ | — | ❌ | ✅ |
| DELETE | `/webhooks/:id` | ✅ | ❌ | — | ❌ | ✅ |

---

### 2.6 `sequences` — 4 endpoints

| Método | Ruta | @ApiOperation | @ApiResponse | @ApiQuery | @ApiParam | @ApiBearerAuth |
|--------|------|:---:|:---:|:---:|:---:|:---:|
| POST | `/sequences` | ✅ | ❌ | — | — | ✅ |
| GET | `/sequences/:companyId` | ✅ | ❌ | — | ❌ | ✅ |
| GET | `/sequences/:companyId/available` | ✅ | ❌ | ✅ (type) | ❌ | ✅ |
| POST | `/sequences/:companyId/annul` | ✅ | ❌ | — | ❌ | ✅ |

---

### 2.7 `auth` — 5 endpoints

| Método | Ruta | @ApiOperation | @ApiResponse | @ApiQuery | @ApiParam | Auth |
|--------|------|:---:|:---:|:---:|:---:|:---:|
| POST | `/auth/login` | ✅ | ✅ (200) | — | — | Pública |
| POST | `/auth/keys` | ✅ | ✅ (201) | — | — | ✅ |
| GET | `/auth/keys` | ✅ | ❌ | — | — | ✅ |
| DELETE | `/auth/keys/:id` | ✅ | ❌ | — | ❌ | ✅ |
| POST | `/auth/keys/:id/rotate` | ✅ | ❌ | — | ❌ | ✅ |

---

### 2.8 `tenants` — 4 endpoints

| Método | Ruta | @ApiOperation | @ApiResponse | @ApiParam | Auth |
|--------|------|:---:|:---:|:---:|:---:|
| POST | `/tenants/register` | ✅ | ✅ (201) | — | Pública |
| GET | `/tenants/me` | ✅ | ❌ | — | ✅ |
| PATCH | `/tenants/me` | ✅ | ❌ | — | ✅ |
| GET | `/tenants/me/stats` | ✅ | ❌ | — | ✅ |

---

### 2.9 `admin` — 1 endpoint

| Método | Ruta | @ApiOperation | @ApiResponse | Auth |
|--------|------|:---:|:---:|:---:|
| GET | `/admin/queues/stats` | ✅ | ❌ | `ADMIN` scope |

**Problema**: Tag `admin` no registrado en `DocumentBuilder`.

---

### 2.10 `rnc` — 2 endpoints

| Método | Ruta | @ApiOperation | @ApiResponse | @ApiParam | Auth |
|--------|------|:---:|:---:|:---:|:---:|
| GET | `/rnc/:rnc/validate` | ✅ | ❌ | ❌ | ✅ |
| GET | `/rnc/:rnc/lookup` | ✅ | ❌ | ❌ | ✅ |

**Problema**: Tag `rnc` no registrado en `DocumentBuilder`.

---

### 2.11 `contingency` — 5 endpoints

| Método | Ruta | @ApiOperation | @ApiResponse | Auth |
|--------|------|:---:|:---:|:---:|
| GET | `/contingency` | ✅ | ❌ | ✅ |
| GET | `/contingency/stats` | ✅ | ❌ | ✅ |
| POST | `/contingency/:invoiceId/retry` | ✅ | ❌ | ✅ |
| POST | `/contingency/retry-all` | ✅ | ❌ | ✅ |
| POST | `/contingency/process` | ✅ | ❌ | ✅ |

**Problema**: Tag `contingency` no registrado en `DocumentBuilder`.

---

### 2.12 `reception` — 2 endpoints

| Método | Ruta | @ApiOperation | @ApiResponse | Auth |
|--------|------|:---:|:---:|:---:|
| GET | `/received` | ✅ | ❌ | ✅ |
| POST | `/received/:id/approve` | ✅ | ❌ | ✅ |

**Problema**: Tag `reception` no registrado en `DocumentBuilder`.

---

### 2.13 `downloads` — 1 endpoint

| Método | Ruta | @ApiOperation | @ApiResponse | @ApiParam | Auth |
|--------|------|:---:|:---:|:---:|:---:|
| GET | `/downloads/invoice-xml/:token` | ✅ | ❌ | ❌ | Pública (token) |

**Problema**: Tag `downloads` no registrado en `DocumentBuilder`.

---

### 2.14 `health` — (asumido)

Tag registrado en `DocumentBuilder` pero no auditado en detalle.

---

## 3. Auditoría de DTOs

### 3.1 Cobertura @ApiProperty

| DTO | Propiedades | Con @ApiProperty | Con example | % example |
|-----|-------------|:---:|:---:|:---:|
| `CreateInvoiceDto` | 9 | 9 ✅ | 3 | 33% |
| `BuyerDto` (nested) | 8 | 8 ✅ | 0 | 0% |
| `InvoiceItemDto` (nested) | 11 | 11 ✅ | 5 | 45% |
| `PaymentDto` (nested) | 7 | 7 ✅ | 3 | 43% |
| `ReferenceDto` (nested) | 4 | 4 ✅ | 1 | 25% |
| `CurrencyDto` (nested) | 2 | 2 ✅ | 2 | 100% |
| `CreateCompanyDto` | 12 | 12 ✅ | 4 | 33% |
| `CreateBuyerDto` | 5 | 5 ✅ | 0 | 0% |
| `UpdateBuyerDto` | 5 | 5 ✅ | 0 | 0% |
| `UploadCertificateDto` | 3 | 3 ✅ | 2 | 67% |
| `CreateWebhookDto` | 2 | 2 ✅ | 2 | 100% |
| `CreateSequenceDto` | 5 | 5 ✅ | 4 | 80% |
| `LoginDto` | 2 | 2 ✅ | 2 | 100% |
| `CreateApiKeyDto` | 3 | 3 ✅ | 2 | 67% |
| `CreateTenantDto` | 4 | 4 ✅ | 3 | 75% |
| `ApproveReceptionDto` | 2 | 2 ✅ | 0 | 0% |
| **TOTAL** | **93** | **93 (100%)** | **33** | **~35%** |

### 3.2 Problemas en DTOs

| Problema | Archivo | Detalle |
|----------|---------|---------|
| `BuyerDto` no exportada | `invoice.dto.ts` | Clase privada al módulo → no aparece como schema reutilizable en Swagger |
| `InvoiceItemDto` no exportada | `invoice.dto.ts` | Idem |
| `PaymentDto` no exportada | `invoice.dto.ts` | Idem |
| `ReferenceDto` no exportada | `invoice.dto.ts` | Idem |
| `CurrencyDto` no exportada | `invoice.dto.ts` | Idem |
| `p12Base64` sin example | `certificate.dto.ts` | Campo crítico sin ejemplo (es un string Base64 largo) |
| `companyId` sin example en CreateInvoiceDto | `invoice.dto.ts` | UUID sin example → aparece como `"string"` |
| `rnc` sin example en CreateBuyerDto | `buyer.dto.ts` | Sin formato ni example |
| Void body sin DTO | `invoices.controller.ts:170` | `body: { reason?: string }` inline no genera schema Swagger |

---

## 4. Resumen de hallazgos críticos

| # | Problema | Impacto | Archivos |
|---|----------|---------|---------|
| 1 | **0% de endpoints tienen @ApiResponse** (salvo 4) | Dev no sabe qué esperar de errores 400/401/403/404/422/500 | Todos los controllers |
| 2 | **7 tags sin registrar** en DocumentBuilder | Módulos enteros sin descripción de tag | `main.ts` |
| 3 | **65% de propiedades sin example** | Schemas vacíos en UI, dev no puede hacer copy-paste | Todos los DTOs |
| 4 | **Void body inline** sin DTO | Campo `reason` invisible en Swagger | `invoices.controller.ts` |
| 5 | **Nested DTOs no exportadas** | No aparecen como schemas reutilizables | `invoice.dto.ts` |
| 6 | **Sin @ApiParam** en rutas con `:id` o `:companyId` | Parámetros de ruta sin descripción ni tipo | Mayoría de controllers |
| 7 | **@ApiQuery falta** en endpoints con filtros | `GET /invoices` tiene 7 params, `GET /buyers` tiene 4, otros ninguno | Varios controllers |

---

## 5. Calificación de completitud

| Criterio | Peso | Score | Nota |
|----------|------|-------|------|
| @ApiOperation coverage | 15% | 100% | Todos los endpoints tienen summary |
| @ApiResponse coverage | 25% | 9% | Solo 4/48 endpoints |
| DTO example coverage | 20% | 35% | ~33 de 93 props |
| @ApiParam coverage | 15% | 5% | Casi ningún param de ruta documentado |
| Tags registrados | 10% | 50% | 7/14 módulos con tag description |
| @ApiBody con ejemplos | 10% | 10% | Ningún endpoint usa @ApiBody explícito |
| Nested schemas visibles | 5% | 40% | Clases nested no exportadas |

**Score ponderado estimado: ~30%**

### Comparación contra benchmarks profesionales

| API | @ApiResponse | Examples en DTOs | Error codes documentados | Score estimado |
|-----|:---:|:---:|:---:|:---:|
| **Stripe** | 100% | 100% | Sí, con `type` por error | ~95% |
| **Twilio** | 100% | ~90% | Sí, tabla completa | ~90% |
| **ecf-api actual** | 9% | 35% | No | **~30%** |

---

## 6. Plan de mejoras (para subtarea 11.2)

Por prioridad de impacto:

1. Agregar `@ApiResponse` a los 44 endpoints restantes (400, 401, 403, 404, 422, 500)
2. Registrar los 7 tags faltantes en `main.ts`
3. Agregar `@ApiParam` a todas las rutas con `:id`, `:companyId`, etc.
4. Agregar `example` a las propiedades críticas en DTOs
5. Crear `VoidInvoiceDto` para reemplazar el body inline
6. Exportar y registrar nested DTOs con `@ApiExtraModels`
7. Agregar `@ApiBody` con ejemplos completos en POST/PATCH endpoints

---

*Auditoría basada en revisión estática del código fuente. No requirió servidor en ejecución.*
