-- ==============================================================
-- 🚀 MIGRACIÓN 008 (FASE P1): ACID, RLS Y PROTECCIÓN DE SESIONES
-- ==============================================================

-- 1. Prevenir transacciones colgadas o conexiones zombies en el pool authenticator
ALTER ROLE authenticator SET idle_in_transaction_session_timeout = '15s';

-- 2. Seguridad en esquema panol: Revocar acceso directo a usuarios anónimos (anon)
--    El sistema Pañol v2 se comunica a través de su backend Express dedicado
--    con Connection Pooling (pg) o autenticación de servicio.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'panol') THEN
    -- Revocar manipulación directa por rol 'anon'
    REVOKE INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA panol FROM anon;
    
    -- Asegurar que roles autenticados y de servicio mantengan permisos necesarios
    GRANT USAGE ON SCHEMA panol TO postgres, service_role, authenticated;
    GRANT ALL ON ALL TABLES IN SCHEMA panol TO postgres, service_role;
    GRANT SELECT ON ALL TABLES IN SCHEMA panol TO authenticated;
  END IF;
END $$;

-- 3. Índice para evitar bloqueos en cascada en panol.stock_movements (order_item_id / item_id)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'panol') THEN
    CREATE INDEX IF NOT EXISTS idx_stock_movements_item_status 
      ON panol.stock_movements (item_id, status);
  END IF;
END $$;
