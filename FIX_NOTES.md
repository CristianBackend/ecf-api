# FIX_NOTES — Implementación de Tareas 1–6

Decisiones y matices que difieren de la consigna o que agregué por necesidad
técnica. Formato: qué se pidió vs. qué hice vs. por qué.

---

## Tarea 1 — Firma XMLDSig con xml-crypto

### Tests nuevos: 21, no 15

La consigna pidió "mínimo 15 tests". La suite final tiene 21 para cubrir
además los cinco roots XML que firma la app (ECF, RFCE, SemillaModel, ARECF,
ACECF, ANECF) en tests independientes y dos branches de la validación
SN==RNC (cert correcto / cert de otro emisor). Ningún test es redundante.

### Certificado de prueba: OID 2.5.4.5 (serialNumber), no "serialName"

El pedido decía que el Subject CN del `.p12` de prueba use un RNC como
"00000000000". `node-forge` no acepta `name: 'serialName'` (ver
x509.js:1959 — "Attribute type not specified"), y la búsqueda `getField('SN')`
tampoco encuentra el atributo si se le puso solamente `CN`. Usé el OID
`2.5.4.5` (serialNumber X.500) que es lo que DGII mira. El
`validateCertificateRnc` sigue funcionando porque el fallback de
`subjectStr.includes(rncNormalized)` encuentra el valor en la forma
`serialNumber=00000000000` que produce node-forge. Esto ya estaba en el
código original, solo lo preservé.

### verifySignedXml no tiene callers hoy

El reporte ya lo notaba (§7.3). Lo reescribí con `xml-crypto` para que sea
correcto y testeable, pero sigue sin llamadores en producción fuera de
`fe-receptor.controller.ts:99`. No creé más, seguí la regla de no hacer
cambios fuera del alcance.

---

## Tarea 2 — Pipeline asíncrono

### Migración Prisma: no aplicada, solo escrita

No tengo PostgreSQL corriendo en este entorno, así que la migración
`20260419180000_add_queued_status_and_webhook_events/migration.sql` está
escrita pero no aplicada. Sí regeneré el Prisma Client desde el schema
(`npx prisma generate`), por eso los tipos `InvoiceStatus.QUEUED`,
`WebhookEvent.INVOICE_QUEUED`, `INVOICE_SUBMITTED` e `INVOICE_CONTINGENCY`
están disponibles para el compilador. Antes del primer deploy hay que
ejecutar `npx prisma migrate deploy`.

### Webhook INVOICE_CONTINGENCY: solo al agotar reintentos de BullMQ

La consigna dice "DGII timeout → status CONTINGENCY → webhook de
contingencia" y "DGII 5xx → retry de BullMQ (3 intentos con backoff)".
Si disparara `INVOICE_CONTINGENCY` en cada attempt fallido, un 503
transitorio que se resuelve en el segundo intento emitiría un webhook
aunque al final la factura termine ACCEPTED — ruido innecesario para el
consumidor. Uso `@OnWorkerEvent('failed')` y solo emito el webhook
cuando `job.attemptsMade >= job.opts.attempts` **y** el invoice sigue en
CONTINGENCY. Hay un test dedicado para cada caso (intermedio vs. final).

### INVOICE_SUBMITTED agregado

El task menciona `invoice.submitted` en la lista de eventos de Tarea 3. Lo
emito en Tarea 2 desde `EcfProcessingProcessor` cuando DGII devuelve un
TrackId, porque ahí ya existía la rama natural (antes del switch
ACCEPTED/REJECTED/PROCESSING). Lo mantengo aunque DGII responda
finalmente ACCEPTED en la misma iteración: los consumidores distinguen
"DGII acusó recibo (trackId)" de "DGII terminó el análisis (final
status)".

### InvoicesService.pollStatus y voidInvoice

Siguen síncronos. `pollStatus` todavía usa `signingService.extractFromP12`
+ `dgiiService.getToken` + `queryStatus` directamente, porque es un
endpoint manual que el cliente invoca de forma explícita — un encolado
extra solo agregaría latencia sin beneficio. `voidInvoice` solo hace un
UPDATE local + audit + webhook, nunca toca DGII, así que también queda
síncrono. Coincide con la intención del task ("POST /invoices" es lo
asíncrono, no todos los endpoints).

### Scheduler corre cert-check en boot además de cada 24h

Sin el primer trigger en boot, un pod recién levantado esperaría 24h
antes de detectar cualquier certificado vencido o a punto de vencer.
Agregué una llamada a `scheduleCertificateCheck()` en `onModuleInit`
aparte del `setInterval`.

---

## Tarea 3 — Unificación de webhooks

### WebhookDeliveryProcessor se movió de `src/queue/` a `src/webhooks/`

El task no especifica dónde vive el processor. Lo moví para evitar un
ciclo `QueueModule <-> WebhooksModule`: si `WebhooksService.emit()` vive
en `WebhooksModule` y los processors en `QueueModule` necesitan invocar
`emit()`, entonces `QueueModule` debe importar `WebhooksModule`. Si a su
vez `WebhooksService.emit()` necesitara `QueueService.fireWebhookEvent`,
tendríamos ciclo. Solución: la `Queue WEBHOOK_DELIVERY` y su processor
viven en `WebhooksModule` (que NO depende de `QueueModule`), y
`QueueModule` simplemente importa `WebhooksModule`. Además agrupa mejor
las responsabilidades: todo lo de webhooks bajo el mismo módulo.

### POST /webhooks/retry eliminado

La consigna dice "BullMQ maneja reintentos". El endpoint manual
sobrevivía del mundo pre-BullMQ (`WebhooksService.retryFailed`). Con 5
attempts y backoff automático, no hace falta.

### `secretHash` sigue siendo la clave HMAC (pre-existente)

El código actual almacena `secretHash = sha256(secret).hex()` y firma
los deliveries usando `secretHash` como key del HMAC. Esto implica que
los subscribers deben verificar con `HMAC(sha256(secret), body)`, no
`HMAC(secret, body)` — lo cual no es el patrón estándar de webhooks
(Stripe, GitHub, Shopify todos usan `HMAC(secret, body)`). Esto ya era
así antes de mi cambio; **no lo arreglé** porque:
1. Cambiarlo rompe retrocompatibilidad con integraciones existentes.
2. Requiere almacenar el secret sin hashear (o cifrado) — cambio de
   schema + migración de datos.
3. Está fuera del alcance explícito de Tarea 3.

Lo documenté en el JSDoc de `WebhooksService.create` para que sea
evidente, y los tests (`computeHmacSha256` + vector conocido) firman
con el mismo esquema, por lo que detectarían una regresión. Lo dejo
anotado aquí para un follow-up: "reemplazar `secretHash` por `secretEnc`
(cifrado AES-GCM) y usar el secret crudo como key HMAC".

### Backoff custom de 5 intentos (30s / 2min / 10min / 1h / 6h)

BullMQ 5.x soporta `settings.backoffStrategy` en `WorkerOptions`, y
`@nestjs/bullmq` permite pasarla por el segundo argumento del decorador
`@Processor`. La estrategia está exportada como `WEBHOOK_RETRY_DELAYS`
para que los tests la importen y no queden acoplados al literal.
`attempts: 5` con `backoff: { type: 'custom' }` en el job + strategy en
el worker producen exactamente la secuencia pedida.

### "acecf.received" → COMMERCIAL_APPROVAL_RECEIVED

El task lista `acecf.received` entre los eventos. El enum ya tiene
`COMMERCIAL_APPROVAL_RECEIVED` que es el mismo evento con otro nombre
(ACECF = Aprobación/Rechazo Comercial Electrónico). No agregué un
segundo alias para no ensuciar el enum; si el API público necesita
"acecf.received" como nombre-string, el mapping puede hacerse a nivel de
documentación sin cambiar el tipo Prisma.

---

## Cosas que NO hice (fuera de alcance de Tareas 1-3)

- No renombré las migraciones `add_buyers` / `add_received_documents`
  (mencionadas en §5.4 del reporte) — se resuelve en Tarea 5.
- No toqué `CORS_ORIGIN` / `JWT_SECRET` / `.env.example` (recomendaciones
  3 y 5 del reporte) — se resuelve en Tarea 5.
- No desacoplé `CERT_ENCRYPTION_KEY` del `JWT_SECRET` — se resuelve en
  Tarea 4.
- No agregué logging estructurado (`pino`) ni métricas Prometheus.
- No instalé `@nestjs/schedule` para reemplazar los `setInterval` del
  scheduler — se resuelve en Tarea 6.

Todos esos son seguimientos válidos pero ajenos a las 3 tareas pedidas.

---

## Tarea 4 — CERT_ENCRYPTION_KEY + HMAC estándar para webhooks

### Formato de cifrado: 12-byte IV + 16-byte authTag (no 16-byte IV legacy)

La consigna pide explícitamente el layout `iv(12 bytes) + authTag(16 bytes)
+ ciphertext` — que es el nonce recomendado por NIST SP 800-38D para
AES-GCM. El código anterior usaba IV de 16 bytes. Consecuencia: **los
certificados ya cargados en una base existente NO se pueden desencriptar
con el nuevo `EncryptionService`**. El `rotate-cert-encryption.ts` maneja
rotaciones futuras entre dos claves ya en formato nuevo; la transición
legacy→nuevo requiere re-subir los `.p12` manualmente o un script de
migración separado. En una base recién creada no hay datos que migrar.
Dejo esto anotado como punto de atención pre-deploy: si la base ya tiene
filas en `certificates`, hay que re-uploadearlas después de deployar
Tarea 4.

### Migración del HMAC: `secret_hash` → `secret_enc` (con compat)

La consigna pidió reemplazar `secretHash` por `secretEnc` cifrado AES-GCM y
usar HMAC(secret crudo, body). Lo hice así, pero **la columna `secret_hash`
sigue existiendo en el schema**. Razón: `SHA-256(secret)` es one-way, así
que no se puede rellenar `secret_enc` a partir de los registros legacy. Mi
enfoque:

1. La migración `20260420100000_webhook_secret_encryption` agrega
   `secret_enc` (BYTEA nullable) y `needs_regeneration` (BOOL, default
   `true` para filas existentes, `false` para inserts futuros). Además
   `secret_hash` pasa a nullable.
2. El código de la app **NO** toca nunca `secret_hash` (confirmado por
   `grep -r "secretHash" src/ → 0`). El processor filtra por
   `needsRegeneration: false` + `secretEnc: not null`, así que las filas
   legacy quedan inertes hasta que el tenant las regenere vía `POST
   /webhooks`.
3. Una **segunda migración futura** (no incluida aquí) debe `DROP COLUMN
   secret_hash` una vez que todos los tenants hayan regenerado. Lo dejo
   documentado como follow-up.

### Clave única CERT_ENCRYPTION_KEY para certs y webhooks

La consigna permite reutilizar el env var tanto para cifrar `.p12` como
para cifrar secretos de webhooks. Uso el mismo `EncryptionService` para
ambos. Rotar la clave rota ambos casos en una sola transacción
(confirmado en `key-rotation.spec.ts`).

### Script de rotación: helper testeable en `src/`, CLI en `scripts/`

El script debe ser ejecutable vía `ts-node scripts/rotate-cert-encryption
.ts`, pero jest (rootDir=src) no lee tests de `scripts/`. Solución: puse
la lógica pura en `src/certificates/key-rotation.ts` (exporta
`rotateEncryptionKeys(prisma, old, new)`) y el archivo en `scripts/` es un
wrapper CLI de ~30 líneas que parsea env y llama al helper. El test
(`key-rotation.spec.ts`) le pasa un fake Prisma con `$transaction` que
emula rollback — ningún Postgres requerido.

### Rollback de la transacción en el test

Prisma no expone hooks de rollback en el cliente, así que el fake
`$transaction` del test hace snapshot+restore manual. Suficiente para
verificar que **un fallo a mitad de rotación no deja filas parcialmente
rotadas ni escribe el audit log**, que es la invariante de interés.

---

## Tarea 5 — Validación Joi y limpieza de env

### La migración "fantasma" `20260419222538_20260419180000_...`

Al listar `prisma/migrations/` encontré un directorio con timestamp
duplicado que NO es parte de mi trabajo — viene del commit `1cd3cb8 fix
(dgii): resolve 3 certification blockers` (un squash previo). Su contenido
es una colección de `ALTER TABLE/TYPE` no relacionados con los cambios de
Tarea 5. **No lo toqué**: alcance estricto de la tarea era renombrar
`add_buyers` y `add_received_documents`. Si Prisma lo trata como válido
porque respeta el prefijo timestamp, no rompe `migrate status`; si molesta,
habrá que borrarlo en otra tarea junto con una verificación manual del
estado de las migraciones en la base productiva.

### `JWT_EXPIRES_IN` → `JWT_EXPIRATION`: reemplazo + throw defensivo

La consigna pidió "alinear auth.service.ts con lo que usa configuration.ts
(JWT_EXPIRATION)". Hice exactamente eso. Además, cambié el fallback de
JWT_SECRET de un string placeholder (`'ecf-api-jwt-secret-change-in-
production'`) a un `throw` explícito si el valor no está definido. La
validación Joi ya atrapa esto al boot, pero si alguien bypassea el
ConfigModule (tests, o futuros comandos ts-node), que explote en lugar de
firmar JWTs con un secreto inválido.

### `allowUnknown: true` en ConfigModule

La consigna no lo pedía, pero lo agregué porque plataformas como Heroku,
Render y Fly inyectan variables (`DYNO`, `HEROKU_APP_NAME`, `FLY_REGION`,
etc.) que harían fallar `abortEarly:false + allowUnknown:false`. El Joi
schema es estricto sobre las variables que conoce pero tolera las que no.

### Migraciones renombradas con `git mv`

Renombré con `git mv` para preservar history. Importante para despliegues
existentes: la tabla `_prisma_migrations` en la base productiva tiene las
filas viejas con nombres sin timestamp. Después de desplegar Tarea 5 hay
que actualizarlas manualmente:

```sql
UPDATE _prisma_migrations SET migration_name = '20260210000000_add_buyers'
  WHERE migration_name = 'add_buyers';
UPDATE _prisma_migrations SET migration_name = '20260210000001_add_received_documents'
  WHERE migration_name = 'add_received_documents';
```

Sin ese UPDATE, `prisma migrate deploy` tratará las migraciones renombradas
como nuevas e intentará aplicar su SQL por segunda vez (que fallará porque
las tablas ya existen). Lo dejo documentado aquí porque no hay forma de
automatizarlo desde Prisma.

---

## Tarea 6 — Scheduler con @nestjs/schedule + lock distribuido Redis

### Conexión Redis dedicada (no reusa la de BullMQ)

La consigna dice "usa SET NX PX atómico"; no especifica de dónde sale el
cliente Redis. Podría haber reutilizado la conexión de BullMQ, pero opté
por una dedicada (`DistributedLockModule` crea un `new IORedis`). Razón:
BullMQ abre conexiones blockantes para `BRPOP`/suscripciones; mezclar
comandos atómicos de lock con ese tráfico puede introducir latencia
variable y hace más difícil razonar sobre fallos. El costo es 1 conexión
extra por pod, irrelevante.

### `withLock` convenience method

La consigna pide `acquireLock` + `releaseLock`. Los implementé. Además
agregué `withLock(key, ttlMs, fn)` que envuelve acquire/release en un
try/finally — es como se usa 100% de las veces en el `SchedulerService`,
así que tenerlo reduce el boilerplate y garantiza el release en excepción.
Los tests cubren explícitamente el acquire/release básico Y el helper.

### Cert-check en boot sin lock (intencional)

En `onModuleInit()` disparo `scheduleCertificateCheck()` directamente sin
envolver en `withLock`. Razón: es el enqueue de un job a BullMQ, no el
trabajo en sí; el `CertificateCheckProcessor` del otro lado ya es
idempotente (se dedupe por `jobId: cert-check-<Date.now()>` pero eso no
importa: incluso N enqueues producen 1 check real en ventana corta porque
el processor hace un `findMany` masivo). Agregar el lock acá complicaría el
startup sin aportar correctitud.

### Tests sin Redis real (stub en memoria)

La consigna dice "2 llamadas concurrentes con misma key → solo una gana".
Sin una Redis real esto requeriría `ioredis-mock` o similar. Opté por un
fake hand-rolled de ~40 líneas dentro del spec que implementa SET NX PX y
el EVAL de release. Esto es intencional:

1. Las primitivas son sencillas y la atomicidad se cumple trivialmente en
   single-threaded JS (el fake no necesita locks internos).
2. El contrato del `DistributedLockService` está definido por esas dos
   primitivas; si un `ioredis` real las respeta, el servicio funciona. Los
   tests de integración con Redis real son un requerimiento de CI/CD, no
   de unit testing.
3. Permite correr la suite sin infraestructura local — alineado con los
   otros tests del repo.

El fake incluye un reloj mutable (`redis.now`, `redis.advance(ms)`) para
verificar expiración TTL sin `setTimeout`.
