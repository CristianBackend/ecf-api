# AUDIT_PDF.md — Auditoría del módulo src/pdf/ contra requisitos DGII RI

**Fecha:** 2026-05-03  
**Módulo auditado:** `src/pdf/` (pdf.module.ts, pdf.controller.ts, pdf.service.ts)  
**Revisor:** Claude Sonnet 4.6  

---

## 1. Estado actual — ¿qué hay realmente?

### Lo que existe

El módulo **no es un placeholder vacío**. Hay código real que:

- Consulta la factura con sus líneas y empresa desde la BD
- Construye una plantilla HTML completa (encabezado, grilla de ítems, totales, pie)
- Llama a `SigningService.buildQrUrl()` para construir la URL correcta de DGII
- Aplica watermark "SIN VALIDEZ FISCAL" y banner de estado según el status de la factura
- Escapa correctamente todo dato de usuario (método `esc()`)
- Expone dos endpoints bajo `GET /invoices/:id/preview` y `GET /invoices/:id/pdf`

### Lo que el módulo NO es

**No genera un PDF binario.** Ambos endpoints retornan `Content-Type: text/html`.  
El endpoint `/pdf` retorna el mismo HTML con un script de `window.print()` que abre el diálogo del navegador. No hay `Content-Disposition: attachment`, no hay buffer de bytes, no hay archivo `.pdf`.

**Dependencia de QR externa.** El código QR se genera vía:
```
https://api.qrserver.com/v1/create-qr-code/?size=130x130&...&data=<url_dgii>
```
Esto es un `<img src="...">` que el navegador carga en tiempo de render. Requiere internet en el cliente; no hay generación server-side de QR.

### Librería PDF instalada

**Ninguna.** `package.json` no tiene `pdfkit`, `puppeteer`, `playwright`, `html-pdf`, `wkhtmltopdf`, `jspdf`, `qrcode`, ni ninguna otra dependencia relacionada con PDF o QR. El módulo funciona 100% con HTML + browser print.

### Tests

**Cero.** No existe ningún archivo `*.spec.ts` en `src/pdf/`. El módulo tiene 0% de cobertura.

---

## 2. Cobertura de los 10 tipos de e-CF

| Tipo | Nombre | Estado en el módulo |
|------|--------|---------------------|
| E31 | Factura Crédito Fiscal | ✅ Layout genérico funciona |
| E32 | Factura Consumo | ✅ FC<250K correctamente identificada (isFcUnder250k) |
| E33 | Nota Débito | ⚠️ Muestra referencia NCF, falta código de modificación |
| E34 | Nota Crédito | ⚠️ Muestra referencia NCF, falta código de modificación |
| E41 | Comprobante Compras | ❌ Sin tratamiento especial (vendedor = parte relevante, no comprador) |
| E43 | Gastos Menores | ❌ Sin tratamiento especial |
| E44 | Regímenes Especiales | ❌ Sin tratamiento especial |
| E45 | Gubernamental | ❌ Sin tratamiento especial |
| E46 | Exportaciones | ❌ **Crítico**: sin secciones de transporte ni información de exportación |
| E47 | Pagos al Exterior | ❌ Sin tratamiento especial (requiere beneficiario exterior, país, concepto) |

---

## 3. Gaps contra requisitos DGII — detalle por sección

### 3.1 QR Code (CRÍTICO)

**Estado actual:** imagen embebida desde `api.qrserver.com` (servicio de terceros).  
**URL del QR:** correcta — la lógica de `SigningService.buildQrUrl()` produce las URLs `https://ecf.dgii.gov.do/...` correctas.  
**Problema:** la generación del QR depende de una llamada de red saliente a un dominio externo en el momento del render. DGII no exige que el QR se genere server-side, pero:
- El PDF resultante contiene una imagen referenciada externamente, no incrustada
- Si el cliente imprime offline, el QR aparece roto (imagen 404)
- Un PDF binario generado con puppeteer o similar capturaría la imagen correctamente
- **Riesgo de certificación:** si el auditor de DGII genera el PDF offline o en un entorno restringido, el QR no se renderiza → documento visualmente incompleto

### 3.2 Encabezado emisor

| Campo | Estado |
|-------|--------|
| Razón social | ✅ `company.businessName` |
| Nombre comercial | ✅ condicional |
| RNC | ✅ `company.rnc` |
| Dirección | ✅ `company.address` |
| Municipio/Provincia | ✅ condicional |
| Teléfono | ✅ condicional |
| e-NCF | ✅ `invoice.encf` |
| Código de seguridad | ✅ `invoice.securityCode` |
| Fecha de emisión | ⚠️ **Bug de zona horaria** — usa `Date` local, no GMT-4 |
| Fecha/hora de firma | ⚠️ **Bug de zona horaria** — misma función `fmtDateTime` sin GMT-4 |

El `SigningService` tiene formateo GMT-4 correcto (`formatDateTimeFirma`), pero `PdfService` implementa sus propios `fmtDate` / `fmtDateTime` que usan `new Date().getDate()` etc., que es hora local del servidor (puede ser UTC u otra zona). Cuando el servidor corre en UTC, todas las fechas del RI estarán mal.

### 3.3 Datos del comprador

| Campo | Estado |
|-------|--------|
| RNC comprador | ✅ condicional |
| Nombre comprador | ✅ "CONSUMIDOR FINAL" si no hay |
| Email comprador | ✅ condicional |
| Dirección comprador | ❌ no mostrada (puede ser exigida en E31) |
| Tipo de comprador | ❌ no mostrado |

**E41 (Comprobante Compras):** el módulo muestra la sección "Comprador" con los campos `buyerRnc`/`buyerName`, pero en E41 el "comprador" somos nosotros y la parte relevante es el **proveedor** (que está en el XML como `Vendedor`). El RI de E41 debería mostrar los datos del vendedor, no del comprador. El módulo lo maneja como cualquier otro tipo → datos incorrectos en el RI.

### 3.4 Detalle de ítems

La tabla actual tiene columnas: `#`, `Descripción`, `Cantidad`, `Precio`, `ITBIS`, `Subtotal`.

| Columna | Estado |
|---------|--------|
| Número de línea | ✅ |
| Descripción | ✅ |
| Cantidad | ✅ |
| Precio unitario | ✅ |
| Descuento por línea | ❌ **Falta** — `line.discount` existe en el modelo pero no se muestra |
| ITBIS por línea | ✅ (`line.itbisAmount`, con indicador "E" para exento) |
| ISC por línea | ❌ **Falta** — `line.iscAmount` existe pero no se muestra |
| Subtotal línea | ✅ |
| Bien o servicio | ❌ **Falta** — `line.goodService` (1=Bien, 2=Servicio) no se muestra |
| Impuesto adicional | ❌ **Falta** — `additionalTaxCode`/`additionalTaxRate` no se muestran |

### 3.5 Totales

| Campo | Estado |
|-------|--------|
| Subtotal | ✅ |
| Descuento total | ✅ condicional |
| ITBIS total | ✅ |
| ISC total | ❌ **Falta** — `invoice.totalIsc` existe en el modelo, no se muestra |
| Otros impuestos | ❌ **Falta** |
| Monto total | ✅ |

### 3.6 Forma de pago

| Campo | Estado |
|-------|--------|
| Tipo de pago | ✅ `getPaymentName()` con 9 tipos |
| Fecha de pago | ❌ **Falta** — `invoice.paymentDate` existe, no se muestra |
| Monto en cada forma cuando es mixto | ❌ **Falta** |

### 3.7 Referencia (E33 / E34)

| Campo | Estado |
|-------|--------|
| NCF modificado | ✅ `invoice.referenceEncf` |
| Fecha documento original | ✅ `invoice.referenceDate` |
| Código de modificación | ❌ **Falta** — `invoice.referenceModCode` existe (1=Anula, 2=Texto, 3=Montos, 4=Contingencia) pero no se muestra en el RI. DGII lo exige. |

### 3.8 Exportaciones (E46) — SECCIÓN COMPLETA FALTANTE

El módulo no tiene ninguna lógica específica para E46. DGII exige dos bloques adicionales en el RI de exportaciones:

**Bloque Transporte:**
- Despachador de embarque
- Destinatario de la mercancía
- Lugar de entrega
- Forma de pago del flete
- Peso bruto / Peso neto / Volumen / Unidad de medida

**Bloque Información de Exportación:**
- INCOTERM
- País de destino
- País de origen de la mercancía
- Referencia aduanera

Estos campos están en el XML del e-CF (sección `Exportaciones`) pero el módulo PDF no los lee ni los muestra. El RI de una E46 generado actualmente **no pasaría la certificación DGII**.

### 3.9 Leyendas fiscales (FALTA POR TIPO)

El módulo muestra una sola leyenda genérica:
```
"Representación Impresa de Comprobante Fiscal Electrónico (e-CF)"
"Documento firmado digitalmente conforme Ley 32-23 | Conservar por 10 años"
```

DGII requiere leyendas **específicas por tipo**:

| Tipo | Leyenda requerida |
|------|-------------------|
| E31 | "El ITBIS facturado forma parte de su crédito fiscal" |
| E32 | "No aplica como crédito fiscal ni sustento de costos y gastos" |
| E33 | "Nota de Débito que modifica el NCF indicado" |
| E34 | "Nota de Crédito que modifica el NCF indicado" |
| E41 | "El ITBIS facturado es un gasto sujeto a proporcionalidad" |
| E43 | "Comprobante de gasto menor — no aplica como crédito fiscal" |
| E44 | "Régimen especial de tributación" |
| E45 | "Documento gubernamental — exento de ITBIS" |
| E46 | "Exportación libre de ITBIS conforme Art. 343 Cód. Tributario" |
| E47 | "Pago al exterior sujeto a retención" |

---

## 4. Análisis técnico — arquitectura del módulo

### Punto fuerte: la URL del QR está bien

La llamada a `signingService.buildQrUrl()` produce:
- `https://ecf.dgii.gov.do/testecf/consultas?...` (DEV/CERT)
- `https://ecf.dgii.gov.do/ecf/consultas?...` (PROD)
- URL alternativa para FC<250K

Esta lógica es correcta y está bien testeada en los tests del `SigningService`.

### Punto débil: no genera PDF real — implicaciones

El diseño "HTML + window.print()" funciona para un humano con un navegador. No funciona para:
- Un cliente API que quiere recibir un `Buffer` binario y guardarlo en S3
- Testing automatizado de la RI (no hay forma de verificar el contenido sin un browser headless)
- Entornos sin browser (servidores, workers, CI)

Para DGII esto puede ser suficiente en la certificación manual (el auditor abre el browser y guarda como PDF), pero crea deuda técnica para el producto final.

### Punto débil: enfoque de metadata frágil

Algunos campos RI se extraen de `invoice.metadata._originalDto`:
```typescript
const originalDto = meta._originalDto || {};
const fechaVencSecuencia = originalDto.sequenceExpiresAt
const indicadorMontoGravado = originalDto.indicadorMontoGravado ?? 0;
const tipoIngresos = originalDto.items?.[0]?.incomeType || 1;
```

Si el formato de `_originalDto` cambia, estos campos desaparecen silenciosamente del RI. `tipoIngresos` toma el del primer ítem y lo aplica a todo el documento — si hay líneas con diferentes tipos de ingreso, el RI es incorrecto.

---

## 5. Recomendación: ¿completar o reescribir?

**Completar lo que hay.** La estructura HTML base es correcta y la integración con `buildQrUrl()` está bien. No hay que tirar nada. Lo que falta son adiciones, no correcciones de raíz.

**Excepción: QR.** Hay que reemplazar `api.qrserver.com` por generación server-side (`qrcode` npm, < 100 líneas de cambio).

**Excepción: fechas.** Las dos funciones de formateo de fecha deben usar GMT-4 (copiar el patrón de `SigningService.formatDateTimeFirma`).

**E46 sí requiere código nuevo** (secciones de transporte/exportación) pero es bounded: una función que lee del XML firmado los nodos del bloque `Exportaciones` y los renderiza.

---

## 6. Estimación de esfuerzo

| Ítem | Esfuerzo |
|------|----------|
| Fix timezone en fmtDate/fmtDateTime | 0.5h |
| Reemplazar QR externo con `qrcode` npm | 1h |
| Agregar ISC + Otros impuestos a totales | 1h |
| Agregar descuento por línea, ISC por línea, goodService | 1h |
| Agregar código de modificación (E33/E34) | 0.5h |
| Agregar leyendas fiscales por tipo (10 tipos) | 1h |
| Agregar fecha de pago | 0.5h |
| E41: mostrar vendedor en lugar de comprador | 1h |
| E46: secciones transporte + exportación | 3h |
| E47: sección beneficiario exterior | 1.5h |
| E44/E45: ajustes menores de layout | 1h |
| Tests (spec.ts) con snapshots HTML mínimos | 3h |
| Generación PDF binario server-side (opcional) | 4h |
| **Total sin PDF binario** | **~15h** |
| **Total con PDF binario** | **~19h** |

---

## 7. Lista priorizada de fixes

### P0 — Bloquean certificación DGII

1. **Fix timezone** — todas las fechas del RI están en hora de servidor (probablemente UTC), no en GMT-4. El auditor DGII ve fechas incorrectas.
2. **Leyendas fiscales por tipo** — requisito explícito en la documentación RI de DGII. Sin ellas el documento falla validación visual.
3. **E46 secciones transporte + exportación** — la RI de E46 sin esos bloques es incompleta per spec.
4. **Código de modificación en E33/E34** — `referenceModCode` debe aparecer ("Anula", "Corrección de Texto", etc.).

### P1 — Gaps funcionales graves

5. **Reemplazar QR externo** — instalar `qrcode` npm y generar el SVG/PNG server-side. El QR no puede depender de `api.qrserver.com` en el documento final.
6. **ISC total en totales** — campo obligatorio en RI si la factura tiene ISC.
7. **Descuento por línea** — la columna está en el modelo pero no en la tabla del RI.
8. **E41 vendedor/proveedor** — el RI muestra "Comprador" cuando debería mostrar "Vendedor".

### P2 — Mejoras necesarias antes de producción

9. **Tests** — 0 tests para el módulo entero. Mínimo: snapshot del HTML para E31 con datos conocidos, test de error en factura no encontrada, test de E46 con y sin bloques de exportación.
10. **Fecha de pago** — campo `invoice.paymentDate` no se muestra.
11. **E47 bloque beneficiario exterior** — país, tipo de renta, monto retención.
12. **E44/E45 ajustes** — E44 puede requerir indicador de zona franca; E45 requiere entidad gubernamental.

### P3 — Deuda técnica / nice-to-have

13. **PDF binario server-side** — para API consumers que quieran recibir un Buffer PDF directamente (headless puppeteer o `html-pdf-node`).
14. **Factorizar metadata frágil** — mover `tipoIngresos`, `indicadorMontoGravado`, `fechaVencSecuencia` a columnas propias en la tabla `invoices` en lugar de leer de `metadata._originalDto`.
15. **Bien/Servicio por línea** — columna `line.goodService` no mostrada.
16. **Impuestos adicionales por línea** — `additionalTaxCode`/`additionalTaxRate` no mostrados.

---

## 8. Diagnóstico resumido

| Dimensión | Calificación |
|-----------|-------------|
| Genera output real | ✅ Sí (HTML → PDF vía browser print) |
| URL del QR correcta | ✅ Sí |
| QR autosuficiente (sin internet) | ❌ No — depende de api.qrserver.com |
| Tipos E31/E32/E33/E34 | ⚠️ Parcial — faltan campos específicos |
| Tipos E41/E43/E44/E45/E47 | ❌ Sin tratamiento específico |
| Tipo E46 (Exportaciones) | ❌ Falta completamente |
| Leyendas fiscales por tipo | ❌ Una sola leyenda genérica |
| ISC en totales | ❌ Falta |
| Descuento por línea | ❌ Falta |
| Fechas en GMT-4 | ❌ Bug — usa hora de servidor |
| Tests | ❌ 0 tests |
| PDF binario server-side | ❌ No — solo HTML |
| **Completitud estimada contra DGII RI** | **~35–40%** |

El módulo está mucho más cerca de un prototipo funcional que de un esqueleto vacío, pero tampoco está cerca del 80%. Los gaps de E46, leyendas fiscales, ISC, y timezone son todos P0 para la certificación.

---

## Post-Fix Status (2026-05-03) — Tarea 10

Commits: `632e838`, `666bb2c`, `61d28ce`

### P0 Items

| # | Issue | Estado |
|---|---|---|
| 1 | Fix timezone — fechas en UTC, no GMT-4 | ✅ **Resuelto** — `fmtDateGmt4` / `fmtDateTimeGmt4` con `Intl.DateTimeFormat` `America/Santo_Domingo` |
| 2 | Leyendas fiscales por tipo (10 tipos) | ✅ **Resuelto** — `getFiscalLegend(ecfType)` en footer, test para cada tipo |
| 3 | E46 secciones transporte + exportación | ✅ **Resuelto** — `buildExportSections()` con sección Transporte + Información de Exportación. Campos sin dato muestran `[no especificado]`. TODO: freightPaymentMethod faltante en DTO. |
| 4 | Código de modificación E33/E34 | ✅ **Resuelto** — `referenceModCode` → nombre legible; warning si es null |

### P1 Items

| # | Issue | Estado |
|---|---|---|
| 5 | QR externo (api.qrserver.com) | ✅ **Resuelto** — `QRCode.toDataURL()` genera PNG base64 server-side; cero dependencias de red |
| 6 | ISC total en totales | ✅ **Resuelto** — fila ISC aparece cuando `totalIsc > 0` |
| 7 | Descuento por línea | ✅ **Resuelto** — columna Descuento siempre presente; muestra `—` cuando es 0 |
| 8 | E41 vendedor/proveedor | ✅ **Resuelto** — sección "Vendedor / Proveedor" para E41; usa `buyerRnc`/`buyerName` con override de `metadata._originalDto.vendedor` |
| 9 | Tests del módulo PDF | ✅ **Resuelto** — 28 tests en `pdf.service.spec.ts`; 223 total |

### Items P2/P3 no cubiertos en Tarea 10 (out of scope)

- E47 bloque beneficiario exterior (P2)
- Fecha de pago `invoice.paymentDate` ✅ **Bonus** — también implementado en 10.8
- ISC columna por línea ✅ **Bonus** — implementado en 10.5
- E44/E45 ajustes de layout (P2)
- PDF binario server-side — Tarea 11
- Bien/Servicio por línea (P3)

### Completitud estimada post-fix

**~75–80%** (vs. ~35–40% pre-fix). Los 4 P0 y los 4 P1 originales están cerrados.
El 20–25% restante son items P2/P3 (E47, E44/E45 ajustes, PDF binario, bien/servicio).
