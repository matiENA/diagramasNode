// ==============================================================
// 🚀 SERVIDOR DEL MICROSERVICIO DE EXTRACCIÓN DE KILÓMETROS
// ==============================================================
const path = require('path');
const fs = require('fs');

// Carga de variables de entorno: Busca en la carpeta local o en el directorio raíz padre
const envLocal = path.join(__dirname, '.env');
const envPadre = path.join(__dirname, '..', '.env');
if (fs.existsSync(envLocal)) {
    require('dotenv').config({ path: envLocal });
} else if (fs.existsSync(envPadre)) {
    require('dotenv').config({ path: envPadre });
} else {
    require('dotenv').config();
}

const express = require('express');
const cors = require('cors');
const compression = require('compression');
const { 
    kmRam, 
    normalizar, 
    ejecutarExtraccionKM, 
    buscarHistorialEnMemoria, 
    guardarHojaRuta, 
    iniciarPollingExtractor,
    ID_SHEET_KILOMETROS
} = require('./extractor');

const app = express();
app.use(compression());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ==============================================================
// 🩺 HEALTH CHECK & MÉTRICAS DE RAM
// ==============================================================
app.get('/health', (req, res) => {
    const mem = process.memoryUsage();
    res.json({
        status: 'OK',
        servicio: 'km-extractor-service',
        planilla_objetivo: ID_SHEET_KILOMETROS,
        uptime_segundos: Math.floor(process.uptime()),
        stats: kmRam.stats,
        memoria_actual: {
            heapUsedMB: +(mem.heapUsed / 1024 / 1024).toFixed(2),
            heapTotalMB: +(mem.heapTotal / 1024 / 1024).toFixed(2),
            rssMB: +(mem.rss / 1024 / 1024).toFixed(2)
        }
    });
});

// ==============================================================
// 📦 ENDPOINTS PRINCIPALES (CONSUMIDOS POR EL BACKEND PRINCIPAL)
// ==============================================================

/**
 * 1. GET /api/km/viajes
 * Retorna el catálogo completo de viajes (ventana activa de 12 meses)
 * Estructura: { [choferNorm]: { [isoDate]: { dominio, km, campo, hoja_ruta } } }
 */
app.get('/api/km/viajes', (req, res) => {
    if (!kmRam.hotCache || Object.keys(kmRam.hotCache).length === 0) {
        if (kmRam.stats.isSyncing) {
            return res.status(503).json({ success: false, message: "Extracción en curso... Reintente en unos segundos." });
        }
    }

    res.json({
        success: true,
        fuente: "MICROSERVICIO_KM",
        timestamp: kmRam.stats.lastSync,
        choferesCount: kmRam.stats.choferesCount,
        totalViajesHot: kmRam.stats.totalViajesHot,
        viajes: kmRam.hotCache
    });
});

/**
 * 2. GET /api/km/viajes/:chofer
 * Retorna los viajes de un chofer específico dentro de la ventana activa
 */
app.get('/api/km/viajes/:chofer', (req, res) => {
    const n = normalizar(req.params.chofer);
    const nSin = n.replace(/ñ/g, 'n');
    const data = kmRam.hotCache[n] || kmRam.hotCache[nSin] || {};
    res.json({
        success: true,
        chofer: n,
        viajes: data
    });
});

/**
 * 3. GET /api/km/historial
 * Consulta histórica rápida sobre el índice completo (Cold Storage)
 * Parámetros query: chofer, desde, hasta
 */
app.get('/api/km/historial', (req, res) => {
    const { chofer, desde, hasta } = req.query;
    if (!chofer) {
        return res.status(400).json({ success: false, error: "Falta parámetro 'chofer'" });
    }

    const resultado = buscarHistorialEnMemoria(chofer, desde, hasta);
    res.json(resultado);
});

/**
 * 4. POST /api/km/hoja-ruta
 * Agrega o actualiza hojas de ruta tanto en memoria como en la planilla de Google
 */
app.post('/api/km/hoja-ruta', async (req, res) => {
    try {
        const { tractor, startIso, endIso, nombre, hojas, overwrite } = req.body;
        if (!startIso || !endIso || !nombre) {
            return res.status(400).json({ success: false, error: "Faltan campos requeridos (startIso, endIso, nombre)" });
        }

        const resp = await guardarHojaRuta(tractor, startIso, endIso, nombre, hojas, overwrite);
        res.json(resp);
    } catch (e) {
        console.error("Error al guardar hoja de ruta en microservicio:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

/**
 * 5. POST /api/km/sync
 * Fuerza la re-extracción inmediata de la planilla
 */
app.post('/api/km/sync', async (req, res) => {
    ejecutarExtraccionKM().catch(e => console.error("Error en sync forzado:", e));
    res.json({
        success: true,
        message: "Extracción forzada iniciada en segundo plano"
    });
});

/**
 * 6. GET /api/km/stats
 * Resumen de salud y estadísticas del microservicio
 */
app.get('/api/km/stats', (req, res) => {
    res.json({
        success: true,
        stats: kmRam.stats
    });
});

// ==============================================================
// ⏱️ INICIAR MOTOR DE EXTRACCIÓN Y SERVIDOR
// ==============================================================
const PORT = process.env.KM_PORT || process.env.PORT || 3001;
const POLL_MINUTOS = parseInt(process.env.POLL_INTERVAL_MINUTES, 10) || 15;

const server = app.listen(PORT, () => {
    console.log(`=======================================================`);
    console.log(`🚀 Microservicio KM activo en puerto ${PORT}`);
    console.log(`📋 Planilla objetivo: ${ID_SHEET_KILOMETROS}`);
    console.log(`⏱️ Intervalo de sincronización: cada ${POLL_MINUTOS} minutos`);
    console.log(`=======================================================`);
    iniciarPollingExtractor(POLL_MINUTOS);
});

module.exports = { app, server };
