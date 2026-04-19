# FIX_NOTES — Implementación de Tareas 1, 2, 3

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

## Cosas que NO hice (fuera de alcance)

- No renombré las migraciones `add_buyers` / `add_received_documents`
  (mencionadas en §5.4 del reporte) — no era parte de ninguna tarea.
- No toqué `CORS_ORIGIN` / `JWT_SECRET` / `.env.example` (recomendaciones
  3 y 5 del reporte).
- No desacoplé `CERT_ENCRYPTION_KEY` del `JWT_SECRET`.
- No agregué logging estructurado (`pino`) ni métricas Prometheus.
- No instalé `@nestjs/schedule` para reemplazar los `setInterval` del
  scheduler.

Todos esos son seguimientos válidos pero ajenos a las 3 tareas pedidas.
