# Deploy en Render (sin ejecutar nada aún)

Blueprint: [`deploy/render.yaml`](../deploy/render.yaml). En Render → *New → Blueprint* → seleccionar el repo y **Blueprint Path = `deploy/render.yaml`**.

## Servicios
1. **`eor-backend`** — Web Service, plan **free** (se suspende por inactividad: primer request tras reposo tarda ~30-60 s), `rootDir: apps/backend`, health `/health`. Cargar en el dashboard las variables `sync:false` (Supabase, DB, Google, IMGBB).
2. **`eor-frontend`** — Static Site, `rootDir: apps/frontend`, publica `dist/`, rewrite `/* → /index.html`. Variables de build: `VITE_API_URL=https://<url-del-backend>`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_KEY`.

## Orden
1. Desplegar backend y anotar su URL pública.
2. Configurar `VITE_API_URL` con esa URL y desplegar el frontend.
3. CORS: el backend ya admite `*.onrender.com`, `localhost` y `127.0.0.1`. Si se usa dominio propio, agregarlo a `dominiosPermitidos` en `apps/backend/server.js`.

## Consideraciones del plan free
- RAM 512 MB (el backend está optimizado para eso; ver `GEMINI.md`).
- Realtime del front va directo a Supabase (no depende del backend dormido), pero las vistas `/api/views/*` sí.
- El frontend hace *fallback* a Supabase directo si el backend no responde (`apiClient.js`).

## Rollback
Ver [`deploy/ROLLBACK_RENDER.md`](../deploy/ROLLBACK_RENDER.md) (heredado: hace referencia a la arquitectura anterior con Railway).
