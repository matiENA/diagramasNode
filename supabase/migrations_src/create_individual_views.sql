-- ==============================================================================
-- 🚀 VISTAS OPTIMIZADAS PARA VISTA INDIVIDUAL (SUPABASE POSTGRESQL)
-- Proyecto: https://rsvajuxihvmpmrmlcbul.supabase.co
-- ==============================================================================

-- 1. VISTA INDIVIDUAL CHOFER: Datos de chofer + unidad + datos de unidad + vencimientos + avalados
DROP VIEW IF EXISTS public.view_individual_chofer CASCADE;

CREATE OR REPLACE VIEW public.view_individual_chofer AS
SELECT 
  c.id AS chofer_id,
  c.nombre,
  c.legajo,
  c.estado AS estado_chofer,
  c.foto,
  COALESCE(sc.denominacion, 'GENERAL') AS servicio,
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
  COALESCE(u.estado, 'disponible') AS estado_unidad,
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
  COALESCE(km.total_km, 0) AS total_km,
  COALESCE(obs.total_obs, 0) AS total_observaciones,
  c.actualizado_el
FROM public.choferes c
LEFT JOIN public.chofer_documentacion cd ON cd.chofer_id = c.id
LEFT JOIN public.servicios_choferes sc ON c.servicio_id = sc.id
LEFT JOIN public.unidades u ON c.unidad_id = u.id
LEFT JOIN public.tractores t ON u.tractor_id = t.id
LEFT JOIN public.semis s ON u.semi_id = s.id
LEFT JOIN (
  SELECT id_chofer, round(sum(km_totales), 2) AS total_km
  FROM public.movimientos_km
  GROUP BY id_chofer
) km ON km.id_chofer = c.id
LEFT JOIN (
  SELECT chofer_id, count(*)::int AS total_obs
  FROM public.chofer_observaciones
  GROUP BY chofer_id
) obs ON obs.chofer_id = c.id;

-- 2. VISTA CALENDARIO DIAGRAMA KMS: Diagrama por mes + KMs agregados por día en JSONB
DROP VIEW IF EXISTS public.view_calendario_diagrama_km CASCADE;

CREATE OR REPLACE VIEW public.view_calendario_diagrama_km AS
SELECT 
  d.id AS diagrama_id,
  d.chofer_id,
  d.mes_tab,
  d.anio,
  d.mes_numero,
  d.tira_dias,
  d.contabilizador,
  COALESCE(km_data.km_mes_total, 0) AS km_mes_total,
  COALESCE(km_data.cant_viajes_mes, 0) AS cant_viajes_mes,
  COALESCE(km_data.dias_km, '{}'::jsonb) AS dias_km
FROM public.diagramas d
LEFT JOIN LATERAL (
  SELECT 
    round(sum(m.km_totales), 2) AS km_mes_total,
    count(*)::int AS cant_viajes_mes,
    jsonb_object_agg(
      to_char(m.fecha, 'YYYY-MM-DD'),
      jsonb_build_object(
        'km', round(m.km_totales, 2),
        'hr', COALESCE(m.hoja_ruta, '')
      )
    ) AS dias_km
  FROM public.movimientos_km m
  WHERE m.id_chofer = d.chofer_id
    AND EXTRACT(YEAR FROM m.fecha) = d.anio
    AND EXTRACT(MONTH FROM m.fecha) = d.mes_numero
) km_data ON true;

-- Permisos RLS y Acceso Público
GRANT SELECT ON public.view_individual_chofer TO anon, authenticated, service_role;
GRANT SELECT ON public.view_calendario_diagrama_km TO anon, authenticated, service_role;
