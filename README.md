# ECF-API

API SaaS de Facturación Electrónica (e-CF) para República Dominicana.

## Stack

- **Runtime:** Node.js 20+ / TypeScript
- **Framework:** NestJS
- **Database:** PostgreSQL 16+
- **Cache/Queue:** Redis + BullMQ
- **ORM:** Prisma

## Setup Rápido

```bash
# 1. Instalar dependencias
npm install

# 2. Crear base de datos
createdb ecf_api

# 3. Configurar variables de entorno
cp .env.example .env

# 4. Ejecutar migraciones
npm run prisma:migrate

# 5. Seed de datos demo
npm run prisma:seed

# 6. Iniciar en modo desarrollo
npm run start:dev
```

## Endpoints

- `GET  /api/v1/health` - Estado del servicio
- `POST /api/v1/tenants/register` - Registrar tenant (público)
- `GET  /api/v1/tenants/me` - Info del tenant
- `POST /api/v1/auth/keys` - Crear API key
- `GET  /api/v1/auth/keys` - Listar API keys
- `POST /api/v1/companies` - Registrar empresa
- `GET  /api/v1/companies` - Listar empresas
- `POST /api/v1/companies/:id/certificates` - Subir .p12
- `POST /api/v1/sequences` - Registrar secuencia eNCF
- `GET  /api/v1/sequences/:companyId` - Ver secuencias

## Autenticación

Todas las rutas protegidas usan API Key en header:

```
Authorization: Bearer frd_test_xxxxxxxxxxxx
```

## Documentación Swagger

Disponible en `http://localhost:3000/docs`

## Rotación de claves de cifrado

`CERT_ENCRYPTION_KEY` (64 caracteres hex = 32 bytes) cifra con AES-256-GCM
todos los secretos que viven en la base: el `.p12` de cada empresa, su
passphrase, y el secret HMAC de cada webhook. Está **desacoplada** del
`JWT_SECRET`: rotar ese último (operación frecuente en un incidente de
seguridad) no destruye los certificados almacenados.

### Generar una clave nueva

```bash
openssl rand -hex 32
# o en Node.js:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Rotar la clave

```bash
# 1. Mantené la clave vieja en el entorno como OLD y agregá la nueva como NEW.
export CERT_ENCRYPTION_KEY_OLD=$(grep '^CERT_ENCRYPTION_KEY=' .env | cut -d= -f2)
export CERT_ENCRYPTION_KEY_NEW=$(openssl rand -hex 32)

# 2. Ejecutá el script. Corre en una única transacción Prisma: si falla a
#    mitad de camino, hace rollback completo y deja la base exactamente como
#    estaba. Al terminar graba un AuditLog con action=CERT_KEY_ROTATED.
npx ts-node scripts/rotate-cert-encryption.ts

# 3. Reemplazá CERT_ENCRYPTION_KEY en .env (y en el secret manager de
#    producción) por el valor nuevo, y redeployá. La vieja se puede retirar.
```

El script:
- Re-cifra cada fila de `certificates.encrypted_p12` / `encrypted_passphrase`.
- Re-cifra cada `webhook_subscriptions.secret_enc` no-nulo (los webhooks
  marcados con `needs_regeneration=true` se omiten: su secret original no
  se puede recuperar y el dueño debe regenerarlos vía `POST /webhooks`).
- Inserta un registro en `audit_logs` con el conteo de filas tocadas.

### Qué pasa si perdés la clave

No hay recovery. El `.p12` y las passphrases quedan irrecuperables —
habría que re-subir los certificados manualmente. Guardá la clave en un
secret manager (AWS Secrets Manager, HashiCorp Vault, GCP Secret Manager)
con al menos dos copias offline firmadas.
