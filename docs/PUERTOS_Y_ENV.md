# Puertos y variables de entorno

## Puertos

| Servicio | Pruebas (`eor_v1`) | Definitivo | Originales (siguen corriendo hasta terminar las pruebas) |
|---|---|---|---|
| Frontend (Vite) | `FRONT_PORT=4000` | 3000 | 3000 (`eor/server.js`) |
| Backend | `BACKEND_PORT=4005` | 3005 | 3005 (`storage_ram_db`) |
| local_loader | `LOADER_PORT=4010` | 3010 | 3010 |
| n8n | 5678 (compartido) | 5678 | 5678 |

Al terminar las pruebas: apagar los originales y cambiar `FRONT_PORT/BACKEND_PORT/LOADER_PORT/BACKEND_URL` en `.env` a los definitivos.

## Un solo `.env` (raíz, no versionado)

`ops/*.bat` leen `*_PORT` del `.env` raíz y exportan `PORT` al proceso (Node `--env-file`). En Render, `PORT` lo define la plataforma.

| Grupo | Variables |
|---|---|
| Puertos locales | `FRONT_PORT`, `BACKEND_PORT`, `LOADER_PORT`, `BACKEND_URL` |
| Frontend (build) | `VITE_API_URL` (vacío en local → proxy de Vite; URL del backend en Render), `VITE_SUPABASE_URL`, `VITE_SUPABASE_KEY` (publishable) |
| Supabase | `SUPABASE_URL`, `SUPABASE_KEY`, `DATABASE_URL`, `PG_MAX_CONNECTIONS`, `PG_IDLE_TIMEOUT` |
| Google | `GOOGLE_SERVICE_ACCOUNT_EMAIL`, `GOOGLE_PRIVATE_KEY`, `ID_SPREADSHEET_MASTER`, `SPREADSHEET_ID`, `ID_SHEET_MOVIMIENTOS`, `MES_MOVIMIENTOS_ID`, `ID_SPREADSHEET_DIAGRAMAS`, `SHEET_KM_ID`, `ID_SHEET_KILOMETROS` |
| Otros | `IMGBB_API_KEY`, `KM_RAM_DIAS`, `SYNC_INTERVAL_MINUTES` (solo loader) |

Cambios respecto a los `.env` originales: se eliminó `NEW_SUPABASE_URL/KEY` (apuntaban al mismo proyecto), `KM_SERVICE_URL` (km-service retirado: km en Supabase), `GEMINI_API_KEY` (bot fuera de alcance) y `PORT` (reemplazado por `*_PORT`).
