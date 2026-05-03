# Postman Collection — ECF API

Colección Postman para la API de facturación electrónica e-CF (República Dominicana).

## Archivos

| Archivo | Descripción |
|---------|-------------|
| `ecf-api.postman_collection.json` | Colección con todos los endpoints y tests automáticos |
| `ecf-api.postman_environment.json` | Variables de entorno (llenar antes de usar) |

## Importar en Postman

1. Abrir Postman
2. Click en **Import** (botón superior izquierdo)
3. Arrastrar **ambos archivos** o seleccionarlos con el browser
4. Seleccionar el entorno **"ECF API — Local Development"** en el dropdown de entornos (arriba a la derecha)

## Flujo de onboarding completo

Ejecutar los requests en este orden:

```
1. Auth > Registrar Tenant         → crea tu cuenta
2. Auth > Login                    → obtiene JWT (auto-seteado)
3. Auth > Crear API Key            → COPIA el valor de `key` a la variable `api_key`
4. Companies > Crear Empresa       → registra empresa emisora (auto-setea company_id)
5. Certificates > Subir Certificado → sube el .p12 de la empresa
6. Sequences > Crear Secuencia     → registra rango eNCF (DEV: usar números 1-10000)
7. Webhooks > Crear Webhook        → configura notificaciones (URL pública requerida)
8. Invoices > E31 — Factura...     → emite primera factura
9. Invoices > Ver Factura          → verifica el estado (QUEUED → ACCEPTED en ~5s)
```

## Variables de entorno

| Variable | Descripción | Cómo obtener |
|----------|-------------|--------------|
| `base_url` | URL base de la API | Default: `http://localhost:3000/api/v1` |
| `api_key` | API key para autenticación | Ejecutar **Auth > Crear API Key** |
| `company_id` | UUID de la empresa emisora | Auto-seteado al crear/listar empresas |
| `buyer_id` | UUID del comprador | Auto-seteado al crear compradores |
| `invoice_id` | UUID de la factura | Auto-seteado al crear facturas |
| `webhook_id` | UUID del webhook | Auto-seteado al crear webhooks |

## Autenticación

Todos los requests (salvo Login y Register) usan el header:
```
X-API-Key: {{api_key}}
```

La colección está configurada con autenticación de tipo API Key a nivel de colección. Solo necesitas llenar la variable `api_key`.

## Convertir .p12 a Base64

**macOS / Linux:**
```bash
base64 -i tu-certificado.p12
```

**Windows PowerShell:**
```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("tu-certificado.p12"))
```

**Node.js:**
```js
const fs = require('fs');
const base64 = fs.readFileSync('tu-certificado.p12').toString('base64');
console.log(base64);
```

## Tests automáticos incluidos

Cada request tiene tests de Postman que verifican:
- Código de estado HTTP esperado
- Presencia de campos clave en la respuesta
- Auto-seteo de variables para requests dependientes (company_id, invoice_id, etc.)

Para ejecutar todos los tests en secuencia: **Collection Runner** → seleccionar la colección → Run.

## Ambientes disponibles

| Ambiente | `base_url` | `dgiiEnv` en empresas |
|----------|-----------|----------------------|
| Local Dev | `http://localhost:3000/api/v1` | `DEV` |
| Staging | `https://api-staging.ecf.tudominio.com/api/v1` | `DEV` |
| Producción | `https://api.ecf.tudominio.com/api/v1` | `PROD` |

> Crear un entorno Postman separado para cada ambiente. Nunca usar datos de producción en DEV.
