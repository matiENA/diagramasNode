/**
 * scripts/setup-view-diaria.js
 * Crea la vista optimizada de PostgreSQL 'public.view_diaria_operativa'
 * para la Grilla Operativa Diaria de Choferes.
 */

require('dotenv').config();
const db = require('../utils/db');

async function run() {
    console.log('===============================================================');
    console.log('⚡ CREANDO VISTA: public.view_diaria_operativa EN SUPABASE');
    console.log('===============================================================\n');

    if (!db.isConfigured()) {
        throw new Error('DATABASE_URL no configurada en .env');
    }

    await db.query(`
        CREATE OR REPLACE VIEW public.view_diaria_operativa AS
        SELECT 
            c.id AS chofer_id,
            c.nombre,
            cd.dni,
            c.legajo,
            cd.telefono,
            COALESCE(sc.denominacion, 'GENERAL') AS servicio,
            c.estado AS estado_chofer,
            c.foto,
            -- Asignación de unidad
            u.id AS unidad_id,
            u.n_ute,
            t.patente AS tractor,
            s.patente AS semi,
            -- Vencimientos de la unidad
            t.vtv AS vtv_tr,
            t.mas AS mas_tr,
            s.vtv AS vtv_semi,
            s.mas AS mas_semi,
            -- Vencimientos de documentación del chofer
            cd.venc_periodico,
            cd.venc_licencia_nacional,
            cd.venc_cargas_peligrosas,
            cd.apto_medico_venc,
            COALESCE(cd.apto_medico_estado, 'Activo') AS apto_medico_estado,
            -- Alertas precomputadas
            CASE 
                WHEN (cd.venc_periodico IS NOT NULL AND cd.venc_periodico < CURRENT_DATE)
                  OR (cd.venc_licencia_nacional IS NOT NULL AND cd.venc_licencia_nacional < CURRENT_DATE)
                  OR (cd.venc_cargas_peligrosas IS NOT NULL AND cd.venc_cargas_peligrosas < CURRENT_DATE)
                  OR (cd.apto_medico_venc IS NOT NULL AND cd.apto_medico_venc < CURRENT_DATE)
                THEN 'VENCIDO'
                WHEN (cd.venc_periodico IS NOT NULL AND cd.venc_periodico <= CURRENT_DATE + INTERVAL '30 days')
                  OR (cd.venc_licencia_nacional IS NOT NULL AND cd.venc_licencia_nacional <= CURRENT_DATE + INTERVAL '30 days')
                  OR (cd.venc_cargas_peligrosas IS NOT NULL AND cd.venc_cargas_peligrosas <= CURRENT_DATE + INTERVAL '30 days')
                  OR (cd.apto_medico_venc IS NOT NULL AND cd.apto_medico_venc <= CURRENT_DATE + INTERVAL '30 days')
                THEN 'POR_VENCER'
                ELSE 'AL_DIA'
            END AS alerta_docs_chofer,
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
            END AS alerta_docs_unidad,
            -- Día activo / último registrado del diagrama (Opción C)
            COALESCE(diag.dia_codigo, '-') AS dia_codigo,
            COALESCE(diag.dia_fecha, CURRENT_DATE::text) AS dia_fecha,
            diag.diagrama_tipo,
            c.actualizado_el
        FROM public.choferes c
        LEFT JOIN public.chofer_documentacion cd ON cd.chofer_id = c.id
        LEFT JOIN public.servicios_choferes sc ON c.servicio_id = sc.id
        LEFT JOIN public.unidades u ON c.unidad_id = u.id
        LEFT JOIN public.tractores t ON u.tractor_id = t.id
        LEFT JOIN public.semis s ON u.semi_id = s.id
        LEFT JOIN LATERAL (
            SELECT 
                COALESCE(
                    NULLIF(NULLIF(d.dias ->> CURRENT_DATE::text, '-'), ''),
                    (
                        SELECT kv.value 
                        FROM jsonb_each_text(d.dias) kv
                        WHERE kv.value NOT IN ('-', '', 'null', '0')
                        ORDER BY kv.key DESC 
                        LIMIT 1
                    ),
                    '-'
                ) AS dia_codigo,
                COALESCE(
                    CASE WHEN d.dias ->> CURRENT_DATE::text NOT IN ('-', '', 'null') THEN CURRENT_DATE::text ELSE NULL END,
                    (
                        SELECT kv.key 
                        FROM jsonb_each_text(d.dias) kv
                        WHERE kv.value NOT IN ('-', '', 'null', '0')
                        ORDER BY kv.key DESC 
                        LIMIT 1
                    ),
                    CURRENT_DATE::text
                ) AS dia_fecha,
                d.diagrama_tipo
            FROM public.diagramas d
            WHERE d.chofer_id = c.id
            ORDER BY d.anio DESC, d.mes_numero DESC
            LIMIT 1
        ) diag ON true
        WHERE LOWER(TRIM(c.nombre)) NOT IN (
            'campo', 'abast', 'glp', 'grales', 'grales.', 'liviano', 
            'metanol', 'pasivo en base', 'ypf', 'apellido y nombre', 
            'personal activo', 'chofer', 'choferes', 'vacante', '-', '1'
        ) AND LENGTH(TRIM(c.nombre)) > 2
        ORDER BY c.nombre ASC;
    `);

    console.log('✅ Vista public.view_diaria_operativa creada con éxito en PostgreSQL.');

    // Verificamos consultando las primeras 2 filas
    const res = await db.query('SELECT chofer_id, nombre, legajo, servicio, tractor, semi, alerta_docs_chofer, alerta_docs_unidad FROM public.view_diaria_operativa LIMIT 2');
    console.log('\n🔍 Verificación de datos (primeras 2 filas):');
    console.table(res.rows);

    process.exit(0);
}

run().catch(err => {
    console.error('❌ Error creando la vista:', err);
    process.exit(1);
});
