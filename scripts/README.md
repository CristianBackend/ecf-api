# DGII Certification Test Set Runner

Script para correr el set de pruebas oficial de DGII (paso 2 de certificación) contra el ambiente CERT.

## Qué hace

1. Hace login en la API y obtiene un JWT.
2. Itera los **25 casos ECF** del Excel oficial de DGII.
3. Por cada caso:
   - Mapea el caso del Excel al `CreateInvoiceDto` de la API.
   - Hace `POST /invoices` con el `encfOverride` del Excel.
   - Hace `POST /invoices/:id/poll` hasta tener estado final de DGII (max 60s).
   - Descarga el XML firmado a `cert-output/<ENCF>.xml`.
4. Continúa aunque un caso falle.
5. Al final escribe:
   - `cert-output/results.json` (detalle completo de cada caso)
   - `cert-output/summary.csv` (tabla amigable)
   - 25 archivos XML firmados (`E310000000005.xml`, etc.)

## Prerequisitos

- Node.js 18+ (para `fetch` nativo)
- Las dependencias del repo instaladas (`npm install`)
- Variables de entorno seteadas (ver abajo)
- Backend deployado y apuntando a CERT (`company.dgiiEnv === 'CERT'`)
- Las 10 secuencias creadas con rangos suficientes

## Configuración

```bash
# Windows CMD
set CERT_API_BASE=https://node-a2.newplain.com
set CERT_EMAIL=cristian@newplain.com
set CERT_PASSWORD=EcfAdmin2026!
set CERT_COMPANY_ID=d749d508-c5e4-4449-838c-03b3471e83a0

# PowerShell
$env:CERT_API_BASE = "https://node-a2.newplain.com"
$env:CERT_EMAIL = "cristian@newplain.com"
$env:CERT_PASSWORD = "EcfAdmin2026!"
$env:CERT_COMPANY_ID = "d749d508-c5e4-4449-838c-03b3471e83a0"

# Linux/macOS
export CERT_API_BASE=https://node-a2.newplain.com
export CERT_EMAIL=cristian@newplain.com
export CERT_PASSWORD=EcfAdmin2026!
export CERT_COMPANY_ID=d749d508-c5e4-4449-838c-03b3471e83a0
```

## Cómo correrlo

```bash
npx ts-node scripts/dgii-cert-runner.ts
```

O si lo agregás a `package.json`:

```json
{
  "scripts": {
    "cert:run": "ts-node scripts/dgii-cert-runner.ts"
  }
}
```

Y después:

```bash
npm run cert:run
```

## Archivos en este directorio

```
scripts/
├── dgii-cert-runner.ts     # entrypoint
├── dgii-cert-mapper.ts     # caso Excel → CreateInvoiceDto
├── cert-data/
│   ├── casos_ecf.json      # 25 casos ECF parseados del Excel
│   └── casos_rfce.json     # 4 casos RFCE (TODO: implementar)
└── README.md
```

## Salida esperada

```
═══════════════════════════════════════════════════
  DGII CERTIFICATION TEST SET RUNNER
═══════════════════════════════════════════════════

API:      https://node-a2.newplain.com
Company:  d749d508-c5e4-4449-838c-03b3471e83a0
Output:   /path/to/repo/cert-output

Casos ECF cargados: 25

[1/3] Login en https://node-a2.newplain.com...
✓ Token obtenido (tenant: Cristian Admin)

[2/3] Procesando casos ECF...

[1/25] 133158744E310000000005 (E31) → ENCF E310000000005
  └─ payload: items=1, override=5
  └─ invoice creado: f47ac10b-...
  └─ status: ACCEPTED | trackId: d2b6e27c-...

[2/25] 133158744E310000000006 (E31) → ENCF E310000000006
  ...

══════════════════ RESUMEN ══════════════════

ENCF             Tipo   Status          XML   TrackId
────────────────────────────────────────────────────────────
E310000000005    E31    ACCEPTED        sí    d2b6e27c-...
E310000000006    E31    ACCEPTED        sí    a8f3b910-...
...

Aceptados: 23   Rechazados: 1   Otros: 1

Archivos generados en: /path/to/repo/cert-output
```

## Manejo de errores

- Si un caso falla con HTTP error → se anota en `error` y sigue.
- Si DGII rechaza → se anota como `REJECTED` con el mensaje de DGII.
- Si el poll excede 60s → se anota como `TIMEOUT`.
- Si una excepción rompe el caso → se anota como `EXCEPTION` con el stack.

El runner nunca aborta. Siempre termina con el reporte completo.

## Nota sobre RFCE

Los 4 casos RFCE están parseados en `cert-data/casos_rfce.json` pero el runner
todavía no los emite porque el endpoint es distinto (`fc.dgii.gov.do`). El método
`submitRfce()` ya existe en el backend; cuando confirmemos la ruta exacta de la API
expuesta para RFCE, agregamos el segundo loop.

## Re-runs

Cada caso tiene un ENCF fijo (lo exige DGII). Si re-corrés el runner:

- Si el caso ya está aceptado en DGII, vas a recibir un error de "ENCF ya usado".
- Para volver a probar el set completo, hay que **resetear los `currentNumber` a 0** en BD.

Por eso, en uso normal: una corrida por intento. Si DGII rechaza algún caso, corregís
el mapeo de ese caso y re-corres SOLO ese (TODO: agregar flag `--only=ENCF`).
