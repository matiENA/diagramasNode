# Inventario de la copia (eor_v1)

Generado: 2026-10-06 06:40

| Carpeta | Archivos | Origen |
|---|---|---|
| `.agents` | 2 | eor/.agents (intacto) |
| `.env` | 1 |  |
| `.env.example` | 1 |  |
| `.gitignore` | 1 |  |
| `apps/backend` | 24 | storage_ram_db (raÃ­z) + views/movimientos de eor |
| `apps/frontend` | 54 | eor/frontend (â‰¡ eor/src) |
| `deploy` | 2 | eor/ROLLBACK_RENDER.md + nuevo render.yaml |
| `docs` | 6 | READMEs heredados + nuevos |
| `docs/_reconciliacion_eor_versions` | 6 |  |
| `docs/legacy_README_eor.md` | 1 |  |
| `docs/legacy_README_storage_ram_db.md` | 1 |  |
| `extraction` | 1 |  |
| `extraction/local_loader` | 33 | storage_ram_db/local_loader (sin data/cache/scratch/.env) |
| `extraction/n8n` | 15 | server_local/n8n y *.py |
| `GEMINI.md` | 1 |  |
| `ops` | 5 | nuevos (rutas relativas) |
| `package.json` | 1 |  |
| `README.md` | 1 |  |
| `supabase` | 1 | eor/supabase + storage_ram_db/*.sql |
| `supabase/migrations_src` | 5 |  |
| `supabase/schema` | 2 |  |
| `supabase/tools` | 4 |  |
| `tools` | 9 | eor/scripts (lista curada) + nuevos |

## No copiado (permanece en su lugar original)
`node_modules`, `.git`, `eor/public` (bundles 25 MB), `public_legacy`, `DASH`, `bot`, `km-service`, `scratch`, `_dbdocs`, `_figma_snapshots`, `notas`, `extraccion_local`, `routes/utils/sync` duplicados de `eor`, `local_loader/{data,cache,scratch_*}`, tests/scratch viejos de `storage_ram_db`, secretos sueltos de `Documents`.

## GarantÃ­a de no modificaciÃ³n de originales
Baseline previo/posterior: nÂº de archivos y Ãºltima escritura de `eor`, `storage_ram_db`, `server_local` idÃ©nticos; `git status` de `eor` idÃ©ntico.
