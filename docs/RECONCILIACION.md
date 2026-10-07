# Reconciliación de archivos divergentes (eor vs storage_ram_db)

Criterio rector: **la v1 no cambia lógica funcional**. Se usa lo que hoy *corre* contra la base real
(`storage_ram_db` en 3005 + las rutas que `eor/server.js` montaba) y se contrasta contra el esquema real
de Supabase (consultado en modo solo lectura el 2026-10-05).

## Esquema real relevante (Supabase `rsvajuxihvmpmrmlcbul`)
- `movimientos_km` **no existe** (km vive en `view_calendario_km`, `choferes_km_mensual`, `cisternas_km`).
- `actualizado_por` existe **solo** en `chofer_documentacion`; **no** existe en `choferes` ni `diagramas`.
- Existen `eor_sync_queue` y triggers `fn_trg_sync_*` (base del sync Supabase → Sheets de la v1.1).
- Vistas disponibles: `view_diaria_operativa`, `view_flota_operativa`, `view_individual_chofer`,
  `view_calendario_diagrama_km`, `view_calendario_km`, `view_movimientos`, `view_personal_retorno`, entre otras.

## Decisiones

| Archivo | Versión usada | Motivo |
|---|---|---|
| `routes/auth.js`, `diagramas.js`, `utils/db.js`, `utils/shared.js`, `utils/kmClient.js` | idénticos | sin diferencias |
| `cache/builder.js` | **storage_ram_db** | Lee `view_calendario_km` y `chofer_documentacion` (esquema actual). La de `eor` lee `movimientos_km` y columnas viejas de `choferes` (`dni`, `c_servicio`, `diagrama_tipo`) que ya no existen. |
| `routes/dash.js` | **storage_ram_db** | La de `eor` escribe `choferes.actualizado_por` → **falla** contra la DB actual (columna inexistente). |
| `routes/proxy.js` | **storage_ram_db** | La de `eor` escribe `diagramas.actualizado_por` (inexistente) y elimina la persistencia de hoja de ruta. Es trabajo en curso, no desplegable aún. |
| `routes/fotos.js` | **storage_ram_db** | Sin dependencia de esquema en `eor`, pero cambia semántica del broadcast Socket.IO; se evalúa en v1.1. |
| `routes/views.js` | **eor** (portado) | No existía en el backend; usada hoy por el front. Solo consulta vistas existentes. |
| `routes/movimientos.js` | **eor** (portado) | Idéntica entre `eor/routes` y `eor/backend/routes` salvo el comentario de cabecera. |

## Pendientes derivados (para v1.1, no se aplican ahora)
1. Migración `ALTER TABLE choferes, diagramas ADD COLUMN actualizado_por text` + adoptar `dash.js`/`proxy.js` de `eor` (auditoría de operador).
2. `proxy.js`/`server.js` (storage_ram_db) aún mencionan `movimientos_km` en bloques `try/catch` que degradan con *warning*; limpiar.
3. Adoptar robustez de `fotos.js` de `eor` (fallback de `sharp`, guardas de `cacheDatosGlobales`, mensajes de error).
4. `services/syncQueueConsumer.js` del `local_loader` ya consume `eor_sync_queue` → Sheets (ver `ROADMAP_v1.1.md`).

Las versiones de `eor` quedaron en `docs/_reconciliacion_eor_versions/` (ignoradas por git) para comparar.
