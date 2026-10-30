-- ==============================================================
-- 🚀 MIGRACIÓN 009 (FASE P2): HIGIENE DE ÍNDICES, LIMPIEZA DE VISTAS ESPEJO Y VISTAS CANÓNICAS
-- ==============================================================

-- 1. ELIMINACIÓN DE 13 ÍNDICES DUPLICADOS / REDUNDANTES
--    Liberan buffer cache RAM, reducen el tamaño de la base de datos y aceleran escrituras (INSERT/UPDATE/DELETE).
DROP INDEX IF EXISTS panol.idx_panol_items_code;
DROP INDEX IF EXISTS panol.idx_items_code;
DROP INDEX IF EXISTS public.idx_chofer_doc_chofer_id;
DROP INDEX IF EXISTS public.idx_semis_patente;
DROP INDEX IF EXISTS public.idx_tractores_patente;
DROP INDEX IF EXISTS public.idx_servicios_choferes_denominacion;
DROP INDEX IF EXISTS public.idx_servicios_unidades_denominacion;
DROP INDEX IF EXISTS public.idx_mov_chofer;
DROP INDEX IF EXISTS public.idx_mov_unidad;
DROP INDEX IF EXISTS public.idx_unidades_tractor_id;
DROP INDEX IF EXISTS public.idx_unidades_semi_id;
DROP INDEX IF EXISTS public.idx_unidades_n_ute;
DROP INDEX IF EXISTS public.idx_diagramas_chofer_id;

-- 2. CREACIÓN DE 4 ÍNDICES FK FALTANTES
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'panol') THEN
    CREATE INDEX IF NOT EXISTS idx_stock_movements_order_item 
      ON panol.stock_movements (order_item_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_cisternas_km_tractor_id ON public.cisternas_km (tractor_id);
CREATE INDEX IF NOT EXISTS idx_cisternas_km_chofer_id ON public.cisternas_km (id_chofer);
CREATE INDEX IF NOT EXISTS idx_cisternas_km_unidad_id ON public.cisternas_km (id_unidad);

-- 3. DEPURACIÓN DE 13 VISTAS ESPEJO MUERTAS EN PUBLIC
--    (El proyecto Pañol v2 consume directamente el esquema panol.*)
DROP VIEW IF EXISTS public.v_boxes_en_vivo CASCADE;
DROP VIEW IF EXISTS public.v_devoluciones_nuevas CASCADE;
DROP VIEW IF EXISTS public.v_devoluciones_pendientes CASCADE;
DROP VIEW IF EXISTS public.v_flota_busqueda CASCADE;
DROP VIEW IF EXISTS public.v_kpis_taller_diario CASCADE;
DROP VIEW IF EXISTS public.v_monitor_pedidos CASCADE;
DROP VIEW IF EXISTS public.v_operario_tasks CASCADE;
DROP VIEW IF EXISTS public.v_ots_anteriores CASCADE;
DROP VIEW IF EXISTS public.v_pedidos_canjes_consolidada CASCADE;
DROP VIEW IF EXISTS public.v_recursos_operarios CASCADE;
DROP VIEW IF EXISTS public.v_tablero_coordinacion CASCADE;
DROP VIEW IF EXISTS public.v_taller_flota_ot CASCADE;
DROP VIEW IF EXISTS public.v_taller_unit_tasks CASCADE;

-- 4. DESPLIEGUE DE VISTAS CANÓNICAS UNIFICADAS CROSS-PROJECT

-- 4.A. Vista Canónica: Formación Operativa y Estado Real de Flota (EOR + Dash + Pañol)
CREATE OR REPLACE VIEW public.v_canon_flota_estado AS
WITH ot_activas AS (
  SELECT
    uwo.tractor_id,
    uwo.semi_id,
    MAX(wo.ot_number) AS ot_activa
  FROM panol.unit_work_orders uwo
  JOIN panol.work_orders wo ON wo.id = uwo.work_order_id
  WHERE wo.status = 'ACTIVA'
  GROUP BY uwo.tractor_id, uwo.semi_id
)
SELECT
  u.id AS unidad_id,
  u.id,
  COALESCE(u.n_ute, '') AS n_ute,
  COALESCE(su.denominacion, 'GENERAL') AS servicio,
  t.id AS tractor_id,
  COALESCE(NULLIF(t.patente, '|'), tr_en_semi.patente, '') AS tractor,
  t.marca AS marca_tr,
  s.id AS semi_id,
  CASE WHEN tr_en_semi.id IS NOT NULL OR s.patente = '|' THEN '' ELSE COALESCE(s.patente, '') END AS semi,
  s.marca AS marca_semi,
  s.cisternado,
  CASE
    WHEN ota_t.ot_activa IS NOT NULL OR ota_s.ot_activa IS NOT NULL THEN 'taller'
    ELSE COALESCE(u.estado, 'disponible')
  END AS estado_unidad,
  COALESCE(ota_t.ot_activa, ota_s.ot_activa) AS ot_activa,
  c.id AS chofer_id,
  COALESCE(c.nombre, '') AS chofer_nombre,
  t.vtv AS vtv_tr, t.mas AS mas_tr,
  s.vtv AS vtv_semi, s.mas AS mas_semi, s.esp_es, s.vi, s.ve,
  CASE
    WHEN t.vtv < CURRENT_DATE OR s.vtv < CURRENT_DATE OR t.mas < CURRENT_DATE OR s.mas < CURRENT_DATE THEN 'VENCIDO'
    WHEN t.vtv <= CURRENT_DATE + 30 OR s.vtv <= CURRENT_DATE + 30 OR t.mas <= CURRENT_DATE + 30 OR s.mas <= CURRENT_DATE + 30 THEN 'POR_VENCER'
    WHEN t.id IS NOT NULL OR s.id IS NOT NULL THEN 'AL_DIA'
    ELSE 'S_D'
  END AS alerta_docs_unidad,
  COALESCE(m.actualizado_el, c.actualizado_el) AS actualizado_el
FROM public.unidades u
LEFT JOIN public.tractores t ON t.id = u.tractor_id
LEFT JOIN public.semis s ON s.id = u.semi_id
LEFT JOIN public.tractores tr_en_semi ON u.tractor_id IS NULL AND s.patente IS NOT NULL AND UPPER(tr_en_semi.patente) = UPPER(s.patente)
LEFT JOIN public.servicios_unidades su ON su.id = u.servicio_id
LEFT JOIN public.movimientos m ON m.id_unidad = u.id
LEFT JOIN public.choferes c ON c.id = m.id_chofer
LEFT JOIN ot_activas ota_t ON ota_t.tractor_id = u.tractor_id
LEFT JOIN ot_activas ota_s ON ota_s.semi_id = u.semi_id;

-- 4.B. Vista Canónica: Novedades Activas con Ventana Temporal
CREATE OR REPLACE VIEW public.v_canon_novedades_activas AS
SELECT 
  n.id,
  n.id AS card_id,
  n.tipo_novedad,
  n.tipo_novedad AS tipo,
  n.fecha_objetivo,
  n.fecha_objetivo AS fecha,
  n.fecha_resolucion,
  n.detalle,
  n.resuelto,
  COALESCE(n.prioridad, 'media') AS prioridad,
  n.creado_el,
  n.creado_el AS timestamp,
  n.creado_por_id,
  COALESCE(d_user.nombre, 'DASH') AS creador,
  COALESCE(d_user.nombre, 'DASH') AS usuario,
  c.id AS chofer_id,
  UPPER(TRIM(COALESCE(c.nombre, ''))) AS nom,
  UPPER(TRIM(COALESCE(c.nombre, ''))) AS chofer_nombre,
  COALESCE(c.estado, 'disponible') AS chofer_estado,
  cd.telefono AS chofer_telefono,
  c.foto,
  u.id AS unidad_id,
  UPPER(TRIM(COALESCE(t.patente, ''))) AS tractor,
  UPPER(TRIM(COALESCE(s.patente, ''))) AS semi,
  s.cisternado,
  COALESCE(u.n_ute, 'S/D') AS n_ute,
  UPPER(TRIM(COALESCE(sc.denominacion, su.denominacion, 'S/A'))) AS srv,
  UPPER(TRIM(COALESCE(sc.denominacion, su.denominacion, 'S/A'))) AS servicio,
  c.servicio_id AS servicio_chofer_id,
  t.vtv AS vtv_tr,
  t.mas AS mas_tr,
  s.vtv AS vtv_semi,
  s.mas AS mas_semi,
  s.esp_es,
  s.vi,
  s.ve,
  CASE
    WHEN n.tipo_novedad = 'LIBRES' THEN COALESCE(term.codigo, '')
    ELSE ''
  END AS terminal,
  CASE
    WHEN n.tipo_novedad = 'LIBRES' THEN n.terminal_id
    ELSE NULL
  END AS terminal_id,
  CASE
    WHEN n.tipo_novedad = 'LIBRES' THEN term.nombre
    ELSE NULL
  END AS terminal_nombre,
  COALESCE((
    SELECT array_agg(m.usuario_nombre)
    FROM public.dash_menciones m
    WHERE m.novedad_id = n.id
  ), ARRAY[]::text[]) AS menciones
FROM public.novedades n
LEFT JOIN public.choferes c ON n.chofer_id = c.id
LEFT JOIN public.servicios_choferes sc ON c.servicio_id = sc.id
LEFT JOIN public.chofer_documentacion cd ON cd.chofer_id = c.id
LEFT JOIN public.unidades u ON n.unidad_id = u.id
LEFT JOIN public.tractores t ON u.tractor_id = t.id
LEFT JOIN public.semis s ON u.semi_id = s.id
LEFT JOIN public.servicios_unidades su ON u.servicio_id = su.id
LEFT JOIN public.terminales term ON n.terminal_id = term.id
LEFT JOIN public.dash d_user ON n.creado_por_id = d_user.id
WHERE NOT n.resuelto OR n.fecha_resolucion >= (CURRENT_DATE - INTERVAL '14 days');

-- 4.C. Vista Canónica: Chofer Operativo Compacto
CREATE OR REPLACE VIEW public.v_canon_chofer_operativo AS
SELECT 
  c.id AS chofer_id,
  c.id,
  c.nombre,
  cd.dni,
  cd.telefono,
  COALESCE(sc.denominacion, 'GENERAL') AS servicio,
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
  COALESCE(cd.apto_medico_estado, 'Activo') AS apto_medico_estado,
  CASE
    WHEN cd.venc_periodico < CURRENT_DATE OR cd.venc_licencia_nacional < CURRENT_DATE OR cd.venc_cargas_peligrosas < CURRENT_DATE OR cd.apto_medico_venc < CURRENT_DATE THEN 'VENCIDO'
    WHEN cd.venc_periodico <= (CURRENT_DATE + INTERVAL '30 days') OR cd.venc_licencia_nacional <= (CURRENT_DATE + INTERVAL '30 days') OR cd.venc_cargas_peligrosas <= (CURRENT_DATE + INTERVAL '30 days') OR cd.apto_medico_venc <= (CURRENT_DATE + INTERVAL '30 days') THEN 'POR_VENCER'
    ELSE 'AL_DIA'
  END AS alerta_docs_chofer,
  CASE
    WHEN t.vtv < CURRENT_DATE OR s.vtv < CURRENT_DATE OR t.mas < CURRENT_DATE OR s.mas < CURRENT_DATE THEN 'VENCIDO'
    WHEN t.vtv <= (CURRENT_DATE + INTERVAL '30 days') OR s.vtv <= (CURRENT_DATE + INTERVAL '30 days') OR t.mas <= (CURRENT_DATE + INTERVAL '30 days') OR s.mas <= (CURRENT_DATE + INTERVAL '30 days') THEN 'POR_VENCER'
    WHEN t.id IS NOT NULL OR s.id IS NOT NULL THEN 'AL_DIA'
    ELSE 'S_D'
  END AS alerta_docs_unidad,
  CASE
    WHEN cd.venc_periodico < CURRENT_DATE OR cd.venc_licencia_nacional < CURRENT_DATE OR cd.venc_cargas_peligrosas < CURRENT_DATE OR cd.apto_medico_venc < CURRENT_DATE OR t.vtv < CURRENT_DATE OR s.vtv < CURRENT_DATE OR t.mas < CURRENT_DATE OR s.mas < CURRENT_DATE THEN 'VENCIDO'
    WHEN cd.venc_periodico <= (CURRENT_DATE + INTERVAL '30 days') OR cd.venc_licencia_nacional <= (CURRENT_DATE + INTERVAL '30 days') OR cd.venc_cargas_peligrosas <= (CURRENT_DATE + INTERVAL '30 days') OR cd.apto_medico_venc <= (CURRENT_DATE + INTERVAL '30 days') OR t.vtv <= (CURRENT_DATE + INTERVAL '30 days') OR s.vtv <= (CURRENT_DATE + INTERVAL '30 days') OR t.mas <= (CURRENT_DATE + INTERVAL '30 days') OR s.mas <= (CURRENT_DATE + INTERVAL '30 days') THEN 'POR_VENCER'
    ELSE 'AL_DIA'
  END AS alerta_vencimientos,
  COALESCE(diag.dia_codigo, '-') AS dia_codigo,
  COALESCE(diag.dia_fecha, CURRENT_DATE::text) AS dia_fecha,
  diag.diagrama_tipo,
  c.actualizado_el
FROM public.choferes c
LEFT JOIN public.chofer_documentacion cd ON cd.chofer_id = c.id
LEFT JOIN public.servicios_choferes sc ON c.servicio_id = sc.id
LEFT JOIN public.unidades u ON c.unidad_id = u.id
LEFT JOIN public.tractores t ON u.tractor_id = t.id
LEFT JOIN public.semis s ON u.semi_id = s.id
LEFT JOIN LATERAL (
  SELECT 
    COALESCE(NULLIF(NULLIF(d.dias ->> CURRENT_DATE::text, '-'), ''), (
      SELECT kv.value
      FROM jsonb_each_text(d.dias) kv(key, value)
      WHERE kv.value <> ALL (ARRAY['-', '', 'null', '0'])
      ORDER BY kv.key DESC
      LIMIT 1
    ), '-') AS dia_codigo,
    COALESCE(
      CASE
        WHEN (d.dias ->> CURRENT_DATE::text) <> ALL (ARRAY['-', '', 'null']) THEN CURRENT_DATE::text
        ELSE NULL
      END, (
        SELECT kv.key
        FROM jsonb_each_text(d.dias) kv(key, value)
        WHERE kv.value <> ALL (ARRAY['-', '', 'null', '0'])
        ORDER BY kv.key DESC
        LIMIT 1
      ), CURRENT_DATE::text
    ) AS dia_fecha,
    d.diagrama_tipo
  FROM public.diagramas d
  WHERE d.chofer_id = c.id
  ORDER BY d.anio DESC, d.mes_numero DESC
  LIMIT 1
) diag ON true
WHERE (LOWER(TRIM(c.nombre)) <> ALL (ARRAY['campo', 'abast', 'glp', 'grales', 'grales.', 'liviano', 'metanol', 'pasivo en base', 'ypf', 'apellido y nombre', 'personal activo', 'chofer', 'choferes', 'vacante', '-', '1']))
  AND LENGTH(TRIM(c.nombre)) > 2;

-- 5. PERMISOS DE LECTURA PARA VISTAS CANÓNICAS
GRANT SELECT ON public.v_canon_flota_estado TO anon, authenticated, service_role;
GRANT SELECT ON public.v_canon_novedades_activas TO anon, authenticated, service_role;
GRANT SELECT ON public.v_canon_chofer_operativo TO anon, authenticated, service_role;
