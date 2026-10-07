# Regla: estructura del proyecto EOR (v1)

## Dónde va cada cosa
| Tipo de cambio | Carpeta |
|---|---|
| UI React, hooks, estilos | `apps/frontend/src` |
| Rutas HTTP, cache RAM, Socket.IO, acceso a DB desde el servidor | `apps/backend` (rutas en `routes/`, montadas en `server.js`) |
| Extractores Sheets→Supabase, panel local | `extraction/local_loader` |
| Workflows n8n (JSON) | `extraction/n8n/workflows` |
| SQL (esquema, vistas, migraciones) | `supabase/` (numerar migraciones nuevas `NNN_descripcion.sql`) |
| Config de despliegue | `deploy/` |
| Scripts de arranque | `ops/` (rutas relativas, nunca `C:\Users\...`) |
| Diagnósticos reutilizables | `tools/diagnostics` |
| Documentación | `docs/` |

## Reglas
1. **Un solo backend** (`apps/backend`): no crear servidores intermedios ni duplicar `routes/`, `utils/` o `cache/` en otras carpetas.
2. **Un solo `.env`** en la raíz (no versionado) + `.env.example` actualizado cuando se agregue una variable. Nunca hardcodear claves en código.
3. **Frontend = Static Site**: toda URL del backend sale de `VITE_API_URL`; en local el proxy de Vite.
4. **No dejar scratch** en el repo: scripts temporales fuera del árbol (o en una carpeta ignorada).
5. **Cada app tiene su `package.json` y su `package-lock.json` versionado** (Render usa `npm ci`).
6. Consultar el esquema real antes de usar columnas/tablas (ver `docs/RECONCILIACION.md`: `movimientos_km` no existe; `actualizado_por` solo en `chofer_documentacion`).
7. Las pruebas automáticas usan **solo lecturas** contra Supabase; extractores y workflows de n8n escriben datos reales.
8. Reglas de reactividad y límites de egress/RAM: ver [reactividad-react.md](reactividad-react.md) (sin cambios).