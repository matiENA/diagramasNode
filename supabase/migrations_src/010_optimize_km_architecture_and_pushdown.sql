-- ==============================================================================
-- 🚀 MIGRACIÓN 010: PUSHDOWN ANUAL Y REFINAMIENTO DE VISTAS DE KM
-- Instancia: rsvajuxihvmpmrmlcbul (Supabase PostgreSQL 17.6)
-- ==============================================================================

-- Eliminar versión anterior de 2 argumentos para evitar ambigüedad de sobrecarga
DROP FUNCTION IF EXISTS public.fn_calendario_diagrama_km(uuid, text[]);

-- 1. Función pushdown optimizada con soporte dual: tabs específicas O año completo
CREATE OR REPLACE FUNCTION public.fn_calendario_diagrama_km(
    p_chofer_id uuid,
    p_tabs text[] DEFAULT NULL::text[],
    p_anio integer DEFAULT NULL::integer
)
RETURNS TABLE(
    diagrama_id uuid,
    chofer_id uuid,
    mes_tab text,
    anio integer,
    mes_numero integer,
    tira_dias text,
    contabilizador jsonb,
    km_mes_total numeric,
    cant_viajes_mes integer,
    dias_km jsonb
)
LANGUAGE sql
STABLE PARALLEL SAFE
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
    SELECT id, chofer_id, mes_tab, anio, mes_numero, tira_dias, contabilizador
    FROM public.diagramas 
    WHERE chofer_id = p_chofer_id 
      AND (p_tabs IS NULL OR mes_tab = ANY(p_tabs))
      AND (p_anio IS NULL OR anio = p_anio)
  ) d
  FULL JOIN (
    SELECT chofer_id, mes_tab, anio, mes_numero, km_mes_total, cant_viajes, dias_km
    FROM public.choferes_km_mensual 
    WHERE chofer_id = p_chofer_id 
      AND (p_tabs IS NULL OR mes_tab = ANY(p_tabs))
      AND (p_anio IS NULL OR anio = p_anio)
  ) ck ON ck.mes_tab = d.mes_tab;
$$;

-- 2. Asegurar índices de cobertura B-Tree para Index Scans < 2ms
CREATE INDEX IF NOT EXISTS idx_diagramas_chofer_anio_mes 
  ON public.diagramas (chofer_id, anio, mes_numero);

CREATE INDEX IF NOT EXISTS idx_choferes_km_chofer_anio_mes 
  ON public.choferes_km_mensual (chofer_id, anio, mes_numero);

COMMENT ON FUNCTION public.fn_calendario_diagrama_km(uuid, text[], integer) IS
'Función pushdown atómica para calendario y KM de chofer. Admite filtrado por lista de pestañas o por año completo.';
