-- ==============================================================================
-- 🚀 MIGRACIÓN: DESACOPLE DE VISTAS Y ELIMINACIÓN DE TABLA RESIDUAL movimientos_km
-- Supabase PostgreSQL
-- ==============================================================================

-- 1. Actualizar public.view_individual_chofer para sumar KMs desde choferes_km_mensual
CREATE OR REPLACE VIEW public.view_individual_chofer AS
SELECT c.id AS chofer_id,
   c.nombre,
   c.legajo,
   c.estado AS estado_chofer,
   c.foto,
   COALESCE(sc.denominacion, 'GENERAL'::text) AS servicio,
   cd.id AS doc_id,
   cd.dni,
   cd.cuil,
   cd.telefono,
   cd.email,
   cd.fecha_alta,
   cd.edad,
   cd.domicilio,
   cd.localidad,
   cd.telefono_emergencia,
   cd.empresa,
   cd.venc_licencia_nacional,
   cd.venc_psicofisico,
   cd.venc_cargas_peligrosas,
   cd.venc_periodico,
   cd.venc_curso_shell,
   cd.venc_manejo_def,
   cd.apto_medico_venc,
   cd.apto_medico_estado,
   cd.avalado_contratos,
   cd.obs_documentacion,
   u.id AS unidad_id,
   u.n_ute,
   COALESCE(u.estado, 'disponible'::text) AS estado_unidad,
   t.patente AS tractor,
   t.marca AS marca_tr,
   t.modelo AS modelo_tr,
   t.n_interno AS n_interno_tr,
   t.vtv AS vtv_tr,
   t.mas AS mas_tr,
   s.patente AS semi,
   s.marca AS marca_semi,
   s.cisternado,
   s.esp_es,
   s.vi,
   s.ve,
   s.vtv AS vtv_semi,
   s.mas AS mas_semi,
   COALESCE(km.total_km, (0)::numeric) AS total_km,
   COALESCE(obs.total_obs, 0) AS total_observaciones,
   c.actualizado_el
  FROM (((((((choferes c
    LEFT JOIN chofer_documentacion cd ON ((cd.chofer_id = c.id)))
    LEFT JOIN servicios_choferes sc ON ((c.servicio_id = sc.id)))
    LEFT JOIN unidades u ON ((c.unidad_id = u.id)))
    LEFT JOIN tractores t ON ((u.tractor_id = t.id)))
    LEFT JOIN semis s ON ((u.semi_id = s.id)))
    LEFT JOIN ( SELECT choferes_km_mensual.chofer_id,
           round(sum(choferes_km_mensual.km_mes_total), 2) AS total_km
          FROM choferes_km_mensual
         GROUP BY choferes_km_mensual.chofer_id) km ON ((km.chofer_id = c.id)))
    LEFT JOIN ( SELECT chofer_observaciones.chofer_id,
           (count(*))::integer AS total_obs
          FROM chofer_observaciones
         GROUP BY chofer_observaciones.chofer_id) obs ON ((obs.chofer_id = c.id)));

GRANT SELECT ON public.view_individual_chofer TO anon, authenticated, service_role, postgres;

-- 2. Recrear public.view_calendario_km como vista virtual sobre choferes_km_mensual
DROP VIEW IF EXISTS public.view_calendario_km CASCADE;

CREATE OR REPLACE VIEW public.view_calendario_km AS
SELECT 
  (day_kv.key)::date AS fecha,
  ck.chofer_id AS id_chofer,
  c.nombre AS chofer_nombre,
  c.legajo,
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
CROSS JOIN LATERAL jsonb_each(ck.dias_km) AS day_kv(key, value);

GRANT SELECT ON public.view_calendario_km TO anon, authenticated, service_role, postgres;

-- 3. Crear índice único de idempotencia para cisternas_km
CREATE UNIQUE INDEX IF NOT EXISTS uq_cisternas_km_trip 
ON public.cisternas_km (fecha, tractor_patente, COALESCE(cisterna_patente, ''), COALESCE(hoja_ruta, ''));

-- 4. Eliminar de forma segura la tabla residual movimientos_km
DROP TABLE IF EXISTS public.movimientos_km CASCADE;
