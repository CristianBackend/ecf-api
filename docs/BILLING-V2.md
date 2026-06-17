# Billing v2 — Pago por Emisión (flat por rango)

Rama: `feature/billing-v2` (desde `main @1f4842f`). Estado: implementado, `nest build` + suite en verde. **Cobro y asignación de planes son MANUALES**: el sistema MIDE, CALCULA y MUESTRA; no cobra ni auto-asigna.

---

## 1. El modelo (definición cerrada)

Cobro mensual **por empresa**:

```
total_mensual = US$60 fijo  +  (emisiones_ACEPTADAS_del_mes × precio_del_rango)
```

- **Flat por rango:** el TOTAL de aceptadas del mes (con mínimo 500) elige **un** rango, y TODAS se cobran a ese precio.
- **Mínimo 500:** si emite menos, se factura como 500 → piso `500×0.06 + 60 = US$90/mes`.
- **Solo ACEPTADAS:** cuentan `ACCEPTED` y `CONDITIONAL`. NO cuentan `REJECTED / VOIDED / ERROR / CONTINGENCY / PROCESSING`.
- **US$200 de certificación:** pago único, se registra aparte; **no** entra en el cálculo mensual.

### Rangos (US$/emisión)

| Desde | Hasta | Precio |
|------:|------:|:------|
| 1 | 500 | 0.06 |
| 501 | 1000 | 0.05 |
| 1001 | 3000 | 0.04 |
| 3001 | 5000 | 0.04 |
| 5001 | 10000 | 0.03 |
| 10001 | 100000 | **REQUIERE_COTIZACIÓN** (total = `null`) |
| 100001 | ∞ | 0.02 |

### "Anomalía flat" (comportamiento ESPERADO, no bug)

Como TODA la cantidad se reprecia al rango donde cae, cruzar un borde puede **abaratar** la factura:
`1000 → 1000×0.05 = $50` vs `1001 → 1001×0.04 = $40.04` (emisiones). Documentado y testeado en `src/billing/pricing.spec.ts`.

---

## 2. Decisiones arquitectónicas

### 2.1 Un solo sistema de billing: **company-level**
Se **eliminó por completo** el sistema legacy tenant-level. El `ActivePlanGuard` y el conteo ya no tienen fallback tenant; todo es company-level.

### 2.2 **Contar al ACEPTAR** (no al crear) — inversión de la semántica
- **Antes (v1):** incrementaba al crear (estado QUEUED) y revertía al rechazar/anular → el neto era "emitidas − rechazadas − anuladas" (sobre-contaba CONDITIONAL/ERROR/PROCESSING/CONTINGENCY).
- **Ahora (v2):** un único `UsageService.countAcceptedEmission(invoiceId, companyId)` incrementa `CompanyUsage.acceptedCount` **en la transición a ACCEPTED/CONDITIONAL**. Lo que nunca llega a aceptado, nunca se cuenta → **no hay refund**.

**Idempotencia (riesgo de revenue):** el conteo es atómico vía el flag `Invoice.usageCounted` (`updateMany WHERE usageCounted:false` → solo el ganador incrementa). Una factura llega a ACCEPTED por **4 caminos** y un re-poll puede reverla; el flag garantiza que se cuenta **a lo sumo una vez**. Llamado en los 4 caminos:
- `src/queue/status-poll.processor.ts` (poller — el común)
- `src/queue/ecf-processing.processor.ts` (submit directo)
- `src/contingency/contingency.service.ts` (reconciliar / reenviar) — 2 sub-caminos
- `src/invoices/invoices.service.ts` (poll manual)

### 2.3 **Post-pago: sin bloqueo por volumen**
El `ActivePlanGuard` exige que la company tenga un plan ACTIVO (sin plan no sabemos la tarifa) pero **nunca bloquea por cantidad**. Se eliminaron: la cuota condicional de `incrementUsage`, el estado `EXHAUSTED`, y el chequeo de `canEmitInvoice` por volumen. DEV/ADMIN siguen exentos.

---

## 3. Esquema nuevo (`prisma/schema.prisma`, migración `20260616120000_billing_v2`)

- **`BillingPlan`** (reutilizado): `code, name, monthlyFee (=60), type: BillingModelType, isActive, sortOrder`. **Quitado** `includedInvoices`. **Agregado** `type` (enum `BillingModelType { PER_EMISSION }`, por si coexisten modelos a futuro) y relación `pricingTiers PricingTier[]`.
- **`PricingTier`** (nuevo): `planCode FK, fromQty, toQty Int? (null=∞), pricePerEmission Decimal(18,4)?, requiresQuote Bool, sortOrder`. Los 7 rangos como filas configurables.
- **`CompanyPlan`** (reutilizado): igual; `status` ahora `CompanyPlanStatus { ACTIVE, EXPIRED, CANCELLED }` (quitado `EXHAUSTED`).
- **`CompanyUsage`** (re-significado): `companyId, cycleStartDate, acceptedCount` (reemplaza `baseUsed`). **Quitados** `topupUsed, totalQuota, notified70/85/95/100`. Mantiene `@@unique([companyId, cycleStartDate])`.
- **`Invoice`**: `usageReverted` → **`usageCounted`** (`Boolean @default(false)`).
- **Enums quitados:** `BillingAlertLevel`, `TenantPlanStatus`. **Enum agregado:** `BillingModelType`.

### Eliminado del schema
`TenantPlan`, `MonthlyUsage`, `TopupPack`, `TopupPurchase`, `BillingAlert` (+ sus relaciones en `Tenant` y `Company`).

> La migración es destructiva pero **no hay datos productivos**: al migrar, las tablas de uso/planes/topups/alertas estaban vacías (solo 4 planes seed de prueba). `prisma migrate diff` da **sin drift**.

---

## 4. API

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/billing-plans` | Catálogo de planes (con sus PricingTier) |
| POST | `/companies/:id/plan` | **Asignar** plan a una empresa (manual) |
| GET | `/companies/:id/plan` · `/usage` | Uso del ciclo (aceptadas, sin cuota/topups) |
| **GET** | **`/companies/:id/billing/current-month`** | **Cargo proyectado** del ciclo (`$60 + aceptadas×precio_rango`, mín 500) o `REQUIERE_COTIZACION` |
| GET | `/admin/plans` | Catálogo (admin) |
| GET | `/admin/billing/dashboard` | Revenue proyectado company-level (fórmula real) |

Motor de tarifa: `src/billing/pricing.ts` — **función pura** `calculateMonthlyCharge(acceptedCount, ranges?)`, exhaustivamente testeada (0,1,499,500,501,1000,1001,3000,3001,5000,5001,10000,10001,99999,100000,100001 + anomalía flat).

---

## 5. Qué se REUTILIZÓ / REEMPLAZÓ / ELIMINÓ

**Reutilizado:** `BillingPlan` (catálogo), `CompanyPlan` (+ asignación manual + ciclo 30d), la detección de ACCEPTED en los 4 caminos como punto de conteo, scopes `BILLING_READ/WRITE` y `ADMIN`.

**Reemplazado:** semántica de `CompanyUsage` (cuota → aceptadas), lógica de conteo (crear+revert → contar-al-aceptar), `UsageService` (reescrito a `countAcceptedEmission`), `CompanyBillingService.getUsage/canEmitInvoice`, dashboard admin (tenant → company-level con fórmula real), `ActivePlanGuard` (sin fallback ni cuota), seed.

**Eliminado (archivos):** `billing.service.ts`, `billing.scheduler.ts`, `jobs/renew-plans.job.ts`, `notifications/billing-notifications.service.ts`, `dto/purchase-topup.dto.ts` (+ sus specs). Endpoints quitados: `topup-packs`, `companies/:id/topup`, `billing-alerts` (+ read), `tenants/me/usage`, y el lifecycle tenant de admin (`plans/assign|activate|cancel`, `tenants/:id/plans`).

**Confirmado:** no quedan referencias vivas a `revertUsage / incrementUsage / incrementInvoiceCount / notifyThresholds / usageReverted / topups / quota / EXHAUSTED / TenantPlan / MonthlyUsage / BillingService` (solo comentarios de documentación).

---

## 6. Tests

- `pricing.spec.ts` — motor puro, todos los bordes + anomalía flat + cobertura de rangos.
- `usage.service.spec.ts` — `countAcceptedEmission`: cuenta una vez, no doble-cuenta (claim perdido), no cuenta DEV/sin-plan.
- `usage.service.integration.spec.ts` — **real DB**: cuenta exactamente 1, re-llamada no doble-cuenta.
- `company-billing.service.spec.ts` — `canEmitInvoice` (nunca bloquea por volumen), `getCurrentMonthBilling` (proyección), `assignPlan`.
- `status-poll.processor.spec.ts` — cuenta en ACCEPTED/CONDITIONAL, no en REJECTED, idempotente en re-poll.
- Specs adaptados: `ecf-processing.processor`, `invoices.service`, `active-plan.guard`, `admin-plans.service`, `admin-tenants.service`.
