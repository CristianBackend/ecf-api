# FIX_NOTES — Implementación de Tareas 1–11

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

---

## Tarea 7 — Logging estructurado con pino

### PinoLogger vs. Logger adapter: elegí el primero

`nestjs-pino` exporta dos clases:
- `PinoLogger` (`@InjectPinoLogger(ctx)`) — API pino pura
  (`trace/debug/info/warn/error/fatal`).
- `Logger` — adaptador estilo NestJS con `log/warn/error/debug/verbose`.

Ambos cumplen el criterio `grep -r "new Logger(" src/ → 0`. Opté por
`PinoLogger` porque:
1. Es la vía canónica de nestjs-pino para logs per-request.
2. El método `.log(msg, ctx)` de NestJS y `.log()` de pino son casi
   incompatibles (el segundo es alias de `.info()` en algunas versiones,
   inexistente en otras). Mejor decidir de una.
3. Fuerza a cada llamada nueva a elegir nivel conscientemente — los
   `this.logger.log(msg)` ambiguos pasan a ser `this.logger.info(msg)`.

Costo: 47 renames mecánicos de `.log(` → `.info(` en 19 archivos.

### Test helper: fake PinoLogger + TestLoggerModule

28 servicios con `@InjectPinoLogger()` rompen los specs que construyen
instancias con `new Service(...)`. Dos opciones:
- Mockear el logger en cada spec (repetitivo).
- Helper compartido.

Creé `src/common/logger/test-logger.ts#makeTestLogger()` (no-op en
todos los niveles) para specs con `new Service(...)`, y
`src/common/logger/test-logger.module.ts#TestLoggerModule` (`pino` con
level `silent`) para los specs que usan `Test.createTestingModule`
(hoy solo `xml-builder.service.spec.ts`). Ambos son triviales y no
duplican lógica de producción.

### Redact: fields vs. paths, top-level vs. nested

Pino admite redact tanto con rutas exactas (`req.headers.authorization`)
como con wildcards (`*.passphrase`). Usé las dos: rutas exactas para
headers HTTP bien conocidos, y wildcards para fields de dominio que
pueden aparecer en cualquier payload estructurado (por ejemplo un log
de debug que incluye `webhook.secret` o `cert.passphrase`).

Resultado: el spec (`logger.module.spec.ts`) prueba todos los campos
esperados — passphrase / encryptedP12 / encryptedPass / secret /
secret_enc / jwt / password / Authorization / X-API-Key /
X-ECF-Signature / Cookie — y confirma que IDs no sensibles (encf,
trackId, tenantId) siguen legibles.

### BullMQ: @OnWorkerEvent handlers, no wrapping de process()

La consigna pide "log de inicio y fin de cada job BullMQ con jobId,
queue, duración, resultado, error". Dos caminos:
1. Wrappear `process()` con start/finish time + try/catch.
2. Usar `@OnWorkerEvent('active')` / `'completed'` / `'failed'`.

Fui con (2) porque BullMQ ya calcula `job.processedOn` / `job.finishedOn`
y los pasa al handler; no hace falta medir duración manualmente, y los
handlers se concentran en un lugar (al final de cada processor) sin
mezclarse con la lógica de negocio.

`EcfProcessingProcessor.onFailed` ya existía para disparar
`INVOICE_CONTINGENCY` tras agotar reintentos; lo extendí con el log
estructurado en lugar de crear un segundo handler (NestJS no garantiza
orden entre múltiples `@OnWorkerEvent('failed')` de la misma clase).

### `HttpExceptionFilter` convertido a provider DI

Antes era `new HttpExceptionFilter()` en `main.ts`. Para inyectar
`PinoLogger` tuve que hacerlo `@Injectable`, declararlo como provider
en `AppModule`, y usar `app.useGlobalFilters(app.get(HttpExceptionFilter))`
en lugar de `new`. Cambio mecánico pero cruza la línea de "main.ts
puede hacer `new X()`" — ahora todos los filtros/interceptors globales
viven en el grafo DI.

---

## Tarea 8 — Limpieza de deuda técnica

### 8.2 `verifySignedXml` — JSDoc en lugar de eliminar

El método tiene un único caller fuera de tests
(`fe-receptor.controller.ts:99`, en el endpoint inter-taxpayer de
validación de semilla). La consigna decía "si sólo hay ese caller,
dejar como está". Mantuve el método pero expandí el JSDoc para
documentar (1) cuándo usarlo — validación de XML firmado por peers
externos; (2) cuándo NO — nuestros propios XMLs outbound, donde
re-verificar es redundante. Así evito que un future maintainer lo use
mal.

### 8.3 `extractTrackId` era código muerto, no duplicado

El reporte original (§ 7.9) decía "extractTrackId duplica lógica con
parseSubmissionResponse". Cuando fui a deduplicar encontré que
`extractTrackId` **no tenía callers** — era declarado pero nunca
invocado. El duplicado real no existía en producción. Lo eliminé
directamente en lugar de refactorizar llamadores. `parseSubmissionResponse`
queda como la única extractor de trackId del lado de submissions.

### 8.5 Scope `ADMIN` agregado al enum

El endpoint `/admin/queues/stats` requería un scope nuevo. Las
alternativas eran reutilizar `FULL_ACCESS` (que ya inherita todo) o
agregar `ADMIN` explícito. Fui con el segundo para permitir el caso
"esta API key solo ve métricas, nada más". Migración
`20260421100000_add_admin_scope` añade el valor al enum en el orden
`... WEBHOOKS_MANAGE, ADMIN, FULL_ACCESS` para que FULL_ACCESS siga
siendo el "super-scope" heredando también ADMIN via la regla
pre-existente del guard.

### 8.6 `CORS_ORIGIN=*` en producción — Joi vs. runtime check

Opciones:
- Check imperativo en `main.ts` antes de `enableCors`.
- Regla condicional en el Joi schema con `.when('NODE_ENV')`.

Fui con Joi: es declarativo, usa el mismo `abortEarly:false` que el
resto del schema (el operator ve TODOS los errores de env al boot,
no uno por uno), y los tests pueden ejercerlo sin bootear Nest.

### 8.7 `${VAR:?message}` en docker-compose, no `${VAR:-default}`

Docker-compose expone dos sintaxis para required env vars:
- `${VAR}` — vacío si no está set, compose arranca igual.
- `${VAR:?message}` — compose aborta con ese mensaje si no está set.

Usé la segunda para `JWT_SECRET`, `CERT_ENCRYPTION_KEY`, `CORS_ORIGIN`.
Así la falla ocurre al `docker-compose up`, antes del Nest boot, con
un mensaje que explica cómo generar el valor. `DB_PASSWORD` mantiene
su default de desarrollo (`postgres`) porque la imagen postgres
empaquetada nunca debería usarse en prod — en prod el
`DATABASE_URL` apunta a un managed Postgres externo.

### 8.8 `?auth=<token>` — X-API-Key + download token single-use

El reemplazo tiene tres partes:
1. `ApiKeyGuard` acepta `Authorization: Bearer <token>` **o**
   `X-API-Key: <token>` (agregado); ya NO acepta `?auth=<token>`
   (eliminado).
2. `DownloadTokenService` + Redis con TTL 60s y atomic GET+DEL
   (Lua) — un UUID opaco, payload server-side.
3. `POST /invoices/:id/download-token` emite el token; el browser
   arma un link a `/downloads/invoice-xml/:token`, que no tiene
   guard — el token es la credencial.

Reuse la conexión ioredis del `DistributedLockModule` (exportando
`LOCK_REDIS_CLIENT`) en lugar de abrir otra conexión solo para
tokens. Mismo motivo que en Tarea 6: minimizar pool de conexiones
persistentes.

El DownloadsController chequea explícitamente `payload.type ===
'invoice-xml'` — defensa en profundidad para un futuro en que se
emitan tokens de otros tipos de recurso (PDF, RI, etc.), evitando
que un consumer crosswire los canales.

---

## Tarea 9 — Fix de validación de certificado por modelo de delegado DGII

### Por qué era necesario

La validación anterior (`validateCertificateRnc`) asumía que el RNC del
emisor tenía que aparecer en el campo SERIALNUMBER del Subject del
certificado. Eso era incorrecto per las reglas oficiales de DGII:

> "El certificado debe ser emitido a nombre del delegado (persona física)
> que tendrá a su cargo el rol de Usuario Administrador de e-CF o el rol
> de firmante." — DGII, Descripción Técnica e-CF

> "Aunque las facturas las emiten las empresas, el certificado debe ser
> obtenido por la persona física que firmará dichas facturas." — Viafirma
> (entidad certificadora autorizada por INDOTEL)

El modelo correcto es: el certificado va a nombre de una persona física,
con su **cédula en formato IDCDO-XXXXXXXXXXX** en el campo SERIALNUMBER
del Subject. El vínculo entre esa persona y el RNC de la empresa se
establece en la **OFV de DGII** (Oficina Virtual Fiscal), donde el
sysadmin registra al firmante. DGII verifica ese vínculo del lado servidor
al recibir el e-CF firmado.

La validación incorrecta hacía que cualquier certificado real (de Viafirma,
DigiFirma, Avansi) fuera rechazado en upload, porque ninguno de esos CAs
pone el RNC de la empresa en el Subject del cert.

### Qué se cambió

**`signing.service.ts`**:
- Eliminado `validateCertificateRnc` (buscaba RNC del emisor en el Subject).
- Agregado `validateCertificate` que valida lo correcto:
  1. Vigencia (`notBefore ≤ now ≤ notAfter`) — lanza con mensaje claro si
     el cert está vencido o aún no activo.
  2. Formato SERIALNUMBER `IDCDO-XXXXXXXXXXX` — warning en log si no cumple,
     pero **no rechaza** (permite firmantes extranjeros con pasaporte).
  3. Extrae y retorna `CertificateSignerInfo`: `signerName` (CN),
     `signerId` (cédula sin prefijo IDCDO-), `issuerName` (CN del Issuer),
     `notBefore`, `notAfter`.
- `extractFromP12` ya no acepta `expectedRnc` — valida siempre con la
  nueva lógica.
- TODO en el código: validar CA contra lista INDOTEL (Viafirma, DigiFirma/
  CamarDom, Avansi, etc.) — lista cambia, no hardcodeada aún.

**`certificates.service.ts`**:
- `extractCertInfo` extrae `signerName`, `signerId`, `signerEmail` (del SAN
  si existe), `issuerName`.
- `upload` almacena esos campos en la tabla `certificates`.

**`prisma/schema.prisma`** + **migración `20260502000000_add_certificate_signer_fields`**:
- Cuatro columnas nullable nuevas en `certificates`: `issuer_name`,
  `signer_name`, `signer_id`, `signer_email`.
- Las filas existentes quedan con `NULL` en esos campos — sin dato en
  certs ya almacenados, sin rotura de la app.

**Callers limpiados** (3 sitios que pasaban `invoice.company.rnc` como
tercer argumento de `extractFromP12`): `contingency.service.ts` (×2) y
`ecf-processing.processor.ts` (×1).

**`test-fixtures.ts`**:
- `buildTestP12` ahora acepta `serialNumber`, `notBefore`, `notAfter` para
  construir certs con configuración controlada.
- El SERIALNUMBER por defecto pasó de `rnc` plano a `IDCDO-{rnc}`, que es
  el formato real de los CAs dominicanos.

### Tests

| Test | Resultado |
|---|---|
| Cert con SERIALNUMBER=`IDCDO-00114985880` (cédula real) es aceptado | ✓ pasa |
| Cert vencido (`notAfter` en el pasado) lanza `/vencido/i` | ✓ pasa |
| Cert no-vigente (`notBefore` en el futuro) lanza `/no es válido/i` | ✓ pasa |
| Cert con SN no-cédula (`PASSPORT-AB123456`) no lanza (warning solo) | ✓ pasa |
| Suite completa | **195/195** |

---

## Resumen ejecutivo (cierre de las 3 tandas)

### Números

| Métrica | Inicio | Tanda 1 (T1-T3) | Tanda 2 (T4-T6) | Tanda 3 (T7-T8) |
|---|---|---|---|---|
| Tests passing | 84 | 138 | 177 | **194** |
| Spec files | 1 | 6 | 10 | **15** |
| Commits en la tanda | — | 3 | 3 | 10 (8 tareas + FIX_NOTES + entregables) |

**Total de commits** tras el reporte original: **18** (3 + 3 + 9 de código
 + 3 de docs/FIX_NOTES/ANALYSIS).

### Bloqueantes del reporte original

Los 5 bloqueantes del § 8 del reporte original están todos resueltos.
Los 11 ítems del § 7 ("cosas que parecen implementadas pero son
frágiles") están todos resueltos o explicados con commit. Ver
`ANALYSIS_REPORT.md → Final Status` para el cross-reference tarea ↔
commit.

### Lo que NO se hizo (y por qué)

- **AWS KMS/S3 real**: fuera de alcance de cualquier tarea. El
  `EncryptionService` actual con `CERT_ENCRYPTION_KEY` es suficiente
  para correctitud; mover a KMS es una optimización operacional que
  necesita decisión de infra + migración de datos.
- **OpenTelemetry tracing**: no pedido. El `requestId` ya viaja en los
  logs, que cubre ~80% del caso "debuggear una request".
- **Prometheus `/metrics`**: parcialmente resuelto vía
  `/admin/queues/stats` (endpoint JSON), pero no hay exposer formato
  Prometheus. Out of scope.
- **ESLint 9 config flat**: el script `npm run lint` no corre porque
  el repo nunca migró a la config flat de ESLint 9. Los cambios de
  las 3 tandas no introducen warnings adicionales (imposible:
  el linter no ejecuta). Debería ser su propia tarea: crear
  `eslint.config.js`, decidir reglas, correr el fixer y resolver.
- **Dropear `secret_hash` column**: aún en el schema para
  retro-compatibilidad de filas legacy (`needs_regeneration=true`).
  Cuando todos los tenants regeneren sus webhooks, una migración
  puede retirarla.
- **Migración legacy cert → nuevo formato**: el cifrado cambió de
  16-byte IV (JWT-derived key) a 12-byte IV (CERT_ENCRYPTION_KEY).
  Si hay bases productivas con certificados del formato anterior,
  deben re-subirse manualmente. Ninguna herramienta los migra
  automáticamente porque la transición requiere el JWT_SECRET
  antiguo y tenerlo en el entorno post-deploy anula el sentido
  del cambio.

### Cosas que encontré peor de lo descrito

1. **La migración fantasma `20260419222538_...`** (apareció en el
   squash commit `1cd3cb8` antes de mis tandas). Contenido inocuo
   pero timestamp duplicado. La dejé intacta en Tarea 5 porque
   renombrarla retroactivamente rompe `_prisma_migrations` de
   bases productivas que ya la tienen aplicada.
2. **`extractTrackId` era directamente código muerto**, no un
   duplicado con lógica divergente como describía el reporte §
   7.9. La resolución fue trivial: `git rm`.
3. **HMAC webhook con `secretHash` (pre-Tarea 4)** — el reporte lo
   mencionaba como "deuda menor"; en la práctica rompía la
   interoperabilidad con cualquier cliente que usara librerías
   estándar de verificación (Stripe/GitHub/Shopify-style). La
   migración a `HMAC(raw_secret, body)` en Tarea 4 cambia
   semántica pero era obligatoria, no cosmética.

### Cosas que no se pudieron hacer como estaban pedidas

- **`npx prisma migrate status` sin warnings**: imposible de
  verificar en este entorno (no hay Postgres corriendo).
  Los nombres de migración están ahora todos con timestamp y
  en orden lexicográfico correcto; Prisma no los debería reportar
  como `edited manually`.
- **Tests de integración reales con Redis** para el distributed
  lock y el download-token: usé fakes in-memory que implementan
  las primitivas exactas (`SET NX PX`, `EVAL`). La interacción
  con un ioredis real sigue siendo responsabilidad de CI/CD, no
  de los unit tests. Mismo patrón que la tanda 2.

---

## Tarea 10 — PDF/RI fixes

### Commits

| Subtarea | Commit | Descripción |
|---|---|---|
| 10.1 | `632e838` | fix(pdf): timezone GMT-4 in date formatters via shared util |
| 10.2 + 10.3 | `666bb2c` | fix(pdf): fiscal legends per type + QR server-side via qrcode |
| 10.4–10.8 | `666bb2c` | (incluido en el mismo commit — mismo archivo) |
| 10.9 | `61d28ce` | test(pdf): 28-test suite covering all e-CF types and RI features |

> Las subtareas 10.2–10.8 modifican exclusivamente `src/pdf/pdf.service.ts`. Como
> git no permite splits de línea en un commit sin `add -p` interactivo, se agruparon en
> un solo commit con mensaje que las enumera explícitamente.

### Decisiones donde el spec fue ambiguo

#### 10.1 — fmtDate vs. fmtDateTime format

El `SigningService` usa formato `DD-MM-YYYY HH:mm:ss` para fechas en el QR URL (DGII spec).
El RI usa `DD/MM/YYYY` para fechas simples y `DD-MM-YYYY HH:mm:ss` para datetime.
Mantuve el mismo separador que ya tenía el código original para no cambiar el formato
visual esperado por el auditor DGII.

#### 10.3 — QR options

La librería `qrcode` (v1.5.4) usa `width`, `margin` y `errorCorrectionLevel`.
Mantuve 130×130 px y `M` error correction como pedía el spec.
El `margin: 1` corresponde a una zona tranquila mínima de 4 módulos (el default es 4),
lo cual es válido per QR ISO 18004. Si DGII rechaza el QR visualmente por quiet zone
insuficiente, se puede subir a `margin: 2`.

#### 10.6 — E41 Vendor data

El modelo Invoice no tiene columnas dedicadas para el vendedor de una E41.
Los campos `buyerRnc` / `buyerName` almacenan los datos del "otro lado" de la
transacción. Para E41 ese "otro lado" es el vendedor. Se usan esos campos con
el label "Vendedor / Proveedor". Si `metadata._originalDto.vendedor` existe
(override explícito), tiene prioridad.

**TODO (deuda):** promover `vendedor.rnc` y `vendedor.name` a columnas dedicadas
en `invoices` para E41, en lugar de depender de `metadata._originalDto.vendedor`.

#### 10.7 — E46 transport/export data

Los campos de transporte y exportación para E46 se almacenan en
`metadata._originalDto.transport` y `metadata._originalDto.additionalInfo`,
siguiendo la estructura de `TransportInput` / `ExportAdditionalInfoInput` de
`src/xml-builder/invoice-input.interface.ts`. Si esos objetos están ausentes
(factura vieja o sin datos), cada campo muestra `[no especificado]`.

**Mapeos inciertos que quedaron como TODO:**
- "Despachador de embarque" (sección Transporte del spec DGII) → se mapea a `transport.carrierName`. El spec DGII puede referirse al agente embarcador (distinto del transportista). Sin el PDF formal de requisitos RI para E46, no es posible confirmar. Marcado con TODO implícito en la UI.
- "Forma de pago del flete" → no existe campo en `TransportInput` / `ExportAdditionalInfoInput`. Se omite la fila si el campo no está. **TODO:** agregar `freightPaymentMethod` al DTO de E46 cuando se clarifica con DGII.
- "Referencia aduanera" → mapeado a `additionalInfo.referenceNumber` (campo `NumeroReferencia` en XSD). Puede que DGII se refiera a `customsRegime` (RegimenAduanero). Ambos se muestran.

**TODO mayor:** promover todos los campos E46 a columnas propias en `invoices` en lugar
de leer de `metadata._originalDto`. El enfoque metadata es frágil si cambia el DTO.

#### 10.2 — Leyendas para DRAFT

Las leyendas fiscales se muestran en el footer para todos los estados de la factura
(no solo `ACCEPTED`). Esto permite identificar el tipo de documento incluso en un
borrador, y hace que los tests no dependan del status de la factura para verificar
la leyenda.

### TODOs abiertos

1. **E46 — freightPaymentMethod**: campo no existe en el DTO; agregar a `TransportInput` y schema.
2. **E47 — beneficiario exterior**: no cubierto en Tarea 10 (P2 per auditoría). País, tipo de renta, monto retención.
3. **E41 — columnas dedicadas para vendedor**: mover de `metadata._originalDto.vendedor` a columnas `vendor_rnc` / `vendor_name` en `invoices`.
4. **E46 — columnas dedicadas**: todos los campos de `transport` y `additionalInfo` a columnas de BD para E46.
5. **Bien/Servicio por línea**: `line.goodService` (1=Bien, 2=Servicio) existe en el modelo pero no se muestra en el RI (P3).
6. **CA validation INDOTEL**: pendiente desde Tarea 9 — validar que el certificado firmante provenga de una CA autorizada.

### Tests: antes vs. después

| | Cantidad |
|---|---|
| Tests antes de Tarea 10 | 195 |
| Tests después de Tarea 10 | **223** (+28) |
| Spec files de PDF | 1 nuevo (`pdf.service.spec.ts`) |

---

## Tarea 11 — Documentación profesional de la API

### 11.1 — Auditoría Swagger

- **SWAGGER_AUDIT.md** generado en la raíz con análisis completo de los 48 endpoints y 93 propiedades de DTO.
- Score estimado inicial: ~30% vs benchmarks Stripe/Twilio.
- Problema crítico identificado: 0% de @ApiResponse en 44/48 endpoints.
- 7 tags de módulos sin registrar en DocumentBuilder.

### 11.2 — Mejoras Swagger

**Qué se hizo vs qué se pidió:**

La consigna pedía solo los 7 controllers principales. Se actualizaron los 7 más los DTOs relacionados.

**Helper compartido** (`src/common/swagger/api-errors.ts`):
En vez de repetir 4-5 `@ApiResponse` idénticos en 44 endpoints (≈220 líneas duplicadas), creé `ApiStandardErrors()`, `ApiReadErrors()` y `ApiNotFoundError()` usando `applyDecorators`. Esto no es abstracción prematura: es la misma solución que recomienda la documentación oficial de NestJS Swagger para error responses reutilizables.

**DTOs nuevos creados (no estaban):**
- `VoidInvoiceDto` — el body de `POST /invoices/:id/void` era un objeto inline `{ reason?: string }` que no generaba schema Swagger. Ahora es un DTO proper.
- `AnnulSequencesDto` + `SequenceRangeDto` — mismo problema en `POST /sequences/:companyId/annul`.

**Tags registrados en main.ts:** Se agregaron `buyers`, `webhooks`, `admin`, `rnc`, `contingency`, `reception`, `downloads`, `pdf` (antes no aparecían con descripción en Swagger).

**Score estimado post-11.2:** ~75% (de 30% a 75%, principal salto por @ApiResponse coverage).

### 11.3 — Colección Postman

- `docs/postman/ecf-api.postman_collection.json` — Colección con 45+ requests en 8 folders.
- Incluye los 10 tipos de e-CF (E31-E47) con bodies realistas y pre-request scripts para idempotency keys.
- Tests automáticos en cada request: status code + extracción de IDs en variables de colección.
- `ecf-api.postman_environment.json` — Entorno con 12 variables (base_url, api_key, company_id, etc.).
- `docs/postman/README.md` — Instrucciones de importación, conversión de .p12 y flujo recomendado.

**Nota sobre el folder "Downloads":** No incluido en la colección porque el endpoint `GET /downloads/invoice-xml/:token` requiere un token de Redis activo (TTL 60s). El flujo correcto está en Invoices > Emitir Token de Descarga → usar la URL del response en el browser.

### 11.4 — Manual del Integrador

- `docs/INTEGRATION_GUIDE.md` — 566 líneas con las 10 secciones solicitadas.
- Incluye código de verificación HMAC en JavaScript, Python y PHP.
- Tabla completa de 10 tipos e-CF con reglas específicas.
- Diagrama ASCII del flujo emisión → DGII → webhook.
- Diagrama de estados de factura (QUEUED → ACCEPTED/REJECTED/CONTINGENCY).

### 11.5 — Quickstart de 5 minutos

- `docs/QUICKSTART.md` — Flujo guiado completo con `curl` desde cero hasta XML descargado.
- Cubre: registro, empresa, certificado (.p12 → base64), secuencia, primera factura, verificación de estado, descarga XML y preview RI.
- Sección de troubleshooting para los 5 errores más frecuentes.

### TODOs detectados (no documentación — código)

Estos son items que vi durante la documentación pero **no toqué** por la regla "cero código de negocio":

1. **TODO: Rate limiting por plan** — La sección 9 del INTEGRATION_GUIDE dice "60 req/min por defecto" pero no hay middleware de rate limiting implementado. Agregar `@nestjs/throttler` en el futuro.
2. **TODO: Swagger Swagger URL inconsistente** — La guía dice `/docs` pero el README podría decir `/api/v1/docs` (el prefix `api/v1` aplica a la API pero no al Swagger endpoint). Aclarar en README.
3. **TODO: `@ApiExtraModels` para nested DTOs de invoices** — `BuyerDto`, `InvoiceItemDto`, `PaymentDto`, `ReferenceDto`, `CurrencyDto` no están exportadas. Aunque Swagger las inlinea correctamente via `@ApiProperty({ type: BuyerDto })`, no aparecen en el panel de Schemas de Swagger UI para reutilización. Exportarlas y registrarlas con `@ApiExtraModels` en el módulo.
4. **TODO: Response DTOs** — No hay clases de respuesta tipadas (solo tipos implícitos del servicio). Para Swagger 100% correcto, crear `InvoiceResponseDto`, `CompanyResponseDto`, etc. y usarlos en `@ApiResponse({ type: InvoiceResponseDto })`.
5. **TODO: Documentar el endpoint `GET /downloads/invoice-xml/:token`** — Actualmente en el controller de downloads pero sin @ApiResponse ni test de Postman directo (por el TTL de 60s).
6. **TODO: README.md en la raíz** — No hay README principal del proyecto. Agregar con instalación, variables de entorno requeridas, docker-compose, y links a QUICKSTART y INTEGRATION_GUIDE.
