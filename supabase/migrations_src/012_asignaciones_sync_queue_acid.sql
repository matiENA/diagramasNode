-- ==============================================================================
-- 🚀 MIGRACIÓN 012: Encolamiento Atómico en eor_sync_queue para Asignaciones y Desuniones
-- ==============================================================================

-- 1. Actualizar Función Atómica: Asignar Unidad a Chofer
CREATE OR REPLACE FUNCTION public.fn_asignar_unidad_chofer(
    p_chofer_id uuid,
    p_unidad_id uuid,
    p_usuario text DEFAULT 'OPERADOR'::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_prev_chofer_id uuid;
    v_prev_chofer_nombre text;
    v_chofer_nombre text;
    v_ute text;
    v_tractor text;
    v_semi text;
    v_prev_unidad_id uuid;
BEGIN
    IF p_chofer_id IS NULL OR p_unidad_id IS NULL THEN
        RAISE EXCEPTION 'p_chofer_id y p_unidad_id son obligatorios para la asignación';
    END IF;

    -- Obtener datos de la unidad a asignar
    SELECT u.n_ute, t.patente, s.patente 
    INTO v_ute, v_tractor, v_semi
    FROM public.unidades u
    LEFT JOIN public.tractores t ON t.id = u.tractor_id
    LEFT JOIN public.semis s ON s.id = u.semi_id
    WHERE u.id = p_unidad_id;

    -- Unidad previa del chofer actual (si tenía)
    SELECT unidad_id, nombre INTO v_prev_unidad_id, v_chofer_nombre
    FROM public.choferes
    WHERE id = p_chofer_id;

    -- 1. Si otro chofer tenía asignada esta unidad, liberarlo y encolar desunión
    SELECT id, nombre INTO v_prev_chofer_id, v_prev_chofer_nombre
    FROM public.choferes
    WHERE unidad_id = p_unidad_id AND id <> p_chofer_id
    FOR UPDATE;

    IF v_prev_chofer_id IS NOT NULL THEN
        UPDATE public.choferes
        SET unidad_id = NULL,
            estado = 'inactivo',
            actualizado_por = p_usuario,
            actualizado_el = NOW()
        WHERE id = v_prev_chofer_id;

        DELETE FROM public.movimientos WHERE id_chofer = v_prev_chofer_id;

        INSERT INTO public.eor_sync_queue (
            entidad, destino_sheet, tipo_operacion, chofer_id, chofer_nombre,
            unidad_tractor, datos_nuevos, datos_previos, usuario
        ) VALUES (
            'ASIGNACION', 'MOVIMIENTOS', 'DELETE', v_prev_chofer_id, v_prev_chofer_nombre,
            v_tractor,
            jsonb_build_object(
                'unidad_id', p_unidad_id,
                'tractor', v_tractor,
                'semi', v_semi,
                'n_ute', v_ute,
                'esDesasignar', true,
                'fecha', CURRENT_DATE
            ),
            jsonb_build_object('unidad_anterior', p_unidad_id, 'tractor', v_tractor),
            p_usuario
        );
    END IF;

    -- 2. Limpiar movimientos previos de chofer o unidad
    DELETE FROM public.movimientos 
    WHERE id_chofer = p_chofer_id OR id_unidad = p_unidad_id;

    -- 3. Actualizar el chofer con su nueva unidad
    UPDATE public.choferes
    SET unidad_id = p_unidad_id,
        estado = 'circulando',
        actualizado_por = p_usuario,
        actualizado_el = NOW()
    WHERE id = p_chofer_id
    RETURNING nombre INTO v_chofer_nombre;

    -- 4. Insertar el pareo activo en movimientos
    INSERT INTO public.movimientos (id_chofer, id_unidad, actualizado_el)
    VALUES (p_chofer_id, p_unidad_id, NOW())
    ON CONFLICT (id_unidad) DO UPDATE SET
        id_chofer = EXCLUDED.id_chofer,
        actualizado_el = NOW();

    -- 5. Encolar mutación en eor_sync_queue para sincronización con Google Sheets
    INSERT INTO public.eor_sync_queue (
        entidad, destino_sheet, tipo_operacion, chofer_id, chofer_nombre,
        unidad_tractor, datos_nuevos, datos_previos, usuario
    ) VALUES (
        'ASIGNACION', 'MOVIMIENTOS', 'UPDATE', p_chofer_id, v_chofer_nombre,
        v_tractor,
        jsonb_build_object(
            'unidad_id', p_unidad_id,
            'tractor', v_tractor,
            'semi', v_semi,
            'n_ute', v_ute,
            'esDesasignar', false,
            'fecha', CURRENT_DATE
        ),
        jsonb_build_object('unidad_anterior', v_prev_unidad_id),
        p_usuario
    );

    RETURN jsonb_build_object(
        'success', true,
        'accion', 'asignacion',
        'chofer_id', p_chofer_id,
        'chofer_nombre', v_chofer_nombre,
        'unidad_id', p_unidad_id,
        'n_ute', v_ute,
        'tractor', v_tractor,
        'semi', v_semi,
        'usuario', p_usuario,
        'liberado_previo', v_prev_chofer_id
    );
END;
$function$;

-- 2. Actualizar Función Atómica: Desunir Unidad de Chofer
CREATE OR REPLACE FUNCTION public.fn_desunir_unidad_chofer(
    p_chofer_id uuid,
    p_usuario text DEFAULT 'OPERADOR'::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
    v_prev_unidad_id uuid;
    v_chofer_nombre text;
    v_prev_tractor text;
    v_prev_semi text;
    v_prev_ute text;
BEGIN
    IF p_chofer_id IS NULL THEN
        RAISE EXCEPTION 'p_chofer_id es obligatorio para la desunión';
    END IF;

    -- Obtener unidad actual con bloqueo pesimista
    SELECT c.unidad_id, c.nombre, u.n_ute, t.patente, s.patente
    INTO v_prev_unidad_id, v_chofer_nombre, v_prev_ute, v_prev_tractor, v_prev_semi
    FROM public.choferes c
    LEFT JOIN public.unidades u ON u.id = c.unidad_id
    LEFT JOIN public.tractores t ON t.id = u.tractor_id
    LEFT JOIN public.semis s ON s.id = u.semi_id
    WHERE c.id = p_chofer_id
    FOR UPDATE OF c;

    -- 1. Desvincular en choferes
    UPDATE public.choferes
    SET unidad_id = NULL,
        estado = 'inactivo',
        actualizado_por = p_usuario,
        actualizado_el = NOW()
    WHERE id = p_chofer_id;

    -- 2. Eliminar de movimientos
    DELETE FROM public.movimientos
    WHERE id_chofer = p_chofer_id OR (v_prev_unidad_id IS NOT NULL AND id_unidad = v_prev_unidad_id);

    -- 3. Encolar mutación en eor_sync_queue para vaciar la celda en Google Sheets
    IF v_prev_unidad_id IS NOT NULL OR v_prev_tractor IS NOT NULL THEN
        INSERT INTO public.eor_sync_queue (
            entidad, destino_sheet, tipo_operacion, chofer_id, chofer_nombre,
            unidad_tractor, datos_nuevos, datos_previos, usuario
        ) VALUES (
            'ASIGNACION', 'MOVIMIENTOS', 'DELETE', p_chofer_id, v_chofer_nombre,
            v_prev_tractor,
            jsonb_build_object(
                'unidad_id', v_prev_unidad_id,
                'tractor', v_prev_tractor,
                'semi', v_prev_semi,
                'n_ute', v_prev_ute,
                'esDesasignar', true,
                'fecha', CURRENT_DATE
            ),
            jsonb_build_object('unidad_anterior', v_prev_unidad_id, 'tractor', v_prev_tractor),
            p_usuario
        );
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'accion', 'desunion',
        'chofer_id', p_chofer_id,
        'chofer_nombre', v_chofer_nombre,
        'unidad_liberada', v_prev_unidad_id,
        'tractor_liberado', v_prev_tractor,
        'usuario', p_usuario
    );
END;
$function$;

-- 3. Conceder permisos de ejecución a los roles Supabase
GRANT EXECUTE ON FUNCTION public.fn_asignar_unidad_chofer(uuid, uuid, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_desunir_unidad_chofer(uuid, text) TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
