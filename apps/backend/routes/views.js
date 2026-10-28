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

module.exports = function createViewsRouter(hotRam = require('../cache/hotRamManager')) {
    const router = express.Router();

    // 0. GET /api/views/diaria-km — Kilómetros del día para la Vista Diaria (Hot RAM O(1) < 1ms)
    router.get('/diaria-km', async (req, res) => {
        const t0 = Date.now();
        try {
            const fecha = req.query.fecha || new Date().toISOString().split('T')[0];

            // ⚡ 1. Servicio Hot RAM (< 1ms, 0 Egress)
            if (hotRam && hotRam.isReady) {
                res.set('Cache-Control', 'public, max-age=15, stale-while-revalidate=60');
                const etag = hotRam.getEtag();
                res.set('ETag', etag);

                const data = hotRam.getDiariaKm(fecha);
                if (data) {
                    return res.json({
                        success: true,
                        fuente: "HOT_RAM",
                        latenciaMs: Date.now() - t0,
                        fecha,
                        count: data.length,
                        data
                    });
                }
            }

            if (!db.isConfigured()) {
                return res.status(503).json({ success: false, error: "PostgreSQL no configurado" });
            }

            // 2. Fallback SQL O(1) indexado por (anio, mes_numero) + JSONB key lookup
            const r = await db.query('SELECT * FROM public.fn_km_por_fecha($1::date)', [fecha]);
            return res.json({
                success: true,
                fuente: "POSTGRES",
                latenciaMs: Date.now() - t0,
                fecha,
                count: r.rows.length,
                data: r.rows
            });
        } catch (err) {
            console.error("❌ Error en /api/views/diaria-km:", err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // 1. GET /api/views/diaria — Vista Diaria Operativa de Choferes
    router.get('/diaria', async (req, res) => {
        const t0 = Date.now();
        try {
            // ⚡ 1. Servicio Hot RAM (< 3ms) con soporte ETag HTTP 304
            if (hotRam && hotRam.isReady) {
                res.set('Cache-Control', 'public, max-age=10, must-revalidate');
                const etag = hotRam.getEtag();
                res.set('ETag', etag);

                const clientEtag = req.headers['if-none-match'];
                if (clientEtag && (clientEtag === etag || clientEtag === `W/${etag}`)) {
                    return res.status(304).end();
                }

                const result = hotRam.queryDiaria(req.query);
                return res.json({
                    success: true,
                    vista: "public.view_diaria_operativa (HOT_RAM)",
                    latenciaMs: Date.now() - t0,
                    paginacion: {
                        total: result.total,
                        limit: result.limit,
                        offset: result.offset,
                        retornados: result.retornados,
                        hay_mas: result.hay_mas
                    },
                    datos: result.datos
                });
            }

            if (!db.isConfigured()) {
                return res.status(503).json({ success: false, error: "PostgreSQL no configurado" });
            }

            const { limit = 50, offset = 0, servicio, alerta, search } = req.query;
            const limitNum = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
            const offsetNum = Math.max(parseInt(offset, 10) || 0, 0);

            const conditions = [];
            const params = [];

            if (servicio && servicio !== 'TODOS') {
                const sUpper = servicio.trim().toUpperCase();
                if (sUpper === 'GRALES.' || sUpper === 'GRALES') {
                    conditions.push(`UPPER(servicio) IN ('GRALES', 'GRALES.')`);
                } else {
                    params.push(sUpper);
                    conditions.push(`UPPER(servicio) = $${params.length}`);
                }
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
                const sUpper = servicio.trim().toUpperCase();
                if (sUpper === 'GRALES.' || sUpper === 'GRALES') {
                    conditions.push(`UPPER(COALESCE(servicio, '')) IN ('GRALES', 'GRALES.')`);
                } else {
                    params.push(sUpper);
                    conditions.push(`UPPER(COALESCE(servicio, '')) = $${params.length}`);
                }
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
            // ⚡ 1. Servicio Hot RAM (< 3ms) con soporte ETag HTTP 304
            if (hotRam && hotRam.isReady) {
                res.set('Cache-Control', 'public, max-age=10, must-revalidate');
                const etag = hotRam.getEtag();
                res.set('ETag', etag);

                const clientEtag = req.headers['if-none-match'];
                if (clientEtag && (clientEtag === etag || clientEtag === `W/${etag}`)) {
                    return res.status(304).end();
                }

                const datos = hotRam.queryFlota(req.query);
                return res.json({
                    success: true,
                    vista: "public.view_flota_operativa (HOT_RAM)",
                    latenciaMs: Date.now() - t0,
                    total: datos.length,
                    datos
                });
            }

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
            const { mesTab = 'Sep-26', servicio, search, limit = 500 } = req.query;

            // ⚡ 1. Servicio Hot RAM (< 3ms)
            if (hotRam && hotRam.isReady) {
                const datos = hotRam.queryDiagramaMensual(mesTab, { servicio, search, limit });
                if (datos.length > 0) {
                    res.set('Cache-Control', 'public, max-age=10, must-revalidate');
                    const etag = hotRam.getEtag();
                    res.set('ETag', etag);

                    const clientEtag = req.headers['if-none-match'];
                    if (clientEtag && (clientEtag === etag || clientEtag === `W/${etag}`)) {
                        return res.status(304).end();
                    }

                    return res.json({
                        success: true,
                        vista: "public.view_diagrama_mensual (HOT_RAM)",
                        mes_tab: mesTab,
                        latenciaMs: Date.now() - t0,
                        total: datos.length,
                        datos
                    });
                }
            }

            if (!db.isConfigured()) {
                return res.status(503).json({ success: false, error: "PostgreSQL no configurado" });
            }
            const limitNum = Math.min(Math.max(parseInt(limit, 10) || 500, 1), 1000);

            const conditions = [`mes_tab = $1`];
            const params = [mesTab.trim()];

            if (servicio && servicio !== 'TODOS') {
                const sUpper = servicio.trim().toUpperCase();
                if (sUpper === 'GRALES.' || sUpper === 'GRALES') {
                    conditions.push(`UPPER(COALESCE(servicio, '')) IN ('GRALES', 'GRALES.')`);
                } else {
                    params.push(sUpper);
                    conditions.push(`UPPER(COALESCE(servicio, '')) = $${params.length}`);
                }
            }

            if (search && search.trim().length > 0) {
                params.push(`%${search.trim().toLowerCase()}%`);
                const idx = params.length;
                conditions.push(`(
                    LOWER(COALESCE(chofer_nombre, '')) LIKE $${idx} OR 
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
            const { fecha, tipo, servicio, search } = req.query;

            // ⚡ 1. Servicio Hot RAM (< 2ms) para fecha de hoy o por defecto
            const hoyIso = new Date().toISOString().split('T')[0];
            const esFechaHoy = !fecha || fecha.trim() === hoyIso;

            if (hotRam && hotRam.isReady && esFechaHoy) {
                res.set('Cache-Control', 'public, max-age=10, must-revalidate');
                const etag = hotRam.getEtag();
                res.set('ETag', etag);

                const clientEtag = req.headers['if-none-match'];
                if (clientEtag && (clientEtag === etag || clientEtag === `W/${etag}`)) {
                    return res.status(304).end();
                }

                const result = hotRam.queryRetorno({ tipo, servicio, search });
                return res.json({
                    success: true,
                    vista: "public.view_personal_retorno (HOT_RAM)",
                    fecha_evaluada: hoyIso,
                    latenciaMs: Date.now() - t0,
                    total: result.total,
                    resumen: result.resumen,
                    datos: result.datos
                });
            }

            if (!db.isConfigured()) {
                return res.status(503).json({ success: false, error: "PostgreSQL no configurado" });
            }

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

            // 2. Filtro por tipo de retorno (HOY, MANANA / MAÑANA, 2, 3, 4 o TODOS)
            if (tipo) {
                const tUpper = tipo.trim().toUpperCase();
                if (tUpper === 'HOY') {
                    conditions.push(`retorna_cuando = 'HOY'`);
                } else if (tUpper === 'MANANA' || tUpper === 'MAÑANA') {
                    conditions.push(`retorna_cuando IN ('MANANA', 'MAÑANA')`);
                } else if (tUpper === '2' || tUpper === '2_DIAS' || tUpper === 'EN 2 DÍAS') {
                    conditions.push(`dias_para_retorno = 2`);
                } else if (tUpper === '3' || tUpper === '3_DIAS' || tUpper === 'EN 3 DÍAS') {
                    conditions.push(`dias_para_retorno = 3`);
                } else if (tUpper === '4' || tUpper === '4_DIAS' || tUpper === 'EN 4 DÍAS') {
                    conditions.push(`dias_para_retorno = 4`);
                }
            }

            // 3. Filtro por servicio
            if (servicio && servicio !== 'TODOS') {
                const sUpper = servicio.trim().toUpperCase();
                if (sUpper === 'GRALES.' || sUpper === 'GRALES') {
                    conditions.push(`UPPER(COALESCE(servicio, '')) IN ('GRALES', 'GRALES.')`);
                } else {
                    params.push(sUpper);
                    conditions.push(`UPPER(COALESCE(servicio, '')) = $${params.length}`);
                }
            }

            // 4. Búsqueda por texto (nombre, dni, tractor, n_ute)
            if (search && search.trim().length > 0) {
                params.push(`%${search.trim().toLowerCase()}%`);
                const idx = params.length;
                conditions.push(`(
                    LOWER(COALESCE(nombre, '')) LIKE $${idx} OR 
                    LOWER(COALESCE(dni, '')) LIKE $${idx} OR 
                    LOWER(COALESCE(tractor, '')) LIKE $${idx} OR 
                    LOWER(COALESCE(n_ute, '')) LIKE $${idx}
                )`);
            }

            const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

            const dataQuery = `
                SELECT * FROM ${fromSource}
                ${whereClause}
                ORDER BY fecha_retorno ASC, nombre ASC
            `;

            const dataRes = await db.query(dataQuery, params);
            const rows = dataRes.rows || [];

            const vuelvenHoy = rows.filter(r => r.retorna_cuando === 'HOY' || r.dias_para_retorno === 0).length;
            const vuelvenManana = rows.filter(r => r.retorna_cuando === 'MANANA' || r.retorna_cuando === 'MAÑANA' || r.dias_para_retorno === 1).length;
            const vuelven2Dias = rows.filter(r => r.dias_para_retorno === 2).length;
            const vuelven3Dias = rows.filter(r => r.dias_para_retorno === 3).length;
            const vuelven4Dias = rows.filter(r => r.dias_para_retorno === 4).length;

            res.json({
                success: true,
                vista: "public.view_personal_retorno",
                fecha_evaluada: fechaEvaluada || new Date().toISOString().split('T')[0],
                latenciaMs: Date.now() - t0,
                total: rows.length,
                resumen: {
                    vuelven_hoy: vuelvenHoy,
                    vuelven_manana: vuelvenManana,
                    vuelven_2dias: vuelven2Dias,
                    vuelven_3dias: vuelven3Dias,
                    vuelven_4dias: vuelven4Dias
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
            // ⚡ 1. Servicio Hot RAM (< 1ms) con soporte ETag HTTP 304
            if (hotRam && hotRam.isReady) {
                res.set('Cache-Control', 'public, max-age=10, must-revalidate');
                const etag = hotRam.getEtag();
                res.set('ETag', etag);

                const clientEtag = req.headers['if-none-match'];
                if (clientEtag && (clientEtag === etag || clientEtag === `W/${etag}`)) {
                    return res.status(304).end();
                }

                const datos = hotRam.queryCatalogoChoferes();
                return res.json({
                    success: true,
                    vista: "public.view_individual_chofer (lite, HOT_RAM)",
                    latenciaMs: Date.now() - t0,
                    total: datos.length,
                    datos
                });
            }

            if (!db.isConfigured()) {
                return res.status(503).json({ success: false, error: "PostgreSQL no configurado" });
            }

            const dataRes = await db.query(`
                SELECT chofer_id, nombre, dni, servicio, foto, telefono, estado_chofer
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
            const { choferId } = req.params;

            // ⚡ 1. Servicio Hot RAM (< 1ms)
            if (hotRam && hotRam.isReady) {
                const dato = hotRam.queryIndividualChofer(choferId);
                if (dato) {
                    return res.json({
                        success: true,
                        vista: "public.view_individual_chofer (HOT_RAM)",
                        latenciaMs: Date.now() - t0,
                        dato
                    });
                }
            }

            if (!db.isConfigured()) {
                return res.status(503).json({ success: false, error: "PostgreSQL no configurado" });
            }

            const dataRes = await db.query(`
                SELECT * FROM public.view_individual_chofer
                WHERE chofer_id::text = $1 OR dni = $1
                LIMIT 1
            `, [choferId]);

            if (dataRes.rows.length === 0) {
                return res.status(404).json({ success: false, error: `Chofer ${choferId} no encontrado` });
            }

            const choferRow = dataRes.rows[0];
            try {
                const hoy = new Date();
                const y = hoy.getFullYear(), m = hoy.getMonth(), d = hoy.getDate();
                const dDesde = d >= 26 ? new Date(y, m, 26) : new Date(y, m - 1, 26);
                const dHasta = d >= 26 ? new Date(y, m + 1, 25) : new Date(y, m, 25);
                const fIni = `${dDesde.getFullYear()}-${String(dDesde.getMonth() + 1).padStart(2, '0')}-26`;
                const fFin = `${dHasta.getFullYear()}-${String(dHasta.getMonth() + 1).padStart(2, '0')}-25`;
                const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
                choferRow.ciclo_label = `${MESES[dDesde.getMonth()]} 26 - ${MESES[dHasta.getMonth()]} 25`;
                choferRow.ciclo_desde = fIni;
                choferRow.ciclo_hasta = fFin;
            } catch (eCiclo) {
                choferRow.km_ciclo = 0;
            }

            res.json({
                success: true,
                vista: "public.view_individual_chofer",
                latenciaMs: Date.now() - t0,
                dato: choferRow
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
            const { choferId } = req.params;
            const { zoom = '3', anio, tabs } = req.query;

            // ⚡ 1. Servicio Hot RAM C1 (< 2ms) cuando el rango consultado cae en la ventana activa
            if (hotRam && hotRam.isReady && hotRam.isCalendarioInWindow({ anio, tabs })) {
                const datos = hotRam.queryCalendario(choferId, { anio, tabs });
                return res.json({
                    success: true,
                    vista: "public.view_calendario_diagrama_km (HOT_RAM_C1)",
                    latenciaMs: Date.now() - t0,
                    total: datos.length,
                    datos
                });
            }

            // ⚡ 2. Caché LRU C2 bajo demanda (10 min TTL) para zooms históricos 6M / 12M
            const c2Key = `${choferId}|${anio || ''}|${tabs || ''}`;
            if (hotRam) {
                const cachedC2 = hotRam.getCalendarioC2(c2Key);
                if (cachedC2) {
                    return res.json({
                        success: true,
                        vista: "public.view_calendario_diagrama_km (LRU_C2)",
                        latenciaMs: Date.now() - t0,
                        total: cachedC2.length,
                        datos: cachedC2
                    });
                }
            }

            if (!db.isConfigured()) {
                return res.status(503).json({ success: false, error: "PostgreSQL no configurado" });
            }

            let sql;
            let params;

            if (tabs) {
                const tabList = tabs.split(',').map(t => t.trim());
                sql = `
                    SELECT diagrama_id, chofer_id, mes_tab, anio, mes_numero, tira_dias, contabilizador, km_mes_total, cant_viajes_mes, dias_km
                    FROM public.fn_calendario_diagrama_km($1::uuid, $2::text[], NULL)
                    ORDER BY anio ASC, mes_numero ASC
                `;
                params = [choferId, tabList];
            } else if (anio) {
                sql = `
                    SELECT diagrama_id, chofer_id, mes_tab, anio, mes_numero, tira_dias, contabilizador, km_mes_total, cant_viajes_mes, dias_km
                    FROM public.fn_calendario_diagrama_km($1::uuid, NULL, $2::int)
                    ORDER BY anio ASC, mes_numero ASC
                `;
                params = [choferId, parseInt(anio, 10)];
            } else {
                sql = `
                    SELECT diagrama_id, chofer_id, mes_tab, anio, mes_numero, tira_dias, contabilizador, km_mes_total, cant_viajes_mes, dias_km
                    FROM public.fn_calendario_diagrama_km($1::uuid, NULL, NULL)
                    ORDER BY anio ASC, mes_numero ASC
                `;
                params = [choferId];
            }

            const dataRes = await db.query(sql, params);
            if (hotRam) {
                hotRam.setCalendarioC2(c2Key, dataRes.rows);
            }

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
                const sUpper = servicio.trim().toUpperCase();
                if (sUpper === 'GRALES.' || sUpper === 'GRALES') {
                    conditions.push(`(UPPER(COALESCE(servicio_unidad, '')) IN ('GRALES', 'GRALES.') OR UPPER(COALESCE(chofer_servicio, '')) IN ('GRALES', 'GRALES.'))`);
                } else {
                    params.push(sUpper);
                    conditions.push(`(UPPER(COALESCE(servicio_unidad, '')) = $${params.length} OR UPPER(COALESCE(chofer_servicio, '')) = $${params.length})`);
                }
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

    // 11. GET /api/views/badge — Conteo liviano de novedades pendientes (reemplaza HEAD PostgREST anon)
    router.get('/badge', async (req, res) => {
        const t0 = Date.now();
        try {
            const now = Date.now();
            if (hotRam && hotRam.badgeCache && (now - hotRam.badgeCache.ts) < 30000) {
                return res.json({
                    success: true,
                    fuente: "HOT_RAM",
                    latenciaMs: now - t0,
                    novedades_pendientes: hotRam.badgeCache.count
                });
            }

            if (!db.isConfigured()) {
                return res.json({ success: true, novedades_pendientes: 0 });
            }

            const r = await db.query('SELECT COUNT(*)::int AS cnt FROM public.novedades WHERE resuelto = false');
            const cnt = r.rows[0]?.cnt || 0;
            if (hotRam) {
                hotRam.badgeCache = { count: cnt, ts: now };
            }

            res.json({
                success: true,
                fuente: "POSTGRES",
                latenciaMs: Date.now() - t0,
                novedades_pendientes: cnt
            });
        } catch (err) {
            console.error("❌ Error en GET /api/views/badge:", err.message);
            res.status(500).json({ success: false, error: err.message, novedades_pendientes: 0 });
        }
    });

    // 12. GET /api/views/chofer-docs/:choferId — Documentación de chofer (Hot RAM C1 + refresco bajo demanda)
    router.get('/chofer-docs/:choferId', async (req, res) => {
        const t0 = Date.now();
        try {
            const chKey = String(req.params.choferId || '').trim();
            const forceFresh = req.query.fresh === '1';

            if (!forceFresh && hotRam && hotRam.docsPorChofer && hotRam.docsPorChofer.has(chKey)) {
                return res.json({
                    success: true,
                    fuente: "HOT_RAM_C1",
                    latenciaMs: Date.now() - t0,
                    dato: hotRam.docsPorChofer.get(chKey)
                });
            }

            if (!db.isConfigured()) {
                return res.status(503).json({ success: false, error: "PostgreSQL no configurado" });
            }

            const r = await db.query(
                'SELECT * FROM public.chofer_documentacion WHERE chofer_id::text = $1 LIMIT 1',
                [chKey]
            );
            const dato = r.rows[0] || null;
            if (hotRam && hotRam.docsPorChofer) {
                hotRam.docsPorChofer.set(chKey, dato);
            }

            res.json({
                success: true,
                fuente: "POSTGRES",
                latenciaMs: Date.now() - t0,
                dato
            });
        } catch (err) {
            console.error("❌ Error en GET /api/views/chofer-docs:", err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // 13. GET /api/views/chofer-observaciones/:choferId — Observaciones de chofer con caché LRU C2 (TTL 5 min)
    router.get('/chofer-observaciones/:choferId', async (req, res) => {
        const t0 = Date.now();
        try {
            const chKey = String(req.params.choferId || '').trim();
            const forceFresh = req.query.fresh === '1';
            const now = Date.now();

            if (!forceFresh && hotRam && hotRam.obsLru) {
                const cached = hotRam.obsLru.get(chKey);
                if (cached && (now - cached.ts) < 5 * 60 * 1000) {
                    return res.json({
                        success: true,
                        fuente: "LRU_C2",
                        latenciaMs: now - t0,
                        datos: cached.datos
                    });
                }
            }

            if (!db.isConfigured()) {
                return res.status(503).json({ success: false, error: "PostgreSQL no configurado" });
            }

            const r = await db.query(
                'SELECT * FROM public.chofer_observaciones WHERE chofer_id::text = $1 ORDER BY fecha DESC',
                [chKey]
            );
            const datos = r.rows || [];

            if (hotRam && hotRam.obsLru) {
                if (hotRam.obsLru.size >= 60 && !hotRam.obsLru.has(chKey)) {
                    const oldest = hotRam.obsLru.keys().next().value;
                    if (oldest !== undefined) hotRam.obsLru.delete(oldest);
                }
                hotRam.obsLru.set(chKey, { ts: now, datos });
            }

            res.json({
                success: true,
                fuente: "POSTGRES",
                latenciaMs: Date.now() - t0,
                datos
            });
        } catch (err) {
            console.error("❌ Error en GET /api/views/chofer-observaciones:", err.message);
            res.status(500).json({ success: false, error: err.message });
        }
    });

    return router;
};
