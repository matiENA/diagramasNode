-- ==============================================================================
-- 🚀 MIGRACIÓN 014: Enriquecer view_flota_operativa con n_ute y servicio
-- ==============================================================================

CREATE OR REPLACE VIEW public.view_flota_operativa AS
 SELECT q.unidad_id,
    q.tractor,
    q.semi,
    q.chofer_id,
    q.chofer_nombre,
    q.dia_diagrama,
    q.vtv_tr,
    q.mas_tr,
    q.vtv_semi,
    q.mas_semi,
    q.n_ute,
    q.servicio
   FROM ( SELECT u.id AS unidad_id,
            u.n_ute,
            COALESCE(su.denominacion, 'GENERAL'::text) AS servicio,
                CASE
                    WHEN t.patente IS NOT NULL AND NOT t.patente ~ '^[0-9\-/]+$'::text AND t.patente <> '|'::text THEN t.patente
                    WHEN t.patente IS NULL AND s.patente IS NOT NULL AND (EXISTS ( SELECT 1
                       FROM tractores tr
                      WHERE upper(tr.patente) = upper(s.patente))) THEN s.patente
                    ELSE ''::text
                END AS tractor,
                CASE
                    WHEN s.patente IS NULL OR s.patente = '|'::text THEN ''::text
                    WHEN (EXISTS ( SELECT 1
                       FROM tractores tr
                      WHERE upper(tr.patente) = upper(s.patente))) THEN ''::text
                    ELSE s.patente
                END AS semi,
            c.id AS chofer_id,
            COALESCE(c.nombre, ''::text) AS chofer_nombre,
            COALESCE(d.dias ->> CURRENT_DATE::text, '-'::text) AS dia_diagrama,
                CASE
                    WHEN t.patente IS NULL OR t.patente ~ '^[0-9\-/]+$'::text OR t.patente = '|'::text THEN NULL::date
                    ELSE t.vtv
                END AS vtv_tr,
                CASE
                    WHEN t.patente IS NULL OR t.patente ~ '^[0-9\-/]+$'::text OR t.patente = '|'::text THEN NULL::date
                    ELSE t.mas
                END AS mas_tr,
            s.vtv AS vtv_semi,
            s.mas AS mas_semi
           FROM unidades u
             LEFT JOIN servicios_unidades su ON u.servicio_id = su.id
             LEFT JOIN tractores t ON u.tractor_id = t.id
             LEFT JOIN semis s ON u.semi_id = s.id
             LEFT JOIN movimientos m ON u.id = m.id_unidad
             LEFT JOIN choferes c ON m.id_chofer = c.id
             LEFT JOIN LATERAL ( SELECT diagramas.dias
                   FROM diagramas
                  WHERE diagramas.chofer_id = c.id AND diagramas.anio = EXTRACT(year FROM CURRENT_DATE)::integer AND diagramas.mes_numero = EXTRACT(month FROM CURRENT_DATE)::integer
                  ORDER BY diagramas.actualizado_el DESC NULLS LAST
                 LIMIT 1) d ON true) q
  WHERE q.tractor <> ''::text OR q.semi <> ''::text
  ORDER BY (NULLIF(q.tractor, ''::text)), (NULLIF(q.semi, ''::text));

GRANT SELECT ON public.view_flota_operativa TO anon, authenticated, service_role;
NOTIFY pgrst, 'reload schema';
