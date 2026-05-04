# Quickstart — Tu Primera Factura en 5 Minutos

> **Prerequisitos**: Tener la API corriendo (`npm run start:dev`) y PostgreSQL + Redis disponibles.
> Ver `docker-compose.yml` para levantar la infraestructura local.

---

## Paso 1 — Registrar tu cuenta (30 seg)

```bash
curl -s -X POST http://localhost:3000/api/v1/tenants/register \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Mi Empresa",
    "email": "admin@miempresa.com",
    "password": "Password123!"
  }' | jq '.data'
```

Guarda el `testApiKey` de la respuesta:

```json
{
  "id": "tenant-uuid",
  "testApiKey": "ecf_test_aBcDeFgHiJkLmNoPqRsTuVw"
}
```

Exporta para los siguientes pasos:
```bash
export API_KEY="ecf_test_aBcDeFgHiJkLmNoPqRsTuVw"
```

---

## Paso 2 — Crear empresa emisora (30 seg)

```bash
curl -s -X POST http://localhost:3000/api/v1/companies \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "rnc": "130000001",
    "businessName": "Empresa Ejemplo SRL",
    "dgiiEnv": "DEV"
  }' | jq '.data.id'
```

Exporta el ID:
```bash
export COMPANY_ID="company-uuid-del-response"
```

---

## Paso 3 — Subir certificado .p12 (1 min)

Convierte tu `.p12` a Base64:

```bash
# macOS/Linux
P12_BASE64=$(base64 -i tu-certificado.p12)

# Windows PowerShell
$P12_BASE64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes("tu-certificado.p12"))
```

Sube el certificado:

```bash
curl -s -X POST http://localhost:3000/api/v1/companies/$COMPANY_ID/certificates \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"companyId\": \"$COMPANY_ID\",
    \"p12Base64\": \"$P12_BASE64\",
    \"passphrase\": \"password-del-cert\"
  }" | jq '.data'
```

---

## Paso 4 — Crear secuencia eNCF (30 seg)

```bash
curl -s -X POST http://localhost:3000/api/v1/sequences \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"companyId\": \"$COMPANY_ID\",
    \"ecfType\": \"E31\",
    \"startNumber\": 1,
    \"endNumber\": 10000
  }" | jq '.data'
```

---

## Paso 5 — Emitir primera factura (30 seg)

```bash
curl -s -X POST http://localhost:3000/api/v1/invoices \
  -H "X-API-Key: $API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"companyId\": \"$COMPANY_ID\",
    \"ecfType\": \"E31\",
    \"buyer\": {
      \"rnc\": \"131793916\",
      \"name\": \"EMPRESA COMPRADORA SRL\",
      \"type\": 1
    },
    \"items\": [{
      \"description\": \"Servicio de consultoría\",
      \"quantity\": 1,
      \"unitPrice\": 10000,
      \"itbisRate\": 18
    }],
    \"payment\": {
      \"type\": 1,
      \"method\": 2
    },
    \"idempotencyKey\": \"quickstart-001\"
  }" | jq '.'
```

Respuesta esperada:
```json
{
  "success": true,
  "data": {
    "id": "invoice-uuid",
    "ecfType": "E31",
    "encf": "E310000000001",
    "status": "QUEUED",
    "totalAmount": 11800,
    "itbisAmount": 1800
  }
}
```

El estado es `QUEUED` — la factura está siendo procesada en background. En ~5 segundos cambiará a `ACCEPTED`.

---

## Verificar el estado

```bash
# Reemplaza con el invoice ID del paso anterior
export INVOICE_ID="invoice-uuid"

curl -s http://localhost:3000/api/v1/invoices/$INVOICE_ID \
  -H "X-API-Key: $API_KEY" | jq '.data.status'
```

Si está `PROCESSING` espera 3 segundos más. Si llega a `ACCEPTED`, ¡listo!

Si no cambia, consulta manualmente:
```bash
curl -s -X POST http://localhost:3000/api/v1/invoices/$INVOICE_ID/poll \
  -H "X-API-Key: $API_KEY" | jq '.data.status'
```

---

## Descargar el XML de la factura

```bash
curl http://localhost:3000/api/v1/invoices/$INVOICE_ID/xml \
  -H "X-API-Key: $API_KEY" \
  -o factura.xml

echo "XML guardado en factura.xml"
```

---

## Ver la Representación Impresa (PDF)

Abre en el browser:
```
http://localhost:3000/api/v1/invoices/{{invoice_id}}/preview
```

O usa la ruta `/pdf` para abrir el diálogo de impresión directamente.

---

## Explorar el Swagger

Con el servidor corriendo, abre:
```
http://localhost:3000/docs
```

Haz click en **Authorize** (candado arriba a la derecha) e ingresa tu API key para probar todos los endpoints directamente desde el browser.

---

## ¿Qué sigue?

| Tema | Dónde leerlo |
|------|-------------|
| Flujo completo de onboarding | [`docs/INTEGRATION_GUIDE.md`](./INTEGRATION_GUIDE.md#3-onboarding-de-una-empresa-cliente) |
| Los 10 tipos de e-CF y sus reglas | [`docs/INTEGRATION_GUIDE.md`](./INTEGRATION_GUIDE.md#5-tipos-de-e-cf) |
| Webhooks y verificación HMAC | [`docs/INTEGRATION_GUIDE.md`](./INTEGRATION_GUIDE.md#6-webhooks) |
| Colección Postman | [`docs/postman/`](./postman/README.md) |
| Referencia de todos los endpoints | `http://localhost:3000/docs` |

---

## Solución rápida de problemas

**Error 401 `Invalid API key`**
→ Asegúrate de usar el header `X-API-Key`, no `Authorization: Bearer`.

**Error 400 `ecfType inválido`**
→ Solo valores válidos: `E31 E32 E33 E34 E41 E43 E44 E45 E46 E47`.

**Factura queda en `PROCESSING` indefinidamente**
→ El worker de BullMQ puede no estar corriendo. Verifica que Redis está activo y el servidor inició correctamente (logs con `npm run start:dev`).

**Error `No active certificate`**
→ El certificado no se subió correctamente o el `companyId` del certificado no coincide con el de la factura.

**Error `No active sequence for type E31`**
→ Crear la secuencia para el tipo de e-CF solicitado (Paso 4).
