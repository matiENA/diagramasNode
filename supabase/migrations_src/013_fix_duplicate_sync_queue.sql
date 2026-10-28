-- ==============================================================================
-- 🚀 MIGRACIÓN 013: Eliminar inserción duplicada en eor_sync_queue
-- ==============================================================================
-- trg_sync_asignacion ya captura automáticamente el cambio en choferes.unidad_id
-- (tanto para asignación como para desasignación con carácter '1').
-- Al quitar la inserción manual redundante dentro de las funciones atómicas,
-- se elimina definitivamente la doble impresión en Google Sheets.

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
    v_chofer_nombre text;
    v_ute text;
    v_tractor text;
    v_semi text;
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

    -- 1. Si otro chofer tenía asignada esta unidad, liberarlo en la misma transacción
    -- (el trigger trg_sync_asignacion en choferes encolará la desunión para v_prev_chofer_id)
    SELECT id INTO v_prev_chofer_id
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
    END IF;

    -- 2. Limpiar movimientos previos de chofer o unidad
    DELETE FROM public.movimientos 
    WHERE id_chofer = p_chofer_id OR id_unidad = p_unidad_id;

    -- 3. Actualizar el chofer con su nueva unidad
    -- (el trigger trg_sync_asignacion en choferes encolará la asignación para p_chofer_id de forma única)
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
BEGIN
    IF p_chofer_id IS NULL THEN
        RAISE EXCEPTION 'p_chofer_id es obligatorio para la desunión';
    END IF;

    -- Obtener unidad actual con bloqueo pesimista
    SELECT c.unidad_id, c.nombre
    INTO v_prev_unidad_id, v_chofer_nombre
    FROM public.choferes c
    WHERE c.id = p_chofer_id
    FOR UPDATE;

    -- 1. Desvincular en choferes
    -- (el trigger trg_sync_asignacion en choferes encolará la desunión con carácter '1' de forma única)
    UPDATE public.choferes
    SET unidad_id = NULL,
        estado = 'inactivo',
        actualizado_por = p_usuario,
        actualizado_el = NOW()
    WHERE id = p_chofer_id;

    -- 2. Eliminar de movimientos
    DELETE FROM public.movimientos
    WHERE id_chofer = p_chofer_id OR (v_prev_unidad_id IS NOT NULL AND id_unidad = v_prev_unidad_id);

    RETURN jsonb_build_object(
        'success', true,
        'accion', 'desunion',
        'chofer_id', p_chofer_id,
        'chofer_nombre', v_chofer_nombre,
        'unidad_liberada', v_prev_unidad_id,
        'usuario', p_usuario
    );
END;
$function$;

-- Permisos
GRANT EXECUTE ON FUNCTION public.fn_asignar_unidad_chofer(uuid, uuid, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_desunir_unidad_chofer(uuid, text) TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
