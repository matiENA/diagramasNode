-- ==============================================================================
-- 🛡️ MIGRACIÓN 009: PROTECCIÓN ANTI-REGRESIÓN EN choferes_km_mensual
-- Evita que sincronizaciones externas o ejecuciones parciales sobrescriban
-- con 0 o nulo los KMs históricos ya consolidados.
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.trg_protect_choferes_km_mensual()
RETURNS trigger AS $$
BEGIN
    -- Si el registro existente ya tiene KMs calculados (> 0) y el nuevo intenta pisarlo con 0 o nulo, conservar el valor anterior
    IF (OLD.km_mes_total > 0 AND (NEW.km_mes_total IS NULL OR NEW.km_mes_total = 0)) THEN
        NEW.km_mes_total := OLD.km_mes_total;
        NEW.cant_viajes := GREATEST(OLD.cant_viajes, NEW.cant_viajes);
        IF (NEW.dias_km IS NULL OR NEW.dias_km = '{}'::jsonb OR NEW.dias_km = 'null'::jsonb) THEN
            NEW.dias_km := OLD.dias_km;
            NEW.rangos := OLD.rangos;
        END IF;
    END IF;

    -- Si el viejo tiene dias_km poblado y el nuevo viene vacío o nulo, conservar los dias_km existentes
    IF (OLD.dias_km IS NOT NULL AND jsonb_typeof(OLD.dias_km) = 'object' AND OLD.dias_km <> '{}'::jsonb) THEN
        IF (NEW.dias_km IS NULL OR NEW.dias_km = '{}'::jsonb OR NEW.dias_km = 'null'::jsonb OR jsonb_typeof(NEW.dias_km) <> 'object') THEN
            NEW.dias_km := OLD.dias_km;
        END IF;
    END IF;

    -- Si el viejo tiene rangos poblado y el nuevo viene vacío, conservar los rangos existentes
    IF (OLD.rangos IS NOT NULL AND jsonb_typeof(OLD.rangos) = 'array' AND jsonb_array_length(OLD.rangos) > 0) THEN
        IF (NEW.rangos IS NULL OR NEW.rangos = '[]'::jsonb OR NEW.rangos = 'null'::jsonb OR jsonb_typeof(NEW.rangos) <> 'array' OR jsonb_array_length(NEW.rangos) = 0) THEN
            NEW.rangos := OLD.rangos;
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_protect_choferes_km_mensual ON public.choferes_km_mensual;

CREATE TRIGGER trg_protect_choferes_km_mensual
BEFORE UPDATE ON public.choferes_km_mensual
FOR EACH ROW
EXECUTE FUNCTION public.trg_protect_choferes_km_mensual();

COMMENT ON FUNCTION public.trg_protect_choferes_km_mensual() IS 
'Protege contra sobreescrituras accidentales a 0 km en choferes_km_mensual por pipelines externos o parciales.';
