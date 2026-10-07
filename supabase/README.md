# supabase/

| Carpeta | Contenido |
|---|---|
| `schema/` | `schema_nueva_db.sql` (esquema nuevo) y `schema.sql` (esquema heredado del backend). Referencia: el esquema **real** puede diferir; consultar `information_schema` antes de migrar. |
| `migrations_src/` | SQL de migración heredado, **sin numerar aún** (`create_*_view.sql`, `setup_km_architecture.sql`, `clean_residual_km_tables.sql`, `supabase_clean_duplicates.sql`). Orden recomendado histórico: `setup_km_architecture` → `create_individual_views` → `create_movimientos_view` → `clean_residual_km_tables`. Numerarlos en v1.1 tras validarlos contra la DB real. |
| `tools/` | Scripts Node de setup/verificación (`setup-db-views.js`, `setup-view-diaria.js`, `execute_migration.js`, `verify_db.js`). **Escriben en la DB**; no ejecutar sin revisión. |

Base canónica: proyecto Supabase `rsvajuxihvmpmrmlcbul` (único; `NEW_SUPABASE_*` era redundante).