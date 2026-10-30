-- ==============================================================================
-- Migración 012: Incorporación de Seguridad Vial (ICM + ISP) a Vistas de Calendario
-- Fecha: 2026-10-30
-- Conecta public.seguridad_vial con public.diagramas y public.choferes_km_mensual
-- mediante el pareo canónico: (chofer_id, anio, mes_numero)
-- ==============================================================================

-- 1. Vista Completa Histórica: view_calendario_diagrama_km
CREATE OR REPLACE VIEW public.view_calendario_diagrama_km AS
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
    COALESCE(ck.dias_km, '{}'::jsonb) AS dias_km,
    sv.icm,
    sv.isp,
    COALESCE(sv.cant_infracciones, 0) AS cant_infracciones,
    COALESCE(sv.tiempo_conduccion_horas, 0::numeric) AS tiempo_conduccion_horas
FROM public.diagramas d
FULL JOIN public.choferes_km_mensual ck 
    ON ck.chofer_id = d.chofer_id AND ck.mes_tab = d.mes_tab
LEFT JOIN public.seguridad_vial sv 
    ON sv.chofer_id = COALESCE(d.chofer_id, ck.chofer_id)
   AND sv.anio = COALESCE(d.anio, ck.anio)
   AND sv.mes_numero = COALESCE(d.mes_numero, ck.mes_numero);

-- 2. Vista 2 Meses Operativos Activos (Ventana C1 de Hot RAM: Sep-26 + Oct-26)
CREATE OR REPLACE VIEW public.view_calendario_diagrama_km_2m AS
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
    COALESCE(ck.dias_km, '{}'::jsonb) AS dias_km,
    sv.icm,
    sv.isp,
    COALESCE(sv.cant_infracciones, 0) AS cant_infracciones,
    COALESCE(sv.tiempo_conduccion_horas, 0::numeric) AS tiempo_conduccion_horas
FROM public.diagramas d
FULL JOIN public.choferes_km_mensual ck 
    ON ck.chofer_id = d.chofer_id AND ck.mes_tab = d.mes_tab
LEFT JOIN public.seguridad_vial sv 
    ON sv.chofer_id = COALESCE(d.chofer_id, ck.chofer_id)
   AND sv.anio = COALESCE(d.anio, ck.anio)
   AND sv.mes_numero = COALESCE(d.mes_numero, ck.mes_numero)
WHERE (((COALESCE(d.anio, ck.anio) = 2026) AND (COALESCE(d.mes_numero, ck.mes_numero) = ANY (ARRAY[9, 10])))
   OR (COALESCE(d.mes_tab, ck.mes_tab) = ANY (ARRAY['Sep-26'::text, 'Oct-26'::text])));

-- 3. Vista 12 Meses Operativos (Zoom Anual)
CREATE OR REPLACE VIEW public.view_calendario_diagrama_km_12m AS
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
    COALESCE(ck.dias_km, '{}'::jsonb) AS dias_km,
    sv.icm,
    sv.isp,
    COALESCE(sv.cant_infracciones, 0) AS cant_infracciones,
    COALESCE(sv.tiempo_conduccion_horas, 0::numeric) AS tiempo_conduccion_horas
FROM public.diagramas d
FULL JOIN public.choferes_km_mensual ck 
    ON ck.chofer_id = d.chofer_id AND ck.mes_tab = d.mes_tab
LEFT JOIN public.seguridad_vial sv 
    ON sv.chofer_id = COALESCE(d.chofer_id, ck.chofer_id)
   AND sv.anio = COALESCE(d.anio, ck.anio)
   AND sv.mes_numero = COALESCE(d.mes_numero, ck.mes_numero)
WHERE (COALESCE(d.anio, ck.anio) = 2026);

-- 4. Función con Filtros Paramétricos: fn_calendario_diagrama_km
DROP FUNCTION IF EXISTS public.fn_calendario_diagrama_km(uuid, text[], integer);

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
    dias_km jsonb,
    icm numeric,
    isp numeric,
    cant_infracciones integer,
    tiempo_conduccion_horas numeric
)
LANGUAGE sql
STABLE PARALLEL SAFE
AS $function$
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
    COALESCE(ck.dias_km, '{}'::jsonb) AS dias_km,
    sv.icm,
    sv.isp,
    COALESCE(sv.cant_infracciones, 0) AS cant_infracciones,
    COALESCE(sv.tiempo_conduccion_horas, 0::numeric) AS tiempo_conduccion_horas
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
  ) ck ON ck.mes_tab = d.mes_tab
  LEFT JOIN public.seguridad_vial sv
    ON sv.chofer_id = p_chofer_id
   AND sv.anio = COALESCE(d.anio, ck.anio)
   AND sv.mes_numero = COALESCE(d.mes_numero, ck.mes_numero);
$function$;

