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

app.use(cors(corsConfig));
app.options('*', cors(corsConfig));
app.use(express.json({ limit: '10mb' }));

// ==============================================================
// 🧠 ESTADO GLOBAL (RAM compartida)
// ==============================================================
let cacheDatosGlobales = {
    diagramas: null,
    tds: null,
    nombresMesActual: [],
    ultimaActualizacion: null,
    novedades: []
};

// ==============================================================
// ⏱️ INICIAR CACHE + POLLING
// ==============================================================
iniciarCachePolling(cacheDatosGlobales, io);

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
        tds: cacheDatosGlobales.tds,
        timestamp: cacheDatosGlobales.ultimaActualizacion,
        usuarios: cacheDatosGlobales.usuarios || []
    });
});

// Auth — Login unificado (Sheets + Supabase)
app.use('/api/auth', createAuthRouter());

// Novedades — CRUD + Polling
app.use('/api/novedades', createNovedadesRouter(cacheDatosGlobales, io, serviceAccountAuth, ID_SPREADSHEET_MASTER, fetchRango));

// Proxy — Escritura directa a Google Sheets (observaciones, docs, estados, hojas de ruta)
app.use('/api/proxy', createProxyRouter(cacheDatosGlobales, io));

// Fotos — Subida a imgbb + vinculación
app.use('/api/subir-foto', createFotosRouter(cacheDatosGlobales, io));

// Webhooks — Inyección en RAM desde Google Sheets
app.use('/api/webhook', webhookRouter(cacheDatosGlobales, io, cargarNovedades, fetchRango, ID_SPREADSHEET_MASTER));

// ==============================================================
// 🟢 INICIAR SERVIDOR
// ==============================================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Servidor Node Activo en puerto ${PORT}`));