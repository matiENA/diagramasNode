-- ==============================================================
-- 🚀 MIGRACIÓN 005: ÍNDICES DE RENDIMIENTO + PAREO ATÓMICO (ACID)
-- ==============================================================
-- Fecha: 2026-10-24
-- Propósito: 
-- 1. Crear índices en claves foráneas sin indexar para evitar Seq Scans y Table Locks
-- 2. Procedimientos RPC atómicos para Asignación y Desunión (Pareo) cumpliendo ACID
-- ==============================================================

-- 1. ÍNDICES EN TABLAS PUBLIC (EOR)
CREATE INDEX IF NOT EXISTS idx_choferes_unidad_id 
    ON public.choferes(unidad_id) 
    WHERE unidad_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_chofer_obs_unidad_id 
    ON public.chofer_observaciones(unidad_id) 
    WHERE unidad_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_novedades_terminal_id 
    ON public.novedades(terminal_id) 
    WHERE terminal_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_novedades_creado_por_id 
    ON public.novedades(creado_por_id) 
    WHERE creado_por_id IS NOT NULL;

-- 2. ÍNDICES EN TABLAS PANOL (TALLER / PAÑOL)
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'panol') THEN
        CREATE INDEX IF NOT EXISTS idx_panol_orders_tractor_id ON panol.orders(tractor_id) WHERE tractor_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_panol_orders_semi_id ON panol.orders(semi_id) WHERE semi_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_panol_orders_staff_id ON panol.orders(panol_staff_id) WHERE panol_staff_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_panol_orders_parent_id ON panol.orders(parent_order_id) WHERE parent_order_id IS NOT NULL;

        CREATE INDEX IF NOT EXISTS idx_panol_staff_holds_wo_id ON panol.staff_holds(work_order_id) WHERE work_order_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_panol_staff_holds_tractor_id ON panol.staff_holds(tractor_id) WHERE tractor_id IS NOT NULL;
        CREATE INDEX IF NOT EXISTS idx_panol_staff_holds_semi_id ON panol.staff_holds(semi_id) WHERE semi_id IS NOT NULL;

        CREATE INDEX IF NOT EXISTS idx_panol_stock_mov_performed_by ON panol.stock_movements(performed_by) WHERE performed_by IS NOT NULL;
    END IF;
END $$;

-- ==============================================================
-- 3. PROCEDIMIENTOS ALMACENADOS ATÓMICOS PARA PAREO (ACID)
-- ==============================================================

-- 3.A. Función Atómica: Asignar Unidad a Chofer
CREATE OR REPLACE FUNCTION public.fn_asignar_unidad_chofer(
    p_chofer_id uuid,
    p_unidad_id uuid,
    p_usuario text DEFAULT 'OPERADOR'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_prev_chofer_id uuid;
    v_chofer_nombre text;
    v_ute text;
BEGIN
    IF p_chofer_id IS NULL OR p_unidad_id IS NULL THEN
        RAISE EXCEPTION 'p_chofer_id y p_unidad_id son obligatorios para la asignación';
    END IF;

    -- 1. Si otro chofer tenía asignada esta unidad, liberarlo en la misma transacción
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

    SELECT n_ute INTO v_ute FROM public.unidades WHERE id = p_unidad_id;

    RETURN jsonb_build_object(
        'success', true,
        'accion', 'asignacion',
        'chofer_id', p_chofer_id,
        'chofer_nombre', v_chofer_nombre,
        'unidad_id', p_unidad_id,
        'n_ute', v_ute,
        'usuario', p_usuario,
        'liberado_previo', v_prev_chofer_id
    );
END;
$$;

-- 3.B. Función Atómica: Desunir Unidad de Chofer
CREATE OR REPLACE FUNCTION public.fn_desunir_unidad_chofer(
    p_chofer_id uuid,
    p_usuario text DEFAULT 'OPERADOR'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_prev_unidad_id uuid;
    v_chofer_nombre text;
BEGIN
    IF p_chofer_id IS NULL THEN
        RAISE EXCEPTION 'p_chofer_id es obligatorio para la desunión';
    END IF;

    -- Obtener unidad actual con bloqueo pesimista
    SELECT unidad_id, nombre INTO v_prev_unidad_id, v_chofer_nombre
    FROM public.choferes
    WHERE id = p_chofer_id
    FOR UPDATE;

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

    RETURN jsonb_build_object(
        'success', true,
        'accion', 'desunion',
        'chofer_id', p_chofer_id,
        'chofer_nombre', v_chofer_nombre,
        'unidad_liberada', v_prev_unidad_id,
        'usuario', p_usuario
    );
END;
$$;

-- Permisos de ejecución para clientes autenticados y anónimos (si procede)
GRANT EXECUTE ON FUNCTION public.fn_asignar_unidad_chofer(uuid, uuid, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fn_desunir_unidad_chofer(uuid, text) TO anon, authenticated, service_role;
