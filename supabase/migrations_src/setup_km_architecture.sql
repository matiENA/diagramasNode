-- ==============================================================================
-- 🚀 ARQUITECTURA OPTIMIZADA DE KM: CHOFERES Y CISTERNAS INDEPENDIENTES
-- Supabase PostgreSQL
-- ==============================================================================

-- 1. TABLA INDEPENDIENTE: cisternas_km (Reservada para reconciliación e inserción futura)
CREATE TABLE IF NOT EXISTS public.cisternas_km (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fecha DATE NOT NULL,
    semi_id UUID REFERENCES public.semis(id) ON DELETE SET NULL,
    cisterna_patente TEXT,
    tractor_id UUID REFERENCES public.tractores(id) ON DELETE SET NULL,
    tractor_patente TEXT,
    id_unidad UUID REFERENCES public.unidades(id) ON DELETE SET NULL,
    id_chofer UUID REFERENCES public.choferes(id) ON DELETE SET NULL,
    km_totales NUMERIC(10,2) DEFAULT 0,
    hoja_ruta TEXT,
    estado_asignacion TEXT DEFAULT 'pendiente' CHECK (estado_asignacion IN ('pendiente', 'confirmado', 'descartado')),
    origen_dato TEXT DEFAULT 'sheets_km',
    creado_el TIMESTAMPTZ DEFAULT NOW(),
    actualizado_el TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cisternas_km_semi_id ON public.cisternas_km(semi_id);
CREATE INDEX IF NOT EXISTS idx_cisternas_km_fecha ON public.cisternas_km(fecha);
CREATE INDEX IF NOT EXISTS idx_cisternas_km_patente ON public.cisternas_km(cisterna_patente);
CREATE INDEX IF NOT EXISTS idx_cisternas_km_estado ON public.cisternas_km(estado_asignacion);

ALTER TABLE public.cisternas_km ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Permitir todo en cisternas_km" ON public.cisternas_km;
CREATE POLICY "Permitir todo en cisternas_km" ON public.cisternas_km FOR ALL USING (true) WITH CHECK (true);
GRANT ALL ON public.cisternas_km TO anon, authenticated, service_role, postgres;

-- 2. TABLA PRINCIPAL DE ROLLUP: choferes_km_mensual (Key: chofer_id + mes_tab)
CREATE TABLE IF NOT EXISTS public.choferes_km_mensual (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    chofer_id UUID NOT NULL REFERENCES public.choferes(id) ON DELETE CASCADE,
    mes_tab TEXT NOT NULL,          -- ej: 'Sep-26', 'Abr-26'
    anio INTEGER NOT NULL,          -- ej: 2026
    mes_numero INTEGER NOT NULL,    -- ej: 9
    km_mes_total NUMERIC(10,2) DEFAULT 0,
    cant_viajes INTEGER DEFAULT 0,
    dias_km JSONB NOT NULL DEFAULT '{}'::jsonb, -- { [isoDate]: { km, hr, id_unidad, tractor, n_ute } }
    rangos JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [ { desde, hasta, dias, km } ]
    actualizado_el TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_chofer_km_mes UNIQUE (chofer_id, mes_tab)
);

CREATE INDEX IF NOT EXISTS idx_chofer_km_lookup ON public.choferes_km_mensual(chofer_id, anio, mes_numero);
CREATE INDEX IF NOT EXISTS idx_chofer_km_mes_tab ON public.choferes_km_mensual(mes_tab);
CREATE INDEX IF NOT EXISTS idx_chofer_km_chofer_id ON public.choferes_km_mensual(chofer_id);

ALTER TABLE public.choferes_km_mensual ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Permitir todo en choferes_km_mensual" ON public.choferes_km_mensual;
CREATE POLICY "Permitir todo en choferes_km_mensual" ON public.choferes_km_mensual FOR ALL USING (true) WITH CHECK (true);
GRANT ALL ON public.choferes_km_mensual TO anon, authenticated, service_role, postgres;

-- 3. VISTA ACTUALIZADA: view_calendario_diagrama_km (Directo O(1) sin LATERAL scan)
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
  COALESCE(ck.km_mes_total, 0) AS km_mes_total,
  COALESCE(ck.cant_viajes, 0) AS cant_viajes_mes,
  COALESCE(ck.dias_km, '{}'::jsonb) AS dias_km
FROM public.diagramas d
LEFT JOIN public.choferes_km_mensual ck 
  ON ck.chofer_id = d.chofer_id AND ck.mes_tab = d.mes_tab;

GRANT SELECT ON public.view_calendario_diagrama_km TO anon, authenticated, service_role, postgres;
