# extraction/ (SOLO LOCAL)

- `local_loader/` — extractores de Google Sheets (Service Account) hacia Supabase, panel de control y consumidor de `eor_sync_queue`. Se arranca con `ops\start-extraction.bat`. **Escribe en la base real.**
  - No se copiaron `data/` (24 MB de volcados) ni `cache/` (se regeneran).
- `n8n/workflows/` — JSON de workflows (referencia/versionado). **No se importaron** al n8n en `localhost:5678`.
- `n8n/tools/` — generadores `.py` heredados. **NO EJECUTAR**: modifican directamente `~/.n8n/database.sqlite` y usan rutas absolutas a `Documents\server_local\...`. Quedan como referencia hasta v1.1.
- Pendiente v1.1: extracción de km mediante n8n y orquestación programada (ver `docs/ROADMAP_v1.1.md`).