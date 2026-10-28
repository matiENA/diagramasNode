const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
require('dotenv').config();

// Manejo global de excepciones para prevenir caídas del servidor
process.on('uncaughtException', (err) => {
    if (['ECONNRESET', 'EPIPE', 'ECONNABORTED'].includes(err.code)) return;
    console.error('💥 [Backend storage_ram_db] Uncaught Exception:', err.message || err);
    if (err.stack) console.error(err.stack);
});
process.on('unhandledRejection', (reason) => {
    console.error('💥 [Backend storage_ram_db] Unhandled Rejection:', reason);
});

const express = require('express');
const compression = require('compression');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

// ==============================================================
// 📦 MÓDULOS PROPIOS
// ==============================================================
const { fetchRango, serviceAccountAuth, ID_SPREADSHEET_MASTER } = require('./utils/shared');
const { cargarNovedades, createNovedadesRouter } = require('./novedades');
const webhookRouter = require('./webhook');
const { iniciarCachePolling } = require('./cache/builder');
const createAuthRouter = require('./routes/auth');
const createProxyRouter = require('./routes/proxy');
const createFotosRouter = require('./routes/fotos');
const createDashRouter = require('./routes/dash');
const createDiagramasRouter = require('./routes/diagramas');
const createServiciosRouter = require('./routes/servicios');
const createActivosRouter = require('./routes/activos');
const createViewsRouter = require('./routes/views');
const createMovimientosRouter = require('./routes/movimientos');
const hotRamManager = require('./cache/hotRamManager');
const createHotRamRouter = require('./routes/hotRamRoutes');

// ==============================================================
// 🚀 EXPRESS + SOCKET.IO
// ==============================================================
const app = express();
app.use(compression());
const server = http.createServer(app);

// ==============================================================
// 🛡️ CONFIGURACIÓN DE CORS
// ==============================================================
const dominiosPermitidos = [
    "https://diagramas-hp1p.onrender.com",
    "https://diagramasnode.onrender.com",
    "http://localhost:3000",
    "https://dash-aa1f.onrender.com"
];

const checkOrigin = function(origin, callback) {
    if (!origin) return callback(null, true);
    if (dominiosPermitidos.includes(origin) || origin.endsWith('.onrender.com') || origin.includes('localhost') || origin.includes('127.0.0.1')) {
        return callback(null, true);
    }
    return callback(null, true);
};

const corsConfig = {
    origin: checkOrigin,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
    credentials: true
};

const io = new Server(server, {
    cors: corsConfig,
    transports: ['websocket', 'polling']
});

// Namespace dedicado para DASH — recibe solo novedades
const ioDash = io.of('/dash');

app.use(cors(corsConfig));
app.options(/(.*)/, cors(corsConfig));
app.use(express.json({ limit: '10mb' }));

// ==============================================================
// 🧠 ESTADO GLOBAL (RAM compartida)
// ==============================================================
let cacheDatosGlobales = {
    diagramas: null,
    nombresMesActual: [],
    ultimaActualizacion: null,
    novedades: []
};

// ==============================================================
// ⏱️ INICIAR CACHE + POLLING
// ==============================================================
iniciarCachePolling(cacheDatosGlobales, io, ioDash);

// ==============================================================
// 🛣️ RUTAS
// ==============================================================

// Health check
app.get('/health', (req, res) => res.status(200).send('OK'));

// Datos principales (lectura)
app.get('/api/datos', (req, res) => {
    if (!cacheDatosGlobales.diagramas) return res.status(503).json({ error: "Cargando DB..." });

    // Enviar el objeto completo incluyendo la ventana de 60 días de KM en RAM (nuevaSeccionViajes)
    const payload = {
        ...cacheDatosGlobales.diagramas,
        nuevaSeccionViajes: cacheDatosGlobales.diagramas.nuevaSeccionViajes || {}
    };

    // Cabecera de caché para permitir respuestas 304 Not Modified con ETag
    res.set('Cache-Control', 'public, max-age=10, must-revalidate');

    const clientEtag = req.headers['if-none-match'];
    const currentVersion = cacheDatosGlobales.ultimaActualizacion;
    if (clientEtag && (clientEtag === `"${currentVersion}"` || clientEtag === currentVersion || clientEtag.includes(currentVersion))) {
        return res.status(304).end();
    }
    if (currentVersion) {
        res.set('ETag', `"${currentVersion}"`);
    }

    res.json({
        success: true,
        diagramas: payload,
        ut: payload.ut || [],
        vencimientosObj: payload.vencimientosObj || [],
        timestamp: cacheDatosGlobales.ultimaActualizacion,
        usuarios: cacheDatosGlobales.usuarios || []
    });
});

// Viajes — Consulta histórica bajo demanda (Híbrido: RAM (2 meses) -> PostgreSQL movimientos_km -> Microservicio -> Cold Storage de respaldo)
app.get(['/api/viajes/historial', '/api/km/historial'], async (req, res) => {
    try {
        const { chofer, desde, hasta } = req.query;
        if (!chofer) return res.status(400).json({ error: "Falta parámetro 'chofer'" });
        
        const { normalizar, fetchRango, ID_SHEET_KILOMETROS, getFechaArgentina } = require('./utils/shared');
        const { isMicroservicioActivo, obtenerHistorialMicroservicio } = require('./utils/kmClient');
        const db = require('./utils/db');
        const nBuscado = normalizar(chofer);
        const KM_RAM_DIAS = parseInt(process.env.KM_RAM_DIAS, 10) || 60;
        const hoyArKm = (typeof getFechaArgentina === 'function') ? getFechaArgentina() : new Date();
        const limiteRamIso = new Date(hoyArKm.getTime() - (KM_RAM_DIAS * 24 * 3600 * 1000)).toISOString().split('T')[0];

        // 1. Si la consulta especifica un rango 'desde' que cae estrictamente dentro de la ventana de 2 meses en RAM
        if (desde && desde >= limiteRamIso && cacheDatosGlobales.diagramas && cacheDatosGlobales.diagramas.nuevaSeccionViajes) {
            const viajesRam = cacheDatosGlobales.diagramas.nuevaSeccionViajes[nBuscado] 
                || (nBuscado.includes('ñ') ? cacheDatosGlobales.diagramas.nuevaSeccionViajes[nBuscado.replace(/ñ/g, 'n')] : null)
                || {};
            let filtrados = {};
            for (let f in viajesRam) {
                if ((!desde || f >= desde) && (!hasta || f <= hasta)) {
                    filtrados[f] = viajesRam[f];
                }
            }
            if (Object.keys(filtrados).length > 0) {
                return res.json({ success: true, fuente: "RAM", data: filtrados });
            }
        }

        // 2. Si se solicitan fechas anteriores a los 2 meses o historial completo, consultar primero PostgreSQL nativo (pg)
        if (db.isConfigured()) {
            try {
                const choferClean = String(chofer).trim();
                let sql = `
                    SELECT 
                        f.key::date AS fecha,
                        f.value->>'tractor' AS dominio,
                        (f.value->>'km')::numeric AS km_totales,
                        COALESCE(f.value->>'hr', '') AS hoja_ruta,
                        (f.value->>'id_unidad')::uuid AS id_unidad
                    FROM public.choferes_km_mensual ck
                    JOIN public.choferes c ON ck.chofer_id = c.id
                    CROSS JOIN LATERAL jsonb_each(ck.dias_km) f
                    WHERE (c.nombre ILIKE $1 OR ck.chofer_id::text = $2)
                      AND ((f.value->>'km')::numeric > 0 OR COALESCE(f.value->>'hr', '') <> '')
                `;
                const params = ['%' + choferClean + '%', choferClean];
                if (desde) {
                    params.push(desde);
                    sql += ` AND f.key >= $${params.length}`;
                }
                if (hasta) {
                    params.push(hasta);
                    sql += ` AND f.key <= $${params.length}`;
                }
                sql += ` ORDER BY f.key ASC`;

                const resPg = await db.query(sql, params);
                if (resPg.rows && resPg.rows.length > 0) {
                    const parseNum = (val) => parseFloat(String(val || '').replace(/,/g, '.').replace(/[^0-9.-]/g, '')) || 0;
                    let resultadoPg = {};
                    resPg.rows.forEach(r => {
                        const iso = r.fecha instanceof Date ? r.fecha.toISOString().split('T')[0] : String(r.fecha).split('T')[0];
                        if (!resultadoPg[iso]) {
                            resultadoPg[iso] = { id_unidad: r.id_unidad || null, dominio: (r.dominio || '').trim(), km: 0, campo: 0, hoja_ruta: [] };
                        }
                        resultadoPg[iso].km += parseNum(r.km_totales);
                        if (r.hoja_ruta) {
                            String(r.hoja_ruta).split(/[,/]/).map(s => s.trim()).filter(Boolean).forEach(h => {
                                if (!resultadoPg[iso].hoja_ruta.includes(h)) resultadoPg[iso].hoja_ruta.push(h);
                            });
                        }
                    });
                    return res.json({ success: true, fuente: "POSTGRES_KM", data: resultadoPg });
                }
            } catch (dbErr) {
                console.warn("⚠️ [Server] Error consultando movimientos_km en Postgres, continuando a fallback:", dbErr.message);
            }
        }

        // 3. Fallback al microservicio exclusivo (Cold Index)
        if (isMicroservicioActivo()) {
            const histMicro = await obtenerHistorialMicroservicio(chofer, desde, hasta);
            if (histMicro && histMicro.success && Object.keys(histMicro.data || {}).length > 0) {
                return res.json(histMicro);
            }
        }

        // 4. Fallback de resiliencia final: Si no hay Postgres ni microservicio, consultar Sheets directamente
        console.warn("⚠️ [Server] Consultando Cold Storage directamente en Google Sheets (fallback)...");
        const rows = await fetchRango(ID_SHEET_KILOMETROS, "'KM'!A1:V");
        const parseNum = (val) => parseFloat(String(val || '').replace(/,/g, '.').replace(/[^0-9.-]/g, '')) || 0;
        let resultado = {};

        if (rows && rows.length > 1) {
            const headers = rows[0] || [];
            const normHeader = (h) => String(h || '').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
            const colMap = {};
            headers.forEach((h, idx) => {
                const k = normHeader(h);
                if (k && colMap[k] === undefined) colMap[k] = idx;
            });
            const colFecha = colMap['fecha'] ?? 1;
            const colChofer = colMap['chofer'] ?? 2;
            const colDominio = colMap['dominio'] ?? colMap['tractor'] ?? 0;
            const colKm = colMap['kmtotales'] ?? colMap['kilometros'] ?? colMap['km'] ?? (colMap['cargas'] !== undefined && colMap['cargas'] === 16 ? 17 : 16);
            const colHr = colMap['nhojaderuta'] ?? colMap['hojaderuta'] ?? colMap['hr'] ?? 20;

            for (let i = 1; i < rows.length; i++) {
                const row = rows[i];
                let fRaw = row[colFecha], nRaw = row[colChofer]; if (!fRaw || !nRaw) continue;
                let norm = normalizar(nRaw);
                if (norm !== nBuscado && norm.replace(/ñ/g, 'n') !== nBuscado.replace(/ñ/g, 'n')) continue;

                let dObj, parts = String(fRaw).split(' ')[0].split(/[\/\-]/);
                if (parts.length >= 3) {
                    let aa = parts[2].length === 2 ? "20" + parts[2] : parts[2];
                    dObj = new Date(parseInt(aa, 10), parseInt(parts[1], 10) - 1, parts[0]);
                } else {
                    dObj = new Date(fRaw);
                }
                if (isNaN(dObj.getTime())) continue;
                let isoDate = dObj.toISOString().split('T')[0];

                if ((!desde || isoDate >= desde) && (!hasta || isoDate <= hasta)) {
                    let km = parseNum(row[colKm]);
                    let campo = parseNum(row[5]);
                    let hojaStr = String(row[colHr] || "").trim();
                    if (!resultado[isoDate]) resultado[isoDate] = { dominio: String(row[colDominio] || '').trim(), km: 0, campo: 0, hoja_ruta: [] };
                    resultado[isoDate].km += km;
                    resultado[isoDate].campo += campo;
                    if (hojaStr) {
                        hojaStr.split(',').map(s => s.trim()).filter(Boolean).forEach(h => {
                            if (!resultado[isoDate].hoja_ruta.includes(h)) resultado[isoDate].hoja_ruta.push(h);
                        });
                    }
                }
            }
        }

        res.json({ success: true, fuente: "COLD_STORAGE", data: resultado });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// Webhook — Notificación de actualización desde microservicio KM para actualizar subnodos en vivo
app.post('/api/webhook/km-updated', async (req, res) => {
    try {
        console.log("📥 [Webhook] Ping de actualización recibido desde Microservicio KM");
        const { actualizarSubnodosKm } = require('./cache/builder');
        const ok = await actualizarSubnodosKm(cacheDatosGlobales, io);
        res.json({ success: ok, message: ok ? "Subnodos actualizados y broadcast emitido" : "No se pudo actualizar subnodos" });
    } catch (e) {
        console.error("❌ Error procesando webhook de KM:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// Estado de salud y métricas de Kilómetros (RAM 60 días + PostgreSQL)
app.get('/api/km/status', async (req, res) => {
    try {
        const db = require('./utils/db');
        const KM_RAM_DIAS = parseInt(process.env.KM_RAM_DIAS, 10) || 60;
        const ram = cacheDatosGlobales.diagramas?.nuevaSeccionViajes || {};
        const choferesEnRam = Object.keys(ram).length;
        let dbMetrics = null;
        if (db.isConfigured()) {
            try {
                const countRes = await db.query(`
                    SELECT COALESCE(SUM(cant_viajes), 0)::int AS total_registros,
                           MIN(MAKE_DATE(anio, mes_numero, 1))::text AS fecha_minima,
                           (MAX(MAKE_DATE(anio, mes_numero, 1)) + INTERVAL '1 month - 1 day')::date::text AS fecha_maxima
                    FROM public.choferes_km_mensual
                `);
                dbMetrics = countRes.rows[0];
            } catch (e) {
                dbMetrics = { error: e.message };
            }
        }
        res.json({
            success: true,
            ram: {
                ventanaDias: KM_RAM_DIAS,
                choferesConViajes: choferesEnRam,
                estado: choferesEnRam > 0 ? "OPERATIVO" : "PENDIENTE"
            },
            database: dbMetrics
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});


// Estado de conexión y métricas de memoria de PostgreSQL (pg client)
app.get('/api/db/status', async (req, res) => {
    try {
        const db = require('./utils/db');
        const metrics = db.getPoolMetrics();
        let health = null;
        if (db.isConfigured()) {
            health = await db.checkHealth();
        }
        res.json({
            success: true,
            ...metrics,
            health
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Reensamblado manual o reactivo de memoria RAM desde Supabase
app.post(['/api/db/refresh', '/api/refresh'], async (req, res) => {
    try {
        const { flujoEncoladoGlobal } = require('./cache/builder');
        await flujoEncoladoGlobal(cacheDatosGlobales, io, ioDash, { forceFull: true, recargarKm: false });
        res.json({
            success: true,
            message: "Memoria RAM reensamblada desde Supabase exitosamente",
            timestamp: cacheDatosGlobales.ultimaActualizacion,
            unidadesCount: cacheDatosGlobales.ut ? cacheDatosGlobales.ut.length : 0,
            choferesCount: cacheDatosGlobales.diagramas && cacheDatosGlobales.diagramas.diagramas ? cacheDatosGlobales.diagramas.diagramas.length : 0
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Auth — Login unificado (Sheets + Supabase)
app.use('/api/auth', createAuthRouter());

// Servicios — Catálogos canónicos de servicios (unidades y choferes)
app.use('/api/servicios', createServiciosRouter(cacheDatosGlobales));

// Vistas relacionales (Supabase/PostgreSQL) - portado desde eor/server.js (v1 unificada)
app.use('/api/views', createViewsRouter(hotRamManager));

// Movimientos - recorte diario y sync-supabase - portado desde eor/server.js (v1 unificada)
app.use('/api/movimientos', createMovimientosRouter(hotRamManager, io));

// Activos — Catálogo canónico de tractores, semis y gestión de acoples
app.use('/api', createActivosRouter(cacheDatosGlobales, io, hotRamManager));

// Hot RAM — Endpoints dedicados (/ram, /ram/diagramas, /diagramas/consulta, /api/km/unidades, /api/km/choferes)
app.use('/', createHotRamRouter(hotRamManager, cacheDatosGlobales));

// Sync Workers — Partición 7 (KM) y Partición 5 (Diagramas)
try {
    const createKmSyncRouter = require('./routes/kmSync');
    app.use('/api/sync/km', createKmSyncRouter(cacheDatosGlobales, io, ioDash));
} catch (e) {
    console.warn("⚠️ No se pudo inicializar routes/kmSync:", e.message);
}

try {
    const createDiagramasSyncRouter = require('./routes/diagramasSync');
    app.use('/api/sync/diagramas', createDiagramasSyncRouter(cacheDatosGlobales, io, ioDash));
} catch (e) {
    console.warn("⚠️ No se pudo inicializar routes/diagramasSync:", e.message);
}

// DASH — API ligera (solo flota + usuarios, sin días) + Legajo bajo demanda
const dashRouter = createDashRouter(cacheDatosGlobales, io);
app.use('/api/dash', dashRouter);
// Alias para acceso directo a chofer y legajo desde el frontend (/api/chofer/:id/legajo)
app.use('/api/chofer', (req, res, next) => {
    req.url = '/chofer' + req.url;
    dashRouter(req, res, next);
});

// Diagramas — Consultas bajo demanda e historial completo (Supabase)
const diagramasRouter = createDiagramasRouter();
app.use('/api/diagramas', diagramasRouter);
app.use('/diagramas', diagramasRouter);

// Novedades — CRUD + Polling
app.use('/api/novedades', createNovedadesRouter(cacheDatosGlobales, io, ioDash, serviceAccountAuth, ID_SPREADSHEET_MASTER, fetchRango));

// Proxy — Escritura directa a Google Sheets (observaciones, docs, estados, hojas de ruta)
app.use('/api/proxy', createProxyRouter(cacheDatosGlobales, io));

// Fotos — Subida a imgbb + vinculación
app.use('/api/subir-foto', createFotosRouter(cacheDatosGlobales, io));

// Webhooks — Inyección en RAM desde Google Sheets
app.use('/api/webhook', webhookRouter(cacheDatosGlobales, io, ioDash, cargarNovedades, fetchRango, ID_SPREADSHEET_MASTER));

// Bot — Asistente de consultas inteligente con Gemini y RAM (Módulo exclusivo local)
try {
    const { createBotRouter, botStaticDir } = require('./bot');
    app.use('/api/bot', createBotRouter(cacheDatosGlobales));
    app.use('/bot', express.static(botStaticDir));
    app.get('/bot', (req, res) => res.sendFile(path.join(botStaticDir, 'index.html')));
    console.log("🤖 Módulo Bot cargado correctamente (entorno local).");
} catch (e) {
    // Si la carpeta bot/ está ignorada en producción, continúa con normalidad
}

// ==============================================================
// 🛣️ ENDPOINTS NATIVOS DE KILÓMETROS (RAM 60 DÍAS + POSTGRESQL)
// ==============================================================

// 1. Catálogo de viajes en RAM (ventana activa de 60 días)
app.get(['/api/km/recientes', '/api/km/viajes'], (req, res) => {
    const chofer = req.query.chofer;
    const viajesRam = (cacheDatosGlobales.diagramas && cacheDatosGlobales.diagramas.nuevaSeccionViajes) || {};
    if (chofer) {
        const { normalizar } = require('./utils/shared');
        const n = normalizar(chofer);
        let data = viajesRam[n] || (n.includes('ñ') ? viajesRam[n.replace(/ñ/g, 'n')] : null);
        if (!data) {
            const matchKey = Object.keys(viajesRam).find(k => k.includes(n));
            if (matchKey) data = viajesRam[matchKey];
        }
        return res.json({ success: true, chofer: n, fuente: "RAM_60D", viajes: data || {} });
    }
    res.json({
        success: true,
        fuente: "RAM_60D",
        choferesCount: Object.keys(viajesRam).length,
        viajes: viajesRam
    });
});

// 2. Viajes de un chofer específico desde RAM
app.get('/api/km/viajes/:chofer', (req, res) => {
    const { normalizar } = require('./utils/shared');
    const n = normalizar(req.params.chofer);
    const viajesRam = (cacheDatosGlobales.diagramas && cacheDatosGlobales.diagramas.nuevaSeccionViajes) || {};
    let data = viajesRam[n] || (n.includes('ñ') ? viajesRam[n.replace(/ñ/g, 'n')] : null);
    if (!data) {
        const matchKey = Object.keys(viajesRam).find(k => k.includes(n));
        if (matchKey) data = viajesRam[matchKey];
    }
    res.json({ success: true, chofer: n, fuente: "RAM_60D", viajes: data || {} });
});

// 3. Consulta de viajes por rango de fechas (RAM para últimos 60 días, PostgreSQL para histórico)
app.get('/api/km/rango', async (req, res) => {
    try {
        const { desde, hasta, chofer } = req.query;
        if (!desde || !hasta) return res.status(400).json({ success: false, error: "Faltan parámetros 'desde' y 'hasta'" });
        const db = require('./utils/db');
        const { normalizar, getFechaArgentina } = require('./utils/shared');
        const KM_RAM_DIAS = parseInt(process.env.KM_RAM_DIAS, 10) || 60;
        const hoyArKm = (typeof getFechaArgentina === 'function') ? getFechaArgentina() : new Date();
        const limiteRamIso = new Date(hoyArKm.getTime() - (KM_RAM_DIAS * 24 * 3600 * 1000)).toISOString().split('T')[0];

        // Si el rango 'desde' cae dentro de los 60 días en RAM, servir desde memoria
        if (desde >= limiteRamIso && cacheDatosGlobales.diagramas?.nuevaSeccionViajes) {
            const ram = cacheDatosGlobales.diagramas.nuevaSeccionViajes;
            let filtrados = {};
            if (chofer) {
                const n = normalizar(chofer);
                const chViajes = ram[n] || (n.includes('ñ') ? ram[n.replace(/ñ/g, 'n')] : {}) || {};
                filtrados[n] = {};
                for (let f in chViajes) {
                    if (f >= desde && f <= hasta) filtrados[n][f] = chViajes[f];
                }
            } else {
                for (let ch in ram) {
                    for (let f in ram[ch]) {
                        if (f >= desde && f <= hasta) {
                            if (!filtrados[ch]) filtrados[ch] = {};
                            filtrados[ch][f] = ram[ch][f];
                        }
                    }
                }
            }
            return res.json({ success: true, fuente: "RAM", data: filtrados });
        }

        // Si se solicitan fechas históricas o fuera de RAM, consultar PostgreSQL choferes_km_mensual
        if (db.isConfigured()) {
            let sql = `
                SELECT 
                    f.key AS fecha,
                    f.value->>'tractor' AS dominio,
                    c.nombre AS chofer_nombre,
                    (f.value->>'km')::numeric AS km_totales,
                    COALESCE(f.value->>'hr', '') AS hoja_ruta,
                    (f.value->>'id_unidad')::uuid AS id_unidad
                FROM public.choferes_km_mensual ck
                JOIN public.choferes c ON ck.chofer_id = c.id
                CROSS JOIN LATERAL jsonb_each(ck.dias_km) f
                WHERE f.key >= $1 AND f.key <= $2
                  AND ((f.value->>'km')::numeric > 0 OR COALESCE(f.value->>'hr', '') <> '')
            `;
            let params = [desde, hasta];
            if (chofer) {
                params.push('%' + String(chofer).trim() + '%');
                sql += ` AND c.nombre ILIKE $${params.length}`;
            }
            sql += ` ORDER BY f.key ASC`;

            const resPg = await db.query(sql, params);
            const parseNum = (val) => parseFloat(String(val || '').replace(/,/g, '.').replace(/[^0-9.-]/g, '')) || 0;
            let resultado = {};
            resPg.rows.forEach(r => {
                if (!r.chofer_nombre) return;
                const n = normalizar(r.chofer_nombre);
                if (!resultado[n]) resultado[n] = {};
                if (!resultado[n][r.fecha]) resultado[n][r.fecha] = { id_unidad: r.id_unidad || null, dominio: (r.dominio || '').trim(), km: 0, campo: 0, hoja_ruta: [] };
                resultado[n][r.fecha].km += parseNum(r.km_totales);
                resultado[n][r.fecha].km = parseFloat(resultado[n][r.fecha].km.toFixed(2));
                if (r.hoja_ruta) {
                    String(r.hoja_ruta).split(/[,/]/).map(s => s.trim()).filter(Boolean).forEach(h => {
                        if (!resultado[n][r.fecha].hoja_ruta.includes(h)) resultado[n][r.fecha].hoja_ruta.push(h);
                    });
                }
            });
            return res.json({ success: true, fuente: "POSTGRES_KM", data: resultado });
        }

        res.status(503).json({ success: false, error: "Base de datos no disponible para consultas fuera de RAM" });
    } catch (err) {
        console.error("❌ Error en /api/km/rango:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Endpoint optimizado para Calendario / Diagrama utilizando View Tables de Supabase
app.get(['/api/km/calendario', '/api/viajes/calendario'], async (req, res) => {
    try {
        const { mes, chofer, desde, hasta } = req.query;
        const db = require('./utils/db');
        if (!db.isConfigured()) {
            return res.status(503).json({ success: false, error: "Base de datos PostgreSQL no configurada" });
        }

        // Si se pide por mes exacto (ej: 2026-09 o Sep-26), usar choferes_km_mensual
        if (mes) {
            let sql = `
                SELECT 
                  ck.mes_tab, ck.anio, ck.mes_numero, 
                  ck.chofer_id AS id_chofer, c.nombre AS chofer_nombre, c.legajo,
                  ck.km_mes_total, ck.cant_viajes, ck.dias_km, ck.rangos
                FROM public.choferes_km_mensual ck
                JOIN public.choferes c ON ck.chofer_id = c.id
                WHERE (ck.mes_tab = $1 OR TO_CHAR(MAKE_DATE(ck.anio, ck.mes_numero, 1), 'YYYY-MM') = $1)
            `;
            const params = [mes];
            if (chofer) {
                params.push('%' + String(chofer).trim() + '%');
                sql += ` AND (c.nombre ILIKE $${params.length} OR ck.chofer_id::text = $${params.length})`;
            }
            sql += ` ORDER BY c.nombre ASC`;
            const resView = await db.query(sql, params);
            return res.json({ success: true, fuente: "CHOFERES_KM_MENSUAL", count: resView.rows.length, data: resView.rows });
        }

        // Si se pide por rango de fechas flexible (desde/hasta), usar choferes_km_mensual
        let sql = `
            SELECT 
                f.key AS fecha, 
                ck.chofer_id AS id_chofer, 
                c.nombre AS chofer_nombre, 
                (f.value->>'id_unidad')::uuid AS id_unidad, 
                f.value->>'n_ute' AS n_ute, 
                f.value->>'tractor' AS dominio, 
                (f.value->>'km')::numeric AS km, 
                1 AS cant_viajes, 
                string_to_array(COALESCE(f.value->>'hr', ''), ', ') AS hoja_ruta
            FROM public.choferes_km_mensual ck
            JOIN public.choferes c ON ck.chofer_id = c.id
            CROSS JOIN LATERAL jsonb_each(ck.dias_km) f
            WHERE ((f.value->>'km')::numeric > 0 OR COALESCE(f.value->>'hr', '') <> '')
        `;
        const params = [];
        if (desde) {
            params.push(desde);
            sql += ` AND f.key >= $${params.length}`;
        }
        if (hasta) {
            params.push(hasta);
            sql += ` AND f.key <= $${params.length}`;
        }
        if (chofer) {
            params.push('%' + String(chofer).trim() + '%');
            sql += ` AND (c.nombre ILIKE $${params.length} OR ck.chofer_id::text = $${params.length})`;
        }
        sql += ` ORDER BY f.key ASC, c.nombre ASC`;
        const resView = await db.query(sql, params);
        return res.json({ success: true, fuente: "CHOFERES_KM_MENSUAL_EXPANDED", count: resView.rows.length, data: resView.rows });
    } catch (err) {
        console.error("❌ Error en /api/km/calendario:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 4. Registro / actualización de hojas de ruta en PostgreSQL y RAM
app.post('/api/km/hoja-ruta', async (req, res) => {
    try {
        const { chofer, fecha, hoja_ruta, startIso, endIso, nombre, hojas } = req.body;
        const nombreChofer = chofer || nombre;
        const fInicio = fecha || startIso;
        const fFin = fecha || endIso || startIso;
        const hrArray = Array.isArray(hojas) ? hojas : (hoja_ruta ? [hoja_ruta] : []);

        if (!nombreChofer || !fInicio) {
            return res.status(400).json({ success: false, error: "Faltan datos obligatorios (chofer/nombre, fecha/startIso)" });
        }

        const { normalizar } = require('./utils/shared');
        const db = require('./utils/db');
        const n = normalizar(nombreChofer);
        const hrStr = hrArray.filter(Boolean).join(',');

        // 1. Actualizar RAM
        if (cacheDatosGlobales.diagramas?.nuevaSeccionViajes) {
            if (!cacheDatosGlobales.diagramas.nuevaSeccionViajes[n]) cacheDatosGlobales.diagramas.nuevaSeccionViajes[n] = {};
            const cur = new Date(fInicio + "T12:00:00");
            const fin = new Date(fFin + "T12:00:00");
            while (cur <= fin) {
                const iso = cur.toISOString().split('T')[0];
                if (!cacheDatosGlobales.diagramas.nuevaSeccionViajes[n][iso]) {
                    cacheDatosGlobales.diagramas.nuevaSeccionViajes[n][iso] = { dominio: '', km: 0, campo: 0, hoja_ruta: [] };
                }
                const target = cacheDatosGlobales.diagramas.nuevaSeccionViajes[n][iso];
                hrArray.forEach(h => { if (!target.hoja_ruta.includes(h)) target.hoja_ruta.push(h); });
                cur.setDate(cur.getDate() + 1);
            }
        }

        res.json({ success: true, message: "Hoja de ruta actualizada en RAM" });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Archivos estáticos del frontend con Cache-Control y ETag optimizados
app.use(express.static(path.join(__dirname, 'public'), {
    maxAge: '2h',
    etag: true,
    lastModified: true
}));

// Resumen de RAM y KPIs delegado a createHotRamRouter (/ram)

app.get('/api/km/resumen', async (req, res) => {
    try {
        const db = require('./utils/db');
        const ram = cacheDatosGlobales.diagramas?.nuevaSeccionViajes || {};
        const choferesCount = Object.keys(ram).length;
        let totalKm = 0;
        let totalViajes = 0;
        for (let ch in ram) {
            for (let f in ram[ch]) {
                totalViajes++;
                totalKm += (ram[ch][f].km || 0);
            }
        }
        let totalesDb = null;
        if (db.isConfigured()) {
            try {
                const rDb = await db.query(`
                    SELECT 
                        COALESCE(SUM(cant_viajes), 0)::int AS total_viajes,
                        ROUND(COALESCE(SUM(km_mes_total), 0))::float AS total_kms_flota,
                        COUNT(DISTINCT chofer_id)::int AS total_choferes
                    FROM public.choferes_km_mensual;
                `);
                totalesDb = rDb.rows[0];
            } catch (eDb) {
                console.warn('⚠️ Error consultando agregados en Supabase:', eDb.message);
            }
        }
        res.json({
            success: true,
            resumen: {
                total_kms_flota: totalesDb ? totalesDb.total_kms_flota : +totalKm.toFixed(2),
                total_viajes: totalesDb ? totalesDb.total_viajes : totalViajes,
                total_choferes: totalesDb ? totalesDb.total_choferes : choferesCount,
                totales_ram: {
                    total_kms: +totalKm.toFixed(2),
                    total_viajes: totalViajes,
                    choferes: choferesCount
                }
            }
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// ==============================================================
// 🟢 INICIAR SERVIDOR
// ==============================================================
const PORT = process.env.BACKEND_PORT || process.env.PORT || 3005;
server.listen(PORT, () => console.log(`🚀 [Backend storage_ram_db] Servidor Node Activo en puerto ${PORT}`));