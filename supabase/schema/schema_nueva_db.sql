-- ==============================================================================
-- 🚀 ESQUEMA UNIFICADO DE BASE DE DATOS (SUPABASE)
-- Proyecto: https://rsvajuxihvmpmrmlcbul.supabase.co
-- Tabla principal nombrada: UNIDADES
-- ==============================================================================

-- 1. Limpieza segura de tablas anteriores si existen
DROP TABLE IF EXISTS public.movimientos CASCADE;
DROP TABLE IF EXISTS public.choferes CASCADE;
DROP TABLE IF EXISTS public.units CASCADE;
DROP TABLE IF EXISTS public.unidades CASCADE;
DROP TABLE IF EXISTS public.usuarios_auth CASCADE;

-- Extensiones
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ==============================================================================
-- 1. TABLA: unidades (Flota canónica y vencimientos)
-- ==============================================================================
CREATE TABLE public.unidades (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    n_ute TEXT,
    tractor TEXT,
    semi TEXT,
    estado TEXT DEFAULT 'disponible' CHECK (estado IN ('disponible', 'circulando', 'taller', 'mantenimiento', 'baja')),
    servicio TEXT,
    marca_tr TEXT,
    marca_semi TEXT,
    cisternado TEXT,
    mas_tr DATE,
    vtv_tr DATE,
    mas_semi DATE,
    vtv_semi DATE,
    esp_es TEXT,
    vi TEXT,
    ve TEXT
);

CREATE INDEX idx_unidades_tractor ON public.unidades(tractor);
CREATE INDEX idx_unidades_semi ON public.unidades(semi);
CREATE INDEX idx_unidades_n_ute ON public.unidades(n_ute);
CREATE INDEX idx_unidades_estado ON public.unidades(estado);
CREATE INDEX idx_unidades_servicio ON public.unidades(servicio);

-- ==============================================================================
-- 2. TABLA: choferes (Catálogo Maestro)
-- ==============================================================================
CREATE TABLE public.choferes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    nombre TEXT NOT NULL,
    dni TEXT,
    legajo TEXT,
    telefono TEXT,
    c_servicio TEXT,
    estado TEXT DEFAULT 'inactivo' CHECK (estado IN ('inactivo', 'circulando', 'franco', 'licencia', 'baja')),
    unidad_id UUID REFERENCES public.unidades(id) ON DELETE SET NULL,
    actualizado_el TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_choferes_nombre ON public.choferes(nombre);
CREATE INDEX idx_choferes_dni ON public.choferes(dni);
CREATE INDEX idx_choferes_estado ON public.choferes(estado);

-- ==============================================================================
-- 3. TABLA: movimientos (Solo id, id_unidad, id_chofer)
-- ==============================================================================
CREATE TABLE public.movimientos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    id_unidad UUID REFERENCES public.unidades(id) ON DELETE CASCADE,
    id_chofer UUID REFERENCES public.choferes(id) ON DELETE CASCADE
);

CREATE INDEX idx_mov_id_unidad ON public.movimientos(id_unidad);
CREATE INDEX idx_mov_id_chofer ON public.movimientos(id_chofer);

-- ==============================================================================
-- 4. TABLA: usuarios_auth (Login Dash)
-- ==============================================================================
CREATE TABLE public.usuarios_auth (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    usuario TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    rol TEXT DEFAULT 'operador',
    creado_el TIMESTAMPTZ DEFAULT NOW()
);

-- ==============================================================================
-- 5. POLÍTICAS DE ACCESO
-- ==============================================================================
ALTER TABLE public.unidades ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.choferes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.movimientos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.usuarios_auth ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Permitir todo en unidades" ON public.unidades;
CREATE POLICY "Permitir todo en unidades" ON public.unidades FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Permitir todo en choferes" ON public.choferes;
CREATE POLICY "Permitir todo en choferes" ON public.choferes FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Permitir todo en movimientos" ON public.movimientos;
CREATE POLICY "Permitir todo en movimientos" ON public.movimientos FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Permitir todo en usuarios_auth" ON public.usuarios_auth;
CREATE POLICY "Permitir todo en usuarios_auth" ON public.usuarios_auth FOR ALL USING (true) WITH CHECK (true);
