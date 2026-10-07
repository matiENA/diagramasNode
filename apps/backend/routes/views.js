/**
 * routes/views.js
 * Router de Vistas Relacionales de PostgreSQL (pg client)
 * 
 * Expone endpoints REST optimizados de solo lectura directamente conectados
 * al connection pool nativo de PostgreSQL (utils/db.js).
 * 
 * Vistas soportadas:
 *   1. GET /api/views/diaria       -> public.view_diaria_operativa
 *   2. GET /api/views/cards        -> public.view_cards_diarias
 *   3. GET /api/views/flota        -> public.view_flota_operativa
 *   4. GET /api/views/diagrama     -> public.view_diagrama_mensual
 *   5. GET /api/views/inducciones  -> public.view_inducciones_recientes
 *   6. GET /api/views/retorno      -> public.view_personal_retorno / fn_personal_retorno
 */

const express = require('express');
const db = require('../utils/db');

module.exports = function createViewsRouter() {
    const router = express.Router();

    // 1. GET /api/views/diaria — Vista Diaria Operativa de Choferes
    router.get('/diaria', async (req, res) => {
        const t0 = Date.now();
        try {
            if (!db.isConfigured()) {
                return res.status(503).json({ success: false, error: "PostgreSQL no configurado" });
            }

            const { limit = 50, offset = 0, servicio, alerta, search } = req.query;
            const limitNum = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
            const offsetNum = Math.max(parseInt(offset, 10) || 0, 0);

            const conditions = [];
            const params = [];

            if (servicio && servicio !== 'TODOS') {
                params.push(servicio.trim().toUpperCase());
                conditions.push(`UPPER(servicio) = $${params.length}`);
            }

            if (alerta === 'DOCS_VENCIDOS') {
                conditions.push(`alerta_docs_chofer = 'VENCIDO'`);
            } else if (alerta === 'UNIDAD_VENCIDA') {
                conditions.push(`alerta_docs_unidad = 'VENCIDO'`);
            } else if (alerta === 'CUALQUIER_ALERTA') {
                conditions.push(`(alerta_docs_chofer IN ('VENCIDO', 'POR_VENCER') OR alerta_docs_unidad IN ('VENCIDO', 'POR_VENCER'))`);
            }

            if (search && search.trim().length > 0) {
                params.push(`%${search.trim().toLowerCase()}%`);
                const idx = params.length;
                conditions.push(`(
                    LOWER(nombre) LIKE $${idx} OR 
                    LOWER(COALESCE(legajo, '')) LIKE $${idx} OR 
                    LOWER(COALESCE(dni, '')) LIKE $${idx} OR 
                    LOWER(COALESCE(tractor, '')) LIKE $${idx} OR 
                    LOWER(COALESCE(semi, '')) LIKE $${idx} OR 
                    LOWER(COALESCE(n_ute, '')) LIKE $${idx}
                )`);
            }

            const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

            // Conteo total para paginación
            const countQuery = `SELECT COUNT(*) AS total FROM public.view_diaria_operativa ${whereClause}`;
            const countRes = await db.query(countQuery, params);
            const total = parseInt(countRes.rows[0]?.total || '0', 10);

            // Consulta paginada
            params.push(limitNum);
            const limitIdx = params.length;
            params.push(offsetNum);
            const offsetIdx = params.length;

            const dataQuery = `
                SELECT * FROM public.view_diaria_operativa 
                ${whereClause}
                ORDER BY nombre ASC
                LIMIT $${limitIdx} OFFSET $${offsetIdx}
            `;
            const dataRes = await db.query(dataQuery, params);

            res.json({
                success: true,
                vista: "public.view_diaria_operativa",
                latenciaMs: Date.now() - t0,
                paginacion: {
                    total,
                    limit: limitNum,
                    offset: offsetNum,
                    retornados: dataRes.rows.length,
                    hay_mas: (offsetNum + dataRes.rows.length) < total
                },
                datos: dataRes.rows
            });

        } catch (err) {
            console.error("❌ Error en GET /api/views/diaria:", err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // 2. GET /api/views/cards — Feed de Novedades y Cards Diarias
    router.get('/cards', async (req, res) => {
        const t0 = Date.now();
        try {
            if (!db.isConfigured()) {
                return res.status(503).json({ success: false, error: "PostgreSQL no configurado" });
            }

            const { limit = 20, offset = 0, estado, servicio, tipo, search } = req.query;
            const limitNum = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 200);
            const offsetNum = Math.max(parseInt(offset, 10) || 0, 0);

            const conditions = [];
            const params = [];

            if (estado === 'pendientes') {
                conditions.push(`resuelto = false`);
            } else if (estado === 'resueltas') {
                conditions.push(`resuelto = true`);
            }

            if (servicio && servicio !== 'TODOS') {
                params.push(servicio.trim().toUpperCase());
                conditions.push(`UPPER(COALESCE(servicio, '')) = $${params.length}`);
            }

            if (tipo && tipo !== 'TODOS') {
                params.push(tipo.trim());
                conditions.push(`tipo = $${params.length}`);
            }

            if (search && search.trim().length > 0) {
                params.push(`%${search.trim().toLowerCase()}%`);
                const idx = params.length;
                conditions.push(`(
                    LOWER(COALESCE(chofer_nombre, '')) LIKE $${idx} OR 
                    LOWER(COALESCE(tractor, '')) LIKE $${idx} OR 
                    LOWER(COALESCE(n_ute, '')) LIKE $${idx} OR 
                    LOWER(COALESCE(detalle, '')) LIKE $${idx}
                )`);
            }

            const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

            // Conteo total
            const countQuery = `SELECT COUNT(*) AS total FROM public.view_cards_diarias ${whereClause}`;
            const countRes = await db.query(countQuery, params);
            const total = parseInt(countRes.rows[0]?.total || '0', 10);

            // Consulta paginada ordenada por fecha objetivo y creación
            params.push(limitNum);
            const limitIdx = params.length;
            params.push(offsetNum);
            const offsetIdx = params.length;

            const dataQuery = `
                SELECT * FROM public.view_cards_diarias 
                ${whereClause}
                ORDER BY fecha DESC NULLS LAST, creado_el DESC
                LIMIT $${limitIdx} OFFSET $${offsetIdx}
            `;
            const dataRes = await db.query(dataQuery, params);

            res.json({
                success: true,
                vista: "public.view_cards_diarias",
                latenciaMs: Date.now() - t0,
                paginacion: {
                    total,
                    limit: limitNum,
                    offset: offsetNum,
                    retornados: dataRes.rows.length,
                    hay_mas: (offsetNum + dataRes.rows.length) < total
                },
                datos: dataRes.rows
            });

        } catch (err) {
            console.error("❌ Error en GET /api/views/cards:", err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // 3. GET /api/views/flota — Catálogo de Flota Operativa y Vencimientos
    router.get('/flota', async (req, res) => {
        const t0 = Date.now();
        try {
            if (!db.isConfigured()) {
                return res.status(503).json({ success: false, error: "PostgreSQL no configurado" });
            }

            const { search } = req.query;
            const conditions = [];
            const params = [];

            if (search && search.trim().length > 0) {
                params.push(`%${search.trim().toLowerCase()}%`);
                const idx = params.length;
                conditions.push(`(
                    LOWER(COALESCE(tractor, '')) LIKE $${idx} OR 
                    LOWER(COALESCE(semi, '')) LIKE $${idx} OR 
                    LOWER(COALESCE(chofer_nombre, '')) LIKE $${idx} OR 
                    LOWER(COALESCE(dia_diagrama, '')) LIKE $${idx}
                )`);
            }

            const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
            const dataQuery = `
                SELECT * FROM public.view_flota_operativa 
                ${whereClause}
                ORDER BY tractor ASC NULLS LAST, semi ASC NULLS LAST
            `;
            const dataRes = await db.query(dataQuery, params);

            res.json({
                success: true,
                vista: "public.view_flota_operativa",
                latenciaMs: Date.now() - t0,
                total: dataRes.rows.length,
                datos: dataRes.rows
            });

        } catch (err) {
            console.error("❌ Error en GET /api/views/flota:", err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // 4. GET /api/views/diagrama — Grilla Operativa Mensual
    router.get('/diagrama', async (req, res) => {
        const t0 = Date.now();
        try {
            if (!db.isConfigured()) {
                return res.status(503).json({ success: false, error: "PostgreSQL no configurado" });
            }

            const { mesTab = 'Sep-26', servicio, search, limit = 500 } = req.query;
            const limitNum = Math.min(Math.max(parseInt(limit, 10) || 500, 1), 1000);

            const conditions = [`mes_tab = $1`];
            const params = [mesTab.trim()];

            if (servicio && servicio !== 'TODOS') {
                params.push(servicio.trim().toUpperCase());
                conditions.push(`UPPER(COALESCE(servicio, '')) = $${params.length}`);
            }

            if (search && search.trim().length > 0) {
                params.push(`%${search.trim().toLowerCase()}%`);
                const idx = params.length;
                conditions.push(`(
                    LOWER(COALESCE(chofer_nombre, '')) LIKE $${idx} OR 
                    LOWER(COALESCE(legajo, '')) LIKE $${idx} OR 
                    LOWER(COALESCE(tractor, '')) LIKE $${idx}
                )`);
            }

            params.push(limitNum);
            const limitIdx = params.length;

            const dataQuery = `
                SELECT * FROM public.view_diagrama_mensual 
                WHERE ${conditions.join(' AND ')}
                ORDER BY chofer_nombre ASC
                LIMIT $${limitIdx}
            `;
            const dataRes = await db.query(dataQuery, params);

            res.json({
                success: true,
                vista: "public.view_diagrama_mensual",
                mes_tab: mesTab,
                latenciaMs: Date.now() - t0,
                total: dataRes.rows.length,
                datos: dataRes.rows
            });

        } catch (err) {
            console.error("❌ Error en GET /api/views/diagrama:", err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // 5. GET /api/views/inducciones — Inducciones y Nuevos Ingresos
    router.get('/inducciones', async (req, res) => {
        const t0 = Date.now();
        try {
            if (!db.isConfigured()) {
                return res.status(503).json({ success: false, error: "PostgreSQL no configurado" });
            }

            const { limit = 50, offset = 0, search } = req.query;
            const limitNum = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
            const offsetNum = Math.max(parseInt(offset, 10) || 0, 0);

            const conditions = [];
            const params = [];

            if (search && search.trim().length > 0) {
                params.push(`%${search.trim().toLowerCase()}%`);
                const idx = params.length;
                conditions.push(`(
                    LOWER(COALESCE(chofer_nombre, '')) LIKE $${idx} OR 
                    LOWER(COALESCE(servicio, '')) LIKE $${idx} OR 
                    LOWER(COALESCE(detalle, '')) LIKE $${idx}
                )`);
            }

            const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

            params.push(limitNum);
            const limitIdx = params.length;
            params.push(offsetNum);
            const offsetIdx = params.length;

            const dataQuery = `
                SELECT * FROM public.view_inducciones_recientes 
                ${whereClause}
                ORDER BY fecha_induccion DESC NULLS LAST, creado_el DESC
                LIMIT $${limitIdx} OFFSET $${offsetIdx}
            `;
            const dataRes = await db.query(dataQuery, params);

            res.json({
                success: true,
                vista: "public.view_inducciones_recientes",
                latenciaMs: Date.now() - t0,
                total: dataRes.rows.length,
                datos: dataRes.rows
            });

        } catch (err) {
            console.error("❌ Error en GET /api/views/inducciones:", err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // 6. GET /api/views/retorno — Personal que Retorna (Hoy / Mañana / Quiebres)
    router.get('/retorno', async (req, res) => {
        const t0 = Date.now();
        try {
            if (!db.isConfigured()) {
                return res.status(503).json({ success: false, error: "PostgreSQL no configurado" });
            }

            const { fecha, tipo, servicio, search } = req.query;
            const params = [];
            const conditions = [];

            // 1. Origen de datos: si se provee una fecha específica válida (YYYY-MM-DD), usamos fn_personal_retorno($1::date)
            let fromSource = 'public.view_personal_retorno';
            let fechaEvaluada = null;

            if (fecha && /^\d{4}-\d{2}-\d{2}$/.test(fecha.trim())) {
                params.push(fecha.trim());
                fromSource = `public.fn_personal_retorno($${params.length}::date)`;
                fechaEvaluada = fecha.trim();
            }

            // 2. Filtro por tipo de retorno (HOY, MANANA o TODOS)
            if (tipo && ['HOY', 'MANANA'].includes(tipo.trim().toUpperCase())) {
                params.push(tipo.trim().toUpperCase());
                conditions.push(`retorna_cuando = $${params.length}`);
            }

            // 3. Filtro por servicio
            if (servicio && servicio !== 'TODOS') {
                params.push(servicio.trim().toUpperCase());
                conditions.push(`UPPER(COALESCE(servicio, '')) = $${params.length}`);
            }

            // 4. Búsqueda por texto (nombre, legajo, dni, tractor, n_ute)
            if (search && search.trim().length > 0) {
                params.push(`%${search.trim().toLowerCase()}%`);
                const idx = params.length;
                conditions.push(`(
                    LOWER(COALESCE(nombre, '')) LIKE $${idx} OR 
                    LOWER(COALESCE(legajo, '')) LIKE $${idx} OR 
                    LOWER(COALESCE(dni, '')) LIKE $${idx} OR 
                    LOWER(COALESCE(tractor, '')) LIKE $${idx} OR 
                    LOWER(COALESCE(n_ute, '')) LIKE $${idx}
                )`);
            }

            const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

            const dataQuery = `
                SELECT * FROM ${fromSource}
                ${whereClause}
                ORDER BY retorna_cuando ASC, nombre ASC
            `;

            const dataRes = await db.query(dataQuery, params);
            const rows = dataRes.rows || [];

            const vuelvenHoy = rows.filter(r => r.retorna_cuando === 'HOY').length;
            const vuelvenManana = rows.filter(r => r.retorna_cuando === 'MANANA').length;

            res.json({
                success: true,
                vista: "public.view_personal_retorno",
                fecha_evaluada: fechaEvaluada || new Date().toISOString().split('T')[0],
                latenciaMs: Date.now() - t0,
                total: rows.length,
                resumen: {
                    vuelven_hoy: vuelvenHoy,
                    vuelven_manana: vuelvenManana
                },
                datos: rows
            });

        } catch (err) {
            console.error("❌ Error en GET /api/views/retorno:", err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // 7. GET /api/views/catalogo-choferes — Catálogo ligero de choferes para navegación
    router.get('/catalogo-choferes', async (req, res) => {
        const t0 = Date.now();
        try {
            if (!db.isConfigured()) {
                return res.status(503).json({ success: false, error: "PostgreSQL no configurado" });
            }

            const dataRes = await db.query(`
                SELECT chofer_id, nombre, legajo, dni, servicio, foto, telefono, estado_chofer
                FROM public.view_individual_chofer
                ORDER BY nombre ASC
            `);

            res.json({
                success: true,
                vista: "public.view_individual_chofer (lite)",
                latenciaMs: Date.now() - t0,
                total: dataRes.rows.length,
                datos: dataRes.rows.map(c => ({
                    ...c,
                    id: c.chofer_id,
                    c_servicio: c.servicio,
                    estado: c.estado_chofer
                }))
            });
        } catch (err) {
            console.error("❌ Error en GET /api/views/catalogo-choferes:", err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // 8. GET /api/views/individual/:choferId — Ficha individual completa Chofer + Unidad + Vencimientos
    router.get('/individual/:choferId', async (req, res) => {
        const t0 = Date.now();
        try {
            if (!db.isConfigured()) {
                return res.status(503).json({ success: false, error: "PostgreSQL no configurado" });
            }

            const { choferId } = req.params;
            const dataRes = await db.query(`
                SELECT * FROM public.view_individual_chofer
                WHERE chofer_id::text = $1 OR legajo = $1
                LIMIT 1
            `, [choferId]);

            if (dataRes.rows.length === 0) {
                return res.status(404).json({ success: false, error: `Chofer ${choferId} no encontrado` });
            }

            res.json({
                success: true,
                vista: "public.view_individual_chofer",
                latenciaMs: Date.now() - t0,
                dato: dataRes.rows[0]
            });
        } catch (err) {
            console.error("❌ Error en GET /api/views/individual:", err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // 9. GET /api/views/calendario/:choferId — Calendario Diagrama + KMs agregados
    router.get('/calendario/:choferId', async (req, res) => {
        const t0 = Date.now();
        try {
            if (!db.isConfigured()) {
                return res.status(503).json({ success: false, error: "PostgreSQL no configurado" });
            }

            const { choferId } = req.params;
            const { zoom = '3', anio, tabs } = req.query;

            let sql = `
                SELECT diagrama_id, chofer_id, mes_tab, anio, mes_numero, tira_dias, contabilizador, km_mes_total, cant_viajes_mes, dias_km
                FROM public.view_calendario_diagrama_km
                WHERE chofer_id::text = $1
            `;
            const params = [choferId];

            if (tabs) {
                const tabList = tabs.split(',').map(t => t.trim());
                params.push(tabList);
                sql += ` AND mes_tab = ANY($${params.length})`;
            } else if (anio) {
                params.push(parseInt(anio, 10));
                sql += ` AND anio = $${params.length}`;
            }

            sql += ` ORDER BY anio ASC, mes_numero ASC`;

            const dataRes = await db.query(sql, params);

            res.json({
                success: true,
                vista: "public.view_calendario_diagrama_km",
                latenciaMs: Date.now() - t0,
                total: dataRes.rows.length,
                datos: dataRes.rows
            });
        } catch (err) {
            console.error("❌ Error en GET /api/views/calendario:", err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // 10. GET /api/views/movimientos — Vista Unificada de Movimientos (Unidad + Chofer Actual)
    router.get('/movimientos', async (req, res) => {
        const t0 = Date.now();
        try {
            if (!db.isConfigured()) {
                return res.status(503).json({ success: false, error: "PostgreSQL no configurado" });
            }

            const { limit = 100, offset = 0, servicio, estado, search } = req.query;
            const limitNum = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
            const offsetNum = Math.max(parseInt(offset, 10) || 0, 0);

            const conditions = [];
            const params = [];

            if (servicio && servicio !== 'TODOS') {
                params.push(servicio.trim().toUpperCase());
                conditions.push(`(UPPER(COALESCE(servicio_unidad, '')) = $${params.length} OR UPPER(COALESCE(chofer_servicio, '')) = $${params.length})`);
            }

            if (estado && estado !== 'TODOS') {
                params.push(estado.trim().toLowerCase());
                conditions.push(`(LOWER(COALESCE(unidad_estado, '')) = $${params.length} OR LOWER(COALESCE(chofer_estado, '')) = $${params.length})`);
            }

            if (search && search.trim().length > 0) {
                params.push(`%${search.trim().toLowerCase()}%`);
                const idx = params.length;
                conditions.push(`(
                    LOWER(COALESCE(chofer_nombre, '')) LIKE $${idx} OR 
                    LOWER(COALESCE(chofer_legajo, '')) LIKE $${idx} OR 
                    LOWER(COALESCE(chofer_dni, '')) LIKE $${idx} OR 
                    LOWER(COALESCE(tractor, '')) LIKE $${idx} OR 
                    LOWER(COALESCE(semi, '')) LIKE $${idx} OR 
                    LOWER(COALESCE(n_ute, '')) LIKE $${idx}
                )`);
            }

            const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

            // Conteo total
            const countQuery = `SELECT COUNT(*) AS total FROM public.view_movimientos ${whereClause}`;
            const countRes = await db.query(countQuery, params);
            const total = parseInt(countRes.rows[0]?.total || '0', 10);

            // Consulta paginada
            params.push(limitNum);
            const limitIdx = params.length;
            params.push(offsetNum);
            const offsetIdx = params.length;

            const dataQuery = `
                SELECT * FROM public.view_movimientos 
                ${whereClause}
                ORDER BY NULLIF(regexp_replace(n_ute, '[^0-9]', '', 'g'), '')::int ASC NULLS LAST, tractor ASC NULLS LAST
                LIMIT $${limitIdx} OFFSET $${offsetIdx}
            `;
            const dataRes = await db.query(dataQuery, params);

            res.json({
                success: true,
                vista: "public.view_movimientos",
                latenciaMs: Date.now() - t0,
                paginacion: {
                    total,
                    limit: limitNum,
                    offset: offsetNum,
                    retornados: dataRes.rows.length,
                    hay_mas: (offsetNum + dataRes.rows.length) < total
                },
                datos: dataRes.rows
            });
        } catch (err) {
            console.error("❌ Error en GET /api/views/movimientos:", err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    return router;
};
