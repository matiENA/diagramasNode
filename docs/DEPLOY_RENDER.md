# Deploy en Render (Blueprint EOR v1 — Backend Unificado)

Blueprint: [`render.yaml`](../render.yaml) o [`deploy/render.yaml`](../deploy/render.yaml).  
En Render → **New → Blueprint** → seleccionar el repositorio y **Blueprint Path = `render.yaml`**.

---

## 🚀 Arquitectura de Servicios en Render (2 Servicios = 100% Free Plan)

Al adherir el worker de sincronización directamente al backend principal de EOR, **no se requiere un tercer servicio**. Esto garantiza que el proyecto se mantenga dentro de las **750 horas mensuales gratuitas** de Render (1 solo Web Service + 1 Static Site).

1. **`eor-backend`** — Web Service (Plan Free)
   - **Root Directory:** `apps/backend`
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Health Check Path:** `/health`
   - **Funciones Integradas:**
     - API REST (vistas operativas, choferes, flota, movimientos, diagramas).
     - WebSocket Realtime (Socket.IO).
     - **Sync Worker Integrado (Partición 8):** Procesa de forma autónoma `public.eor_sync_queue` hacia Google Sheets (batchUpdate respetando 60 req/min).
     - Sondeo autónomo cada 90s cuando hay registros pendientes.
     - Endpoint UptimeRobot: `/uptimerobot` y `/api/sync/queue/uptimerobot`.

2. **`eor` (Frontend)** — Static Site
   - **Root Directory:** `apps/frontend`
   - **Build Command:** `npm ci && npm run build`
   - **Static Publish Path:** `dist`
   - **Rewrites:** `/* -> /index.html`
   - **Optimistic UI:** Actualización inmediata en RAM (<16ms) para asignaciones de flota y sincronización reactiva en segundo plano con Supabase y Google Sheets.

---

## 📡 Monitoreo y Keep-Alive con UptimeRobot (1 Solo Monitor)

Un solo monitor de UptimeRobot mantiene despierto todo el backend (`eor-backend`) las 24 horas y gatilla el consumo automático de mutaciones pendientes:

### Configuración del Monitor en UptimeRobot:
- **Monitor Type:** `HTTP(s)`
- **Friendly Name:** `EOR Backend & Sync Queue`
- **URL (o IP):** `https://eor-backend.onrender.com/health`  
  *(o con verificación de cola:* `https://eor-backend.onrender.com/uptimerobot?token=eor-sync-robot-mon-v1`*)*
- **Monitoring Interval:** `5 minutes`
- **HTTP Method:** `HEAD` o `GET`
- **Expected Status Code:** `200`
- **Monitor ID:** Se autogenera en el Dashboard de UptimeRobot al crear el monitor (ej. `m791234567`).  
  Token interno de validación del servicio: `eor-sync-robot-mon-v1`.

---

## 🔄 Variables de Entorno en Render Dashboard (`sync: false`)
Cargar en el Dashboard de Render para `eor-backend`:
- `DATABASE_URL`: `postgresql://postgres.rsvajuxihvmpmrmlcbul:kMmGplQEcWDYUBAB@aws-0-us-east-1.pooler.supabase.com:6543/postgres?pgbouncer=true`
- `SUPABASE_URL`: `https://rsvajuxihvmpmrmlcbul.supabase.co`
- `SUPABASE_KEY`: Service role key o anon key de Supabase.
- `GOOGLE_SERVICE_ACCOUNT_EMAIL`: Correo de la Service Account de Google Cloud.
- `GOOGLE_PRIVATE_KEY`: Llave privada RSA (`-----BEGIN PRIVATE KEY...`).
- `SPREADSHEET_ID`: ID del Spreadsheet principal de Google Sheets.
- `MES_MOVIMIENTOS_ID`: `14Mb5rD853zxDkaLDS-IrW-OBDTDBjuJxn_3olXeWlkc`
- `UPTIMEROBOT_MONITOR_TOKEN`: `eor-sync-robot-mon-v1`
