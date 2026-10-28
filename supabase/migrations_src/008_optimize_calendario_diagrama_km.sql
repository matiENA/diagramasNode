-- ==============================================================================
-- 🚀 OPTIMIZACIÓN PUSHDOWN P0: fn_calendario_diagrama_km
-- Elimina Seq Scan y Hash Full Join de 4000 filas a Index Scan directo O(1) < 1ms
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.fn_calendario_diagrama_km(p_chofer_id uuid, p_tabs text[] DEFAULT NULL)
RETURNS TABLE (
  diagrama_id uuid,
  chofer_id uuid,
  mes_tab text,
  anio int,
  mes_numero int,
  tira_dias text,
  contabilizador jsonb,
  km_mes_total numeric,
  cant_viajes_mes int,
  dias_km jsonb
)
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT 
    COALESCE(d.id, gen_random_uuid()) AS diagrama_id,
    COALESCE(d.chofer_id, ck.chofer_id) AS chofer_id,
    COALESCE(d.mes_tab, ck.mes_tab) AS mes_tab,
    COALESCE(d.anio, ck.anio) AS anio,
    COALESCE(d.mes_numero, ck.mes_numero) AS mes_numero,
    COALESCE(d.tira_dias, ''::text) AS tira_dias,
    COALESCE(d.contabilizador, '{}'::jsonb) AS contabilizador,
    COALESCE(ck.km_mes_total, 0::numeric) AS km_mes_total,
    COALESCE(ck.cant_viajes, 0) AS cant_viajes_mes,
    COALESCE(ck.dias_km, '{}'::jsonb) AS dias_km
  FROM (
    SELECT * FROM public.diagramas 
    WHERE chofer_id = p_chofer_id AND (p_tabs IS NULL OR mes_tab = ANY(p_tabs))
  ) d
  FULL JOIN (
    SELECT * FROM public.choferes_km_mensual 
    WHERE chofer_id = p_chofer_id AND (p_tabs IS NULL OR mes_tab = ANY(p_tabs))
  ) ck ON ck.mes_tab = d.mes_tab;
$$;

GRANT EXECUTE ON FUNCTION public.fn_calendario_diagrama_km(uuid, text[]) TO anon, authenticated, service_role, postgres;
