-- ==============================================================================
-- 🚀 TABLA, TRIGGERS Y VISTA ENRIQUECIDA: MOVIMIENTOS (UNIDAD + CHOFER ACTUAL)
-- Proyecto: https://rsvajuxihvmpmrmlcbul.supabase.co
-- ==============================================================================

-- 1. Eliminar la vista anterior 'movimientos' si existe para recrear la tabla base
DROP VIEW IF EXISTS public.movimientos CASCADE;

-- 2. Crear tabla relacional base 'movimientos'
CREATE TABLE IF NOT EXISTS public.movimientos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    id_unidad UUID NOT NULL REFERENCES public.unidades(id) ON DELETE CASCADE,
    id_chofer UUID NOT NULL REFERENCES public.choferes(id) ON DELETE CASCADE,
    creado_el TIMESTAMPTZ DEFAULT NOW(),
    actualizado_el TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_movimientos_unidad UNIQUE (id_unidad),
    CONSTRAINT uq_movimientos_chofer UNIQUE (id_chofer)
);

CREATE INDEX IF NOT EXISTS idx_mov_unidad ON public.movimientos(id_unidad);
CREATE INDEX IF NOT EXISTS idx_mov_chofer ON public.movimientos(id_chofer);
CREATE INDEX IF NOT EXISTS idx_mov_actualizado ON public.movimientos(actualizado_el);

-- 3. Políticas RLS
ALTER TABLE public.movimientos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Permitir todo en movimientos" ON public.movimientos;
CREATE POLICY "Permitir todo en movimientos" ON public.movimientos FOR ALL USING (true) WITH CHECK (true);

-- 4. Trigger de Sincronización Automática entre 'movimientos' <-> 'choferes' y 'unidades'
CREATE OR REPLACE FUNCTION public.fn_trg_movimientos_sync()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- 1. Limpiar asignación previa de este chofer o de esta unidad si existiera en choferes
        UPDATE public.choferes
        SET unidad_id = NULL,
            estado = CASE WHEN estado = 'circulando' THEN 'inactivo' ELSE estado END,
            actualizado_el = NOW()
        WHERE (unidad_id = NEW.id_unidad AND id <> NEW.id_chofer)
           OR (id = NEW.id_chofer AND unidad_id IS DISTINCT FROM NEW.id_unidad);

        -- 2. Asignar unidad y marcar chofer como circulando
        UPDATE public.choferes
        SET unidad_id = NEW.id_unidad,
            estado = 'circulando',
            actualizado_el = NOW()
        WHERE id = NEW.id_chofer;

        -- 3. Marcar unidad como circulando
        UPDATE public.unidades
        SET estado = 'circulando'
        WHERE id = NEW.id_unidad;

        RETURN NEW;

    ELSIF TG_OP = 'UPDATE' THEN
        IF (OLD.id_unidad IS DISTINCT FROM NEW.id_unidad OR OLD.id_chofer IS DISTINCT FROM NEW.id_chofer) THEN
            -- Desvincular chofer anterior
            UPDATE public.choferes
            SET unidad_id = NULL,
                estado = CASE WHEN estado = 'circulando' THEN 'inactivo' ELSE estado END,
                actualizado_el = NOW()
            WHERE id = OLD.id_chofer AND id <> NEW.id_chofer;

            -- Desvincular unidad anterior si no tiene otro movimiento
            UPDATE public.unidades
            SET estado = 'disponible'
            WHERE id = OLD.id_unidad AND id <> NEW.id_unidad;

            -- Vincular nuevo chofer y unidad
            UPDATE public.choferes
            SET unidad_id = NEW.id_unidad,
                estado = 'circulando',
                actualizado_el = NOW()
            WHERE id = NEW.id_chofer;

            UPDATE public.unidades
            SET estado = 'circulando'
            WHERE id = NEW.id_unidad;
        END IF;
        RETURN NEW;

    ELSIF TG_OP = 'DELETE' THEN
        -- Al eliminar el movimiento, desasignar chofer y liberar unidad
        UPDATE public.choferes
        SET unidad_id = NULL,
            estado = CASE WHEN estado = 'circulando' THEN 'inactivo' ELSE estado END,
            actualizado_el = NOW()
        WHERE id = OLD.id_chofer;

        UPDATE public.unidades
        SET estado = 'disponible'
        WHERE id = OLD.id_unidad;

        RETURN OLD;
    END IF;

    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_movimientos_sync ON public.movimientos;
CREATE TRIGGER trg_movimientos_sync
AFTER INSERT OR UPDATE OR DELETE ON public.movimientos
FOR EACH ROW EXECUTE FUNCTION public.fn_trg_movimientos_sync();

-- 5. Poblar 'movimientos' inicial con choferes que ya tienen unidad_id asignada
INSERT INTO public.movimientos (id_unidad, id_chofer, actualizado_el)
SELECT DISTINCT ON (c.unidad_id) 
    c.unidad_id, 
    c.id, 
    COALESCE(c.actualizado_el, NOW())
FROM public.choferes c
WHERE c.unidad_id IS NOT NULL
ON CONFLICT (id_unidad) DO UPDATE SET 
    id_chofer = EXCLUDED.id_chofer,
    actualizado_el = EXCLUDED.actualizado_el;

-- 6. Crear Vista Enriquecida: public.view_movimientos (Unión de Unidad y Chofer Actual)
DROP VIEW IF EXISTS public.view_movimientos CASCADE;

CREATE OR REPLACE VIEW public.view_movimientos AS
SELECT 
    m.id AS movimiento_id,
    -- Datos de la Unidad
    u.id AS unidad_id,
    u.n_ute,
    u.estado AS unidad_estado,
    u.fecha_acople,
    su.denominacion AS servicio_unidad,
    -- Tractor
    t.id AS tractor_id,
    t.patente AS tractor,
    t.marca AS marca_tr,
    t.modelo AS modelo_tr,
    t.vtv AS vtv_tr,
    t.mas AS mas_tr,
    -- Semi
    s.id AS semi_id,
    s.patente AS semi,
    s.marca AS marca_semi,
    s.cisternado,
    s.esp_es,
    s.vi,
    s.ve,
    s.vtv AS vtv_semi,
    s.mas AS mas_semi,
    -- Datos del Chofer
    c.id AS chofer_id,
    c.nombre AS chofer_nombre,
    c.legajo AS chofer_legajo,
    cd.dni AS chofer_dni,
    cd.cuil AS chofer_cuil,
    cd.telefono AS chofer_telefono,
    c.foto AS chofer_foto,
    c.estado AS chofer_estado,
    COALESCE(sc.denominacion, su.denominacion, 'GENERAL') AS chofer_servicio,
    -- Día de diagrama para hoy
    COALESCE(
        d.dias ->> CURRENT_DATE::text,
        '-'
    ) AS dia_diagrama,
    -- Alerta básica de vencimientos de unidad
    CASE 
        WHEN (t.vtv IS NOT NULL AND t.vtv < CURRENT_DATE)
          OR (s.vtv IS NOT NULL AND s.vtv < CURRENT_DATE)
          OR (t.mas IS NOT NULL AND t.mas < CURRENT_DATE)
          OR (s.mas IS NOT NULL AND s.mas < CURRENT_DATE)
        THEN 'VENCIDO'
        WHEN (t.vtv IS NOT NULL AND t.vtv <= CURRENT_DATE + INTERVAL '15 days')
          OR (s.vtv IS NOT NULL AND s.vtv <= CURRENT_DATE + INTERVAL '15 days')
          OR (t.mas IS NOT NULL AND t.mas <= CURRENT_DATE + INTERVAL '15 days')
          OR (s.mas IS NOT NULL AND s.mas <= CURRENT_DATE + INTERVAL '15 days')
        THEN 'POR_VENCER'
        WHEN (t.id IS NOT NULL OR s.id IS NOT NULL) THEN 'AL_DIA'
        ELSE 'S_D'
    END AS alerta_vencimientos_unidad,
    m.actualizado_el
FROM public.movimientos m
JOIN public.unidades u ON m.id_unidad = u.id
JOIN public.choferes c ON m.id_chofer = c.id
LEFT JOIN public.chofer_documentacion cd ON cd.chofer_id = c.id
LEFT JOIN public.tractores t ON u.tractor_id = t.id
LEFT JOIN public.semis s ON u.semi_id = s.id
LEFT JOIN public.servicios_unidades su ON u.servicio_id = su.id
LEFT JOIN public.servicios_choferes sc ON c.servicio_id = sc.id
LEFT JOIN LATERAL (
    SELECT dias 
    FROM public.diagramas diag 
    WHERE diag.chofer_id = c.id 
      AND diag.anio = EXTRACT(YEAR FROM CURRENT_DATE)::int 
      AND diag.mes_numero = EXTRACT(MONTH FROM CURRENT_DATE)::int 
    ORDER BY diag.actualizado_el DESC 
    LIMIT 1
) d ON true
ORDER BY u.n_ute ASC NULLS LAST, t.patente ASC NULLS LAST;

GRANT SELECT ON public.view_movimientos TO anon, authenticated, service_role, postgres;
