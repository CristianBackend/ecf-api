# AUDITORÍA DE SOLO LECTURA — ecf-api

**Fecha:** 2026-07-01
**Alcance:** Código, esquema Prisma, migraciones (como archivos) y tests en `main` HEAD (`29dade3`).
**Explícitamente EXCLUIDO:** estado de la BD local (vacía/desactualizada). Ningún conteo, drift de migración ni dato proviene de la BD local. Producción fue auditada por separado; aquí solo se citan sus hallazgos (H3/H5/H6) como síntoma a explicar desde el código.
**Referencias oficiales usadas:** los 10 XSD DGII en `xsd/` (e-CF-31…47), `xsd/ANECF.xsd`, `xsd/ACECF.xsd`, `xsd/ARECF.xsd`, `xsd/RFCE-32.xsd`; la Descripción Técnica DGII (v1.6, citada en el propio código); la librería `dgii-ecf@1.8.0`.

> **Nota de método sobre causalidad:** donde un síntoma de producción (p. ej. "26 secuenciales sin factura") podría tener varias causas, se listan los **mecanismos de código** que lo producen con evidencia `archivo:línea`, pero NO se afirma cuál ocurrió en producción (la BD no fue consultada). Esos casos se marcan como *candidato*.

---

## Resumen de hallazgos por severidad

| # | Severidad | Título | Frente |
|---|---|---|---|
| C1 | **CRÍTICO fiscal** | El consumo de secuencial NO es transaccional con la persistencia de la factura → huecos de eNCF que la propia lógica ANECF no puede anular | 2 |
| I1 | IMPORTANTE | El pipeline asíncrono (processors + contingencia) NO escribe audit log en ninguna transición de estado; solo se registra `queued` | 2 |
| I2 | IMPORTANTE | `encfOverride` avanza `currentNumber` con `Math.max` dejando huecos permanentes (solo CERT/DEV) | 2 |
| M1 | MENOR | E46 `<TotalITBIS>0.00</TotalITBIS>` solo puede originarse por override de certificación, no por cálculo | 3 |
| M2 | MENOR | ANECF: sin validación defensiva del límite `maxOccurs=10` de `<Anulacion>` | 4 |
| M3 | MENOR | Rama `feature/billing-v2` diverge fuertemente (−3504 líneas) y está marcada "DO NOT MERGE"; riesgo de drift | 1 |
| S1 | SIN ANCLA | ¿Debe reutilizarse el mismo eNCF al reenviar un e-CF RECHAZADO, o consumir uno nuevo? El código nunca reenvía y no reutiliza | 2 |
| S2 | SIN ANCLA | Supuestos sensibles a versión de la Descripción Técnica (URLs, estados, QR, 72h, umbral 250K) — inventario para diff manual | 5 |

**Frentes sin hallazgos negativos (resultado positivo, verificado):**
- **Frente 3** — builders XML de la sección Totales: **CUMPLEN** el XSD campo por campo, tipo por tipo. La "discrepancia" de producción (E46 emite `TotalITBIS`, E43/44/47 lo omiten) es **comportamiento XSD-correcto**, no un defecto.
- **Frente 4** — ANECF: **implementado de extremo a extremo** y conforme a `xsd/ANECF.xsd` elemento por elemento. `sequence_annulments` vacío en producción = feature no usada, NO no implementada.

---

# CRÍTICO fiscal

## C1 — El consumo de secuencial NO es transaccional con la persistencia de la factura

**Descripción.**
En `InvoicesService.create` el eNCF se asigna llamando a `getNextEncf` **fuera** de la transacción que inserta la factura. `getNextEncf` abre **su propia** `$transaction`, incrementa `current_number` y **hace commit inmediatamente**. Solo *después* se construye el XML y se abre una **segunda** transacción que inserta el `invoice`. Si algo entre ambos commits falla, el secuencial queda consumido en BD **sin que exista fila `invoice`**.

**Evidencia (archivo:línea).**
- Asignación del eNCF (commit propio, antes de todo): `src/invoices/invoices.service.ts:164`
  ```ts
  const encf = await this.sequencesService.getNextEncf(tenantId, dto.companyId, ecfType, dto.encfOverride);
  ```
- `getNextEncf` corre y COMMITEA en su propia transacción, incrementando `current_number`: `src/sequences/sequences.service.ts:147` (apertura `$transaction`), `:207` (`nextNumber = currentNumber + 1`), `:221-224` (`tx.sequence.update` de `currentNumber`).
- Construcción de XML posterior (puede lanzar): `src/invoices/invoices.service.ts:214`.
- **Segunda** transacción, separada, que inserta la factura + líneas + audit + billing: `src/invoices/invoices.service.ts:224` (`this.prisma.$transaction`), `:225` (`tx.invoice.create`).
- No existe compensación/rollback del secuencial si la 2.ª transacción falla (revisado todo `invoices.service.ts`; no hay `try/catch` que revierta `current_number`).

**Rutas concretas de fallo que producen el hueco (todas alcanzables):**
1. **Cuota agotada en el límite:** `usageService.incrementUsage(...)` corre DENTRO de la 2.ª tx (`invoices.service.ts:334`) y lanza `ForbiddenException` cuando la cuota está agotada (`src/billing/usage.service.ts:97-100`). La 2.ª tx hace rollback → factura no creada, pero el eNCF ya fue commiteado en `getNextEncf`.
2. **Carrera de idempotencia:** dos requests concurrentes con el mismo `idempotencyKey` pasan ambos el chequeo previo (`invoices.service.ts:81`), ambos consumen un eNCF distinto en `getNextEncf`, y al insertar uno gana y el otro viola el índice único `idempotency_key` (migración `20260608130000_idempotency_key_per_tenant`) → rollback → eNCF consumido sin factura.
3. **Cualquier throw de `buildEcfXml`** (`invoices.service.ts:214`) tras el commit de `getNextEncf`.
4. **Cualquier error de BD** en `invoice.create`/`invoiceLine.createMany`/`auditLog.create` dentro de la 2.ª tx.

**Fuente oficial.**
`xsd/ANECF.xsd` (formato de anulación de rangos e-NCF) y la Descripción Técnica: los secuenciales autorizados por DGII deben terminar **emitidos** o **anulados vía ANECF**. Un hueco que no es ni lo uno ni lo otro no tiene representación válida. Agravante: **la propia lógica ANECF del sistema no puede anular ese hueco**, porque rechaza cualquier rango cuyo extremo inferior sea `<= currentNumber` (`src/sequences/sequences.service.ts:389-395`, mensaje "incluye secuencias ya utilizadas… Solo se pueden anular secuencias NO utilizadas"). Como `current_number` ya avanzó por encima del hueco, ese número queda **permanentemente irrecuperable**: ni factura, ni anulable.

**Impacto.**
- Huecos en la numeración de eNCF que DGII fiscaliza y que el sistema no puede regularizar por su propia vía (ANECF).
- **Candidato** a la causa del hallazgo de producción H3/H6 (E31 `current=34`, 8 facturas todas ACCEPTED, ~26 secuenciales sin factura). *No confirmado*: no se consultó la BD. Nótese que **rechazos NO explican el síntoma** — las facturas RECHAZADAS/ERROR/CONTINGENCY/VOIDED **permanecen como filas** (no se borran; ver C1-corolario), así que 26 "faltantes" no pueden ser rechazos; apuntan a fallos pre-inserción como los de arriba (o a I2 en CERT).

**C1-corolario (dato de respaldo, no defecto): las facturas nunca se borran.**
No existe ninguna llamada `invoice.delete`/`deleteMany` en todo `src/` (verificado por grep; los únicos deletes son de `dgiiToken`, `webhookSubscription`, `step3AcecfDocument`). Por tanto, una factura RECHAZADA por DGII **se conserva** con `status=REJECTED` (`src/queue/ecf-processing.processor.ts:269-278`, `src/queue/status-poll.processor.ts:154-162`), **no** se le sobreescribe el eNCF ni se reintenta con un secuencial nuevo automáticamente. Esto es consistente con "no reutilizar un eNCF rechazado", pero implica que todo hueco observado NO proviene de rechazos.

---

# IMPORTANTE

## I1 — El pipeline asíncrono no escribe audit log en ninguna transición de estado

**Descripción.**
Todo el ciclo de vida real de la factura (firma → envío DGII → ACCEPTED/REJECTED/CONDITIONAL/ERROR/CONTINGENCY → reintentos → contingencia) ocurre en los *queue processors* y en `ContingencyService`. Ninguno de ellos escribe en `audit_logs`: solo actualizan `invoice.status` y emiten logs `pino` (no persistidos como auditoría). El **único** evento de auditoría del ciclo normal es `queued`, escrito en la creación.

**Inventario COMPLETO de escrituras a `auditLog` en el código (grep `auditLog.create` / `createAuditLog`):**

| Acción | Archivo:línea | ¿En el ciclo automático? |
|---|---|---|
| `queued` | `src/invoices/invoices.service.ts:307-317` | Sí (creación) — **único que se dispara siempre** |
| `status_updated` | `src/invoices/invoices.service.ts:418` | **No** — solo por el endpoint MANUAL `pollStatus` |
| `voided` | `src/invoices/invoices.service.ts:594` | No — solo anulación manual |
| `sequences_annulled` | `src/sequences/sequences.service.ts:537-551` | No — solo ANECF manual |
| `commercial_approval_sent` / `commercial_rejection_sent` | `src/reception/reception.service.ts:278-283` | No — recepción |
| `plan_assigned` | `src/billing/company-billing.service.ts:64-69` | No |
| `certificate_uploaded` | `src/certificates/certificates.service.ts:147-152` | No |
| `CERT_KEY_ROTATED` | `src/certificates/key-rotation.ts:122-127` | No |
| `company_created` | `src/tenants/companies.service.ts:71-76` | No |
| `dgii_env_changed` | `src/tenants/companies.service.ts:169-174` | No |

**Ausencia probada de audit log en el pipeline automático:**
- `EcfProcessingProcessor.process` actualiza estado (`src/queue/ecf-processing.processor.ts:172-180`, `:269-278`, `:370-376`) **sin** un solo `auditLog.create`.
- `StatusPollProcessor.process` idem (`src/queue/status-poll.processor.ts:154-162`, `:108-114`, `:122-128`, `:242-251`) sin auditoría.
- `ContingencyService.processQueue` idem (`src/contingency/contingency.service.ts:226-234`, `:295-306`, `:330-336`) sin auditoría.

**Fuente oficial.**
Descripción Técnica DGII — requisito de **conservación y trazabilidad** de los e-CF durante 10 años (constante `STORAGE_RETENTION_YEARS = 10`, `src/xml-builder/ecf-types.ts:258`, anotada "per DGII"). La transición de estados (En Proceso → Aceptado/Rechazado) es parte del expediente del comprobante.

> Anclaje: el *requisito de trazabilidad/conservación* es de fuente DGII; que dicha trazabilidad deba materializarse específicamente en la tabla `audit_logs` es criterio operativo interno. Por eso se clasifica IMPORTANTE (operativo con anclaje de trazabilidad), no CRÍTICO fiscal.

**Impacto.**
Explica exactamente el hallazgo de producción ("`audit_logs` solo contiene `queued`, 655 eventos"). No hay rastro persistido de cuándo/por qué una factura fue aceptada o rechazada por DGII salvo los campos `dgiiResponse`/`dgiiMessage`/`dgiiTimestamp` del propio `invoice` (que se sobrescriben en cada actualización). Auditoría fiscal y soporte a disputas quedan debilitados.

## I2 — `encfOverride` avanza `currentNumber` con `Math.max`, dejando huecos permanentes

**Descripción.**
Cuando se fuerza un número con `encfOverride`, `getNextEncf` fija `currentNumber = max(currentNumber, override)`. Forzar un número alto salta el contador por encima de los intermedios, que quedan sin emitir y (por C1) inanulables.

**Evidencia.**
- `src/sequences/sequences.service.ts:199` → `const newCurrent = Math.max(sequence.currentNumber, overrideNumber);` y `:200-203` actualiza `currentNumber` a ese valor.
- Origen del override: mapper de certificación `src/certification/services/mappers/base-excel.mapper.ts:417` (`encfOverride: encfToOverride(encf)`).
- **Mitigación existente:** `encfOverride` está **prohibido en PROD** (`src/invoices/invoices.service.ts:142-151`, lanza `ForbiddenException` si `dgiiEnv === 'PROD'`). Por eso este mecanismo solo aplica a CERT/DEV.

**Fuente oficial.** Misma que C1 (`xsd/ANECF.xsd` + numeración sin huecos).

**Impacto.** Huecos de numeración en ambientes CERT/DEV (esperable en certificación con set de pruebas DGII). En PROD está bloqueado, por lo que **no** explica el síntoma de producción — se documenta para descartarlo y por completitud.

---

# MENOR

## M1 — E46 `<TotalITBIS>0.00</TotalITBIS>` solo puede venir de un override de certificación

En la ruta de cálculo normal, `TotalITBIS` se emite únicamente si `totals.totalItbis > 0` (`src/xml-builder/xml-builder.service.ts:863`). Un `0.00` literal solo puede provenir del override `totalsRawText.TotalITBIS` (`:861-862`). Como E46 (exportación) normalmente no lleva ITBIS, un `0.00` real indica que el valor entró por la ruta de certificación (raw), no por el cálculo. **No es violación de XSD** (`e-CF-46.xsd:152` declara `TotalITBIS` minOccurs=0, tipo `MayorIgualCero`; `0.00` es válido). Se registra como observación de origen del dato, no como defecto de conformidad.

## M2 — ANECF sin validación defensiva del límite `maxOccurs=10` de `<Anulacion>`

`buildAnecfXml` agrupa rangos por tipo de e-CF y emite una `<Anulacion>` por tipo (`src/xml-builder/xml-builder.service.ts:186-218`), sin un chequeo explícito del `maxOccurs="10"` que impone `xsd/ANECF.xsd` (elemento `Anulacion`). En la práctica solo existen 10 `CFType` válidos, por lo que **no puede excederse**; queda como robustez menor.

## M3 — La rama `feature/billing-v2` diverge fuertemente y está marcada "DO NOT MERGE"

`git log main..origin/feature/billing-v2`: 2 commits (`f2cb871` "pay-per-accepted-emission model (billing-v2) [DO NOT MERGE until certified]", `167a53b`). `--stat`: 62 archivos, +1629/−3504. Sustituye el modelo quota+topups por per-emisión (`usage_counted`, `pricing_tiers`, `BillingModelType`). Riesgo de drift creciente entre `main` y la rama mientras no se certifique. No es hallazgo fiscal; se registra por gestión de riesgo. Detalle completo en el **Frente 1** abajo.

---

# SIN ANCLA — requieren verificación

## S1 — Reenvío de e-CF RECHAZADO: ¿reutilizar el mismo eNCF o consumir uno nuevo?

**Observación de código.** Ante un RECHAZO de DGII, el sistema marca `REJECTED` y **se detiene**: no reenvía una versión corregida ni reutiliza el eNCF (`src/queue/ecf-processing.processor.ts:286-300`, `src/queue/status-poll.processor.ts:186-203`). Una corrección posterior por el usuario crearía una **factura nueva con un eNCF nuevo** (vía `getNextEncf`), dejando el eNCF rechazado como fila `REJECTED` conservada.

**Por qué SIN ANCLA.** No he podido localizar en las fuentes disponibles en el repo (XSD + constantes) la regla DGII que determine si, tras un RECHAZO, el **mismo** eNCF debe reutilizarse en el reenvío corregido (interpretación "el rechazo no consume el secuencial") o si corresponde uno nuevo. Esto debe verificarse contra la sección de **estados/rechazo** de la Descripción Técnica vigente antes de calificarlo como defecto. Si la norma exige reutilización, el comportamiento actual generaría huecos por diseño en cada rechazo corregido.

## S2 — Supuestos sensibles a la versión de la Descripción Técnica

La DGII publicó actualizaciones (Descripción Técnica 29/05/2026; Informe Técnico e-CF 06/04/2026: bonos de regalo, indicador "No facturable", contingencia). El repo se construyó contra v1.5–v1.6 (2023). El **inventario completo** de puntos de código a diferenciar manualmente está en el **Frente 5** al final de este documento. Cada punto es SIN ANCLA hasta hacer el diff contra los documentos nuevos.

---

# FRENTE 1 — Estado real del billing en `main` (descriptivo)

**Modelo activo en `main` HEAD:** quota-based **dual-nivel** (TenantPlan legacy + CompanyPlan/CompanyUsage con topups). Verificado en `prisma/schema.prisma` y migraciones-como-archivo.

**Presente en `main`:**
- `Invoice.usageReverted` → `@map("usage_reverted")`: `prisma/schema.prisma:363`. Migraciones: `prisma/migrations/20260525154424_add_company_level_billing/migration.sql` y `…/20260608120000_billing_p4_trackid_safety/migration.sql`.
- `model TenantPlan` (`tenant_plans`) `schema.prisma:651-669`; `model MonthlyUsage` (`monthly_usages`) `:671-686`; `model CompanyPlan` (`company_plans`) `:692-708`; `model CompanyUsage` (`company_usages`, con `base_used`/`topup_used`/`total_quota`) `:710-728`; `model TopupPack` `:730-741`; `model TopupPurchase` `:743-758`; `model BillingAlert` `:760-773`.
- **NO existe** `usage_counted`/`usageCounted` en ninguna parte de `main` (grep sin hits en `src/`; sin hits en `prisma/migrations/`). Coincide con producción.

**Solo en la rama `feature/billing-v2` (NO en main)** — `git diff main origin/feature/billing-v2`:
- `Invoice.usageCounted` (`usage_counted`) que **reemplaza** a `usageReverted`; `enum BillingModelType { PER_EMISSION }`; `model PricingTier` (`pricing_tiers`); `CompanyUsage.acceptedCount`; migración `prisma/migrations/20260616120000_billing_v2/migration.sql`; `docs/BILLING-V2.md`, `src/billing/pricing.ts`.
- La rama **borra** `TenantPlan`, `MonthlyUsage`, `TopupPack`, `TopupPurchase`, `BillingAlert`, `billing.scheduler.ts`, `billing.service.ts`, `jobs/renew-plans.job.ts`, `notifications/billing-notifications.service.ts` (todos vivos en main).

**Lógica legacy tenant_plans/topup — ACTIVA y alcanzable (no dead code):**
- `BillingModule` provee `BillingService, BillingScheduler, CompanyBillingService, UsageService, BillingNotificationsService, RenewPlansJob`: `src/billing/billing.module.ts`; importado en `app.module.ts`, `invoices.module.ts`, `queue.module.ts`, `contingency.module.ts`, `tenants.module.ts`.
- Tenant-level: `ActivePlanGuard` cae al path legacy `src/billing/guards/active-plan.guard.ts:55` (`billingService.canEmitInvoice`), guard aplicado a la emisión real (`src/invoices/invoices.controller.ts` `@UseGuards(ActivePlanGuard)`). Conteo tenant: `src/invoices/invoices.service.ts:343` (`billingService.incrementInvoiceCount`). Cron de expiración: `BillingScheduler` `@Cron EVERY_HOUR` → `expireStalePlans()` (`src/billing/billing.service.ts:193-207`).
- Company-level: `usageService.incrementUsage` en emisión (`invoices.service.ts:326-334`), guard company-path (`active-plan.guard.ts:40-51`).
- Topup: endpoints HTTP `GET billing/topup-packs` y `POST companies/:id/topup` (`src/billing/company-billing.controller.ts`), consumo/refund FIFO/LIFO en `usage.service.ts:105-115` y `:159-169`.
- **Sin doble conteo:** la emisión elige UNA vía (`companyPlan ? usageService : billingService`), `invoices.service.ts:326-344`.

**`usage_reverted` — qué hace y dónde se activa.**
Guardia de **idempotencia de reembolso** de cuota. Una emisión reserva cuota al llegar a `QUEUED`; `usage_reverted` garantiza que el refund de esa cuota ocurra **como máximo una vez**, aunque varios paths terminales lo intenten.
- **Único punto de escritura (atómico):** `src/billing/usage.service.ts:207-212` (`revertUsage`): `updateMany({ where:{ id, usageReverted:false }, data:{ usageReverted:true } })`; solo si `count===1` ejecuta `decrementUsage`. Valor inicial: `@default(false)` (schema.prisma:363), sin set explícito en la creación.
- **Paths que disparan `revertUsage` (política FIX G: refund solo en REJECTED y VOIDED; ACCEPTED/CONDITIONAL conservan cuota; ERROR/CONTINGENCY son transitorios y no refundan):**
  1. Processor, REJECTED inmediato: `src/queue/ecf-processing.processor.ts:286-299`.
  2. Poller, REJECTED tardío (flujo STANDARD): `src/queue/status-poll.processor.ts:186-202`.
  3. Poll manual, REJECTED: `src/invoices/invoices.service.ts:427-437`.
  4. VOID (si `previousStatus !== DRAFT`): `src/invoices/invoices.service.ts:588-589`.
  5. Contingencia (reconcile trackId existente / reenvío): `src/contingency/contingency.service.ts:238` y `:308-311`.
- Es un flag **de facturación, no fiscal**: solo afecta a empresas con `CompanyPlan`; no toca el eNCF ni la secuencia.

---

# FRENTE 2 — Respuestas directas

- **¿Qué pasa con la factura al rechazar DGII?** Se conserva con `status=REJECTED`; **no** se borra, **no** se sobreescribe el eNCF, **no** se reintenta con un secuencial nuevo. Código: `src/queue/ecf-processing.processor.ts:269-300` (rechazo en submit) y `src/queue/status-poll.processor.ts:153-203` (rechazo tardío por poll). No hay `invoice.delete` en el repo. (Ver S1 sobre si esto cumple la norma de reenvío.)
- **¿Qué eventos escribe audit.log en todo el ciclo?** Solo `queued` en el ciclo automático. Inventario completo en **I1**.
- **¿El consumo de secuencial es transaccional con la persistencia de la factura?** **NO.** Son dos transacciones separadas; el secuencial puede consumirse sin que quede factura. Detalle en **C1**.

---

# FRENTE 3 — Builders XML vs XSD por tipo (tabla completa)

**Método.** Se extrajo cada `xs:element` del complexType `<Totales>` de los 10 XSD con su `minOccurs`, y se comparó con `XmlBuilderService.buildTotales` (`src/xml-builder/xml-builder.service.ts:783-993`). Los *type-guards* del builder están en `:785-796` (verificados manualmente contra el archivo).

**Hallazgo clave.** `TotalISC` **no existe como elemento en ningún XSD**; el ISC se declara vía `MontoImpuestoAdicional` (resumen) y el wrapper `ImpuestosAdicionales > ImpuestoAdicional > MontoImpuestoSelectivoConsumo{Especifico,Advalorem}`. El builder nunca emite `<TotalISC>` — correcto.

**Sobre el hallazgo de producción H5** (E46 emite `TotalITBIS 0.00`; E43/E44/E47 lo omiten): es **XSD-correcto**. E46 declara `TotalITBIS` (opcional) → puede emitirlo; E43/E44/E47 **no declaran el elemento** → emitirlo los VIOLARÍA. El guard `hasTotalItbis = ![43,44,47].includes(typeCode)` (`:789`) respeta ambos casos.

### Mapa de guards (xml-builder.service.ts)
| Guard | Línea | Tipos que SÍ emiten |
|---|---|---|
| `hasGravadoTotal` | 785 | todos menos 43,44,47 |
| `hasExento` | 787 | todos menos 46 |
| `hasTotalItbis` | 789 | todos menos 43,44,47 |
| `hasImpuestoAdicional` | 791 | todos menos 41,43,46,47 |
| `hasItbisRetenido` | 793 | 31,33,34,41 |
| `hasIsrRetencion` | 794 | 31,33,34,41,47 |
| `hasItbisPercepcion` / `hasIsrPercepcion` | 795/796 | 31,33,34,41 |

### TotalITBIS (builder emite `:861-865`, guard `:789`)
| Tipo | XSD dice (minOccurs) | Builder hace (file:line) | Veredicto |
|---|---|---|---|
| E31 | minOccurs=0 (e-CF-31.xsd:140) | emite si `totalItbis>0` o raw (859-865) | CUMPLE |
| E32 | minOccurs=0 (e-CF-32.xsd:140) | idem | CUMPLE |
| E33 | minOccurs=0 (e-CF-33.xsd:141) | idem | CUMPLE |
| E34 | minOccurs=0 (e-CF-34.xsd:140) | idem | CUMPLE |
| E41 | minOccurs=0 (e-CF-41.xsd:95) | idem | CUMPLE |
| E43 | **NO existe** en el XSD | guard 789 excluye 43 → nunca emite | CUMPLE |
| E44 | **NO existe** | excluye 44 → nunca emite | CUMPLE |
| E45 | minOccurs=0 (e-CF-45.xsd:123) | emite si `>0`/raw | CUMPLE |
| **E46** | minOccurs=0 (e-CF-46.xsd:152) | incluye 46; `0.00` solo por raw (861-862) | CUMPLE (ver M1) |
| E47 | **NO existe** | excluye 47 → nunca emite | CUMPLE |

### TotalISC (no existe como elemento en ningún XSD)
| Tipo | XSD dice | Builder hace | Veredicto |
|---|---|---|---|
| TODOS (31–47) | **inexistente/prohibido** | nunca emite `<TotalISC>`; ISC → `MontoImpuestoAdicional` (888) y wrapper `ImpuestosAdicionales` (894-916) | CUMPLE |

### MontoImpuestoAdicional (builder emite `:885-892`, wrapper `:894-916`, guard `:791`)
| Tipo | XSD dice (minOccurs) | Builder hace | Veredicto |
|---|---|---|---|
| E31 | minOccurs=0 (e-CF-31.xsd:144) | emite si `totalIsc+otros>0` (887-891) | CUMPLE |
| E32 | minOccurs=0 (e-CF-32.xsd:144) | idem | CUMPLE |
| E33 | minOccurs=0 (e-CF-33.xsd:145) | idem | CUMPLE |
| E34 | minOccurs=0 (e-CF-34.xsd:144) | idem | CUMPLE |
| **E41** | **NO existe** (e-CF-41.xsd) | guard 791 excluye 41 → nunca emite | CUMPLE |
| E43 | NO existe | excluye 43 | CUMPLE |
| E44 | minOccurs=0 (e-CF-44.xsd:133) | emite; suprime `MontoImpuestoSelectivo*` para 44 (904,907) dejando solo `OtrosImpuestosAdicionales` | CUMPLE |
| E45 | minOccurs=0 (e-CF-45.xsd:127) | emite si `>0` | CUMPLE |
| E46 | **NO existe** (e-CF-46.xsd) | excluye 46 | CUMPLE |
| **E47** | **NO existe** (e-CF-47.xsd) | excluye 47 | CUMPLE |

### Retenciones — TotalITBISRetenido (emite `:969-973`, guard `:793`)
| Tipo | XSD dice | Builder | Veredicto |
|---|---|---|---|
| E31 | minOccurs=0 (e-CF-31.xsd:168) | emite si `>0`/raw | CUMPLE |
| E33 | minOccurs=0 (e-CF-33.xsd:169) | emite | CUMPLE |
| E34 | minOccurs=0 (e-CF-34.xsd:169) | emite | CUMPLE |
| E41 | minOccurs=0 (e-CF-41.xsd:104) | emite | CUMPLE |
| E32,43,44,45,46,47 | **NO existe** | guard 793 los excluye | CUMPLE |

### Retenciones — TotalISRRetencion (emite `:974-978`, guard `:794`)
| Tipo | XSD dice | Builder | Veredicto |
|---|---|---|---|
| E31 | minOccurs=0 (e-CF-31.xsd:169) | emite | CUMPLE |
| E33 | minOccurs=0 (e-CF-33.xsd:170) | emite | CUMPLE |
| E34 | minOccurs=0 (e-CF-34.xsd:170) | emite | CUMPLE |
| E41 | minOccurs=0 (e-CF-41.xsd:105) | emite | CUMPLE |
| **E47** | minOccurs=0 (e-CF-47.xsd:93) — **único campo de retención de E47** | guard 794 **incluye** 47 → emite | CUMPLE |
| E32,43,44,45,46 | NO existe | excluidos | CUMPLE |

### Retenciones — TotalITBISPercepcion / TotalISRPercepcion (emite `:979-988`, guards `:795/796`)
| Tipo | XSD dice | Builder | Veredicto |
|---|---|---|---|
| E31,E33,E34,E41 | minOccurs=0 | emite | CUMPLE |
| **E47** | **NO existe** (E47 solo tiene TotalISRRetencion) | guards 795/796 excluyen 47 → no emite | CUMPLE |
| resto | NO existe | excluidos | CUMPLE |

### MontoTotal (emite `:918-926`, incondicional)
| Tipo | XSD dice | Builder | Veredicto |
|---|---|---|---|
| TODOS | **minOccurs=1 (OBLIGATORIO)** (31:162, 32:162, 33:163, 34:162, 41:99, 43:52, 44:149, 45:145, 46:154, 47:88) | siempre emite (922-926) | CUMPLE |

### MontoGravadoTotal (emite `:807-814`, guard `:785`)
| Tipo | XSD dice | Builder | Veredicto |
|---|---|---|---|
| E31,32,33,34,41,45,46 | minOccurs=0 | emite si `>0`/raw | CUMPLE |
| E43,44,47 | NO existe | guard 785 excluye | CUMPLE |

**Veredicto global Frente 3:** **NINGUNA violación de XSD** en la sección Totales. Los guards `:785-796` coinciden campo por campo, tipo por tipo, con la presencia/ausencia de cada elemento en los 10 XSD oficiales.

---

# FRENTE 4 — ANECF (verificación elemento por elemento)

**Veredicto: IMPLEMENTADO de extremo a extremo y CONFORME al XSD.** No es stub ni schema-only.

**Cadena de implementación:**
- Endpoint `POST sequences/:companyId/annul` (scope `INVOICES_WRITE`): `src/sequences/sequences.controller.ts:127-155`.
- Orquestación (validación de rangos → build → firma → envío → persistencia → ajuste local atómico): `src/sequences/sequences.service.ts:294-559`.
- Build XML: `src/xml-builder/xml-builder.service.ts:176-235`.
- Firma XMLDSig (ANECF se firma **sin** `FechaHoraFirma`, correcto): `src/signing/signing.service.ts` vía `sequences.service.ts:437`.
- Envío a DGII `anulacionrangos/api/operaciones/anularrango`: `src/dgii/dgii.service.ts:226-261` (`submitAnecf`); parseo defensivo (ambiguo→REJECTED): `:268-295`.
- Persistencia `sequence_annulments`: create PENDING `sequences.service.ts:448`; REJECTED `:481`; ACCEPTED transaccional `:494`; modelo `prisma/schema.prisma:501-516`.

**`dgii-ecf`** solo aporta la firma (el tipo `'ANECF'` está en su union de documentos firmables); el build y el submit son propios del proyecto.

**Verificación elemento-por-elemento (`buildAnecfXml` vs `xsd/ANECF.xsd`):**

| Elemento XSD | Generado en código | ✓ |
|---|---|---|
| `ANECF` (raíz, sin namespace) | xml-builder.service.ts:222,232 | ✓ |
| `Encabezado` | :223,228 | ✓ |
| `Version` = "1.0" (enum) | :224 literal `1.0` | ✓ |
| `RncEmisor` (casing exacto) | :225 `<RncEmisor>` | ✓ |
| `CantidadeNCFAnulados` (total NCF, no rangos) | :226 = `totalAnulados` (suma de counts, :196) | ✓ |
| `FechaHoraAnulacioneNCF` dd-MM-yyyy HH:mm:ss | :227 `formatDateTime(now)` — helper GMT-4 America/Santo_Domingo con ese patrón exacto (:1818-1834) | ✓ |
| `DetalleAnulacion` | :229,231 | ✓ |
| `Anulacion` (1 por tipo; NoLinea 1..N) | :205-217, agrupado por tipo :186-194 | ✓ |
| Orden interno: NoLinea → TipoeCF → Tabla → CantidadeNCFAnulados | :206,207,208,216 | ✓ |
| `TablaRangoSecuenciasAnuladaseNCF` | :208,215 | ✓ |
| `Secuencias` (1 por rango) | :210-213 | ✓ |
| `SecuenciaeNCFDesde`/`Hasta` (AlfaNum13) | :211,212 (eNCF validado a 13 chars, sequences.service.ts:332) | ✓ |
| `CantidadeNCFAnulados` por línea | :216 = `typeTotal` | ✓ |
| `xs:any` (minOccurs=1) = ranura de firma | Signature añadida como último hijo del root por `signXml` | ✓ |

Único punto menor: sin validación defensiva de `maxOccurs=10` de `<Anulacion>` (ver M2; no puede excederse porque solo hay 10 CFType válidos).

**`sequence_annulments` vacío en producción** ⇒ la feature **no ha sido usada**, no que esté sin implementar. Además `annulSequences` rechaza correctamente rangos ya consumidos (`sequences.service.ts:389-395`), lo que conecta con C1: los huecos por debajo de `currentNumber` no son anulables por esta vía.

---

# FRENTE 5 — Inventario de supuestos sensibles a versión de documentación (para diff manual)

Cada punto depende de la Descripción Técnica / Informe Técnico. **No se especula** sobre qué cambió; se listan las anclas de código con `archivo:línea` para diferenciar manualmente contra los documentos de 2026.

### 5.1 URLs y rutas de servicios DGII
| Supuesto | archivo:línea |
|---|---|
| Dominios base por ambiente (`ecf.dgii.gov.do/{testecf,certecf,ecf}`, `fc.dgii.gov.do/…`) | `src/xml-builder/ecf-types.ts:175-191` (`DGII_ENDPOINTS`) |
| Rutas de servicio (semilla, validarsemilla, recepción, consultas, anularrango, directorio, aprobación comercial, recepcionfc, consultarfce) | `src/xml-builder/ecf-types.ts:203-218` (`DGII_SERVICES`) |
| Patrón de URL `{base}/{service}{resource}` | `src/xml-builder/ecf-types.ts:227-232` (`buildDgiiUrl`) |
| Dominio separado de estatus de servicios | `src/xml-builder/ecf-types.ts:221` (`DGII_STATUS_SERVICE_URL`) |
| Endpoint aprobación comercial receptor `{emitterUrl}/fe/aprobacioncomercial/api/ecf` y recepción `{emitterUrl}/fe/recepcion/api/ecf` | `src/dgii/dgii.service.ts:465,528` |
| Nombre de archivo `{RNCEmisor}{eNCF}.xml` (y `{RNC}ANECF.xml`) | `src/queue/ecf-processing.processor.ts:256,262`; `src/sequences/sequences.service.ts:465` |

### 5.2 Estados y estructura de respuestas DGII
| Supuesto | archivo:línea |
|---|---|
| Códigos de estado `NOT_FOUND=0, ACCEPTED=1, REJECTED=2, IN_PROCESS=3, CONDITIONAL=4` | `src/xml-builder/ecf-types.ts:234-241` (`DGII_STATUS`) |
| Mapeo estado DGII→`InvoiceStatus` (processor) | `src/queue/ecf-processing.processor.ts:476-484`; (poller) `src/queue/status-poll.processor.ts:329-337`; (service) `src/invoices/invoices.service.ts:614-622` |
| Parseo de respuesta por `codigo`/`nombre`/`mensajes` (con fallback textual "aceptado"/"rechazado") | `src/dgii/dgii.service.ts:270-295` |
| `submitEcf` asume IN_PROCESS tras recepción; el veredicto llega por poll | `src/dgii/dgii.service.ts:150,163` |
| `anularrango` no devuelve TrackId | `src/dgii/dgii.service.ts:254` |
| Extracción de TrackId de respuesta (JSON o `<trackId>`) | `src/queue/status-poll.processor.ts:317-327` |
| Token JWT ~1h (semilla → firma → token) | `src/dgii/dgii.service.ts:32,679-695` |

### 5.3 Reglas de contingencia
| Supuesto | archivo:línea |
|---|---|
| Ventana de contingencia **72 horas** | `src/contingency/contingency.service.ts:180` (`CONTINGENCY_LIMIT_MS`), y `:52` (`72 - hoursInContingency`) |
| Al exceder 72h → ERROR "requiere gestión manual" | `src/contingency/contingency.service.ts:186-198` |
| Clasificación de error de red → CONTINGENCY vs ERROR | `src/queue/ecf-processing.processor.ts:362-368` |
| Reconciliación por trackId existente (no reenviar, para no duplicar) | `src/contingency/contingency.service.ts:213-261`; `src/queue/ecf-processing.processor.ts:89-101` |
| Backoff de polling (30s…1h, 20 intentos ≈ 24h) | `src/queue/status-poll.processor.ts:37,304-315` |
| Códigos de modificación NC/ND (incl. `REPLACE_CONTINGENCY=4`) | `src/xml-builder/ecf-types.ts:95-109` |

### 5.4 Formato QR y timbre
| Supuesto | archivo:línea |
|---|---|
| URLs base del timbre por ambiente (estándar `…/ConsultaTimbre?`, RFCE `…/ConsultaTimbreFC?`) | `src/representacion-impresa/services/qr-builder.service.ts:75-90` |
| Parámetros QR estándar: `RncEmisor,[RncComprador],ENCF,FechaEmision,MontoTotal,FechaFirma,CodigoSeguridad` | `src/representacion-impresa/services/qr-builder.service.ts:48-63` |
| Parámetros QR RFCE: `RncEmisor,ENCF,MontoTotal,CodigoSeguridad` | `src/representacion-impresa/services/qr-builder.service.ts:38-46` |
| `CodigoSeguridad` = primeros 6 chars del `SignatureValue`; `encodeURIComponent` de todos los params | `src/representacion-impresa/services/qr-builder.service.ts:33-36`; nota `src/xml-builder/ecf-types.ts:271-276` |

### 5.5 Reglas de redondeo, tolerancia y umbrales fiscales
| Supuesto | archivo:línea |
|---|---|
| Redondeo a 2 decimales (`Math.round((n+EPSILON)*100)/100`) — fuente única | `src/xml-builder/itbis.util.ts:15-17` (`round2`) |
| Umbral RFCE Factura Consumo **< 250.000** (E32 resumen) | `src/xml-builder/ecf-types.ts:248` (`FC_FULL_SUBMISSION_THRESHOLD`); uso `invoices.service.ts:220`, `contingency.service.ts:275` |
| Máx. ítems (1000 normal / 10000 FC<250K) | `src/xml-builder/ecf-types.ts:251-252` |
| NC/ND: **30 días** límite para devolución de ITBIS | `src/xml-builder/ecf-types.ts:255` (`NC_ITBIS_RETURN_LIMIT_DAYS`) |
| Conservación **10 años** | `src/xml-builder/ecf-types.ts:258` |
| Tasas ITBIS (18/16/0) e `IndicadorFacturacion` (0=No Facturable,1=18%,2=16%,3=0%,4=Exento) | `src/xml-builder/ecf-types.ts:59-63`; `src/xml-builder/itbis.util.ts:19-57` |
| ACECF aplica solo a E31,E33,E34,E44,E45 (excluye 32,41,43,46,47) — "Descripción Técnica p.28-29" | `src/xml-builder/ecf-types.ts:52-56` (`ACECF_EXCLUDED_TYPES`) |
| Tipos que exigen RNC comprador (31,41,45) y reglas E32/E46/E47 | `src/xml-builder/ecf-types.ts:35-46` |
| Vigencia de secuencia hasta 31-dic del año siguiente a la autorización | `src/xml-builder/ecf-types.ts:303-309` (`isSequenceExpired`) |
| Códigos de impuestos adicionales / rangos ISC (006-039) | `src/xml-builder/ecf-types.ts:123-169` |
| Comentario que fija la versión de referencia del código: "Descripción Técnica v1.6" y "v1.0 + Informe Técnico" | `src/xml-builder/ecf-types.ts:194`; `:1-5` |

> **Recomendación de diff:** priorizar 5.3 (contingencia — el Informe Técnico 06/04/2026 declara cambios en escenarios de contingencia) y las reglas de "No facturable"/bonos de regalo, que tocan `IndicadorFacturacion` (`itbis.util.ts:19-57`, `MontoNoFacturable` en `xml-builder.service.ts:928-933`) y códigos de modificación (`ecf-types.ts:95-109`).

---

## Anexo — Verificaciones que NO arrojaron hallazgo (para constancia)
- Facturas nunca borradas (sin `invoice.delete` en `src/`) → rechazos se conservan como filas.
- Sin doble conteo de billing (una sola vía por emisión, `invoices.service.ts:326-344`).
- `revertUsage` idempotente por `usage_reverted` (un solo decremento por factura pese a múltiples paths).
- ANECF firmado como último hijo del root (ranura `xs:any`), verificado por test (`signing.service.spec.ts:109-121`).
- Builders Totales: 0 violaciones de XSD (Frente 3).

*Fin del reporte. Único archivo creado: `AUDITORIA-2026-07.md`. Ningún otro archivo fue modificado.*
