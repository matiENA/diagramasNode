# Roadmap v1.1

Fuera del alcance de la reorganización v1 (decisión del usuario).

## 1. Extracción vía n8n (incluye km)
- El `km-service` se retiró: los km están en Supabase. Falta crear la **extracción de km mediante n8n** (hoy los extractores viven en `extraction/local_loader/extractors/kilometros.js`).
- Unificar los pipelines de `extraction/n8n/workflows/*.json` con trigger programado (Schedule) y activarlos.
- Los generadores `extraction/n8n/tools/*.py` **escriben directo en `~/.n8n/database.sqlite`** del n8n vivo y apuntan a rutas absolutas viejas (`Documents\server_local\...`). **No ejecutar** sin revisarlos/parametrizarlos.

## 2. Sync Supabase → Sheets
- Ya existen en la DB: `eor_sync_queue` y triggers `trg_sync_asignacion`, `trg_sync_diagramas`, `trg_sync_documentacion`, `trg_movimientos_sync`.
- Ya existe el consumidor `extraction/local_loader/services/syncQueueConsumer.js` (cola → Sheets por lotes, con `dryRun`). Falta decidir si lo orquesta n8n (WF-3 del plan previo) y validar la columna de estado de la cola (la consulta por `estado` falló en la sonda de esquema: revisar nombres reales de columnas).
- Retirar el "doble guardado" del frontend (`fetch('/api/proxy')` en `useUpdateDocField`, `useSaveAllDocs`, `TrimestralCalendar`) una vez validado.

## 3. Auditoría de operador
- Migración `actualizado_por` en `choferes` y `diagramas` y adopción de `dash.js`/`proxy.js` de `eor` (ver `RECONCILIACION.md`).

## 4. Limpieza y hardening
- Eliminar referencias a `movimientos_km` en `server.js`/`proxy.js`.
- Rotar contraseña de DB y keys; mover/rotar `service_account.json`, tokens de Figma y notas con credenciales (fuera de este repo).
- Mover los originales a `Documents/legacy_eor/` cuando se apruebe, tras apagar los servicios viejos.
- Decidir destino de `DASH/` (cliente de `/api/dash`) y del `bot/` (ambos fuera de la v1).
