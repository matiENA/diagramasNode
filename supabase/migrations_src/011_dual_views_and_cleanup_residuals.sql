-- ==============================================================================
-- 🚀 MIGRACIÓN 011: Vistas Especializadas (2M / 12M) y Depuración de Residuales
-- ==============================================================================
-- 1. Elimina la vista residual view_calendario_km (CROSS JOIN LATERAL jsonb_each)
--    que causaba CPU throttling y descargas masivas no indexadas.
-- 2. Crea public.view_calendario_diagrama_km_2m optimizada para los 2 meses operativos
--    (Sep-26 + Oct-26) para la vista predeterminada activa (< 2 KB gzip).
-- 3. Crea public.view_calendario_diagrama_km_12m optimizada para los 12 meses (2026)
--    para la consulta anual bajo demanda.
-- ==============================================================================

-- 1. Eliminación de vista residual obsoleta
DROP VIEW IF EXISTS public.view_calendario_km CASCADE;

-- 2. Vista optimizada para 2 Meses (Horizonte Operativo Activo: Sep-26 + Oct-26)
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
    COALESCE(ck.dias_km, '{}'::jsonb) AS dias_km
FROM public.diagramas d
FULL JOIN public.choferes_km_mensual ck 
    ON ck.chofer_id = d.chofer_id AND ck.mes_tab = d.mes_tab
WHERE (COALESCE(d.anio, ck.anio) = 2026 AND COALESCE(d.mes_numero, ck.mes_numero) IN (9, 10))
   OR COALESCE(d.mes_tab, ck.mes_tab) IN ('Sep-26', 'Oct-26');

-- 3. Vista optimizada para 12 Meses (Consulta Anual Completa: Año 2026)
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
    COALESCE(ck.dias_km, '{}'::jsonb) AS dias_km
FROM public.diagramas d
FULL JOIN public.choferes_km_mensual ck 
    ON ck.chofer_id = d.chofer_id AND ck.mes_tab = d.mes_tab
WHERE COALESCE(d.anio, ck.anio) = 2026;

-- Otorgar permisos de lectura a roles estándar
GRANT SELECT ON public.view_calendario_diagrama_km_2m TO anon, authenticated, service_role;
GRANT SELECT ON public.view_calendario_diagrama_km_12m TO anon, authenticated, service_role;
