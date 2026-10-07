/**
 * backend/routes/movimientos.js
 * Extracción limpia de la matriz de Movimientos desde Google Sheets
 * incluyendo detección explícita de Desuniones (borrado = 1 en chofer)
 * y sincronización atómica con Supabase (public.movimientos, choferes y unidades).
 */

const express = require('express');
const db = require('../utils/db');
const {
    fetchRango,
    getTabName,
    ID_SHEET_MOVIMIENTOS,
    getFechaArgentina,
    mesesLargo
} = require('../utils/shared');

module.exports = function createMovimientosRouter() {
    const router = express.Router();

    // Caché en memoria para evitar saturar la cuota de Google Sheets (TTL: 30 segundos)
    let cacheRecorte = null;
    let cacheTimestamp = 0;
    const CACHE_TTL_MS = 30000;

    const blacklist = new Set([
        'TRACTOR', 'SEMI', 'CHOFER', 'NOMBRE', 'APELLIDO', '1', '0', '-', 'S/A', 'VACANTE',
        'FECHA', 'N°', 'CISTERNADO', 'TOTAL', 'LIVIANO', 'METANOL', 'CAMPO', 'GLP', 'SOCIO', 'OCTUBRE',
        'DESCANSO', 'FRANCO', 'VACACIONES', 'LICENCIA', 'GUARDIA', 'EN GESTION', 'DISPONIBLE'
    ]);

    async function extraerPareosYDesunionesDesdeSheets(diaParam = null) {
        const now = Date.now();
        if (!diaParam && cacheRecorte && (now - cacheTimestamp < CACHE_TTL_MS)) {
            return cacheRecorte;
        }

        const tab = await getTabName(ID_SHEET_MOVIMIENTOS, 'Mov.Unidades', 'OCTUBRE 2026- Mov.Unidades y Choferes');
        const rows = await fetchRango(ID_SHEET_MOVIMIENTOS, `'${tab}'!A1:ZZ350`);

        const hoyAr = getFechaArgentina();
        const diaHoy = diaParam ? parseInt(diaParam, 10) : hoyAr.getDate();
        // Stride canónico: Día 1 = Col 27, Día 2 = Col 40 ... Día d = 27 + 13 * (d - 1)
        const colChoferHoy = 27 + 13 * (diaHoy - 1);

        const pareos = [];
        const desuniones = [];
        let currentSrv = 'GENERAL';

        for (let i = 1; i < rows.length; i++) {
            const r = rows[i];
            if (!r || r.length === 0) continue;

            const col0 = String(r[0] || '').trim();
            const col2 = String(r[2] || '').trim();
            const col4 = String(r[4] || '').trim();
            const col5 = String(r[5] || '').trim();

            // Detección de fila cabecera de Categoría / Servicio
            if (col0 && !col2 && !col4 && !col5) {
                const up = col0.toUpperCase();
                if (!up.includes('FECHA') && !up.includes('N°') && !mesesLargo.some(m => up.includes(m.toUpperCase()))) {
                    currentSrv = up;
                }
                continue;
            }

            const tractor = col4.toUpperCase().replace(/\s+/g, '');
            const semi = col5.toUpperCase().replace(/\s+/g, '');
            const nUte = col2.replace(/[^0-9]/g, '');

            if (!tractor && !semi && !nUte) continue;
            if (tractor === 'TRACTOR' || semi === 'SEMI') continue;

            const rawChofer = colChoferHoy < r.length ? String(r[colChoferHoy] || '').trim() : '';

            // Detectar si la celda indica desunión/borrado (1, 0, vacío, S/A, vacante, etc.)
            const esDesunion = (!rawChofer || rawChofer === '1' || rawChofer === '0' || rawChofer === '-' ||
                                rawChofer.length < 3 || !/[a-zA-Z]/.test(rawChofer) || blacklist.has(rawChofer.toUpperCase()));

            if (esDesunion) {
                desuniones.push({
                    n_ute: nUte || null,
                    patente_tractor: tractor || '',
                    patente_semi: semi || '',
                    raw_chofer: rawChofer,
                    accion: 'DESUNIR',
                    dia_operativo: diaHoy
                });
            } else {
                pareos.push({
                    n_ute: nUte || null,
                    patente_tractor: tractor || '',
                    patente_semi: semi || '',
                    chofer_nombre: rawChofer.replace(/,/g, '').toUpperCase(),
                    servicio_denominacion: currentSrv,
                    accion: 'UPSERT',
                    dia_operativo: diaHoy
                });
            }
        }

        const resultado = { pareos, desuniones, diaHoy };

        if (!diaParam) {
            cacheRecorte = resultado;
            cacheTimestamp = Date.now();
        }

        return resultado;
    }

    // 1. GET /api/movimientos/recorte-diario — Para consumo en n8n u otros servicios
    router.get('/recorte-diario', async (req, res) => {
        const t0 = Date.now();
        try {
            const { dia } = req.query;
            const { pareos, desuniones, diaHoy } = await extraerPareosYDesunionesDesdeSheets(dia);

            res.json({
                success: true,
                dia_operativo: diaHoy,
                total_pareos: pareos.length,
                total_desuniones: desuniones.length,
                latenciaMs: Date.now() - t0,
                datos: pareos,
                desuniones: desuniones
            });
        } catch (err) {
            console.error('❌ Error en GET /api/movimientos/recorte-diario:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // 2. POST /api/movimientos/sync-supabase — Upsert atómico directo en Supabase con desunión
    router.post('/sync-supabase', async (req, res) => {
        const t0 = Date.now();
        try {
            if (!db.isConfigured()) {
                return res.status(503).json({ success: false, error: "PostgreSQL no configurado" });
            }

            const { dia } = req.body || {};
            const { pareos, desuniones, diaHoy } = await extraerPareosYDesunionesDesdeSheets(dia);

            // PASO 1: Resolver unidades a desunir (chofer = 1 o borrado)
            const desunionesRes = await db.query(`
                WITH desuniones_input AS (
                  SELECT * FROM jsonb_to_recordset($1::jsonb) AS d(
                    n_ute text,
                    patente_tractor text,
                    patente_semi text
                  )
                )
                SELECT DISTINCT u.id AS id_unidad
                FROM desuniones_input d
                LEFT JOIN public.tractores t ON UPPER(TRIM(t.patente)) = UPPER(TRIM(d.patente_tractor)) AND TRIM(d.patente_tractor) <> ''
                LEFT JOIN public.semis s ON UPPER(TRIM(s.patente)) = UPPER(TRIM(d.patente_semi)) AND TRIM(d.patente_semi) <> ''
                JOIN public.unidades u ON (
                  (t.id IS NOT NULL AND u.tractor_id = t.id)
                  OR (s.id IS NOT NULL AND u.semi_id = s.id)
                  OR (NULLIF(TRIM(d.n_ute), '') IS NOT NULL AND u.n_ute = TRIM(d.n_ute))
                )
            `, [JSON.stringify(desuniones)]);

            const desunirIds = desunionesRes.rows.map(r => r.id_unidad);

            // PASO 2: Resolver pareos activos válidos
            const pareosRes = await db.query(`
                WITH pareos_input AS (
                  SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(
                    n_ute text,
                    patente_tractor text,
                    patente_semi text,
                    chofer_nombre text,
                    servicio_denominacion text,
                    dia_operativo int
                  )
                ),
                resolved_raw AS (
                  SELECT
                    u.id AS id_unidad,
                    c.id AS id_chofer,
                    ROW_NUMBER() OVER (
                      PARTITION BY u.id 
                      ORDER BY (t.id IS NOT NULL AND u.tractor_id = t.id) DESC, 
                               (s.id IS NOT NULL AND u.semi_id = s.id) DESC
                    ) as rn_u
                  FROM pareos_input p
                  JOIN public.choferes c ON UPPER(TRIM(REPLACE(c.nombre, ',', ''))) = UPPER(TRIM(REPLACE(p.chofer_nombre, ',', '')))
                  LEFT JOIN public.tractores t ON UPPER(TRIM(t.patente)) = UPPER(TRIM(p.patente_tractor)) AND TRIM(p.patente_tractor) <> ''
                  LEFT JOIN public.semis s ON UPPER(TRIM(s.patente)) = UPPER(TRIM(p.patente_semi)) AND TRIM(p.patente_semi) <> ''
                  JOIN public.unidades u ON (
                    (t.id IS NOT NULL AND u.tractor_id = t.id)
                    OR (s.id IS NOT NULL AND u.semi_id = s.id)
                    OR (NULLIF(TRIM(p.n_ute), '') IS NOT NULL AND u.n_ute = TRIM(p.n_ute))
                  )
                  WHERE u.id IS NOT NULL AND c.id IS NOT NULL
                ),
                resolved_units AS (
                  SELECT id_unidad, id_chofer 
                  FROM resolved_raw 
                  WHERE rn_u = 1
                )
                SELECT DISTINCT ON (id_chofer) id_unidad, id_chofer
                FROM resolved_units
                ORDER BY id_chofer
            `, [JSON.stringify(pareos)]);

            const validPareos = pareosRes.rows;
            const activeUnitIds = validPareos.map(p => p.id_unidad);
            const activeChoferIds = validPareos.map(p => p.id_chofer);

            // PASO 3: Ejecutar desuniones (eliminar movimientos y liberar choferes)
            let desunidosDeleted = 0;
            if (desunirIds.length > 0) {
                const delDes = await db.query(`DELETE FROM public.movimientos WHERE id_unidad = ANY($1::uuid[]) RETURNING id`, [desunirIds]);
                desunidosDeleted = delDes.rowCount;

                await db.query(`
                    UPDATE public.choferes
                    SET unidad_id = NULL,
                        estado = CASE WHEN estado = 'circulando' THEN 'inactivo' ELSE estado END,
                        actualizado_el = NOW()
                    WHERE unidad_id = ANY($1::uuid[])
                `, [desunirIds]);
            }

            // PASO 4: Limpiar conflictos previos antes de insertar
            if (activeUnitIds.length > 0) {
                await db.query(`DELETE FROM public.movimientos WHERE id_unidad = ANY($1::uuid[]) OR id_chofer = ANY($2::uuid[])`, [activeUnitIds, activeChoferIds]);
            }

            // PASO 5: Insertar pareos activos
            let insertados = 0;
            if (validPareos.length > 0) {
                const insRes = await db.query(`
                    INSERT INTO public.movimientos (id_unidad, id_chofer, actualizado_el)
                    SELECT id_unidad, id_chofer, NOW()
                    FROM jsonb_to_recordset($1::jsonb) AS x(id_unidad uuid, id_chofer uuid)
                    ON CONFLICT (id_unidad) DO UPDATE SET
                      id_chofer = EXCLUDED.id_chofer,
                      actualizado_el = NOW()
                    RETURNING id
                `, [JSON.stringify(validPareos)]);
                insertados = insRes.rowCount;
            }

            res.json({
                success: true,
                estado: "✅ Sincronización y desunión completadas con éxito en Supabase",
                dia_operativo: diaHoy,
                total_procesados: pareos.length + desuniones.length,
                total_pareos_activos: pareos.length,
                total_pareos_resueltos: validPareos.length,
                desuniones_detectadas: desuniones.length,
                desuniones_aplicadas: desunidosDeleted,
                insertados: insertados,
                latenciaMs: Date.now() - t0,
                timestamp: new Date().toISOString()
            });

        } catch (err) {
            console.error('❌ Error en POST /api/movimientos/sync-supabase:', err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    return router;
};
