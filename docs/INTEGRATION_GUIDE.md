# Manual del Integrador — ECF API

Guía completa para integrar ecf-api en tu sistema. Dirigida a desarrolladores de empresas cliente que quieran emitir facturas electrónicas (e-CF) en República Dominicana.

---

## 1. ¿Qué es ecf-api?

ecf-api es una plataforma SaaS que abstrae toda la complejidad de la **facturación electrónica (e-CF)** requerida por la Dirección General de Impuestos Internos (DGII) de República Dominicana. Expone una API REST moderna que permite a cualquier sistema ERP, POS o plataforma de e-commerce emitir comprobantes fiscales electrónicos sin necesidad de implementar el estándar XMLDSig, el protocolo SOAP de la DGII, ni el manejo de certificados digitales.

La plataforma soporta los **10 tipos de e-CF** reconocidos por la DGII (E31–E47), maneja la firma digital de los XML, el envío al sistema DGII, el polling de estado, y notifica los resultados vía webhooks. También genera la Representación Impresa (RI) en PDF para entregar al cliente final.

Está diseñada para **multi-tenancy**: una sola instancia de ecf-api puede servir a múltiples empresas integradoras, cada una con sus propias empresas emisoras, certificados, secuencias y API keys.

---

## 2. Arquitectura general

### Flujo de emisión de una factura

```
Tu sistema (ERP/POS)
        │
        │  POST /invoices  (JSON)
        ▼
  ┌─────────────┐
  │  ecf-api    │  1. Valida JSON
  │  (NestJS)   │  2. Asigna eNCF
  │             │  3. Genera XML
  │             │  4. Guarda en DB
  │             │  5. Encola job
  └──────┬──────┘
         │ 202 ACCEPTED (status=QUEUED)
         │
         ▼ (background)
  ┌─────────────┐
  │   BullMQ    │
  │  (Redis)    │
  └──────┬──────┘
         │
         ▼
  ┌─────────────┐
  │  Processor  │  1. Firma XML (XMLDSig + .p12)
  │             │  2. Envía a DGII (SOAP)
  │             │  3. Guarda TrackId
  │             │  4. Polling DGII (~5s)
  └──────┬──────┘
         │
         ▼
  ┌─────────────┐
  │    DGII     │  Respuesta: ACCEPTED / REJECTED / CONDITIONAL
  └──────┬──────┘
         │
         ▼
  ┌─────────────┐
  │  Webhook    │  POST a tu URL con evento + HMAC
  └─────────────┘
```

### Multi-tenancy

Cada **tenant** es una empresa integradora (tu empresa) que puede gestionar múltiples **empresas emisoras** (tus clientes). Cada empresa emisora tiene su propio certificado .p12, sus secuencias de eNCF y sus configuraciones.

La autenticación es por **API key** a nivel de tenant. Cada API key puede tener scopes limitados (ej: solo `INVOICES_READ`).

### Modelo de certificado DGII

El certificado `.p12` que usa ecf-api para firmar facturas debe ser el **certificado de firma electrónica del representante autorizado** de la empresa emisora (cédula del delegado DGII). Este certificado lo emite un proveedor autorizado por DGII (INDOTEL). ecf-api lo almacena cifrado con AES-GCM.

---

## 3. Onboarding de una empresa cliente

Pasos completos para que una empresa pueda emitir su primera factura.

### Paso 1 — Crear cuenta (tenant)

```bash
curl -X POST https://api.ecf.tudominio.com/api/v1/tenants/register \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Mi Empresa Integradora",
    "email": "admin@miempresa.com",
    "password": "Password123!"
  }'
```

Respuesta:
```json
{
  "success": true,
  "data": {
    "id": "tenant-uuid",
    "name": "Mi Empresa Integradora",
    "testApiKey": "ecf_test_aBcDeFgHiJkLmNoPqRsTuVw",
    "liveApiKey": "ecf_live_XyZ123456AbCdEfGhIjKlM"
  }
}
```

> Guarda ambas API keys en un lugar seguro. El valor completo no se vuelve a mostrar.

### Paso 2 — Registrar empresa emisora

```bash
curl -X POST https://api.ecf.tudominio.com/api/v1/companies \
  -H "X-API-Key: ecf_test_..." \
  -H "Content-Type: application/json" \
  -d '{
    "rnc": "130000001",
    "businessName": "Empresa Cliente SRL",
    "address": "Av. Winston Churchill 1099, Santo Domingo",
    "phone": "809-555-0100",
    "email": "contabilidad@empresa.com",
    "dgiiEnv": "DEV"
  }'
```

Guarda el `id` de la empresa (`company_id`).

### Paso 3 — Subir certificado .p12

Convertir el certificado a Base64 primero:

```bash
# macOS / Linux
base64 -i certificado.p12

# Windows PowerShell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("certificado.p12"))
```

```bash
curl -X POST https://api.ecf.tudominio.com/api/v1/companies/{{company_id}}/certificates \
  -H "X-API-Key: ecf_test_..." \
  -H "Content-Type: application/json" \
  -d '{
    "companyId": "{{company_id}}",
    "p12Base64": "MIIKDgIBAzCCCcoGCSqG...",
    "passphrase": "password-del-certificado"
  }'
```

### Paso 4 — Crear secuencias de eNCF

Debes solicitar la autorización de secuencias a la DGII primero (OFV — Oficina Virtual). Una vez autorizado, regístralas:

```bash
curl -X POST https://api.ecf.tudominio.com/api/v1/sequences \
  -H "X-API-Key: ecf_test_..." \
  -H "Content-Type: application/json" \
  -d '{
    "companyId": "{{company_id}}",
    "ecfType": "E31",
    "startNumber": 1,
    "endNumber": 10000,
    "expiresAt": "2027-12-31T23:59:59.000Z"
  }'
```

Repetir para cada tipo de e-CF que la empresa necesite emitir.

### Paso 5 — Configurar webhook

```bash
curl -X POST https://api.ecf.tudominio.com/api/v1/webhooks \
  -H "X-API-Key: ecf_test_..." \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://tu-sistema.com/webhooks/ecf",
    "events": ["invoice.accepted", "invoice.rejected", "invoice.contingency"]
  }'
```

> Guarda el `secret` de la respuesta para verificar las firmas HMAC.

### Paso 6 — Crear API key de producción con scopes mínimos

```bash
curl -X POST https://api.ecf.tudominio.com/api/v1/auth/keys \
  -H "X-API-Key: ecf_test_..." \
  -H "Content-Type: application/json" \
  -d '{
    "name": "ERP Producción",
    "isLive": true,
    "scopes": ["INVOICES_WRITE", "INVOICES_READ", "COMPANIES_READ"]
  }'
```

---

## 4. Emisión de la primera factura

### Quickstart en 5 pasos

1. Completar el onboarding (sección 3)
2. Preparar el body del request con los datos de la factura
3. Hacer `POST /invoices` — recibirás `202 QUEUED`
4. Esperar el webhook `invoice.accepted` en tu URL (3–10 segundos)
5. Si el webhook no llega, hacer `POST /invoices/{id}/poll`

### Ejemplo curl completo — E31 Factura con Valor Fiscal

```bash
curl -X POST https://api.ecf.tudominio.com/api/v1/invoices \
  -H "X-API-Key: ecf_live_..." \
  -H "Content-Type: application/json" \
  -d '{
    "companyId": "uuid-de-tu-empresa",
    "ecfType": "E31",
    "buyer": {
      "rnc": "131793916",
      "name": "EMPRESA COMPRADORA SRL",
      "type": 1
    },
    "items": [
      {
        "description": "Servicio de desarrollo de software",
        "quantity": 1,
        "unitPrice": 50000,
        "itbisRate": 18
      }
    ],
    "payment": {
      "type": 1,
      "method": 2
    },
    "idempotencyKey": "1746273600000-INV-001"
  }'
```

### Respuesta inmediata (202 ACCEPTED)

```json
{
  "success": true,
  "data": {
    "id": "clng9x0010000vwc0l5s1234",
    "ecfType": "E31",
    "encf": "E310000000001",
    "status": "QUEUED",
    "totalAmount": 59000,
    "itbisAmount": 9000,
    "createdAt": "2026-05-03T12:00:00.000Z"
  }
}
```

### Webhook recibido ~5 segundos después

```json
{
  "event": "invoice.accepted",
  "tenantId": "tenant-uuid",
  "data": {
    "id": "clng9x0010000vwc0l5s1234",
    "encf": "E310000000001",
    "status": "ACCEPTED",
    "trackId": "DGII-TRACK-12345",
    "acceptedAt": "2026-05-03T12:00:05.000Z"
  }
}
```

---

## 5. Tipos de e-CF

| Tipo | Nombre | Cuándo usarlo |
|------|--------|---------------|
| **E31** | Factura con Valor Fiscal | Venta a empresa con RNC registrado (crédito fiscal). RNC del comprador **obligatorio**. |
| **E32** | Consumidor Final | Venta a persona sin RNC. Monto total **< RD$250,000** (si supera, usar E31 aunque no tengan RNC). |
| **E33** | Nota de Débito | Incremento de monto sobre factura existente. Requiere campo `reference` con el eNCF original. |
| **E34** | Nota de Crédito | Reducción/anulación de factura existente. Requiere `reference`. Usar para facturas ACCEPTED (no void). |
| **E41** | Gastos Menores | Registrar compras a personas naturales o informales (gastos de caja chica). |
| **E43** | Regímenes Especiales | Para empresas en zonas francas u otros regímenes especiales de tributación. |
| **E44** | Gubernamental | Venta a entidades del Estado (ministerios, ayuntamientos, etc.). |
| **E45** | Comprobante de Compras | Registrar compras formales para deducción de ITBIS. RNC del vendedor obligatorio. |
| **E46** | Exportación | Venta al exterior. Comprador tipo 3 (Extranjero). ITBIS 0%. Usar campo `currency`. |
| **E47** | Pagos al Exterior | Servicios comprados fuera del país (licencias, suscripciones, etc.). Usar `currency`. |

### Reglas especiales por tipo

**E31** — `buyer.rnc` obligatorio, `buyer.type: 1` (Jurídica) o `2` (Física con cédula).

**E32** — Sin `buyer.rnc`. Monto total < RD$250,000. Si el total supera esa cifra, DGII puede rechazarlo.

**E33 / E34** — Campo `reference` obligatorio:
```json
"reference": {
  "encf": "E310000000001",
  "date": "01-05-2026",
  "modificationCode": 1,
  "reason": "Devolución de mercancía"
}
```
Códigos de modificación: `1=Anula`, `2=Corrige texto`, `3=Corrige montos`, `4=Reemplazo contingencia`, `5=Referencia FC`.

**E41** — El campo `buyer` representa al **vendedor** (persona que recibe el pago por el gasto).

**E46 / E47** — Campo `currency` obligatorio para moneda extranjera:
```json
"currency": { "code": "USD", "exchangeRate": 57.50 }
```

---

## 6. Webhooks

### Lista de eventos

| Evento | Cuándo se dispara |
|--------|------------------|
| `invoice.queued` | Factura encolada para firma/envío |
| `invoice.submitted` | Factura enviada a DGII (esperando respuesta) |
| `invoice.accepted` | DGII aceptó la factura ✅ |
| `invoice.rejected` | DGII rechazó la factura ❌ |
| `invoice.conditional` | Aceptada con observaciones ⚠️ |
| `invoice.contingency` | Fallida después de todos los reintentos (requiere atención manual) |

### Ejemplo de payload

```json
{
  "event": "invoice.accepted",
  "tenantId": "tenant-uuid",
  "timestamp": "2026-05-03T12:00:05.000Z",
  "data": {
    "id": "invoice-uuid",
    "encf": "E310000000001",
    "ecfType": "E31",
    "status": "ACCEPTED",
    "companyId": "company-uuid",
    "totalAmount": 59000,
    "trackId": "DGII-TRACK-12345",
    "acceptedAt": "2026-05-03T12:00:05.000Z"
  }
}
```

### Verificar el HMAC

Cada entrega incluye el header `X-ECF-Signature: sha256=<hmac>`. **Siempre verifica la firma** antes de procesar el webhook.

**JavaScript (Node.js)**:
```javascript
const crypto = require('crypto');

function verifyWebhook(payload, signature, secret) {
  const expected = 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(payload, 'utf8')
    .digest('hex');
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected)
  );
}

// En tu endpoint Express:
app.post('/webhooks/ecf', express.raw({ type: 'application/json' }), (req, res) => {
  const signature = req.headers['x-ecf-signature'];
  const isValid = verifyWebhook(req.body, signature, process.env.WEBHOOK_SECRET);
  if (!isValid) return res.status(401).send('Invalid signature');
  // procesar evento...
  res.status(200).send('OK');
});
```

**Python**:
```python
import hmac
import hashlib

def verify_webhook(payload: bytes, signature: str, secret: str) -> bool:
    expected = 'sha256=' + hmac.new(
        secret.encode(), payload, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(signature, expected)
```

**PHP**:
```php
function verifyWebhook(string $payload, string $signature, string $secret): bool {
    $expected = 'sha256=' . hash_hmac('sha256', $payload, $secret);
    return hash_equals($expected, $signature);
}
```

### Política de retry

Ante un error HTTP (no-2xx) o timeout, el sistema reintenta con backoff exponencial:

| Intento | Delay |
|---------|-------|
| 1 | 30 segundos |
| 2 | 2 minutos |
| 3 | 10 minutos |
| 4 | 1 hora |
| 5 | 6 horas |

Si todos los intentos fallan, el webhook se marca como `FAILED`. El historial de entregas está disponible en `GET /webhooks/{id}`.

**Recomendaciones:**
- Responder `200 OK` en menos de 5 segundos (procesar en background si necesitas más tiempo)
- Implementar idempotencia: el mismo evento puede llegar más de una vez
- Verificar siempre el HMAC antes de procesar

---

## 7. Manejo de errores

### Formato de error

Todos los errores siguen el mismo formato:

```json
{
  "success": false,
  "error": {
    "code": 400,
    "type": "Bad Request",
    "message": "buyer.rnc: RNC debe tener 9 dígitos o Cédula 11 dígitos",
    "timestamp": "2026-05-03T12:00:00.000Z",
    "path": "/api/v1/invoices"
  }
}
```

### Códigos de error comunes

| HTTP | Qué significa | Qué hacer |
|------|---------------|-----------|
| `400` | Datos inválidos (validación) | Revisar el campo `message`, corregir el body |
| `401` | API key inválida o ausente | Verificar el header `X-API-Key` |
| `403` | Scope insuficiente | Crear una API key con el scope necesario |
| `404` | Recurso no encontrado | Verificar el ID y que pertenezca al tenant |
| `409` | Conflicto de estado | Ej: intentar anular una factura ACCEPTED directamente |
| `422` | Error semántico (DGII) | Revisar las reglas del tipo de e-CF |
| `429` | Rate limit excedido | Esperar y reintentar con backoff |
| `500` | Error interno | Contactar soporte con el `timestamp` del error |

### Errores frecuentes y soluciones

**`buyer.rnc: RNC debe tener 9 dígitos`**
→ El RNC debe ser exactamente 9 dígitos (empresa) o 11 (cédula de persona).

**`ecfType inválido`**
→ Solo se aceptan: `E31`, `E32`, `E33`, `E34`, `E41`, `E43`, `E44`, `E45`, `E46`, `E47`.

**`Cannot void an ACCEPTED invoice directly`**
→ Para corregir una factura ACCEPTED, emitir una Nota de Crédito E34 con `reference`.

**`No active sequence for type E31`**
→ No hay secuencia activa con números disponibles. Crear una nueva secuencia o verificar que no esté vencida.

**`No active certificate for company`**
→ La empresa no tiene certificado .p12 subido o el certificado venció. Subir uno nuevo.

**DGII rechaza con código X**
→ Revisar el campo `dgiiResponse` en el detalle de la factura. Los códigos de error de DGII están documentados en la norma técnica e-CF (DGII).

---

## 8. Estados de una factura

### Diagrama de estados

```
                    POST /invoices
                          │
                          ▼
                       QUEUED ───────────────────────────────────────┐
                          │ (procesador BullMQ)                       │
                          ▼                                           │
                      PROCESSING                                      │
                     /         \                                      │
                    /           \                                     │
              ACCEPTED      REJECTED                          (fallo técnico)
                │               │                                     │
                │               │                                     ▼
               RI/XML        (corregir)                         CONTINGENCY
                              E34/E33                                 │
                                                         POST /:id/retry
                                                                      │
                                                                  QUEUED (reintentar)


VOIDED  ◄──── POST /:id/void (solo DRAFT, ERROR, CONTINGENCY)
```

### Descripción de estados

| Estado | Significado | Acción recomendada |
|--------|-------------|-------------------|
| `QUEUED` | Encolado para procesamiento | Esperar webhook |
| `PROCESSING` | En proceso de firma y envío a DGII | Esperar webhook |
| `ACCEPTED` | DGII aceptó la factura ✅ | Entregar al cliente (XML/PDF) |
| `REJECTED` | DGII rechazó la factura ❌ | Revisar `dgiiResponse`, corregir y reemitir |
| `CONDITIONAL` | Aceptada con observaciones | Revisar observaciones de DGII |
| `CONTINGENCY` | Falló después de todos los reintentos | Verificar conexión DGII, usar `/retry` |
| `ERROR` | Error técnico en el procesador | Revisar logs, usar `/retry` |
| `VOIDED` | Anulada manualmente | Estado final |

---

## 9. Rate Limiting

- **Default**: 60 requests por minuto por API key
- **Header de respuesta**: `X-RateLimit-Remaining`, `X-RateLimit-Reset`
- **Al exceder**: HTTP 429 con `Retry-After`

Ejemplo de manejo correcto:
```javascript
async function createInvoice(data, retries = 3) {
  for (let i = 0; i < retries; i++) {
    const response = await fetch('/api/v1/invoices', { ... });
    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After') || 60;
      await sleep(retryAfter * 1000);
      continue;
    }
    return response.json();
  }
}
```

> **TODO**: Documentar límites por plan cuando estén implementados.

---

## 10. Sandbox vs Producción

### URLs

| Ambiente | URL base |
|----------|----------|
| Sandbox (DEV) | Configurar `dgiiEnv: "DEV"` en la empresa |
| Producción | Configurar `dgiiEnv: "PROD"` en la empresa |

Las empresas pueden tener diferentes `dgiiEnv`. Puedes tener empresas en DEV y en PROD en el mismo tenant.

### Cambiar el ambiente de una empresa

```bash
curl -X PATCH /api/v1/companies/{{company_id}} \
  -H "X-API-Key: ..." \
  -d '{ "dgiiEnv": "PROD" }'
```

> **Importante**: Antes de cambiar a PROD, asegúrate de tener el certificado de producción y las secuencias de PROD correctas (autorizadas por DGII en ambiente productivo).

### Set de datos de prueba DGII (DEV)

- **RNC de empresa emisora de prueba**: `130000001`
- **RNC de comprador de prueba**: `131793916`
- **Certificado de prueba**: Usar el certificado de prueba proporcionado por DGII o el que venga con el ambiente DEV
- **Las facturas en DEV no tienen validez fiscal**

---

## Soporte

- **Swagger interactivo**: `{{base_url}}/docs`
- **Colección Postman**: `docs/postman/`
- **Issues**: [GitHub Issues](https://github.com/your-org/ecf-api/issues)
