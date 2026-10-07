-- ==============================================================================
-- 🚀 MIGRACIÓN 004: Habilitar actualizado_por y corregir triggers para eor_sync_queue
-- ==============================================================================

-- 1. AGREGAR COLUMNAS DE AUDITORÍA/CONTROL A TABLAS BASE
ALTER TABLE public.choferes 
ADD COLUMN IF NOT EXISTS actualizado_por TEXT;

ALTER TABLE public.diagramas 
ADD COLUMN IF NOT EXISTS actualizado_por TEXT;

-- 2. CORREGIR TRIGGER FUNCTION DE DIAGRAMAS
-- Elimina la referencia inexistente NEW.chofer_nombre y busca el nombre directamente en public.choferes
CREATE OR REPLACE FUNCTION public.fn_trg_sync_diagramas()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_nombre TEXT;
    v_usuario TEXT;
BEGIN
    -- La cola de sincronización es EXCLUSIVA de operaciones del frontend (requiere actualizado_por)
    IF NEW.actualizado_por IS NULL THEN
        RETURN NEW;
    END IF;

    IF (OLD.tira_dias IS DISTINCT FROM NEW.tira_dias) THEN
        SELECT nombre INTO v_nombre FROM public.choferes WHERE id = NEW.chofer_id LIMIT 1;
        v_usuario := NEW.actualizado_por;

        INSERT INTO public.eor_sync_queue (
            entidad, destino_sheet, tipo_operacion, chofer_id, chofer_nombre,
            datos_nuevos, datos_previos, usuario
        ) VALUES (
            'DIAGRAMA', NEW.mes_tab, 'UPDATE', NEW.chofer_id, v_nombre,
            jsonb_build_object('mes_tab', NEW.mes_tab, 'tira_dias', NEW.tira_dias),
            jsonb_build_object('tira_dias_previa', OLD.tira_dias),
            v_usuario
        );
    END IF;

    -- Resetear para que futuras actualizaciones de background/ETL no hereden este valor
    NEW.actualizado_por := NULL;
    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Falla en fn_trg_sync_diagramas: %', SQLERRM;
    RETURN NEW;
END;
$$;

-- Asegurar que el trigger esté asignado como BEFORE UPDATE en diagramas
DROP TRIGGER IF EXISTS trg_sync_diagramas ON public.diagramas;
CREATE TRIGGER trg_sync_diagramas
    BEFORE UPDATE ON public.diagramas
    FOR EACH ROW
    EXECUTE FUNCTION public.fn_trg_sync_diagramas();

-- 3. CORREGIR TRIGGER FUNCTION DE DOCUMENTACIÓN (INCORPORA PSICOFÍSICO)
CREATE OR REPLACE FUNCTION public.fn_trg_sync_documentacion()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_nombre TEXT;
    v_dni TEXT;
    v_cuil TEXT;
    v_usuario TEXT;
BEGIN
    -- La cola de sincronización es EXCLUSIVA de operaciones del frontend (requiere actualizado_por)
    IF NEW.actualizado_por IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT nombre INTO v_nombre FROM public.choferes WHERE id = NEW.chofer_id LIMIT 1;
    v_dni := NEW.dni;
    v_cuil := COALESCE(NEW.cuil, NEW.dni);
    v_usuario := NEW.actualizado_por;

    -- Vencimiento Periódico modificado -> Hoja PERIODICOS Columna I
    IF (OLD.venc_periodico IS DISTINCT FROM NEW.venc_periodico) AND NEW.venc_periodico IS NOT NULL THEN
        INSERT INTO public.eor_sync_queue (
            entidad, destino_sheet, tipo_operacion, chofer_id, chofer_nombre, dni_cuil,
            datos_nuevos, datos_previos, usuario
        ) VALUES (
            'DOCUMENTACION', 'PERIODICOS', 'UPDATE', NEW.chofer_id, v_nombre, v_cuil,
            jsonb_build_object('campo', 'venc_periodico', 'valor', NEW.venc_periodico, 'columna', 'I'),
            jsonb_build_object('valor_previo', OLD.venc_periodico),
            v_usuario
        );
    END IF;

    -- Licencia Nacional modificada -> Hoja VENCIMIENTOS Columna E
    IF (OLD.venc_licencia_nacional IS DISTINCT FROM NEW.venc_licencia_nacional) AND NEW.venc_licencia_nacional IS NOT NULL THEN
        INSERT INTO public.eor_sync_queue (
            entidad, destino_sheet, tipo_operacion, chofer_id, chofer_nombre, dni_cuil,
            datos_nuevos, datos_previos, usuario
        ) VALUES (
            'DOCUMENTACION', 'VENCIMIENTOS', 'UPDATE', NEW.chofer_id, v_nombre, v_dni,
            jsonb_build_object('campo', 'venc_licencia_nacional', 'valor', NEW.venc_licencia_nacional, 'columna', 'E'),
            jsonb_build_object('valor_previo', OLD.venc_licencia_nacional),
            v_usuario
        );
    END IF;

    -- Cargas Peligrosas modificada -> Hoja VENCIMIENTOS Columna D
    IF (OLD.venc_cargas_peligrosas IS DISTINCT FROM NEW.venc_cargas_peligrosas) AND NEW.venc_cargas_peligrosas IS NOT NULL THEN
        INSERT INTO public.eor_sync_queue (
            entidad, destino_sheet, tipo_operacion, chofer_id, chofer_nombre, dni_cuil,
            datos_nuevos, datos_previos, usuario
        ) VALUES (
            'DOCUMENTACION', 'VENCIMIENTOS', 'UPDATE', NEW.chofer_id, v_nombre, v_dni,
            jsonb_build_object('campo', 'venc_cargas_peligrosas', 'valor', NEW.venc_cargas_peligrosas, 'columna', 'D'),
            jsonb_build_object('valor_previo', OLD.venc_cargas_peligrosas),
            v_usuario
        );
    END IF;

    -- Psicofísico modificado -> Hoja VENCIMIENTOS Columna F
    IF (OLD.venc_psicofisico IS DISTINCT FROM NEW.venc_psicofisico) AND NEW.venc_psicofisico IS NOT NULL THEN
        INSERT INTO public.eor_sync_queue (
            entidad, destino_sheet, tipo_operacion, chofer_id, chofer_nombre, dni_cuil,
            datos_nuevos, datos_previos, usuario
        ) VALUES (
            'DOCUMENTACION', 'VENCIMIENTOS', 'UPDATE', NEW.chofer_id, v_nombre, v_dni,
            jsonb_build_object('campo', 'venc_psicofisico', 'valor', NEW.venc_psicofisico, 'columna', 'F'),
            jsonb_build_object('valor_previo', OLD.venc_psicofisico),
            v_usuario
        );
    END IF;

    -- Resetear para que futuras actualizaciones de background/ETL no hereden este valor
    NEW.actualizado_por := NULL;
    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Falla en fn_trg_sync_documentacion: %', SQLERRM;
    RETURN NEW;
END;
$$;

-- Asegurar que el trigger esté asignado como BEFORE UPDATE en chofer_documentacion
DROP TRIGGER IF EXISTS trg_sync_documentacion ON public.chofer_documentacion;
CREATE TRIGGER trg_sync_documentacion
    BEFORE UPDATE ON public.chofer_documentacion
    FOR EACH ROW
    EXECUTE FUNCTION public.fn_trg_sync_documentacion();

-- 4. RECARGAR SCHEMA CACHE DE POSTGREST
NOTIFY pgrst, 'reload schema';
