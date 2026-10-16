-- ==============================================================================
-- 🚀 SCRIPT DE NORMALIZACIÓN RELACIONAL - SUPABASE POSTGRESQL
-- Proyecto: rsvajuxihvmpmrmlcbul.supabase.co
-- Regla: 1 sola vez cada dato. Todo enlazado mediante IDs / Foreign Keys.
-- ==============================================================================

BEGIN;

-- ==============================================================================
-- 1. FASE DE RESGUARDO Y ENLACE PREVIO DE DATOS
-- ==============================================================================

-- 1.1 Salvaguardar DNIs y teléfonos presentes en choferes hacia chofer_documentacion
UPDATE public.chofer_documentacion cd
SET dni = c.dni
FROM public.choferes c
WHERE cd.chofer_id = c.id
  AND (cd.dni IS NULL OR TRIM(cd.dni) = '')
  AND c.dni IS NOT NULL;

UPDATE public.chofer_documentacion cd
SET telefono = c.telefono
FROM public.choferes c
WHERE cd.chofer_id = c.id
  AND (cd.telefono IS NULL OR TRIM(cd.telefono) = '')
  AND c.telefono IS NOT NULL;

-- 1.2 Agregar unidad_id a chofer_observaciones y vincular patentes existentes
ALTER TABLE public.chofer_observaciones 
ADD COLUMN IF NOT EXISTS unidad_id UUID REFERENCES public.unidades(id) ON DELETE SET NULL;

UPDATE public.chofer_observaciones o
SET unidad_id = u.id
FROM public.tractores t
JOIN public.unidades u ON u.tractor_id = t.id
WHERE o.unidad_id IS NULL
  AND o.unidad_dominio IS NOT NULL
  AND UPPER(REPLACE(o.unidad_dominio, ' ', '')) = UPPER(REPLACE(t.patente, ' ', ''));

-- 1.3 Vincular unidades en movimientos_km que estaban sin id_unidad pero tenían dominio
UPDATE public.movimientos_km m
SET id_unidad = u.id
FROM public.tractores t
JOIN public.unidades u ON u.tractor_id = t.id
WHERE m.id_unidad IS NULL
  AND m.dominio IS NOT NULL
  AND UPPER(REPLACE(m.dominio, ' ', '')) = UPPER(REPLACE(t.patente, ' ', ''));

-- ==============================================================================
-- 2. FASE DE ELIMINACIÓN DE COLUMNAS REPETIDAS (DROP CASCADE)
-- ==============================================================================

-- 2.1 Limpiar tabla choferes (conservar solo datos operativos esenciales)
ALTER TABLE public.choferes
    DROP COLUMN IF EXISTS dni CASCADE,
    DROP COLUMN IF EXISTS telefono CASCADE,
    DROP COLUMN IF EXISTS c_servicio CASCADE,
    DROP COLUMN IF EXISTS diagrama_tipo CASCADE,
    DROP COLUMN IF EXISTS diagrama_json CASCADE,
    DROP COLUMN IF EXISTS contabilizador CASCADE,
    DROP COLUMN IF EXISTS actualizado_por CASCADE;

-- 2.2 Limpiar tabla diagramas (remover strings duplicados de chofer y servicio)
ALTER TABLE public.diagramas
    DROP COLUMN IF EXISTS chofer_nombre CASCADE,
    DROP COLUMN IF EXISTS legajo CASCADE,
    DROP COLUMN IF EXISTS servicio CASCADE,
    DROP COLUMN IF EXISTS actualizado_por CASCADE;

-- 2.3 Limpiar tabla movimientos_km (remover nombres y patentes en texto)
ALTER TABLE public.movimientos_km
    DROP COLUMN IF EXISTS chofer_nombre CASCADE,
    DROP COLUMN IF EXISTS dominio CASCADE;

-- 2.4 Limpiar tabla novedades (remover nombres, vehículos y servicios en texto)
ALTER TABLE public.novedades
    DROP COLUMN IF EXISTS nom CASCADE,
    DROP COLUMN IF EXISTS tractor CASCADE,
    DROP COLUMN IF EXISTS semi CASCADE,
    DROP COLUMN IF EXISTS n_ute CASCADE,
    DROP COLUMN IF EXISTS srv CASCADE;

-- 2.5 Limpiar tabla chofer_observaciones (remover patente en texto una vez vinculada)
ALTER TABLE public.chofer_observaciones
    DROP COLUMN IF EXISTS unidad_dominio CASCADE;

-- 2.6 Reemplazar tabla física movimientos por VISTA dinámica sobre choferes.unidad_id
DROP TABLE IF EXISTS public.movimientos CASCADE;

CREATE OR REPLACE VIEW public.movimientos AS
SELECT 
    gen_random_uuid() AS id,
    id AS id_chofer,
    unidad_id AS id_unidad
FROM public.choferes
WHERE unidad_id IS NOT NULL;

-- ==============================================================================
-- 3. FASE DE RECONSTRUCCIÓN DE VISTAS RELACIONALES (CON JOINS)
-- ==============================================================================

-- 3.1 Vista básica de calendario KM con JOINs normalizados
CREATE OR REPLACE VIEW public.view_calendario_km AS
SELECT 
    m.fecha,
    m.id_chofer,
    c.nombre AS chofer_nombre,
    c.legajo,
    m.id_unidad,
    u.n_ute,
    t.patente AS dominio,
    ROUND(SUM(m.km_totales)::numeric, 2) AS km,
    COUNT(*)::int AS cant_viajes,
    ARRAY_REMOVE(ARRAY_AGG(DISTINCT m.hoja_ruta), NULL) AS hoja_ruta
FROM public.movimientos_km m
LEFT JOIN public.choferes c ON m.id_chofer = c.id
LEFT JOIN public.unidades u ON m.id_unidad = u.id
LEFT JOIN public.tractores t ON u.tractor_id = t.id
GROUP BY m.fecha, m.id_chofer, c.nombre, c.legajo, m.id_unidad, u.n_ute, t.patente;

-- 3.2 Vista básica de Diagramas Mensuales con JOIN a choferes y servicios
CREATE OR REPLACE VIEW public.view_diagrama_mensual AS
SELECT 
    d.id AS registro_id,
    d.mes_tab,
    d.anio,
    d.mes_numero,
    sc.denominacion AS servicio,
    d.diagrama_tipo,
    d.chofer_id,
    c.nombre AS chofer_nombre,
    c.legajo,
    d.tira_dias,
    d.dias,
    d.contabilizador,
    d.actualizado_el
FROM public.diagramas d
JOIN public.choferes c ON d.chofer_id = c.id
LEFT JOIN public.servicios_choferes sc ON c.servicio_id = sc.id;

-- 3.3 Vista Diaria Operativa
CREATE OR REPLACE VIEW public.view_diaria_operativa AS
SELECT 
    c.id AS chofer_id,
    c.nombre,
    cd.dni,
    c.legajo,
    cd.telefono,
    sc.denominacion AS servicio,
    c.estado AS estado_chofer,
    c.foto,
    u.id AS unidad_id,
    u.n_ute,
    t.patente AS tractor,
    s.patente AS semi,
    t.vtv AS vtv_tr,
    t.mas AS mas_tr,
    s.vtv AS vtv_semi,
    s.mas AS mas_semi,
    cd.venc_periodico,
    cd.venc_licencia_nacional,
    cd.venc_cargas_peligrosas,
    cd.apto_medico_venc,
    cd.apto_medico_estado,
    c.actualizado_el
FROM public.choferes c
LEFT JOIN public.chofer_documentacion cd ON cd.chofer_id = c.id
LEFT JOIN public.servicios_choferes sc ON c.servicio_id = sc.id
LEFT JOIN public.unidades u ON c.unidad_id = u.id
LEFT JOIN public.tractores t ON u.tractor_id = t.id
LEFT JOIN public.semis s ON u.semi_id = s.id;

-- 3.4 Vista Flota Operativa
CREATE OR REPLACE VIEW public.view_flota_operativa AS
SELECT 
    u.id AS unidad_id,
    t.patente AS tractor,
    s.patente AS semi,
    c.id AS chofer_id,
    c.nombre AS chofer_nombre,
    t.vtv AS vtv_tr,
    t.mas AS mas_tr,
    s.vtv AS vtv_semi,
    s.mas AS mas_semi
FROM public.unidades u
LEFT JOIN public.tractores t ON u.tractor_id = t.id
LEFT JOIN public.semis s ON u.semi_id = s.id
LEFT JOIN public.choferes c ON c.unidad_id = u.id;

-- 3.5 Vista Cards Diarias
CREATE OR REPLACE VIEW public.view_cards_diarias AS
SELECT 
    n.id AS card_id,
    n.legacy_id,
    n.tipo_novedad AS tipo,
    n.fecha_objetivo AS fecha,
    n.detalle,
    n.resuelto,
    n.creador,
    n.creado_el,
    n.fecha_resolucion,
    c.nombre AS chofer_nombre,
    c.id AS chofer_id,
    c.estado AS chofer_estado,
    cd.telefono AS chofer_telefono,
    t.patente AS tractor,
    s.patente AS semi,
    u.n_ute,
    su.denominacion AS servicio,
    u.id AS unidad_id
FROM public.novedades n
LEFT JOIN public.choferes c ON n.chofer_id = c.id
LEFT JOIN public.chofer_documentacion cd ON cd.chofer_id = c.id
LEFT JOIN public.unidades u ON n.unidad_id = u.id
LEFT JOIN public.tractores t ON u.tractor_id = t.id
LEFT JOIN public.semis s ON u.semi_id = s.id
LEFT JOIN public.servicios_unidades su ON u.servicio_id = su.id;

-- 3.6 Vista Inducciones Recientes
CREATE OR REPLACE VIEW public.view_inducciones_recientes AS
SELECT 
    n.id AS novedad_id,
    n.fecha_objetivo AS fecha_induccion,
    n.detalle,
    n.resuelto,
    n.creado_el,
    c.nombre AS chofer_nombre,
    c.id AS chofer_id,
    sc.denominacion AS servicio,
    cd.telefono AS chofer_telefono
FROM public.novedades n
LEFT JOIN public.choferes c ON n.chofer_id = c.id
LEFT JOIN public.chofer_documentacion cd ON cd.chofer_id = c.id
LEFT JOIN public.servicios_choferes sc ON c.servicio_id = sc.id
WHERE n.tipo_novedad = 'EXAMEN_CHOFER' 
   OR n.detalle ILIKE '%inducc%' 
   OR n.detalle ILIKE '%ingreso%'
ORDER BY n.fecha_objetivo DESC NULLS LAST, n.creado_el DESC;

-- 3.7 Función y Vista Personal Retorno
DROP VIEW IF EXISTS public.view_dash_retorno CASCADE;
DROP VIEW IF EXISTS public.view_personal_retorno CASCADE;
DROP FUNCTION IF EXISTS public.fn_personal_retorno(DATE) CASCADE;

CREATE OR REPLACE FUNCTION public.fn_personal_retorno(p_fecha DATE DEFAULT CURRENT_DATE)
RETURNS TABLE (
    chofer_id UUID,
    nombre TEXT,
    legajo TEXT,
    dni TEXT,
    servicio TEXT,
    diagrama_tipo TEXT,
    n_ute TEXT,
    tractor TEXT,
    semi TEXT,
    codigo_ayer TEXT,
    codigo_hoy TEXT,
    codigo_manana TEXT,
    retorna_cuando TEXT,
    fecha_retorno DATE,
    dias_para_retorno INTEGER
) LANGUAGE plpgsql STABLE AS $$
DECLARE
    v_m1 TEXT := (p_fecha - INTERVAL '1 day')::date::text;
    v_0  TEXT := p_fecha::text;
    v_p1 TEXT := (p_fecha + INTERVAL '1 day')::date::text;
    v_p2 TEXT := (p_fecha + INTERVAL '2 days')::date::text;
    v_p3 TEXT := (p_fecha + INTERVAL '3 days')::date::text;
    v_p4 TEXT := (p_fecha + INTERVAL '4 days')::date::text;
BEGIN
    RETURN QUERY
    WITH codigos AS (
        SELECT 
            c.id AS q_chofer_id,
            c.nombre AS q_nombre,
            c.legajo AS q_legajo,
            cd.dni AS q_dni,
            COALESCE(sc.denominacion, 'GENERAL') AS q_servicio,
            d.diagrama_tipo AS q_diagrama_tipo,
            u.n_ute AS q_n_ute,
            t.patente AS q_tractor,
            s.patente AS q_semi,
            UPPER(TRIM(COALESCE(d.dias->>v_m1, '-'))) AS code_m1,
            UPPER(TRIM(COALESCE(d.dias->>v_0,  '-'))) AS code_0,
            UPPER(TRIM(COALESCE(d.dias->>v_p1, '-'))) AS code_p1,
            UPPER(TRIM(COALESCE(d.dias->>v_p2, '-'))) AS code_p2,
            UPPER(TRIM(COALESCE(d.dias->>v_p3, '-'))) AS code_p3,
            UPPER(TRIM(COALESCE(d.dias->>v_p4, '-'))) AS code_p4
        FROM public.choferes c
        LEFT JOIN public.chofer_documentacion cd ON cd.chofer_id = c.id
        LEFT JOIN public.servicios_choferes sc ON c.servicio_id = sc.id
        LEFT JOIN public.unidades u ON c.unidad_id = u.id
        LEFT JOIN public.tractores t ON u.tractor_id = t.id
        LEFT JOIN public.semis s ON u.semi_id = s.id
        LEFT JOIN LATERAL (
            SELECT sub_d.dias, sub_d.diagrama_tipo FROM public.diagramas sub_d
            WHERE sub_d.chofer_id = c.id 
            ORDER BY sub_d.anio DESC, sub_d.mes_numero DESC 
            LIMIT 1
        ) d ON true
        WHERE LOWER(TRIM(c.nombre)) NOT IN (
            'campo', 'abast', 'glp', 'grales', 'grales.', 'liviano', 
            'metanol', 'pasivo en base', 'ypf', 'apellido y nombre', 
            'personal activo', 'chofer', 'choferes', 'vacante', '-', '1'
          ) AND LENGTH(TRIM(c.nombre)) > 2
    ),
    evaluados AS (
        SELECT 
            codigos.*,
            (code_m1 ~ '[A-Za-z]') AS nov_m1,
            (code_0  ~ '[A-Za-z]') AS nov_0,
            (code_p1 ~ '[A-Za-z]') AS nov_p1,
            (code_p2 ~ '[A-Za-z]') AS nov_p2,
            (code_p3 ~ '[A-Za-z]') AS nov_p3,
            (code_p4 ~ '[A-Za-z]') AS nov_p4
        FROM codigos
    ),
    clasificados AS (
        SELECT 
            evaluados.q_chofer_id,
            evaluados.q_nombre,
            evaluados.q_legajo,
            evaluados.q_dni,
            evaluados.q_servicio,
            evaluados.q_diagrama_tipo,
            evaluados.q_n_ute,
            evaluados.q_tractor,
            evaluados.q_semi,
            evaluados.code_m1 AS q_code_ayer,
            evaluados.code_0  AS q_code_hoy,
            evaluados.code_p1 AS q_code_manana,
            CASE 
                WHEN evaluados.nov_m1 AND NOT evaluados.nov_0 THEN 'HOY'
                WHEN evaluados.nov_0 AND NOT evaluados.nov_p1 THEN 'MAÑANA'
                WHEN evaluados.nov_0 AND evaluados.nov_p1 AND NOT evaluados.nov_p2 THEN 'EN 2 DÍAS'
                WHEN evaluados.nov_0 AND evaluados.nov_p1 AND evaluados.nov_p2 AND NOT evaluados.nov_p3 THEN 'EN 3 DÍAS'
                WHEN evaluados.nov_0 AND evaluados.nov_p1 AND evaluados.nov_p2 AND evaluados.nov_p3 AND NOT evaluados.nov_p4 THEN 'EN 4 DÍAS'
                ELSE NULL
            END AS q_retorna_cuando,
            CASE 
                WHEN evaluados.nov_m1 AND NOT evaluados.nov_0 THEN p_fecha
                WHEN evaluados.nov_0 AND NOT evaluados.nov_p1 THEN (p_fecha + INTERVAL '1 day')::date
                WHEN evaluados.nov_0 AND evaluados.nov_p1 AND NOT evaluados.nov_p2 THEN (p_fecha + INTERVAL '2 days')::date
                WHEN evaluados.nov_0 AND evaluados.nov_p1 AND evaluados.nov_p2 AND NOT evaluados.nov_p3 THEN (p_fecha + INTERVAL '3 days')::date
                WHEN evaluados.nov_0 AND evaluados.nov_p1 AND evaluados.nov_p2 AND evaluados.nov_p3 AND NOT evaluados.nov_p4 THEN (p_fecha + INTERVAL '4 days')::date
                ELSE NULL
            END AS q_fecha_retorno,
            CASE 
                WHEN evaluados.nov_m1 AND NOT evaluados.nov_0 THEN 0
                WHEN evaluados.nov_0 AND NOT evaluados.nov_p1 THEN 1
                WHEN evaluados.nov_0 AND evaluados.nov_p1 AND NOT evaluados.nov_p2 THEN 2
                WHEN evaluados.nov_0 AND evaluados.nov_p1 AND evaluados.nov_p2 AND NOT evaluados.nov_p3 THEN 3
                WHEN evaluados.nov_0 AND evaluados.nov_p1 AND evaluados.nov_p2 AND evaluados.nov_p3 AND NOT evaluados.nov_p4 THEN 4
                ELSE NULL
            END AS q_dias_para_retorno
        FROM evaluados
    )
    SELECT 
        clasificados.q_chofer_id,
        clasificados.q_nombre,
        clasificados.q_legajo,
        clasificados.q_dni,
        clasificados.q_servicio,
        clasificados.q_diagrama_tipo,
        clasificados.q_n_ute,
        clasificados.q_tractor,
        clasificados.q_semi,
        clasificados.q_code_ayer,
        clasificados.q_code_hoy,
        clasificados.q_code_manana,
        clasificados.q_retorna_cuando,
        clasificados.q_fecha_retorno,
        clasificados.q_dias_para_retorno
    FROM clasificados 
    WHERE clasificados.q_retorna_cuando IS NOT NULL;
END;
$$;

DROP VIEW IF EXISTS public.view_personal_retorno CASCADE;

CREATE OR REPLACE VIEW public.view_personal_retorno AS
SELECT * FROM public.fn_personal_retorno(CURRENT_DATE);

CREATE OR REPLACE VIEW public.view_dash_retorno AS
SELECT 
    chofer_id,
    nombre AS nom,
    COALESCE(tractor, '') AS tractor,
    codigo_ayer,
    codigo_hoy,
    codigo_manana,
    retorna_cuando,
    fecha_retorno,
    dias_para_retorno
FROM public.fn_personal_retorno(CURRENT_DATE)
ORDER BY fecha_retorno ASC, nombre ASC;

GRANT EXECUTE ON FUNCTION public.fn_personal_retorno(DATE) TO anon, authenticated, service_role, postgres;
GRANT SELECT ON public.view_personal_retorno TO anon, authenticated, service_role, postgres;
GRANT SELECT ON public.view_dash_retorno TO anon, authenticated, service_role, postgres;

COMMIT;
