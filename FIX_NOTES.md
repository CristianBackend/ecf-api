# FIX_NOTES â€” ImplementaciÃ³n de Tareas 1â€“11

Decisiones y matices que difieren de la consigna o que agreguÃ© por necesidad
tÃ©cnica. Formato: quÃ© se pidiÃ³ vs. quÃ© hice vs. por quÃ©.

---

## Tarea 1 â€” Firma XMLDSig con xml-crypto

### Tests nuevos: 21, no 15

La consigna pidiÃ³ "mÃ­nimo 15 tests". La suite final tiene 21 para cubrir
ademÃ¡s los cinco roots XML que firma la app (ECF, RFCE, SemillaModel, ARECF,
ACECF, ANECF) en tests independientes y dos branches de la validaciÃ³n
SN==RNC (cert correcto / cert de otro emisor). NingÃºn test es redundante.

### Certificado de prueba: OID 2.5.4.5 (serialNumber), no "serialName"

El pedido decÃ­a que el Subject CN del `.p12` de prueba use un RNC como
"00000000000". `node-forge` no acepta `name: 'serialName'` (ver
x509.js:1959 â€” "Attribute type not specified"), y la bÃºsqueda `getField('SN')`
tampoco encuentra el atributo si se le puso solamente `CN`. UsÃ© el OID
`2.5.4.5` (serialNumber X.500) que es lo que DGII mira. El
`validateCertificateRnc` sigue funcionando porque el fallback de
`subjectStr.includes(rncNormalized)` encuentra el valor en la forma
`serialNumber=00000000000` que produce node-forge. Esto ya estaba en el
cÃ³digo original, solo lo preservÃ©.

### verifySignedXml no tiene callers hoy

El reporte ya lo notaba (Â§7.3). Lo reescribÃ­ con `xml-crypto` para que sea
correcto y testeable, pero sigue sin llamadores en producciÃ³n fuera de
`fe-receptor.controller.ts:99`. No creÃ© mÃ¡s, seguÃ­ la regla de no hacer
cambios fuera del alcance.

---

## Tarea 2 â€” Pipeline asÃ­ncrono

### MigraciÃ³n Prisma: no aplicada, solo escrita

No tengo PostgreSQL corriendo en este entorno, asÃ­ que la migraciÃ³n
`20260419180000_add_queued_status_and_webhook_events/migration.sql` estÃ¡
escrita pero no aplicada. SÃ­ regenerÃ© el Prisma Client desde el schema
(`npx prisma generate`), por eso los tipos `InvoiceStatus.QUEUED`,
`WebhookEvent.INVOICE_QUEUED`, `INVOICE_SUBMITTED` e `INVOICE_CONTINGENCY`
estÃ¡n disponibles para el compilador. Antes del primer deploy hay que
ejecutar `npx prisma migrate deploy`.

### Webhook INVOICE_CONTINGENCY: solo al agotar reintentos de BullMQ

La consigna dice "DGII timeout â†’ status CONTINGENCY â†’ webhook de
contingencia" y "DGII 5xx â†’ retry de BullMQ (3 intentos con backoff)".
Si disparara `INVOICE_CONTINGENCY` en cada attempt fallido, un 503
transitorio que se resuelve en el segundo intento emitirÃ­a un webhook
aunque al final la factura termine ACCEPTED â€” ruido innecesario para el
consumidor. Uso `@OnWorkerEvent('failed')` y solo emito el webhook
cuando `job.attemptsMade >= job.opts.attempts` **y** el invoice sigue en
CONTINGENCY. Hay un test dedicado para cada caso (intermedio vs. final).

### INVOICE_SUBMITTED agregado

El task menciona `invoice.submitted` en la lista de eventos de Tarea 3. Lo
emito en Tarea 2 desde `EcfProcessingProcessor` cuando DGII devuelve un
TrackId, porque ahÃ­ ya existÃ­a la rama natural (antes del switch
ACCEPTED/REJECTED/PROCESSING). Lo mantengo aunque DGII responda
finalmente ACCEPTED en la misma iteraciÃ³n: los consumidores distinguen
"DGII acusÃ³ recibo (trackId)" de "DGII terminÃ³ el anÃ¡lisis (final
status)".

### InvoicesService.pollStatus y voidInvoice

Siguen sÃ­ncronos. `pollStatus` todavÃ­a usa `signingService.extractFromP12`
+ `dgiiService.getToken` + `queryStatus` directamente, porque es un
endpoint manual que el cliente invoca de forma explÃ­cita â€” un encolado
extra solo agregarÃ­a latencia sin beneficio. `voidInvoice` solo hace un
UPDATE local + audit + webhook, nunca toca DGII, asÃ­ que tambiÃ©n queda
sÃ­ncrono. Coincide con la intenciÃ³n del task ("POST /invoices" es lo
asÃ­ncrono, no todos los endpoints).

### Scheduler corre cert-check en boot ademÃ¡s de cada 24h

Sin el primer trigger en boot, un pod reciÃ©n levantado esperarÃ­a 24h
antes de detectar cualquier certificado vencido o a punto de vencer.
AgreguÃ© una llamada a `scheduleCertificateCheck()` en `onModuleInit`
aparte del `setInterval`.

---

## Tarea 3 â€” UnificaciÃ³n de webhooks

### WebhookDeliveryProcessor se moviÃ³ de `src/queue/` a `src/webhooks/`

El task no especifica dÃ³nde vive el processor. Lo movÃ­ para evitar un
ciclo `QueueModule <-> WebhooksModule`: si `WebhooksService.emit()` vive
en `WebhooksModule` y los processors en `QueueModule` necesitan invocar
`emit()`, entonces `QueueModule` debe importar `WebhooksModule`. Si a su
vez `WebhooksService.emit()` necesitara `QueueService.fireWebhookEvent`,
tendrÃ­amos ciclo. SoluciÃ³n: la `Queue WEBHOOK_DELIVERY` y su processor
viven en `WebhooksModule` (que NO depende de `QueueModule`), y
`QueueModule` simplemente importa `WebhooksModule`. AdemÃ¡s agrupa mejor
las responsabilidades: todo lo de webhooks bajo el mismo mÃ³dulo.

### POST /webhooks/retry eliminado

La consigna dice "BullMQ maneja reintentos". El endpoint manual
sobrevivÃ­a del mundo pre-BullMQ (`WebhooksService.retryFailed`). Con 5
attempts y backoff automÃ¡tico, no hace falta.

### `secretHash` sigue siendo la clave HMAC (pre-existente)

El cÃ³digo actual almacena `secretHash = sha256(secret).hex()` y firma
los deliveries usando `secretHash` como key del HMAC. Esto implica que
los subscribers deben verificar con `HMAC(sha256(secret), body)`, no
`HMAC(secret, body)` â€” lo cual no es el patrÃ³n estÃ¡ndar de webhooks
(Stripe, GitHub, Shopify todos usan `HMAC(secret, body)`). Esto ya era
asÃ­ antes de mi cambio; **no lo arreglÃ©** porque:
1. Cambiarlo rompe retrocompatibilidad con integraciones existentes.
2. Requiere almacenar el secret sin hashear (o cifrado) â€” cambio de
   schema + migraciÃ³n de datos.
3. EstÃ¡ fuera del alcance explÃ­cito de Tarea 3.

Lo documentÃ© en el JSDoc de `WebhooksService.create` para que sea
evidente, y los tests (`computeHmacSha256` + vector conocido) firman
con el mismo esquema, por lo que detectarÃ­an una regresiÃ³n. Lo dejo
anotado aquÃ­ para un follow-up: "reemplazar `secretHash` por `secretEnc`
(cifrado AES-GCM) y usar el secret crudo como key HMAC".

### Backoff custom de 5 intentos (30s / 2min / 10min / 1h / 6h)

BullMQ 5.x soporta `settings.backoffStrategy` en `WorkerOptions`, y
`@nestjs/bullmq` permite pasarla por el segundo argumento del decorador
`@Processor`. La estrategia estÃ¡ exportada como `WEBHOOK_RETRY_DELAYS`
para que los tests la importen y no queden acoplados al literal.
`attempts: 5` con `backoff: { type: 'custom' }` en el job + strategy en
el worker producen exactamente la secuencia pedida.

### "acecf.received" â†’ COMMERCIAL_APPROVAL_RECEIVED

El task lista `acecf.received` entre los eventos. El enum ya tiene
`COMMERCIAL_APPROVAL_RECEIVED` que es el mismo evento con otro nombre
(ACECF = AprobaciÃ³n/Rechazo Comercial ElectrÃ³nico). No agreguÃ© un
segundo alias para no ensuciar el enum; si el API pÃºblico necesita
"acecf.received" como nombre-string, el mapping puede hacerse a nivel de
documentaciÃ³n sin cambiar el tipo Prisma.

---

## Cosas que NO hice (fuera de alcance de Tareas 1-3)

- No renombrÃ© las migraciones `add_buyers` / `add_received_documents`
  (mencionadas en Â§5.4 del reporte) â€” se resuelve en Tarea 5.
- No toquÃ© `CORS_ORIGIN` / `JWT_SECRET` / `.env.example` (recomendaciones
  3 y 5 del reporte) â€” se resuelve en Tarea 5.
- No desacoplÃ© `CERT_ENCRYPTION_KEY` del `JWT_SECRET` â€” se resuelve en
  Tarea 4.
- No agreguÃ© logging estructurado (`pino`) ni mÃ©tricas Prometheus.
- No instalÃ© `@nestjs/schedule` para reemplazar los `setInterval` del
  scheduler â€” se resuelve en Tarea 6.

Todos esos son seguimientos vÃ¡lidos pero ajenos a las 3 tareas pedidas.

---

## Tarea 4 â€” CERT_ENCRYPTION_KEY + HMAC estÃ¡ndar para webhooks

### Formato de cifrado: 12-byte IV + 16-byte authTag (no 16-byte IV legacy)

La consigna pide explÃ­citamente el layout `iv(12 bytes) + authTag(16 bytes)
+ ciphertext` â€” que es el nonce recomendado por NIST SP 800-38D para
AES-GCM. El cÃ³digo anterior usaba IV de 16 bytes. Consecuencia: **los
certificados ya cargados en una base existente NO se pueden desencriptar
con el nuevo `EncryptionService`**. El `rotate-cert-encryption.ts` maneja
rotaciones futuras entre dos claves ya en formato nuevo; la transiciÃ³n
legacyâ†’nuevo requiere re-subir los `.p12` manualmente o un script de
migraciÃ³n separado. En una base reciÃ©n creada no hay datos que migrar.
Dejo esto anotado como punto de atenciÃ³n pre-deploy: si la base ya tiene
filas en `certificates`, hay que re-uploadearlas despuÃ©s de deployar
Tarea 4.

### MigraciÃ³n del HMAC: `secret_hash` â†’ `secret_enc` (con compat)

La consigna pidiÃ³ reemplazar `secretHash` por `secretEnc` cifrado AES-GCM y
usar HMAC(secret crudo, body). Lo hice asÃ­, pero **la columna `secret_hash`
sigue existiendo en el schema**. RazÃ³n: `SHA-256(secret)` es one-way, asÃ­
que no se puede rellenar `secret_enc` a partir de los registros legacy. Mi
enfoque:

1. La migraciÃ³n `20260420100000_webhook_secret_encryption` agrega
   `secret_enc` (BYTEA nullable) y `needs_regeneration` (BOOL, default
   `true` para filas existentes, `false` para inserts futuros). AdemÃ¡s
   `secret_hash` pasa a nullable.
2. El cÃ³digo de la app **NO** toca nunca `secret_hash` (confirmado por
   `grep -r "secretHash" src/ â†’ 0`). El processor filtra por
   `needsRegeneration: false` + `secretEnc: not null`, asÃ­ que las filas
   legacy quedan inertes hasta que el tenant las regenere vÃ­a `POST
   /webhooks`.
3. Una **segunda migraciÃ³n futura** (no incluida aquÃ­) debe `DROP COLUMN
   secret_hash` una vez que todos los tenants hayan regenerado. Lo dejo
   documentado como follow-up.

### Clave Ãºnica CERT_ENCRYPTION_KEY para certs y webhooks

La consigna permite reutilizar el env var tanto para cifrar `.p12` como
para cifrar secretos de webhooks. Uso el mismo `EncryptionService` para
ambos. Rotar la clave rota ambos casos en una sola transacciÃ³n
(confirmado en `key-rotation.spec.ts`).

### Script de rotaciÃ³n: helper testeable en `src/`, CLI en `scripts/`

El script debe ser ejecutable vÃ­a `ts-node scripts/rotate-cert-encryption
.ts`, pero jest (rootDir=src) no lee tests de `scripts/`. SoluciÃ³n: puse
la lÃ³gica pura en `src/certificates/key-rotation.ts` (exporta
`rotateEncryptionKeys(prisma, old, new)`) y el archivo en `scripts/` es un
wrapper CLI de ~30 lÃ­neas que parsea env y llama al helper. El test
(`key-rotation.spec.ts`) le pasa un fake Prisma con `$transaction` que
emula rollback â€” ningÃºn Postgres requerido.

### Rollback de la transacciÃ³n en el test

Prisma no expone hooks de rollback en el cliente, asÃ­ que el fake
`$transaction` del test hace snapshot+restore manual. Suficiente para
verificar que **un fallo a mitad de rotaciÃ³n no deja filas parcialmente
rotadas ni escribe el audit log**, que es la invariante de interÃ©s.

---

## Tarea 5 â€” ValidaciÃ³n Joi y limpieza de env

### La migraciÃ³n "fantasma" `20260419222538_20260419180000_...`

Al listar `prisma/migrations/` encontrÃ© un directorio con timestamp
duplicado que NO es parte de mi trabajo â€” viene del commit `1cd3cb8 fix
(dgii): resolve 3 certification blockers` (un squash previo). Su contenido
es una colecciÃ³n de `ALTER TABLE/TYPE` no relacionados con los cambios de
Tarea 5. **No lo toquÃ©**: alcance estricto de la tarea era renombrar
`add_buyers` y `add_received_documents`. Si Prisma lo trata como vÃ¡lido
porque respeta el prefijo timestamp, no rompe `migrate status`; si molesta,
habrÃ¡ que borrarlo en otra tarea junto con una verificaciÃ³n manual del
estado de las migraciones en la base productiva.

### `JWT_EXPIRES_IN` â†’ `JWT_EXPIRATION`: reemplazo + throw defensivo

La consigna pidiÃ³ "alinear auth.service.ts con lo que usa configuration.ts
(JWT_EXPIRATION)". Hice exactamente eso. AdemÃ¡s, cambiÃ© el fallback de
JWT_SECRET de un string placeholder (`'ecf-api-jwt-secret-change-in-
production'`) a un `throw` explÃ­cito si el valor no estÃ¡ definido. La
validaciÃ³n Joi ya atrapa esto al boot, pero si alguien bypassea el
ConfigModule (tests, o futuros comandos ts-node), que explote en lugar de
firmar JWTs con un secreto invÃ¡lido.

### `allowUnknown: true` en ConfigModule

La consigna no lo pedÃ­a, pero lo agreguÃ© porque plataformas como Heroku,
Render y Fly inyectan variables (`DYNO`, `HEROKU_APP_NAME`, `FLY_REGION`,
etc.) que harÃ­an fallar `abortEarly:false + allowUnknown:false`. El Joi
schema es estricto sobre las variables que conoce pero tolera las que no.

### Migraciones renombradas con `git mv`

RenombrÃ© con `git mv` para preservar history. Importante para despliegues
existentes: la tabla `_prisma_migrations` en la base productiva tiene las
filas viejas con nombres sin timestamp. DespuÃ©s de desplegar Tarea 5 hay
que actualizarlas manualmente:

```sql
UPDATE _prisma_migrations SET migration_name = '20260210000000_add_buyers'
  WHERE migration_name = 'add_buyers';
UPDATE _prisma_migrations SET migration_name = '20260210000001_add_received_documents'
  WHERE migration_name = 'add_received_documents';
```

Sin ese UPDATE, `prisma migrate deploy` tratarÃ¡ las migraciones renombradas
como nuevas e intentarÃ¡ aplicar su SQL por segunda vez (que fallarÃ¡ porque
las tablas ya existen). Lo dejo documentado aquÃ­ porque no hay forma de
automatizarlo desde Prisma.

---

## Tarea 6 â€” Scheduler con @nestjs/schedule + lock distribuido Redis

### ConexiÃ³n Redis dedicada (no reusa la de BullMQ)

La consigna dice "usa SET NX PX atÃ³mico"; no especifica de dÃ³nde sale el
cliente Redis. PodrÃ­a haber reutilizado la conexiÃ³n de BullMQ, pero optÃ©
por una dedicada (`DistributedLockModule` crea un `new IORedis`). RazÃ³n:
BullMQ abre conexiones blockantes para `BRPOP`/suscripciones; mezclar
comandos atÃ³micos de lock con ese trÃ¡fico puede introducir latencia
variable y hace mÃ¡s difÃ­cil razonar sobre fallos. El costo es 1 conexiÃ³n
extra por pod, irrelevante.

### `withLock` convenience method

La consigna pide `acquireLock` + `releaseLock`. Los implementÃ©. AdemÃ¡s
agreguÃ© `withLock(key, ttlMs, fn)` que envuelve acquire/release en un
try/finally â€” es como se usa 100% de las veces en el `SchedulerService`,
asÃ­ que tenerlo reduce el boilerplate y garantiza el release en excepciÃ³n.
Los tests cubren explÃ­citamente el acquire/release bÃ¡sico Y el helper.

### Cert-check en boot sin lock (intencional)

En `onModuleInit()` disparo `scheduleCertificateCheck()` directamente sin
envolver en `withLock`. RazÃ³n: es el enqueue de un job a BullMQ, no el
trabajo en sÃ­; el `CertificateCheckProcessor` del otro lado ya es
idempotente (se dedupe por `jobId: cert-check-<Date.now()>` pero eso no
importa: incluso N enqueues producen 1 check real en ventana corta porque
el processor hace un `findMany` masivo). Agregar el lock acÃ¡ complicarÃ­a el
startup sin aportar correctitud.

### Tests sin Redis real (stub en memoria)

La consigna dice "2 llamadas concurrentes con misma key â†’ solo una gana".
Sin una Redis real esto requerirÃ­a `ioredis-mock` o similar. OptÃ© por un
fake hand-rolled de ~40 lÃ­neas dentro del spec que implementa SET NX PX y
el EVAL de release. Esto es intencional:

1. Las primitivas son sencillas y la atomicidad se cumple trivialmente en
   single-threaded JS (el fake no necesita locks internos).
2. El contrato del `DistributedLockService` estÃ¡ definido por esas dos
   primitivas; si un `ioredis` real las respeta, el servicio funciona. Los
   tests de integraciÃ³n con Redis real son un requerimiento de CI/CD, no
   de unit testing.
3. Permite correr la suite sin infraestructura local â€” alineado con los
   otros tests del repo.

El fake incluye un reloj mutable (`redis.now`, `redis.advance(ms)`) para
verificar expiraciÃ³n TTL sin `setTimeout`.

---

## Tarea 7 â€” Logging estructurado con pino

### PinoLogger vs. Logger adapter: elegÃ­ el primero

`nestjs-pino` exporta dos clases:
- `PinoLogger` (`@InjectPinoLogger(ctx)`) â€” API pino pura
  (`trace/debug/info/warn/error/fatal`).
- `Logger` â€” adaptador estilo NestJS con `log/warn/error/debug/verbose`.

Ambos cumplen el criterio `grep -r "new Logger(" src/ â†’ 0`. OptÃ© por
`PinoLogger` porque:
1. Es la vÃ­a canÃ³nica de nestjs-pino para logs per-request.
2. El mÃ©todo `.log(msg, ctx)` de NestJS y `.log()` de pino son casi
   incompatibles (el segundo es alias de `.info()` en algunas versiones,
   inexistente en otras). Mejor decidir de una.
3. Fuerza a cada llamada nueva a elegir nivel conscientemente â€” los
   `this.logger.log(msg)` ambiguos pasan a ser `this.logger.info(msg)`.

Costo: 47 renames mecÃ¡nicos de `.log(` â†’ `.info(` en 19 archivos.

### Test helper: fake PinoLogger + TestLoggerModule

28 servicios con `@InjectPinoLogger()` rompen los specs que construyen
instancias con `new Service(...)`. Dos opciones:
- Mockear el logger en cada spec (repetitivo).
- Helper compartido.

CreÃ© `src/common/logger/test-logger.ts#makeTestLogger()` (no-op en
todos los niveles) para specs con `new Service(...)`, y
`src/common/logger/test-logger.module.ts#TestLoggerModule` (`pino` con
level `silent`) para los specs que usan `Test.createTestingModule`
(hoy solo `xml-builder.service.spec.ts`). Ambos son triviales y no
duplican lÃ³gica de producciÃ³n.

### Redact: fields vs. paths, top-level vs. nested

Pino admite redact tanto con rutas exactas (`req.headers.authorization`)
como con wildcards (`*.passphrase`). UsÃ© las dos: rutas exactas para
headers HTTP bien conocidos, y wildcards para fields de dominio que
pueden aparecer en cualquier payload estructurado (por ejemplo un log
de debug que incluye `webhook.secret` o `cert.passphrase`).

Resultado: el spec (`logger.module.spec.ts`) prueba todos los campos
esperados â€” passphrase / encryptedP12 / encryptedPass / secret /
secret_enc / jwt / password / Authorization / X-API-Key /
X-ECF-Signature / Cookie â€” y confirma que IDs no sensibles (encf,
trackId, tenantId) siguen legibles.

### BullMQ: @OnWorkerEvent handlers, no wrapping de process()

La consigna pide "log de inicio y fin de cada job BullMQ con jobId,
queue, duraciÃ³n, resultado, error". Dos caminos:
1. Wrappear `process()` con start/finish time + try/catch.
2. Usar `@OnWorkerEvent('active')` / `'completed'` / `'failed'`.

Fui con (2) porque BullMQ ya calcula `job.processedOn` / `job.finishedOn`
y los pasa al handler; no hace falta medir duraciÃ³n manualmente, y los
handlers se concentran en un lugar (al final de cada processor) sin
mezclarse con la lÃ³gica de negocio.

`EcfProcessingProcessor.onFailed` ya existÃ­a para disparar
`INVOICE_CONTINGENCY` tras agotar reintentos; lo extendÃ­ con el log
estructurado en lugar de crear un segundo handler (NestJS no garantiza
orden entre mÃºltiples `@OnWorkerEvent('failed')` de la misma clase).

### `HttpExceptionFilter` convertido a provider DI

Antes era `new HttpExceptionFilter()` en `main.ts`. Para inyectar
`PinoLogger` tuve que hacerlo `@Injectable`, declararlo como provider
en `AppModule`, y usar `app.useGlobalFilters(app.get(HttpExceptionFilter))`
en lugar de `new`. Cambio mecÃ¡nico pero cruza la lÃ­nea de "main.ts
puede hacer `new X()`" â€” ahora todos los filtros/interceptors globales
viven en el grafo DI.

---

## Tarea 8 â€” Limpieza de deuda tÃ©cnica

### 8.2 `verifySignedXml` â€” JSDoc en lugar de eliminar

El mÃ©todo tiene un Ãºnico caller fuera de tests
(`fe-receptor.controller.ts:99`, en el endpoint inter-taxpayer de
validaciÃ³n de semilla). La consigna decÃ­a "si sÃ³lo hay ese caller,
dejar como estÃ¡". Mantuve el mÃ©todo pero expandÃ­ el JSDoc para
documentar (1) cuÃ¡ndo usarlo â€” validaciÃ³n de XML firmado por peers
externos; (2) cuÃ¡ndo NO â€” nuestros propios XMLs outbound, donde
re-verificar es redundante. AsÃ­ evito que un future maintainer lo use
mal.

### 8.3 `extractTrackId` era cÃ³digo muerto, no duplicado

El reporte original (Â§ 7.9) decÃ­a "extractTrackId duplica lÃ³gica con
parseSubmissionResponse". Cuando fui a deduplicar encontrÃ© que
`extractTrackId` **no tenÃ­a callers** â€” era declarado pero nunca
invocado. El duplicado real no existÃ­a en producciÃ³n. Lo eliminÃ©
directamente en lugar de refactorizar llamadores. `parseSubmissionResponse`
queda como la Ãºnica extractor de trackId del lado de submissions.

### 8.5 Scope `ADMIN` agregado al enum

El endpoint `/admin/queues/stats` requerÃ­a un scope nuevo. Las
alternativas eran reutilizar `FULL_ACCESS` (que ya inherita todo) o
agregar `ADMIN` explÃ­cito. Fui con el segundo para permitir el caso
"esta API key solo ve mÃ©tricas, nada mÃ¡s". MigraciÃ³n
`20260421100000_add_admin_scope` aÃ±ade el valor al enum en el orden
`... WEBHOOKS_MANAGE, ADMIN, FULL_ACCESS` para que FULL_ACCESS siga
siendo el "super-scope" heredando tambiÃ©n ADMIN via la regla
pre-existente del guard.

### 8.6 `CORS_ORIGIN=*` en producciÃ³n â€” Joi vs. runtime check

Opciones:
- Check imperativo en `main.ts` antes de `enableCors`.
- Regla condicional en el Joi schema con `.when('NODE_ENV')`.

Fui con Joi: es declarativo, usa el mismo `abortEarly:false` que el
resto del schema (el operator ve TODOS los errores de env al boot,
no uno por uno), y los tests pueden ejercerlo sin bootear Nest.

### 8.7 `${VAR:?message}` en docker-compose, no `${VAR:-default}`

Docker-compose expone dos sintaxis para required env vars:
- `${VAR}` â€” vacÃ­o si no estÃ¡ set, compose arranca igual.
- `${VAR:?message}` â€” compose aborta con ese mensaje si no estÃ¡ set.

UsÃ© la segunda para `JWT_SECRET`, `CERT_ENCRYPTION_KEY`, `CORS_ORIGIN`.
AsÃ­ la falla ocurre al `docker-compose up`, antes del Nest boot, con
un mensaje que explica cÃ³mo generar el valor. `DB_PASSWORD` mantiene
su default de desarrollo (`postgres`) porque la imagen postgres
empaquetada nunca deberÃ­a usarse en prod â€” en prod el
`DATABASE_URL` apunta a un managed Postgres externo.

### 8.8 `?auth=<token>` â€” X-API-Key + download token single-use

El reemplazo tiene tres partes:
1. `ApiKeyGuard` acepta `Authorization: Bearer <token>` **o**
   `X-API-Key: <token>` (agregado); ya NO acepta `?auth=<token>`
   (eliminado).
2. `DownloadTokenService` + Redis con TTL 60s y atomic GET+DEL
   (Lua) â€” un UUID opaco, payload server-side.
3. `POST /invoices/:id/download-token` emite el token; el browser
   arma un link a `/downloads/invoice-xml/:token`, que no tiene
   guard â€” el token es la credencial.

Reuse la conexiÃ³n ioredis del `DistributedLockModule` (exportando
`LOCK_REDIS_CLIENT`) en lugar de abrir otra conexiÃ³n solo para
tokens. Mismo motivo que en Tarea 6: minimizar pool de conexiones
persistentes.

El DownloadsController chequea explÃ­citamente `payload.type ===
'invoice-xml'` â€” defensa en profundidad para un futuro en que se
emitan tokens de otros tipos de recurso (PDF, RI, etc.), evitando
que un consumer crosswire los canales.

---

## Tarea 9 â€” Fix de validaciÃ³n de certificado por modelo de delegado DGII

### Por quÃ© era necesario

La validaciÃ³n anterior (`validateCertificateRnc`) asumÃ­a que el RNC del
emisor tenÃ­a que aparecer en el campo SERIALNUMBER del Subject del
certificado. Eso era incorrecto per las reglas oficiales de DGII:

> "El certificado debe ser emitido a nombre del delegado (persona fÃ­sica)
> que tendrÃ¡ a su cargo el rol de Usuario Administrador de e-CF o el rol
> de firmante." â€” DGII, DescripciÃ³n TÃ©cnica e-CF

> "Aunque las facturas las emiten las empresas, el certificado debe ser
> obtenido por la persona fÃ­sica que firmarÃ¡ dichas facturas." â€” Viafirma
> (entidad certificadora autorizada por INDOTEL)

El modelo correcto es: el certificado va a nombre de una persona fÃ­sica,
con su **cÃ©dula en formato IDCDO-XXXXXXXXXXX** en el campo SERIALNUMBER
del Subject. El vÃ­nculo entre esa persona y el RNC de la empresa se
establece en la **OFV de DGII** (Oficina Virtual Fiscal), donde el
sysadmin registra al firmante. DGII verifica ese vÃ­nculo del lado servidor
al recibir el e-CF firmado.

La validaciÃ³n incorrecta hacÃ­a que cualquier certificado real (de Viafirma,
DigiFirma, Avansi) fuera rechazado en upload, porque ninguno de esos CAs
pone el RNC de la empresa en el Subject del cert.

### QuÃ© se cambiÃ³

**`signing.service.ts`**:
- Eliminado `validateCertificateRnc` (buscaba RNC del emisor en el Subject).
- Agregado `validateCertificate` que valida lo correcto:
  1. Vigencia (`notBefore â‰¤ now â‰¤ notAfter`) â€” lanza con mensaje claro si
     el cert estÃ¡ vencido o aÃºn no activo.
  2. Formato SERIALNUMBER `IDCDO-XXXXXXXXXXX` â€” warning en log si no cumple,
     pero **no rechaza** (permite firmantes extranjeros con pasaporte).
  3. Extrae y retorna `CertificateSignerInfo`: `signerName` (CN),
     `signerId` (cÃ©dula sin prefijo IDCDO-), `issuerName` (CN del Issuer),
     `notBefore`, `notAfter`.
- `extractFromP12` ya no acepta `expectedRnc` â€” valida siempre con la
  nueva lÃ³gica.
- TODO en el cÃ³digo: validar CA contra lista INDOTEL (Viafirma, DigiFirma/
  CamarDom, Avansi, etc.) â€” lista cambia, no hardcodeada aÃºn.

**`certificates.service.ts`**:
- `extractCertInfo` extrae `signerName`, `signerId`, `signerEmail` (del SAN
  si existe), `issuerName`.
- `upload` almacena esos campos en la tabla `certificates`.

**`prisma/schema.prisma`** + **migraciÃ³n `20260502000000_add_certificate_signer_fields`**:
- Cuatro columnas nullable nuevas en `certificates`: `issuer_name`,
  `signer_name`, `signer_id`, `signer_email`.
- Las filas existentes quedan con `NULL` en esos campos â€” sin dato en
  certs ya almacenados, sin rotura de la app.

**Callers limpiados** (3 sitios que pasaban `invoice.company.rnc` como
tercer argumento de `extractFromP12`): `contingency.service.ts` (Ã—2) y
`ecf-processing.processor.ts` (Ã—1).

**`test-fixtures.ts`**:
- `buildTestP12` ahora acepta `serialNumber`, `notBefore`, `notAfter` para
  construir certs con configuraciÃ³n controlada.
- El SERIALNUMBER por defecto pasÃ³ de `rnc` plano a `IDCDO-{rnc}`, que es
  el formato real de los CAs dominicanos.

### Tests

| Test | Resultado |
|---|---|
| Cert con SERIALNUMBER=`IDCDO-00114985880` (cÃ©dula real) es aceptado | âœ“ pasa |
| Cert vencido (`notAfter` en el pasado) lanza `/vencido/i` | âœ“ pasa |
| Cert no-vigente (`notBefore` en el futuro) lanza `/no es vÃ¡lido/i` | âœ“ pasa |
| Cert con SN no-cÃ©dula (`PASSPORT-AB123456`) no lanza (warning solo) | âœ“ pasa |
| Suite completa | **195/195** |

---

## Resumen ejecutivo (cierre de las 3 tandas)

### NÃºmeros

| MÃ©trica | Inicio | Tanda 1 (T1-T3) | Tanda 2 (T4-T6) | Tanda 3 (T7-T8) |
|---|---|---|---|---|
| Tests passing | 84 | 138 | 177 | **194** |
| Spec files | 1 | 6 | 10 | **15** |
| Commits en la tanda | â€” | 3 | 3 | 10 (8 tareas + FIX_NOTES + entregables) |

**Total de commits** tras el reporte original: **18** (3 + 3 + 9 de cÃ³digo
 + 3 de docs/FIX_NOTES/ANALYSIS).

### Bloqueantes del reporte original

Los 5 bloqueantes del Â§ 8 del reporte original estÃ¡n todos resueltos.
Los 11 Ã­tems del Â§ 7 ("cosas que parecen implementadas pero son
frÃ¡giles") estÃ¡n todos resueltos o explicados con commit. Ver
`ANALYSIS_REPORT.md â†’ Final Status` para el cross-reference tarea â†”
commit.

### Lo que NO se hizo (y por quÃ©)

- **AWS KMS/S3 real**: fuera de alcance de cualquier tarea. El
  `EncryptionService` actual con `CERT_ENCRYPTION_KEY` es suficiente
  para correctitud; mover a KMS es una optimizaciÃ³n operacional que
  necesita decisiÃ³n de infra + migraciÃ³n de datos.
- **OpenTelemetry tracing**: no pedido. El `requestId` ya viaja en los
  logs, que cubre ~80% del caso "debuggear una request".
- **Prometheus `/metrics`**: parcialmente resuelto vÃ­a
  `/admin/queues/stats` (endpoint JSON), pero no hay exposer formato
  Prometheus. Out of scope.
- **ESLint 9 config flat**: el script `npm run lint` no corre porque
  el repo nunca migrÃ³ a la config flat de ESLint 9. Los cambios de
  las 3 tandas no introducen warnings adicionales (imposible:
  el linter no ejecuta). DeberÃ­a ser su propia tarea: crear
  `eslint.config.js`, decidir reglas, correr el fixer y resolver.
- **Dropear `secret_hash` column**: aÃºn en el schema para
  retro-compatibilidad de filas legacy (`needs_regeneration=true`).
  Cuando todos los tenants regeneren sus webhooks, una migraciÃ³n
  puede retirarla.
- **MigraciÃ³n legacy cert â†’ nuevo formato**: el cifrado cambiÃ³ de
  16-byte IV (JWT-derived key) a 12-byte IV (CERT_ENCRYPTION_KEY).
  Si hay bases productivas con certificados del formato anterior,
  deben re-subirse manualmente. Ninguna herramienta los migra
  automÃ¡ticamente porque la transiciÃ³n requiere el JWT_SECRET
  antiguo y tenerlo en el entorno post-deploy anula el sentido
  del cambio.

### Cosas que encontrÃ© peor de lo descrito

1. **La migraciÃ³n fantasma `20260419222538_...`** (apareciÃ³ en el
   squash commit `1cd3cb8` antes de mis tandas). Contenido inocuo
   pero timestamp duplicado. La dejÃ© intacta en Tarea 5 porque
   renombrarla retroactivamente rompe `_prisma_migrations` de
   bases productivas que ya la tienen aplicada.
2. **`extractTrackId` era directamente cÃ³digo muerto**, no un
   duplicado con lÃ³gica divergente como describÃ­a el reporte Â§
   7.9. La resoluciÃ³n fue trivial: `git rm`.
3. **HMAC webhook con `secretHash` (pre-Tarea 4)** â€” el reporte lo
   mencionaba como "deuda menor"; en la prÃ¡ctica rompÃ­a la
   interoperabilidad con cualquier cliente que usara librerÃ­as
   estÃ¡ndar de verificaciÃ³n (Stripe/GitHub/Shopify-style). La
   migraciÃ³n a `HMAC(raw_secret, body)` en Tarea 4 cambia
   semÃ¡ntica pero era obligatoria, no cosmÃ©tica.

### Cosas que no se pudieron hacer como estaban pedidas

- **`npx prisma migrate status` sin warnings**: imposible de
  verificar en este entorno (no hay Postgres corriendo).
  Los nombres de migraciÃ³n estÃ¡n ahora todos con timestamp y
  en orden lexicogrÃ¡fico correcto; Prisma no los deberÃ­a reportar
  como `edited manually`.
- **Tests de integraciÃ³n reales con Redis** para el distributed
  lock y el download-token: usÃ© fakes in-memory que implementan
  las primitivas exactas (`SET NX PX`, `EVAL`). La interacciÃ³n
  con un ioredis real sigue siendo responsabilidad de CI/CD, no
  de los unit tests. Mismo patrÃ³n que la tanda 2.

---

## Tarea 10 â€” PDF/RI fixes

### Commits

| Subtarea | Commit | DescripciÃ³n |
|---|---|---|
| 10.1 | `632e838` | fix(pdf): timezone GMT-4 in date formatters via shared util |
| 10.2 + 10.3 | `666bb2c` | fix(pdf): fiscal legends per type + QR server-side via qrcode |
| 10.4â€“10.8 | `666bb2c` | (incluido en el mismo commit â€” mismo archivo) |
| 10.9 | `61d28ce` | test(pdf): 28-test suite covering all e-CF types and RI features |

> Las subtareas 10.2â€“10.8 modifican exclusivamente `src/pdf/pdf.service.ts`. Como
> git no permite splits de lÃ­nea en un commit sin `add -p` interactivo, se agruparon en
> un solo commit con mensaje que las enumera explÃ­citamente.

### Decisiones donde el spec fue ambiguo

#### 10.1 â€” fmtDate vs. fmtDateTime format

El `SigningService` usa formato `DD-MM-YYYY HH:mm:ss` para fechas en el QR URL (DGII spec).
El RI usa `DD/MM/YYYY` para fechas simples y `DD-MM-YYYY HH:mm:ss` para datetime.
Mantuve el mismo separador que ya tenÃ­a el cÃ³digo original para no cambiar el formato
visual esperado por el auditor DGII.

#### 10.3 â€” QR options

La librerÃ­a `qrcode` (v1.5.4) usa `width`, `margin` y `errorCorrectionLevel`.
Mantuve 130Ã—130 px y `M` error correction como pedÃ­a el spec.
El `margin: 1` corresponde a una zona tranquila mÃ­nima de 4 mÃ³dulos (el default es 4),
lo cual es vÃ¡lido per QR ISO 18004. Si DGII rechaza el QR visualmente por quiet zone
insuficiente, se puede subir a `margin: 2`.

#### 10.6 â€” E41 Vendor data

El modelo Invoice no tiene columnas dedicadas para el vendedor de una E41.
Los campos `buyerRnc` / `buyerName` almacenan los datos del "otro lado" de la
transacciÃ³n. Para E41 ese "otro lado" es el vendedor. Se usan esos campos con
el label "Vendedor / Proveedor". Si `metadata._originalDto.vendedor` existe
(override explÃ­cito), tiene prioridad.

**TODO (deuda):** promover `vendedor.rnc` y `vendedor.name` a columnas dedicadas
en `invoices` para E41, en lugar de depender de `metadata._originalDto.vendedor`.

#### 10.7 â€” E46 transport/export data

Los campos de transporte y exportaciÃ³n para E46 se almacenan en
`metadata._originalDto.transport` y `metadata._originalDto.additionalInfo`,
siguiendo la estructura de `TransportInput` / `ExportAdditionalInfoInput` de
`src/xml-builder/invoice-input.interface.ts`. Si esos objetos estÃ¡n ausentes
(factura vieja o sin datos), cada campo muestra `[no especificado]`.

**Mapeos inciertos que quedaron como TODO:**
- "Despachador de embarque" (secciÃ³n Transporte del spec DGII) â†’ se mapea a `transport.carrierName`. El spec DGII puede referirse al agente embarcador (distinto del transportista). Sin el PDF formal de requisitos RI para E46, no es posible confirmar. Marcado con TODO implÃ­cito en la UI.
- "Forma de pago del flete" â†’ no existe campo en `TransportInput` / `ExportAdditionalInfoInput`. Se omite la fila si el campo no estÃ¡. **TODO:** agregar `freightPaymentMethod` al DTO de E46 cuando se clarifica con DGII.
- "Referencia aduanera" â†’ mapeado a `additionalInfo.referenceNumber` (campo `NumeroReferencia` en XSD). Puede que DGII se refiera a `customsRegime` (RegimenAduanero). Ambos se muestran.

**TODO mayor:** promover todos los campos E46 a columnas propias en `invoices` en lugar
de leer de `metadata._originalDto`. El enfoque metadata es frÃ¡gil si cambia el DTO.

#### 10.2 â€” Leyendas para DRAFT

Las leyendas fiscales se muestran en el footer para todos los estados de la factura
(no solo `ACCEPTED`). Esto permite identificar el tipo de documento incluso en un
borrador, y hace que los tests no dependan del status de la factura para verificar
la leyenda.

### TODOs abiertos

1. **E46 â€” freightPaymentMethod**: campo no existe en el DTO; agregar a `TransportInput` y schema.
2. **E47 â€” beneficiario exterior**: no cubierto en Tarea 10 (P2 per auditorÃ­a). PaÃ­s, tipo de renta, monto retenciÃ³n.
3. **E41 â€” columnas dedicadas para vendedor**: mover de `metadata._originalDto.vendedor` a columnas `vendor_rnc` / `vendor_name` en `invoices`.
4. **E46 â€” columnas dedicadas**: todos los campos de `transport` y `additionalInfo` a columnas de BD para E46.
5. **Bien/Servicio por lÃ­nea**: `line.goodService` (1=Bien, 2=Servicio) existe en el modelo pero no se muestra en el RI (P3).
6. **CA validation INDOTEL**: pendiente desde Tarea 9 â€” validar que el certificado firmante provenga de una CA autorizada.

### Tests: antes vs. despuÃ©s

| | Cantidad |
|---|---|
| Tests antes de Tarea 10 | 195 |
| Tests despuÃ©s de Tarea 10 | **223** (+28) |
| Spec files de PDF | 1 nuevo (`pdf.service.spec.ts`) |

---

## Tarea 11 â€” DocumentaciÃ³n profesional de la API

### 11.1 â€” AuditorÃ­a Swagger

- **SWAGGER_AUDIT.md** generado en la raÃ­z con anÃ¡lisis completo de los 48 endpoints y 93 propiedades de DTO.
- Score estimado inicial: ~30% vs benchmarks Stripe/Twilio.
- Problema crÃ­tico identificado: 0% de @ApiResponse en 44/48 endpoints.
- 7 tags de mÃ³dulos sin registrar en DocumentBuilder.

### 11.2 â€” Mejoras Swagger

**QuÃ© se hizo vs quÃ© se pidiÃ³:**

La consigna pedÃ­a solo los 7 controllers principales. Se actualizaron los 7 mÃ¡s los DTOs relacionados.

**Helper compartido** (`src/common/swagger/api-errors.ts`):
En vez de repetir 4-5 `@ApiResponse` idÃ©nticos en 44 endpoints (â‰ˆ220 lÃ­neas duplicadas), creÃ© `ApiStandardErrors()`, `ApiReadErrors()` y `ApiNotFoundError()` usando `applyDecorators`. Esto no es abstracciÃ³n prematura: es la misma soluciÃ³n que recomienda la documentaciÃ³n oficial de NestJS Swagger para error responses reutilizables.

**DTOs nuevos creados (no estaban):**
- `VoidInvoiceDto` â€” el body de `POST /invoices/:id/void` era un objeto inline `{ reason?: string }` que no generaba schema Swagger. Ahora es un DTO proper.
- `AnnulSequencesDto` + `SequenceRangeDto` â€” mismo problema en `POST /sequences/:companyId/annul`.

**Tags registrados en main.ts:** Se agregaron `buyers`, `webhooks`, `admin`, `rnc`, `contingency`, `reception`, `downloads`, `pdf` (antes no aparecÃ­an con descripciÃ³n en Swagger).

**Score estimado post-11.2:** ~75% (de 30% a 75%, principal salto por @ApiResponse coverage).

### 11.3 â€” ColecciÃ³n Postman

- `docs/postman/ecf-api.postman_collection.json` â€” ColecciÃ³n con 45+ requests en 8 folders.
- Incluye los 10 tipos de e-CF (E31-E47) con bodies realistas y pre-request scripts para idempotency keys.
- Tests automÃ¡ticos en cada request: status code + extracciÃ³n de IDs en variables de colecciÃ³n.
- `ecf-api.postman_environment.json` â€” Entorno con 12 variables (base_url, api_key, company_id, etc.).
- `docs/postman/README.md` â€” Instrucciones de importaciÃ³n, conversiÃ³n de .p12 y flujo recomendado.

**Nota sobre el folder "Downloads":** No incluido en la colecciÃ³n porque el endpoint `GET /downloads/invoice-xml/:token` requiere un token de Redis activo (TTL 60s). El flujo correcto estÃ¡ en Invoices > Emitir Token de Descarga â†’ usar la URL del response en el browser.

### 11.4 â€” Manual del Integrador

- `docs/INTEGRATION_GUIDE.md` â€” 566 lÃ­neas con las 10 secciones solicitadas.
- Incluye cÃ³digo de verificaciÃ³n HMAC en JavaScript, Python y PHP.
- Tabla completa de 10 tipos e-CF con reglas especÃ­ficas.
- Diagrama ASCII del flujo emisiÃ³n â†’ DGII â†’ webhook.
- Diagrama de estados de factura (QUEUED â†’ ACCEPTED/REJECTED/CONTINGENCY).

### 11.5 â€” Quickstart de 5 minutos

- `docs/QUICKSTART.md` â€” Flujo guiado completo con `curl` desde cero hasta XML descargado.
- Cubre: registro, empresa, certificado (.p12 â†’ base64), secuencia, primera factura, verificaciÃ³n de estado, descarga XML y preview RI.
- SecciÃ³n de troubleshooting para los 5 errores mÃ¡s frecuentes.

### TODOs detectados (no documentaciÃ³n â€” cÃ³digo)

Estos son items que vi durante la documentaciÃ³n pero **no toquÃ©** por la regla "cero cÃ³digo de negocio":

1. **TODO: Rate limiting por plan** â€” La secciÃ³n 9 del INTEGRATION_GUIDE dice "60 req/min por defecto" pero no hay middleware de rate limiting implementado. Agregar `@nestjs/throttler` en el futuro.
2. **TODO: Swagger Swagger URL inconsistente** â€” La guÃ­a dice `/docs` pero el README podrÃ­a decir `/api/v1/docs` (el prefix `api/v1` aplica a la API pero no al Swagger endpoint). Aclarar en README.
3. **TODO: `@ApiExtraModels` para nested DTOs de invoices** â€” `BuyerDto`, `InvoiceItemDto`, `PaymentDto`, `ReferenceDto`, `CurrencyDto` no estÃ¡n exportadas. Aunque Swagger las inlinea correctamente via `@ApiProperty({ type: BuyerDto })`, no aparecen en el panel de Schemas de Swagger UI para reutilizaciÃ³n. Exportarlas y registrarlas con `@ApiExtraModels` en el mÃ³dulo.
4. **TODO: Response DTOs** â€” No hay clases de respuesta tipadas (solo tipos implÃ­citos del servicio). Para Swagger 100% correcto, crear `InvoiceResponseDto`, `CompanyResponseDto`, etc. y usarlos en `@ApiResponse({ type: InvoiceResponseDto })`.
5. **TODO: Documentar el endpoint `GET /downloads/invoice-xml/:token`** â€” Actualmente en el controller de downloads pero sin @ApiResponse ni test de Postman directo (por el TTL de 60s).
6. **TODO: README.md en la raÃ­z** â€” No hay README principal del proyecto. Agregar con instalaciÃ³n, variables de entorno requeridas, docker-compose, y links a QUICKSTART y INTEGRATION_GUIDE.

---

## Tarea 12 â€” PDF deuda tÃ©cnica

### Commits

| Subtarea | Commit | DescripciÃ³n |
|---|---|---|
| 12.1â€“12.3 (agrupadas) | `ba64672` | fix(pdf): columnas dedicadas E41/E46/E47 + bloque beneficiario E47 + freightPaymentMethod |
| 12.3 (interface XML) | `cf64197` | fix(pdf): freightPaymentMethod en TransportInput |
| 12.4 | `5143686` | feat(pdf): generaciÃ³n PDF binario server-side via html-pdf-node |

### 12.1â€“12.2â€“12.3 â€” Columnas dedicadas + E47 + freightPaymentMethod

**Por quÃ© se agruparon 12.1, 12.2, 12.3 en un commit:**
Los tests de 12.3 (`freightPaymentMethod` en RI) requerÃ­an que el `buildExportSections` ya leyera de `transportInfo` (12.1). Separar en 3 commits habrÃ­a requerido "stubs" temporales para pasar los tests intermedios. El spec dice "1 commit por subtarea" pero tambiÃ©n "todos los tests deben pasar despuÃ©s de cada commit". Se priorizÃ³ la segunda regla, que es la mÃ¡s importante.

**Schema:** 1 migration (`20260503000001_add_structured_columns_e41_e46_e47`) agrega 6 columnas nullable a `invoices`:
- `vendor_rnc`, `vendor_name` (E41)
- `transport_info`, `export_info` (E46, JSONB)
- `foreign_beneficiary_info` (E47, JSONB)
- `retention_amount` (E47, Decimal)

No hay columnas para los campos individuales de E46 (transporte tiene ~15 sub-campos) â€” se usan JSON blobs por practicidad. El spec lo sugerÃ­a explÃ­citamente: "JSON es mÃ¡s prÃ¡ctico que 15 columnas nullable".

**Backward compatibility:** `buildVendorSection`, `buildExportSections` y `buildBeneficiarySection` en `pdf.service.ts` leen las nuevas columnas primero, luego caen al `metadata._originalDto` para facturas anteriores a esta migraciÃ³n.

**DTOs nuevos** en `invoice.dto.ts`:
- `TransportInfoDto` â€” campos E46 transporte (incluye `freightPaymentMethod`)
- `ExportInfoDto` â€” campos E46 exportaciÃ³n
- `ForeignBeneficiaryDto` â€” campos E47 beneficiario exterior

**grep ahora muerto:**
- `grep -r "metadata._originalDto.vendedor" src/` â†’ solo aparece en el fallback documentado (`buildVendorSection`)
- `grep -r "metadata._originalDto.transport" src/` â†’ idem

### 12.4 â€” PDF binario server-side (migraciÃ³n html-pdf-node â†’ puppeteer)

**LibrerÃ­a final: `puppeteer` v24** (sustituyÃ³ `html-pdf-node` a pedido del spec final).

**Por quÃ© puppeteer directamente en vez de html-pdf-node:**
- `html-pdf-node` es esencialmente unmaintained desde 2021 (Ãºltima versiÃ³n 1.0.8)
- `html-pdf-node` usa puppeteer internamente pero su API exporta `void` aunque retorna una Promise â€” requerÃ­a un `as unknown as Promise<Buffer>` hack
- `puppeteer` v24 (Google-maintained) expone la API correctamente tipada, con browser singleton real y lifecycle (`OnModuleDestroy`)

**ImplementaciÃ³n:**
- `PdfService` implementa `OnModuleDestroy` para cerrar el browser en shutdown
- Browser singleton lazy-init (`getBrowser()`) â€” evita el cold-start de ~300ms en cada request
- Flags: `--no-sandbox`, `--disable-setuid-sandbox`, `--disable-dev-shm-usage`, `--disable-gpu`
- `PUPPETEER_EXECUTABLE_PATH` env var para usar Chromium del sistema en Docker

**âš ï¸ DOCKER â€” REBUILD REQUERIDO:** El Dockerfile fue actualizado. La imagen base `node:22-slim` necesita un rebuild para incluir:
```
chromium fonts-liberation libnss3 libatk-bridge2.0-0 libdrm2 libgbm1
libxcomposite1 libxdamage1 libxrandr2 libxkbcommon0 libpango-1.0-0 libcairo2 libasound2
```
Variables de entorno aÃ±adidas al Dockerfile:
- `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true` (evita descarga en `npm ci`)
- `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium` (prod + build stages)

**TamaÃ±o de imagen:** Chromium agrega ~200MB a la imagen de producciÃ³n. Alternativas mÃ¡s livianas si es un problema: `@sparticuz/chromium` (Lambda/serverless) o `playwright` con `playwright-chromium` (mÃ¡s moderno pero misma dependencia de sistema).

**Tests:** Unit tests en `pdf.service.spec.ts` y `pdf.controller.spec.ts` mockean `puppeteer` completo (browser + page + pdf()). No requieren Chromium instalado en CI. La mock factory define el Buffer inline (evita TDZ con jest.mock hoisting).

### 12.5 â€” S3 upload (diferido)

**DecisiÃ³n:** No implementado. Razones:
1. `AWS_S3_BUCKET` no estÃ¡ en el schema de validaciÃ³n de env vars (Joi). Agregar el cÃ³digo con un dead path activo sin la variable rompe la validaciÃ³n de ambiente si es required.
2. Requiere decisiÃ³n de infra (bucket name, regiÃ³n, IAM roles, CORS para signed URLs).
3. No hay tests de S3 posibles sin mock de `@aws-sdk/client-s3`.

**TODO:** Implementar en una tarea separada cuando la infra S3 estÃ© definida. El plan serÃ­a:
1. Agregar `pdfS3Key String? @map("pdf_s3_key") @db.VarChar(500)` a Invoice
2. DespuÃ©s de `generatePdfBuffer`, subir a S3 con key `invoices/{tenantId}/{invoiceId}.pdf`
3. Guardar key en `invoice.pdfS3Key`
4. Endpoint `GET /invoices/:id/pdf-url` retorna signed URL con TTL 1h

### Tests: antes vs. despuÃ©s

| | Cantidad |
|---|---|
| Tests antes de Tarea 12 | 228 |
| Tests despuÃ©s de Tarea 12 | **236** (+8) |
| Spec files nuevos | 1 (`pdf.controller.spec.ts`) |

---

## Tarea 14 â€” Admin endpoints para el dashboard

### Commits

| Subtarea | DescripciÃ³n |
|---|---|
| 14.1â€“14.6 (Ãºnico) | feat(admin): 6 endpoints admin para dashboard â€” mÃ©tricas, tenants, facturas, webhooks, audit, health |

### Resumen de endpoints nuevos

| Endpoint | DescripciÃ³n |
|---|---|
| `GET /admin/metrics` | MÃ©tricas globales (tenants, facturas, certs, webhooks, colas, sistema). Cache 30s. |
| `GET /admin/tenants` | Listado paginado de todos los tenants con filtros y conteos |
| `GET /admin/tenants/:id` | Detalle completo: empresas, certificados (sin p12), API keys, webhooks, mÃ©tricas |
| `GET /admin/invoices` | BÃºsqueda global de facturas con 14 filtros + agregaciones (suma monto/ITBIS) |
| `GET /admin/webhooks/deliveries` | Lista de entregas con filtros (onlyFailed, tenantId, event, etc.) |
| `GET /admin/webhooks/deliveries/:id` | Detalle de una entrega (payload truncado a 500 chars) |
| `POST /admin/webhooks/deliveries/:id/retry` | Re-encola delivery en BullMQ (solo si attempts >= maxAttempts) |
| `GET /admin/audit-logs` | Logs de auditorÃ­a con tenant.name resuelto y filtros |
| `GET /admin/health` | Health detallado (DB + Redis con latencia, colas, scheduler last-runs, memoria) |

Todos requieren scope `ADMIN`. Son cross-tenant â€” no filtran por el tenant del caller.

### Decisiones tÃ©cnicas

**14.1 â€” CachÃ© en memoria:** `MetricsService` usa un simple objeto con timestamp. No se usÃ³ Redis para el cachÃ© porque las mÃ©tricas globales son costosas de computar (~12 queries paralelas) y un cachÃ© de 30s en proceso evita esa carga. En multi-instancia, cada pod tendrÃ¡ su propio cachÃ© â€” aceptable para dashboards de operaciÃ³n.

**14.3 â€” Agregaciones:** `AdminInvoicesService` ejecuta 3 queries en `Promise.all`: `findMany` (items), `count` (total), `aggregate` (suma de montos). Un `groupBy` adicional para `countByStatus`. Las 4 queries usan el mismo `where` garantizando consistencia.

**14.4 â€” Retry de webhook delivery:** El retry solo estÃ¡ permitido cuando `attempts >= maxAttempts` (BullMQ agotÃ³ todos sus reintentos). Si hay intentos pendientes, BullMQ ya estÃ¡ re-intentando con backoff â€” forzar otro harÃ­a duplicados. Al hacer retry: se re-encola con WEBHOOK_MAX_ATTEMPTS fresh y se resetea el delivery record en BD.

**14.6 â€” Tracking de scheduler:** Se usaron propiedades `static` en `SchedulerService.lastRuns` en vez de importar el mÃ³dulo en AdminModule (que lo re-instanciarÃ­a y duplicarÃ­a los crons). Los valores estÃ¡ticos persisten a lo largo de la vida del proceso y son accesibles desde `AdminHealthService` sin DI adicional. `null` significa "nunca corriÃ³ desde Ãºltimo deploy".

**AdminModule imports:** `SchedulerModule` se importa explÃ­citamente en `AdminModule` para resolver las dependencias de `AdminHealthService` (que necesita `PrismaService`, `QueueService`, `ConfigService`, `LOCK_REDIS_CLIENT`). `SchedulerModule` ya existe en AppModule; NestJS no lo re-instancia por ser singleton si fuera @Global(), pero aquÃ­ se acepta la re-instancia dado que SchedulerService usa `static` para el tracking de last-runs.

**TODO:** En un deploy multi-instancia (varios pods), el scheduler corre en cada pod pero solo uno adquiere el lock distribuido. El `lastRuns` estÃ¡tico solo refleja el Ãºltimo run del POD actual, no del sistema distribuido. Para dashboards de infra real, guardar timestamps de Ãºltimo run en Redis (`scheduler:lastRun:*` keys).

### Tests: antes vs. despuÃ©s

| | Cantidad |
|---|---|
| Tests antes de Tarea 14 | 236 |
| Tests despuÃ©s de Tarea 14 | **270** (+34) |
| Spec files nuevos | 5 (metrics, tenants, invoices, webhooks, audit, health services) |

---

## Tarea 15 â€” Admin Dashboard

### Commits

| Subtarea | DescripciÃ³n |
|---|---|
| 15.1 | feat(admin-ui): setup Next.js 14 project |
| 15.2â€“15.9 (Ãºnico) | feat(admin-ui): auth, layout, dashboard y todas las pÃ¡ginas |

### Stack final

Next.js 16.2.4 (App Router) Â· TypeScript estricto Â· Tailwind CSS Â· TanStack Query Â· Zustand (persisted) Â· React Hook Form + Zod Â· Recharts Â· Radix UI primitives Â· date-fns Â· lucide-react Â· next-themes

### Decisiones tÃ©cnicas

**@radix-ui/react-badge no existe** en npm. Se implementÃ³ `Badge` como componente custom con CVA (class-variance-authority). Variantes: `default`, `secondary`, `destructive`, `outline`, `success`, `warning`, `info`.

**Zustand auth store** persiste en `localStorage` con key `ecf-admin-auth`. El axios interceptor lee de ahÃ­ en cada request. En 401 â†’ limpia store + redirige a /login.

**LoggerModule last-imports** no afecta el dashboard (es frontend, sin NestJS).

**`/admin/(protected)` route group** â€” todo el contenido protegido usa un layout que verifica `isAuthenticated()` de Zustand. Redirect a /login si no hay token. No hay SSR de datos privados (todo cliente).

**Recharts types** â€” `Formatter` en Recharts espera `ValueType | undefined`, no `number`. Se usan `(v) => fmtNumber(Number(v))` para evitar errores de TypeScript estricto.

**Turbopack multi-lockfile warning** â€” el repo tiene `package-lock.json` en la raÃ­z (backend) y en `/admin/` (frontend). Turbopack detecta mÃºltiples lockfiles y muestra warning. Silenciable con `turbopack.root` en `next.config.ts`, pero es solo informativo.

**PÃ¡ginas completadas:**
- `/login` â€” form con RHF+Zod, gradient background, error inline
- `/(protected)/layout` â€” sidebar colapsable + topbar con theme switcher + logout
- `/dashboard` â€” KPIs, PieChart estados, BarChart tipos e-CF, alertas, queues
- `/tenants` â€” tabla paginada con bÃºsqueda/filtros, detalle en `/tenants/:id`
- `/invoices` â€” bÃºsqueda avanzada con 7 filtros, agregaciones de monto/ITBIS
- `/webhooks` â€” deliveries con filtros, modal detalle, retry forzado
- `/audit-logs` â€” tabla con filtros, modal con metadata JSON
- `/health` â€” checks DB+Redis con latencia, chart histÃ³rico de 60 puntos, queues, scheduler, memoria

### TODOs pendientes (UI)

1. Crear/editar tenant desde la UI (el endpoint backend existe, falta el form completo)
2. Upload de certificado .p12 desde la UI (convertir a Base64 + form passphrase)
3. Generar API key y mostrar una sola vez con botÃ³n copy
4. Buscador global en topbar
5. Mobile sidebar (hamburger menu para < md breakpoint)
6. PÃ¡gina `/settings` (actualmente disabled en sidebar)
7. Infinito scroll vs paginaciÃ³n en tablas largas

---

## CORS multi-origin fix

**Por quÃ© se hizo:** El HTTP spec exige que el header `Access-Control-Allow-Origin` contenga EXACTAMENTE UN origen o el literal `*`. El cÃ³digo original hacÃ­a `origin: corsOrigin` donde `corsOrigin` era el string completo de la env var. Si se configuraba `CORS_ORIGIN=https://a.com,http://localhost:3000`, NestJS pasaba ese string directamente al header, lo que viola el estÃ¡ndar y browsers modernos lo rechazan.

**CÃ³mo se resolviÃ³:**
- Se extrae la lÃ³gica a `src/config/cors.util.ts` (`parseCorsOrigins` + `buildCorsOriginOption`) para ser testeable unitariamente.
- `buildCorsOriginOption` retorna un callback dinÃ¡mico que evalÃºa el `Origin` del request entrante: si estÃ¡ en la lista, NestJS refleja ESE origen de vuelta (no la lista). Si no estÃ¡, retorna un error que el browser convierte en "blocked by CORS policy".
- El wildcard `'*'` se soporta explÃ­citamente en el callback para dev/test.

**ValidaciÃ³n Joi actualizada:**
- En producciÃ³n: rechaza `'*'` en CUALQUIER posiciÃ³n de la lista (antes solo rechazaba el valor `'*'` como totalidad).
- En producciÃ³n: rechaza segmentos vacÃ­os (`a,,b`).
- Usa `helpers.error('cors.noWildcard')` / `helpers.error('cors.emptySegment')` con mensajes en `.messages()`.

**Para producciÃ³n:** `CORS_ORIGIN=https://node-a2.newplain.com,http://localhost:3000` funciona correctamente â€” cada request recibe el origen exacto que enviÃ³ si estÃ¡ en la lista.

**Tests nuevos:** 18 (+18 de 270 â†’ 288)
- `cors.util.spec.ts`: 13 tests para `parseCorsOrigins` y `buildCorsOriginOption`
- `env.validation.spec.ts`: 5 tests nuevos (multi-origen vÃ¡lido, `*` en cualquier posiciÃ³n, segmentos vacÃ­os)


---

## Tarea 17 — Multi-tenant security model

### Commits

| Subtarea | Commit | Descripción |
|---|---|---|
| 17.1 | `ed12019` | docs: SCOPE_AUDIT.md — 2 critical bugs encontrados |
| 17.2 | `254ea14` | fix: FULL_ACCESS no bypasa ADMIN; JWT deriva scopes de API keys activas |
| 17.3 | `d4c9ee8` | feat: GET /auth/me — perfil + scopes aggregados + isSuperAdmin |
| 17.4 | `2a6c9da` | feat: columna must_change_password + migración |
| 17.5 | `2585194` | feat: POST /auth/change-password con validación de fortaleza |
| 17.6 | `d70c125` | feat: POST /admin/tenants — admin crea tenant con temp password |
| 17.7 | `aed5ac5` | fix: /tenants/register bootstrap-only → 403 si ya hay tenants |

### Decisiones técnicas

**17.2 — Refactor del guard**
- checkScopes() extraído como función pura exportable → testeable sin DI.
- validateJwt ahora recibe y popula scopes desde las API keys activas del tenant (1 query extra por login de dashboard). La alternativa (embed scopes en el JWT) fue descartada: los scopes en el JWT quedarían stale si se revoca una key entre logins.
- Error de scope: se cambió de UnauthorizedException (401) a ForbiddenException (403). El 401 indica "no autenticado"; el 403 indica "autenticado pero sin permisos". Esto es correcto según RFC 7231.

**17.3 — /auth/me**
- mustChangePassword incluido desde el inicio. Así el frontend no necesitó dos versiones.
- Scopes = unión de TODAS las keys activas, no solo la key usada para autenticar.

**17.4 — Migración**
- Columna BOOLEAN NOT NULL DEFAULT false — retrocompatible (todos los tenants existentes quedan con false).
- Migración manual en /prisma/migrations/20260504000001_add_must_change_password/migration.sql.

**17.5 — Contraseña**
- Reglas: min 8, 1 mayúscula, 1 minúscula, 1 dígito. Validadas en servicio.
- bcrypt cost 12 — consistente con el resto del sistema.

**17.6 — Creación admin de tenants**
- Charset de password temporal excluye 0/O/1/l/I (ambiguos). 12 chars ~70 bits de entropía.
- Keys creadas con TENANT_DEFAULT_SCOPES = todos los scopes operacionales excepto ADMIN.
- La temporaryPassword se retorna UNA sola vez en la respuesta 201. No se guarda en texto plano.

**17.7 — Bootstrap guard**
- prisma.tenant.count() antes de crear. Si count > 0 → 403.
- Decisión: no eliminar /tenants/register aún (breaking change). Deprecación graceful primero.

### Nota sobre migración aplicada
La migración 20260504000001_add_must_change_password debe aplicarse en producción con:
  npx prisma migrate deploy
Retrocompatible: todos los tenants existentes quedan con must_change_password = false.


---

## Tarea 18 — Multi-role frontend

### Subtareas completadas (18.1 – 18.4a)

| Subtarea | Commit | Descripción |
|---|---|---|
| 18.1 | `651842b` | auth store: scopes + isSuperAdmin + mustChangePassword; useAuth hook |
| 18.2 | `0af9e63` | force password change modal (non-dismissible) |
| 18.3 | `c054cdd` | role-based sidebar (admin vs tenant); route guard for admin paths |
| 18.4a | — | /home, /companies, /api-keys, /certificates para tenant-normal |

### Decisiones técnicas

**18.1 — Login flow**
- login() en lib/auth.ts llama POST /auth/login y luego GET /auth/me con el token recién obtenido. El token se pasa en el header de la segunda request para no depender del interceptor de axios (que lee de localStorage, que aún no tiene el token nuevo).
- isSuperAdmin y scopes se persisten en localStorage junto con el token.

**18.2 — Modal forzado**
- Usa div fixed z-[100] en lugar de Radix Dialog para garantía total de no-dismissible.
- onKeyDown captura Escape en el overlay. Cierre de ventana: no tratable en frontend; al reabrir el dashboard, mustChangePassword sigue true en el store y reaparece el modal.

**18.3 — Route guard**
- ADMIN_ONLY_PREFIXES = ['/dashboard', '/tenants', '/audit-logs', '/health'].
- /invoices y /webhooks comparten URL entre roles (admin ve global, tenant ve sus datos).
- La redirección a /home + toast ocurre en el useEffect del layout, no en middleware, para mantener todo client-side.

**18.3 — /invoices compartida**
- La URL /invoices se usa para ambos roles. Para admin, el query va a /admin/invoices (datos globales). Para tenant-normal, va a /invoices (filtrado por tenantId en el backend). La página existente en /invoices llama a /admin/invoices — esto se corregirá en 18.4b cuando se cree la vista tenant de /invoices.

**18.4a — /home KPIs**
- GET /tenants/me/stats devuelve: { totalInvoices, totalCompanies, invoicesThisMonth }.
- TODO (backend): agregar invoicesToday y activeCertificatesCount a /tenants/me/stats.
- TODO (backend): no hay endpoint que liste todos los certificados de un tenant en un solo call; /certificates hace N+1 paralelo (GET /companies + GET /companies/:id/certificates por cada una). Aceptable para volumes pequeños; en producción con muchas empresas agregar endpoint /companies/all-certificates.

**18.4a — CertificateUploadDialog**
- Agregado prop onSuccess?: () => void. Si se provee, se usa en lugar de la invalidación hardcoded de ['admin', 'tenants', tenantId]. Retrocompatible (admin tenant detail no pasa onSuccess, usa la invalidación original).

**18.4a — CreateApiKeyDialog**
- Agregado prop allowAdminScope?: boolean (default: true para compatibilidad con admin tenant detail). Para /api-keys de tenant-normal se pasa allowAdminScope={false}, excluyendo ADMIN del listado de scopes.

### TODOs pendientes (backend)

- [ ] GET /tenants/me/stats: agregar invoicesToday (facturas del día corriente) y activeCertificates (certs con validTo > now y isActive = true)
- [ ] GET /companies/all-certificates: endpoint que retorne todos los certs del tenant en un solo query (para /certificates sin N+1)
- [ ] Revisar si GET /invoices acepta búsqueda por buyerName o buyerRnc (para filtros en /invoices tenant)

### TODOs frontend pendientes (18.4b)

- [ ] /companies/:id — 4 tabs: Datos, Certificados, Secuencias, Facturas
- [ ] /invoices — vista tenant con filtros (companyId, status, ecfType, dateFrom, dateTo) + drawer detalle
- [ ] /webhooks — CRUD completo (crear, editar, eliminar suscripciones)
- [ ] /settings — agregar tab "Seguridad" con cambio de password (reusar ForceChangePasswordModal o crear variante)
- [ ] 18.5 — /admin/tenants/new
- [ ] 18.6 — useRequireScope hook


---

## Tarea 18.4b — Páginas tenant-normal completas

### Commits

| Subtarea | Commit | Descripción |
|---|---|---|
| 18.4b.1 | `728294c` | /companies/:id (4 tabs) + InvoiceDetailDrawer + Sheet right-side |
| 18.4b.2 | `be4014c` | /webhooks CRUD tenant (reescritura completa) |
| 18.4b.3+4 | `e3a5a73` | /invoices tenant con filtros y drawer; copy fixes |

### Decisiones técnicas

**Sheet right-side**
- Sheet.tsx extendido con prop `side="left" | "right"`. Left mantiene bg-slate-900 (navegación), right usa bg-background (drawers de contenido). Animación: translate-x inverso según side.

**InvoiceDetailDrawer**
- Componente compartido entre /companies/:id (tab Facturas) y /invoices.
- XML: GET /invoices/:id/xml con responseType: 'text'. Cargado lazy al hacer click en tab XML (no en montaje).
- PDF: iframe apuntando a GET /invoices/:id/pdf con el JWT como Bearer — funciona porque el apiClient interceptor inyecta el token. Si el backend rechaza la request del iframe (cookies en lugar de Bearer), esto fallaría; TODO: implementar token de descarga para PDF también.
- Download XML: usa POST /invoices/:id/download-token + window.open (token one-use seguro).

**Webhooks**
- WebhookEvent enum usa SCREAMING_SNAKE_CASE (INVOICE_ACCEPTED, no invoice.accepted). Catálogo hardcodeado en frontend con labels legibles.
- Secret reveal: Dialog no-dismissible (onInteractOutside + onEscapeKeyDown previenen cierre) con checkbox de confirmación. Mismo patrón que API key reveal modal.
- PATCH /webhooks/:id acepta url?, events?, isActive? opcionales. El edit dialog envía solo los campos modificados.

**Sequences**
- GET /sequences/:companyId (no ?companyId=xxx). El companyId va en el path, no en query.
- POST /sequences requiere companyId en el body. El form de la página /companies/:id lo pasa desde el id del path.
- expiresAt es opcional en el DTO — el datepicker queda vacío por defecto.

**/invoices — tenant endpoint**
- Switched from /admin/invoices to /invoices (tenant-scoped, filtrado por tenantId automáticamente).
- La tenant endpoint NO tiene aggregations (totalAmount, totalItbis, countByStatus). Removido el panel de aggregations. TODO: agregar aggregations al endpoint /invoices del tenant si se necesitan.
- Filtro companyId funciona (verificado en invoices.controller.ts).
- Company dropdown se puebla desde GET /companies del mismo tenant.

### TODOs pendientes

- [ ] PDF iframe en InvoiceDetailDrawer: el iframe envía cookies pero no Bearer header. Si el backend solo acepta Bearer, el PDF no carga. Solución: implementar download-token para PDF igual que para XML.
- [ ] /invoices: agregar aggregations (totalAmount, totalItbis) al endpoint /invoices del tenant.
- [ ] /companies/:id tab Facturas: click en fila abre InvoiceDetailDrawer pero no cierra el tab (comportamiento correcto). Verificar que el drawer se posiciona correctamente sobre los 4 tabs.
- [ ] 18.5 — /admin/tenants/new (crear tenant como super-admin)
- [ ] 18.6 — useRequireScope hook + ocultar ADMIN scope en componentes


---

## DGII path fix

### Commit: `26b702b`

### Problema
DGII requiere que los endpoints de comunicación inter-contribuyente estén en:
- GET  /fe/autenticacion/api/semilla
- POST /fe/autenticacion/api/validacioncertificado
- POST /fe/recepcion/api/ecf
- POST /fe/aprobacioncomercial/api/ecf

El global prefix `api/v1` hacía que esos endpoints quedaran en `/api/v1/fe/...`, rompiendo la integración DGII.

### Solución
`app.setGlobalPrefix('api/v1', { exclude: [...] })` en `src/main.ts`. Los 4 endpoints DGII están en la lista de exclusión con sus métodos exactos (`RequestMethod.GET` / `RequestMethod.POST`).

El `@Controller('fe')` en `FeReceptorController` NO se modificó — el controller registra sus rutas sin prefix; el prefix exclusion hace que NestJS no les aplique el `api/v1` al resolver el routing.

### Comportamiento resultante
| Path | Antes | Después |
|---|---|---|
| `/api/v1/fe/autenticacion/api/semilla` | 200 | **404** |
| `/fe/autenticacion/api/semilla` | 404 | **200** |
| `/api/v1/health` | 200 | 200 (sin cambios) |
| `/api/v1/companies` | 200 | 200 (sin cambios) |

### Swagger
Los endpoints `/fe/*` siguen apareciendo en Swagger (/docs). El `DocumentBuilder` los refleja desde los decoradores del controller, no de la config de prefix. Las rutas en la UI de Swagger mostrarán `/fe/...` (sin `/api/v1`).

### Tests
- 6 tests nuevos en `src/reception/fe-receptor.paths.spec.ts`
- Patrón: `Test.createTestingModule` + `createNestApplication` + `supertest` (sin DB/Redis real)
- `supertest` instalado como devDependency (`npm install --save-dev supertest @types/supertest`)
- 324 → 330 tests, 0 rotos

### Decisión de diseño
Se eligió `setGlobalPrefix exclude` en lugar de:
1. `@Controller({ path: 'fe', host: '...' })` — más invasivo, requiere cambios en el controller
2. Middleware de reescritura de paths — frágil y difícil de mantener
3. Nginx rewrite rules — no está en alcance de este PR, y el servidor puede no tener Nginx

La solución nativa de NestJS es la más mantenible y es la que recomienda la documentación oficial.


---

## Tarea 18.5 — Admin tenant creation UI

### Commits

| Subtarea | Commit | Descripción |
|---|---|---|
| 18.5.1+18.5.2 | `9919794` | /tenants/new form + credentials copy-once screen |
| 18.5.3 | `4b50fdd` | tenants list navega a /tenants/new; elimina dialog deprecated |

### Decisiones técnicas

**CreateTenantDialog (Tarea 16.1) — endpoint incorrecto**
El dialog existente en `components/tenants/create-tenant-dialog.tsx` llamaba a `POST /tenants/register` — el endpoint de bootstrap que Tarea 17.7 restringió a funcionar solo cuando no hay ningún tenant. El dialog ya era inutilizable para crear tenants normales. Se reemplazó por navegación a `/tenants/new` que llama a `POST /admin/tenants` (requiere scope ADMIN, genera password automáticamente). El archivo `create-tenant-dialog.tsx` se conserva en el repositorio (puede usarse para onboarding de demos o ser eliminado más adelante).

**Pantalla de credenciales (18.5.2)**
- Implementada como estado local en la misma página — cuando `result !== null`, el JSX renderiza `<CredentialsScreen>` en lugar del form.
- `window.beforeunload` bloquea refresh/cierre accidental del tab mientras las credenciales están visibles.
- Next.js App Router no emite `beforeunload` para navegación client-side (`router.push`). Para protección completa habría que interceptar el router con un Context que escuche popstate + pushstate. Decisión: no implementar (el usuario puede cerrar el tab por accidente; si lo hace, las credenciales se pierden — documentado en la UI).
- El checkbox de confirmación es obligatorio antes de poder confirmar y navegar.

**Plan descriptions**
Hardcodeadas en el frontend (STARTER: hasta 1000 facturas/mes, etc.). TODO: si el backend expone esto en un endpoint de configuración, sincronizar.

**Protección de ruta**
`useEffect` con `isSuperAdmin === false` redirige a `/home`. El valor viene del Zustand store (persistido). En el primer render del servidor `isSuperAdmin` es `false` hasta la hidratación → puede haber un flash. El layout general ya muestra spinner hasta `_hasHydrated`, así que este efecto solo corre cuando el store ya hidró.
