-- ==============================================================================
-- 🚀 MIGRACIÓN 007 (PLAN P0): CORTE DE EGRESS, FUNCIÓN O(1) DE KM POR FECHA
--    ÍNDICES CRÍTICOS Y PUSHDOWN EN MONITOR DE PAÑOL
-- ==============================================================================

-- 1. Índices críticos P0 para ventanas móviles, cruce de patentes y delta sync
CREATE INDEX IF NOT EXISTS idx_choferes_km_anio_mes
  ON public.choferes_km_mensual (anio, mes_numero);

CREATE INDEX IF NOT EXISTS idx_diagramas_anio_mes
  ON public.diagramas (anio, mes_numero);

CREATE INDEX IF NOT EXISTS idx_tractores_upper_patente
  ON public.tractores (UPPER(patente));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'panol') THEN
    CREATE INDEX IF NOT EXISTS idx_panol_items_upper_name
      ON panol.items (UPPER(TRIM(name)))
      WHERE is_active = true;

    CREATE INDEX IF NOT EXISTS idx_panol_items_updated_at
      ON panol.items (updated_at);

    CREATE INDEX IF NOT EXISTS idx_panol_orders_created_desc
      ON panol.orders (created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_panol_stock_mov_order_id
      ON panol.stock_movements (order_id);
  END IF;
END $$;

-- 2. Función O(1) public.fn_km_por_fecha(p_fecha)
--    Reemplaza el escaneo completo CROSS JOIN LATERAL jsonb_each(dias_km) de
--    view_calendario_km (~105.8 ms) por acceso indexado directo al mes (< 1 ms).
CREATE OR REPLACE FUNCTION public.fn_km_por_fecha(p_fecha date DEFAULT CURRENT_DATE)
RETURNS TABLE (
  fecha date,
  id_chofer uuid,
  chofer_id uuid,
  chofer_nombre text,
  id_unidad uuid,
  n_ute text,
  dominio text,
  km numeric,
  km_totales numeric,
  cant_viajes integer,
  hoja_ruta text[]
)
LANGUAGE sql
STABLE
AS $$
  WITH raw_day AS (
    SELECT
      ck.chofer_id,
      ck.dias_km -> (p_fecha::text) AS info
    FROM public.choferes_km_mensual ck
    WHERE ck.anio = EXTRACT(YEAR FROM p_fecha)::int
      AND ck.mes_numero = EXTRACT(MONTH FROM p_fecha)::int
      AND ck.dias_km ? (p_fecha::text)
  )
  SELECT
    p_fecha AS fecha,
    r.chofer_id AS id_chofer,
    r.chofer_id AS chofer_id,
    c.nombre AS chofer_nombre,
    NULLIF(r.info ->> 'id_unidad', '')::uuid AS id_unidad,
    r.info ->> 'n_ute' AS n_ute,
    r.info ->> 'tractor' AS dominio,
    COALESCE(NULLIF(r.info ->> 'km', '')::numeric, 0) AS km,
    COALESCE(NULLIF(r.info ->> 'km', '')::numeric, 0) AS km_totales,
    1::integer AS cant_viajes,
    CASE
      WHEN COALESCE(r.info ->> 'hr', '') <> ''
      THEN string_to_array(r.info ->> 'hr', ', ')
      ELSE ARRAY[]::text[]
    END AS hoja_ruta
  FROM raw_day r
  JOIN public.choferes c ON c.id = r.chofer_id
  WHERE COALESCE(NULLIF(r.info ->> 'km', '')::numeric, 0) > 0
     OR COALESCE(r.info ->> 'hr', '') <> '';
$$;

GRANT EXECUTE ON FUNCTION public.fn_km_por_fecha(date) TO anon, authenticated, service_role, postgres;

-- 3. Pushdown CTE en panol.v_monitor_pedidos para evitar GROUP BY global sobre histórico
CREATE OR REPLACE VIEW panol.v_monitor_pedidos AS
WITH target_orders AS (
  SELECT *
  FROM panol.orders
  WHERE status = ANY (ARRAY['PENDIENTE'::text, 'LISTO'::text, 'EN_PREPARACION'::text, 'EN_CAMBIO'::text, 'DEVOLUCION PENDIENTE'::text, 'DEVOLUCION'::text])
     OR created_at >= (now() - '14 days'::interval)
  ORDER BY created_at DESC
  LIMIT 80
)
SELECT
  o.id AS order_id,
  o.order_number,
  o.req_code,
  o.order_type,
  o.parent_order_id,
  o.created_at,
  o.ready_at,
  o.status AS order_status,
  COALESCE(o.box_number, '01'::text) AS box_number,
  o.notes AS order_notes,
  s.id AS mechanic_id,
  COALESCE(s.name, 'MECÁNICO'::text) AS mechanic_name,
  s.op_code AS mechanic_op_code,
  sp.id AS panol_staff_id,
  sp.name AS panol_staff_name,
  wo.id AS work_order_id,
  COALESCE(o.ot_number, wo.ot_number, "substring"(o.notes, 'OT(?:\s*Original)?:\s*([0-9]+)'::text), ''::text) AS ot_number,
  COALESCE(o.tractor_id, u.tractor_id) AS tractor_id,
  COALESCE(o.semi_id, u.semi_id) AS semi_id,
  o.unidad_id,
  COALESCE(t.patente, ''::text) AS tractor,
  COALESCE(t.marca, ''::text) AS marca_tr,
  COALESCE(sem.patente, ''::text) AS semi,
  COALESCE(sem.marca, ''::text) AS marca_semi,
  COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'order_item_id', sm.id,
        'id', sm.id,
        'item_id', i.id,
        'name', i.name,
        'code', i.item_code,
        'qty', sm.quantity,
        'delivered_qty', COALESCE(sm.delivered_qty, 0::numeric),
        'returned_qty', COALESCE(sm.returned_qty, 0::numeric),
        'location', i.location,
        'requires_exchange', i.requires_exchange,
        'status', sm.status,
        'exchange_status', sm.exchange_status,
        'panol_confirmation', sm.panol_confirmation,
        'notes', sm.notes,
        'return_notes', sm.return_notes
      ) ORDER BY sm.created_at
    ) FILTER (WHERE sm.id IS NOT NULL),
    '[]'::jsonb
  ) AS items
FROM target_orders o
LEFT JOIN panol.staff s ON o.mechanic_id = s.id
LEFT JOIN panol.staff sp ON o.panol_staff_id = sp.id
LEFT JOIN panol.work_orders wo ON o.work_order_id = wo.id
LEFT JOIN public.unidades u ON o.unidad_id = u.id
LEFT JOIN public.tractores t ON COALESCE(o.tractor_id, u.tractor_id) = t.id
LEFT JOIN public.semis sem ON COALESCE(o.semi_id, u.semi_id) = sem.id
LEFT JOIN panol.stock_movements sm ON sm.order_id = o.id
LEFT JOIN panol.items i ON sm.item_id = i.id
GROUP BY
  o.id, o.order_number, o.req_code, o.order_type, o.parent_order_id,
  o.created_at, o.ready_at, o.status, o.box_number, o.notes, o.ot_number,
  s.id, s.name, s.op_code, sp.id, sp.name, wo.id, wo.ot_number,
  o.tractor_id, o.semi_id, o.unidad_id, u.tractor_id, u.semi_id,
  t.patente, t.marca, sem.patente, sem.marca;

GRANT SELECT ON panol.v_monitor_pedidos TO anon, authenticated, service_role, postgres;
