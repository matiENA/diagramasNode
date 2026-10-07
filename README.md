# EOR v1 — Proyecto unificado

Un solo repo para administrar el flujo end-to-end:

```mermaid
flowchart LR
  GS[(Google Sheets)] -->|Service Account| EX["extraction/local_loader (LOCAL)"]
  N8N["n8n :5678 (LOCAL)"] -->|orquesta HTTP| EX
  EX -->|upsert| SB[(Supabase Postgres)]
  SB -->|pg pool / REST| BE["apps/backend (Render Web Service)"]
  SB -->|Realtime| FE
  BE -->|REST + Socket.IO| FE["apps/frontend (Render Static Site)"]
  FE -->|escrituras| BE
  BE -->|escritura directa| GS
  SB -.->|eor_sync_queue (v1.1)| GS
```

## Estructura

| Carpeta | Contenido | Dónde corre |
|---|---|---|
| `apps/frontend` | React 19 + Vite + TanStack Query | local `FRONT_PORT` · Render **Static Site** |
| `apps/backend` | Express 5 + Socket.IO + cache RAM. **Todas** las rutas (`/api/views`, `/api/movimientos`, `/api/dash`, `/api/diagramas`, `/api/proxy`, `/api/subir-foto`, `/api/auth`, `/api/servicios`, `/api/novedades`, `/api/webhook`, `/api/km/*`) | local `BACKEND_PORT` · Render **Web Service (free)** |
| `extraction/local_loader` | Extractores Sheets → Supabase, panel de control y consumidor de `eor_sync_queue` | **solo local** |
| `extraction/n8n` | Workflows y generadores `.py` (ver advertencia) | **solo local** |
| `supabase` | Esquema, migraciones y vistas SQL, scripts de setup | Supabase |
| `deploy` | `render.yaml`, rollback | — |
| `ops` | `.bat` de arranque con rutas relativas | local |
| `tools` | `check-syntax.js`, diagnósticos | local |
| `.agents/rules` | Reglas del proyecto (`reactividad-react.md`) | agentes |

## Puesta en marcha local (puertos de prueba)

1. `copy .env.example .env` y completar (o usar el `.env` ya generado).
2. `npm run install:all`
3. `ops\start-backend.bat` → `http://localhost:4005/health`
4. `ops\start-frontend.bat` → `http://localhost:4000`

> **Advertencia:** backend y frontend usan la **base Supabase real**. `ops\start-extraction.bat` y los workflows de n8n **escriben** datos reales; no se arrancan en las pruebas automáticas.

## Documentación
- [PUERTOS_Y_ENV.md](PUERTOS_Y_ENV.md) · [RECONCILIACION.md](RECONCILIACION.md) · [DEPLOY_RENDER.md](DEPLOY_RENDER.md) · [ROADMAP_v1.1.md](ROADMAP_v1.1.md) · [INVENTARIO_COPIA.md](INVENTARIO_COPIA.md)
- Documentos heredados (referencia, rutas desactualizadas): `legacy_README_*.md`, `FRONTEND_README.md`.
