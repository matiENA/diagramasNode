/**
 * apps/backend/routes/hotRamRoutes.js
 * 
 * Endpoints dedicados de alto rendimiento para el motor Hot RAM:
 * - /ram                               -> Estadísticas generales y métricas de memoria
 * - /ram/diagramas                     -> Ventana completa de 60 días activos en RAM (< 5ms)
 * - /ram/diagramas/chofer/:idOrNombre  -> 60 días de un chofer específico en RAM
 * - /diagramas/consulta                -> Consulta histórica/futura bajo demanda con cálculo de contabilizador en RAM
 * - /diagramas/parametros              -> Diccionario de parámetros y reglas canónicas
 * - /api/km/unidades                   -> Resumen de KM por Unidad (Hot RAM 2m + Supabase)
 * - /api/km/choferes                   -> Resumen de KM por Chofer (Hot RAM 2m + Supabase)
 */

const express = require('express');
const db = require('../utils/db');
const { normalizar } = require('../utils/shared');

function getBaseState(char) {
    if (!char) return '-';
    let s = String(char).trim().toUpperCase();
    if (s.includes('+')) {
        s = s.split('+')[0].trim();
    }
    return s;
}

function contabilizarDias(diasMap) {
    let trabajados = 0;
    let francos = 0;
    let vacaciones = 0;
    let ausencias = 0;
    let inactivos = 0;

    const entries = Object.entries(diasMap || {});
    for (const [, val] of entries) {
        if (!val || val === '-' || val === '0' || val === 'NULL' || val === 'UNDEFINED') {
            inactivos++;
            continue;
        }

        const base = getBaseState(val);

        if ((!isNaN(base) && base !== '') || base === 'O' || base === 'OPERATIVO') {
            trabajados++;
        } else if (['F', 'FSF', 'FRANCO', 'RPT'].includes(base)) {
            francos++;
        } else if (['V', 'VSF', 'VACACIONES'].includes(base)) {
            vacaciones++;
        } else if (['E', 'ART', 'IND', 'IIND', 'A', 'S', 'P', 'MED', 'SUSP', 'LIC'].some(k => base.includes(k))) {
            ausencias++;
        } else {
            inactivos++;
        }
    }

    return {
        trabajados,
        francos,
        vacaciones,
        ausencias,
        inactivos,
        total_evaluados: entries.length
    };
}

module.exports = function createHotRamRouter(hotRam = require('../cache/hotRamManager'), cacheDatosGlobales = {}) {
    const router = express.Router();

    // 1. Estado y Métricas de Hot RAM
    router.get('/ram', (req, res) => {
        const mem = process.memoryUsage();
        res.json({
            status: hotRam.isReady ? 'ready' : 'hydrating',
            timestamp: new Date().toISOString(),
            lastSync: hotRam.lastSync,
            etag: hotRam.getEtag(),
            memoria: {
                heapUsedMb: +(mem.heapUsed / 1024 / 1024).toFixed(2),
                heapTotalMb: +(mem.heapTotal / 1024 / 1024).toFixed(2),
                rssMb: +(mem.rss / 1024 / 1024).toFixed(2)
            },
            stats: {
                totalDiaria: hotRam.diaria.length,
                totalFlota: hotRam.flota.length,
                totalRetorno: hotRam.retorno.length,
                totalChoferes: hotRam.catalogoChoferes.length,
                totalCalendarios: hotRam.stats.totalCalendarios,
                totalDiagramaMes: hotRam.stats.totalDiagramaMes,
                viajesEnRam: Object.keys(cacheDatosGlobales?.diagramas?.nuevaSeccionViajes || {}).length
            }
        });
    });

    // 2. Ventana completa de 60 Días de Turnos en RAM (< 5ms)
    router.get('/ram/diagramas', (req, res) => {
        const t0 = Date.now();
        res.set('Cache-Control', 'public, max-age=10, must-revalidate');
        const etag = hotRam.getEtag();
        res.set('ETag', etag);

        const clientEtag = req.headers['if-none-match'];
        if (clientEtag && (clientEtag === etag || clientEtag === `W/${etag}`)) {
            return res.status(304).end();
        }

        // Si tenemos choferes en memoria con diagrama_json, construir ventana de 60 días
        const choferesConTurnos = hotRam.diaria.map(d => {
            const ind = hotRam.individualPorId.get(String(d.chofer_id)) || {};
            return {
                chofer_id: d.chofer_id,
                nombre: d.nombre,
                legajo: d.legajo || ind.legajo || '',
                servicio: d.servicio,
                diagrama_tipo: d.diagrama_tipo || ind.diagrama_tipo || null,
                dia_codigo: d.dia_codigo || '-',
                tractor: d.tractor || '',
                semi: d.semi || '',
                n_ute: d.n_ute || ''
            };
        });

        res.json({
            success: true,
            fuente: 'HOT_RAM_NODEJS',
            latenciaMs: Date.now() - t0,
            etag: hotRam.getEtag(),
            totalChoferes: choferesConTurnos.length,
            choferes: choferesConTurnos
        });
    });

    // 3. Ventana de 60 Días en Hot RAM para un chofer específico
    router.get('/ram/diagramas/chofer/:idOrNombre', (req, res) => {
        const t0 = Date.now();
        const { idOrNombre } = req.params;
        const norm = normalizar(decodeURIComponent(idOrNombre).trim());

        const ch = hotRam.diaria.find(c => {
            return String(c.chofer_id) === idOrNombre ||
                   normalizar(c.nombre) === norm ||
                   (c.dni && String(c.dni) === idOrNombre) ||
                   (c.legajo && String(c.legajo) === idOrNombre);
        });

        if (!ch) {
            return res.status(404).json({ success: false, error: `Chofer '${idOrNombre}' no encontrado en Hot RAM.` });
        }

        const cal = hotRam.calendarioPorChofer.get(String(ch.chofer_id)) || [];
        const ind = hotRam.individualPorId.get(String(ch.chofer_id)) || {};

        res.json({
            success: true,
            fuente: 'HOT_RAM_NODEJS',
            latenciaMs: Date.now() - t0,
            chofer: {
                ...ch,
                ...ind,
                calendarios: cal
            }
        });
    });

    // 4. Consulta bajo demanda por rango de fechas y filtros avanzados
    // GET /diagramas/consulta?desde=YYYY-MM-DD&hasta=YYYY-MM-DD&chofer=...&servicio=...
    router.get('/diagramas/consulta', async (req, res) => {
        const t0 = Date.now();
        const { desde, hasta, chofer, legajo, servicio, diagrama_tipo, formato = 'completo', limit, offset = 0 } = req.query;

        if (!desde || !hasta) {
            return res.status(400).json({
                error: "Debe proveer los parámetros obligatorios 'desde' y 'hasta' (formato YYYY-MM-DD).",
                ejemplo: "/diagramas/consulta?desde=2026-08-01&hasta=2026-08-31&servicio=METANOL"
            });
        }

        const dCurrent = new Date(desde + 'T12:00:00');
        const dEnd = new Date(hasta + 'T12:00:00');
        if (isNaN(dCurrent.getTime()) || isNaN(dEnd.getTime()) || dCurrent > dEnd) {
            return res.status(400).json({ error: "Rango de fechas inválido. Formato requerido: YYYY-MM-DD y 'desde' <= 'hasta'." });
        }

        const diasRango = [];
        for (let d = new Date(dCurrent); d <= dEnd; d.setDate(d.getDate() + 1)) {
            diasRango.push(d.toISOString().split('T')[0]);
        }

        let target = hotRam.catalogoChoferes;

        if (chofer) {
            const nNorm = normalizar(chofer);
            target = target.filter(c => normalizar(c.nombre).includes(nNorm) || String(c.dni || '').includes(chofer));
        }
        if (servicio && servicio !== 'TODOS') {
            const sUpper = servicio.trim().toUpperCase();
            target = target.filter(c => (c.servicio || '').toUpperCase() === sUpper);
        }

        const totalCoincidencias = target.length;
        const offsetNum = parseInt(offset, 10) || 0;
        const limitNum = parseInt(limit, 10) || 100;
        const paginados = target.slice(offsetNum, offsetNum + limitNum);

        const resultados = paginados.map(c => {
            const cals = hotRam.calendarioPorChofer.get(String(c.chofer_id)) || [];
            const caracteresRango = {};

            diasRango.forEach(iso => {
                let car = '-';
                for (const row of cals) {
                    if (row.dias_km && row.dias_km[iso]) {
                        car = row.dias_km[iso].codigo || car;
                    }
                }
                caracteresRango[iso] = car;
            });

            const item = {
                chofer_id: c.chofer_id,
                nombre: c.nombre,
                dni: c.dni,
                servicio: c.servicio,
                contabilizador: contabilizarDias(caracteresRango)
            };

            if (formato !== 'resumido') {
                item.caracteres = caracteresRango;
            }
            return item;
        });

        res.json({
            fuente: 'HOT_RAM_CONSULTA',
            latenciaMs: Date.now() - t0,
            parametros_aplicados: { desde, hasta, total_dias: diasRango.length, servicio, chofer },
            paginacion: {
                total_registros: totalCoincidencias,
                retornados: resultados.length,
                offset: offsetNum,
                hay_mas: (offsetNum + resultados.length) < totalCoincidencias
            },
            resultados
        });
    });

    // 5. Diccionario de Parámetros
    router.get('/diagramas/parametros', (req, res) => {
        res.json({
            servicio: "Consultas de Diagramas Bajo Demanda (Hot RAM)",
            descripcion: "Permite consultar cualquier rango de fechas con cálculo dinámico del contabilizador canónico en RAM.",
            endpoints: [
                { ruta: "GET /diagramas/consulta", descripcion: "Consulta bajo demanda con contabilizador dinámico." },
                { ruta: "GET /ram/diagramas", descripcion: "Lectura instantánea (<5ms) de la ventana activa en Hot RAM." },
                { ruta: "GET /ram/diagramas/chofer/:idOrNombre", descripcion: "Detalle de un chofer en Hot RAM." }
            ],
            contabilizador_reglas: {
                trabajados: "Números (1-35), 'O', 'OPERATIVO'",
                francos: "'F', 'FSF', 'FRANCO', 'RPT', 'F+...'",
                vacaciones: "'V', 'VSF', 'VACACIONES', 'V+...'",
                ausencias: "'E', 'ART', 'IND', 'S', 'A', 'P', 'MED', 'LIC'"
            }
        });
    });

    // 6. Listado de Unidades con KMs (acumulados o por mes)
    router.get('/api/km/unidades', async (req, res) => {
        const t0 = Date.now();
        const { mes, search, servicio, limit = 500, offset = 0 } = req.query;
        const limitNum = Math.min(Math.max(parseInt(limit, 10) || 500, 1), 1000);
        const offsetNum = Math.max(parseInt(offset, 10) || 0, 0);

        let list = hotRam.flota.map(f => {
            return {
                id_unidad: f.unidad_id,
                dominio: f.tractor || 'S/D',
                tractor: f.tractor || '',
                semi: f.semi || '',
                n_ute: f.n_ute || null,
                servicio: f.servicio || 'S/A',
                chofer_nombre: f.chofer_nombre || '',
                total_km: 0,
                km_periodo: 0,
                viajes_count: 0
            };
        });

        if (servicio && servicio !== 'TODOS') {
            list = list.filter(u => (u.servicio || '').toUpperCase() === servicio.trim().toUpperCase());
        }

        if (search && search.trim().length > 0) {
            const term = normalizar(search.trim());
            list = list.filter(u => 
                (u.dominio && normalizar(u.dominio).includes(term)) ||
                (u.semi && normalizar(u.semi).includes(term)) ||
                (u.chofer_nombre && normalizar(u.chofer_nombre).includes(term))
            );
        }

        const total = list.length;
        const paginated = list.slice(offsetNum, offsetNum + limitNum);

        res.json({
            success: true,
            fuente: 'HOT_RAM_2M',
            latenciaMs: Date.now() - t0,
            total,
            offset: offsetNum,
            limit: limitNum,
            unidades: paginated
        });
    });

    // 7. Listado de Choferes con KMs (acumulados o por mes)
    router.get('/api/km/choferes', async (req, res) => {
        const t0 = Date.now();
        const { search, servicio, limit = 500, offset = 0 } = req.query;
        const limitNum = Math.min(Math.max(parseInt(limit, 10) || 500, 1), 1000);
        const offsetNum = Math.max(parseInt(offset, 10) || 0, 0);

        let list = hotRam.catalogoChoferes.map(c => {
            const cals = hotRam.calendarioPorChofer.get(String(c.chofer_id)) || [];
            let totalKm = 0;
            let totalViajes = 0;
            cals.forEach(cal => {
                totalKm += parseFloat(cal.km_mes_total) || 0;
                totalViajes += parseInt(cal.cant_viajes_mes, 10) || 0;
            });

            return {
                id_chofer: c.chofer_id,
                nombre: c.nombre,
                dni: c.dni,
                servicio: c.servicio,
                total_km: +totalKm.toFixed(2),
                km_periodo: +totalKm.toFixed(2),
                viajes_count: totalViajes
            };
        });

        if (servicio && servicio !== 'TODOS') {
            list = list.filter(c => (c.servicio || '').toUpperCase() === servicio.trim().toUpperCase());
        }

        if (search && search.trim().length > 0) {
            const term = normalizar(search.trim());
            list = list.filter(c => normalizar(c.nombre).includes(term) || (c.dni && String(c.dni).includes(term)));
        }

        list.sort((a, b) => b.total_km - a.total_km);
        const total = list.length;
        const paginated = list.slice(offsetNum, offsetNum + limitNum);

        res.json({
            success: true,
            fuente: 'HOT_RAM_2M',
            latenciaMs: Date.now() - t0,
            total,
            offset: offsetNum,
            limit: limitNum,
            choferes: paginated
        });
    });

    return router;
};
