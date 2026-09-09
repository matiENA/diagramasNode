require('dotenv').config();

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
app.options('*', cors(corsConfig));
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
    res.json({
        success: true,
        diagramas: cacheDatosGlobales.diagramas,
        ut: cacheDatosGlobales.diagramas.ut || [],
        vencimientosObj: cacheDatosGlobales.diagramas.vencimientosObj || [],
        timestamp: cacheDatosGlobales.ultimaActualizacion,
        usuarios: cacheDatosGlobales.usuarios || []
    });
});

// Viajes — Consulta histórica bajo demanda (Híbrido: RAM -> Microservicio -> Cold Storage de respaldo)
app.get('/api/viajes/historial', async (req, res) => {
    try {
        const { chofer, desde, hasta } = req.query;
        if (!chofer) return res.status(400).json({ error: "Falta parámetro 'chofer'" });
        
        const { normalizar, fetchRango, ID_SHEET_KILOMETROS } = require('./utils/shared');
        const { isMicroservicioActivo, obtenerHistorialMicroservicio } = require('./utils/kmClient');
        const nBuscado = normalizar(chofer);

        // 1. Si está dentro de la ventana de 12 meses en RAM, responder de inmediato
        if (cacheDatosGlobales.diagramas && cacheDatosGlobales.diagramas.nuevaSeccionViajes) {
            const viajesRam = cacheDatosGlobales.diagramas.nuevaSeccionViajes[nBuscado] || {};
            const fechas = Object.keys(viajesRam);
            if (fechas.length > 0 && (!desde || fechas.some(f => f <= desde))) {
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
        }

        // 2. Si se solicitan fechas anteriores a 12 meses, consultar al microservicio exclusivo
        if (isMicroservicioActivo()) {
            const histMicro = await obtenerHistorialMicroservicio(chofer, desde, hasta);
            if (histMicro && histMicro.success) {
                return res.json(histMicro);
            }
        }

        // 3. Fallback de resiliencia: Si el microservicio no está disponible, consultar Sheets directamente
        console.warn("⚠️ [Server] Consultando Cold Storage directamente en Google Sheets (fallback)...");
        const rows = await fetchRango(ID_SHEET_KILOMETROS, "'KM'!A2:T");
        const parseNum = (val) => parseFloat(String(val || '').replace(/,/g, '.').replace(/[^0-9.-]/g, '')) || 0;
        let resultado = {};

        rows.forEach(row => {
            let fRaw = row[1], nRaw = row[2]; if (!fRaw || !nRaw) return;
            let norm = normalizar(nRaw);
            if (norm !== nBuscado && norm.replace(/ñ/g, 'n') !== nBuscado.replace(/ñ/g, 'n')) return;

            let dObj, parts = String(fRaw).split(' ')[0].split(/[\/\-]/);
            if (parts.length >= 3) { let aa = parts[2].length === 2 ? "20" + parts[2] : parts[2]; dObj = new Date(aa, parseInt(parts[1], 10) - 1, parts[0]); } else { dObj = new Date(fRaw); }
            if (isNaN(dObj.getTime())) return;
            let isoDate = dObj.toISOString().split('T')[0];

            if ((!desde || isoDate >= desde) && (!hasta || isoDate <= hasta)) {
                let km = parseNum(row[16]) > 0 ? parseNum(row[16]) : parseNum(row[8]);
                let campo = parseNum(row[5]);
                let hojaStr = String(row[19] || "").trim();
                if (!resultado[isoDate]) resultado[isoDate] = { dominio: String(row[0] || '').trim(), km: 0, campo: 0, hoja_ruta: [] };
                resultado[isoDate].km += km;
                resultado[isoDate].campo += campo;
                if (hojaStr) {
                    hojaStr.split(',').map(s => s.trim()).filter(Boolean).forEach(h => {
                        if (!resultado[isoDate].hoja_ruta.includes(h)) resultado[isoDate].hoja_ruta.push(h);
                    });
                }
            }
        });

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

// Estado de conexión con la partición de microservicio KM
app.get('/api/km/status', async (req, res) => {
    const { isMicroservicioActivo, getKmServiceUrl, checkSaludMicroservicio } = require('./utils/kmClient');
    const activo = isMicroservicioActivo();
    const url = getKmServiceUrl();
    let salud = null;
    if (activo) {
        salud = await checkSaludMicroservicio();
    }
    res.json({
        microservicio_configurado: activo,
        url: url || null,
        salud: salud
    });
});

// Auth — Login unificado (Sheets + Supabase)
app.use('/api/auth', createAuthRouter());

// DASH — API ligera (solo flota + usuarios, sin días)
app.use('/api/dash', createDashRouter(cacheDatosGlobales));

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

// Archivos estáticos del frontend
const path = require('path');
app.use(express.static(path.join(__dirname, 'public')));

// ==============================================================
// 🟢 INICIAR SERVIDOR
// ==============================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Servidor Node Activo en puerto ${PORT}`));