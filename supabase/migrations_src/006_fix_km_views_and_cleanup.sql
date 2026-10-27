-- ==============================================================================
-- 🚀 MIGRACIÓN 006: CORRECCIÓN DE VISTAS DE KM, REALTIME Y LIMPIEZA DE BASURA
-- Supabase PostgreSQL
-- ==============================================================================

-- 1. Limpieza de registros corruptos fuera de rango o con fechas inválidas
DELETE FROM public.choferes_km_mensual 
WHERE anio < 2020 OR anio > 2030 OR mes_tab = 'Dic-99';

-- 2. VISTA ACTUALIZADA: view_calendario_diagrama_km
-- Usa FULL OUTER JOIN para no perder los KMs de meses que aún no tienen diagrama cargado
DROP VIEW IF EXISTS public.view_calendario_diagrama_km CASCADE;

CREATE OR REPLACE VIEW public.view_calendario_diagrama_km AS
SELECT 
  COALESCE(d.id, gen_random_uuid()) AS diagrama_id,
  COALESCE(d.chofer_id, ck.chofer_id) AS chofer_id,
  COALESCE(d.mes_tab, ck.mes_tab) AS mes_tab,
  COALESCE(d.anio, ck.anio) AS anio,
  COALESCE(d.mes_numero, ck.mes_numero) AS mes_numero,
  COALESCE(d.tira_dias, '') AS tira_dias,
  COALESCE(d.contabilizador, '{}'::jsonb) AS contabilizador,
  COALESCE(ck.km_mes_total, 0) AS km_mes_total,
  COALESCE(ck.cant_viajes, 0) AS cant_viajes_mes,
  COALESCE(ck.dias_km, '{}'::jsonb) AS dias_km
FROM public.diagramas d
FULL OUTER JOIN public.choferes_km_mensual ck 
  ON ck.chofer_id = d.chofer_id AND ck.mes_tab = d.mes_tab;

GRANT SELECT ON public.view_calendario_diagrama_km TO anon, authenticated, service_role, postgres;

-- 3. VISTA ACTUALIZADA: view_calendario_km
-- Filtra celdas vacías (km=0 y sin HR) para reducir drásticamente el consumo de Egress
DROP VIEW IF EXISTS public.view_calendario_km CASCADE;

CREATE OR REPLACE VIEW public.view_calendario_km AS
SELECT 
  (day_kv.key)::date AS fecha,
  ck.chofer_id AS id_chofer,
  c.nombre AS chofer_nombre,
  (day_kv.value->>'id_unidad')::uuid AS id_unidad,
  day_kv.value->>'n_ute' AS n_ute,
  day_kv.value->>'tractor' AS dominio,
  (day_kv.value->>'km')::numeric AS km,
  (day_kv.value->>'km')::numeric AS km_totales,
  1::integer AS cant_viajes,
  CASE 
    WHEN day_kv.value->>'hr' IS NOT NULL AND day_kv.value->>'hr' <> '' 
    THEN string_to_array(day_kv.value->>'hr', ', ')
    ELSE ARRAY[]::text[]
  END AS hoja_ruta
FROM public.choferes_km_mensual ck
JOIN public.choferes c ON ck.chofer_id = c.id
CROSS JOIN LATERAL jsonb_each(ck.dias_km) AS day_kv(key, value)
WHERE (day_kv.value->>'km')::numeric > 0 OR COALESCE(day_kv.value->>'hr', '') <> '';

GRANT SELECT ON public.view_calendario_km TO anon, authenticated, service_role, postgres;

-- 4. Habilitar publicación Realtime en choferes_km_mensual (si no está ya agregada)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'choferes_km_mensual'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.choferes_km_mensual;
  END IF;
END $$;
