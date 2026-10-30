/**
 * ==============================================================================
 * 🚀 EOR SYNC WORKER MICROSERVICE (Render Blueprint + UptimeRobot Auto-Sync)
 * ==============================================================================
 * Microservicio autónomo para procesar mutaciones de `public.eor_sync_queue`
 * (Supabase) hacia Google Sheets (batchUpdate respetando cuotas de 60 req/min).
 * 
 * - Health Check (/health): Para Render y monitores de UptimeRobot.
 * - Endpoint Ping UptimeRobot (/uptimerobot): Mantiene el servicio despierto (24/7)
 *   y gatilla consumo si hay registros pendientes.
 * - Endpoint On-Demand (/api/sync/run): Para n8n o triggers manuales.
 * - Background Poller: Revisa la cola cada 90s cuando el servicio está activo.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
require('dotenv').config({ path: path.resolve(__dirname, '.env') });
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { processSyncQueue } = require('./sync/syncQueueConsumer');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3010;
const MONITOR_TOKEN = process.env.UPTIMEROBOT_MONITOR_TOKEN || 'eor-sync-robot-mon-v1';

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Telemetría en memoria
let isProcessing = false;
let lastSyncReport = {
    timestamp: null,
    totalPending: 0,
    completed: 0,
    failed: 0,
    batchRequestsSent: 0,
    egressBytes: 0,
    executionTimeMs: 0
};

// ==============================================================================
// 1. HEALTH CHECK — Render & UptimeRobot Monitor
// ==============================================================================
app.get('/health', async (req, res) => {
    try {
        const { rows } = await pool.query(
            "SELECT count(*) AS total_pendientes FROM public.eor_sync_queue WHERE estado_sync = 'PENDIENTE' OR (estado_sync = 'EN_PROCESO' AND creado_el < NOW() - INTERVAL '5 minutes')"
        );
        const pendingCount = parseInt(rows[0]?.total_pendientes || 0, 10);

        return res.status(200).json({
            status: 'healthy',
            service: 'eor-sync-worker',
            version: '1.0.0',
            uptimeSeconds: Math.floor(process.uptime()),
            timestamp: new Date().toISOString(),
            pendingQueueCount: pendingCount,
            isProcessing,
            lastSync: lastSyncReport
        });
    } catch (err) {
        return res.status(200).json({
            status: 'degraded',
            service: 'eor-sync-worker',
            uptimeSeconds: Math.floor(process.uptime()),
            timestamp: new Date().toISOString(),
            warning: err.message,
            isProcessing
        });
    }
});

// ==============================================================================
// 2. ENDPOINT UPTIMEROBOT — Mantiene despierto el worker y procesa pendientes
// ==============================================================================
app.all(['/uptimerobot', '/api/uptimerobot'], async (req, res) => {
    const token = req.query.token || req.headers['x-monitor-token'] || req.headers['authorization'];
    
    // Si viene token y no coincide, advertir pero responder 200 para mantener el monitor verde
    const tokenMatch = !token || token === MONITOR_TOKEN || token === `Bearer ${MONITOR_TOKEN}`;

    // Responder de inmediato (<15ms) a UptimeRobot para métricas perfectas de latencia
    res.status(200).json({
        ok: true,
        monitorId: 'eor-sync-worker-uptime-v1',
        tokenValid: tokenMatch,
        message: 'Ping de UptimeRobot recibido con éxito. Servicio EOR activo.',
        timestamp: new Date().toISOString()
    });

    // En segundo plano: si hay pendientes y no está procesando, ejecutar lote
    if (!isProcessing) {
        setImmediate(async () => {
            try {
                const { rows } = await pool.query(
                    "SELECT count(*) AS total FROM public.eor_sync_queue WHERE estado_sync = 'PENDIENTE' OR (estado_sync = 'EN_PROCESO' AND creado_el < NOW() - INTERVAL '5 minutes')"
                );
                const count = parseInt(rows[0]?.total || 0, 10);
                if (count > 0) {
                    console.log(`⏰ [UptimeRobot Ping] ${count} mutaciones pendientes detectadas, ejecutando syncQueueConsumer...`);
                    await executeSync({ batchLimit: 50, dryRun: false });
                }
            } catch (bgErr) {
                console.error('⚠️ [UptimeRobot Ping] Error en verificación de fondo:', bgErr.message);
            }
        });
    }
});

// ==============================================================================
// 3. ENDPOINT MANUAL / N8N — Ejecución On-Demand con retorno de telemetría
// ==============================================================================
async function executeSync({ batchLimit = 50, dryRun = false } = {}) {
    if (isProcessing) {
        return {
            status: 'ALREADY_RUNNING',
            message: 'Hay una sincronización en curso. Se omite ejecución duplicada.',
            lastSync: lastSyncReport
        };
    }

    isProcessing = true;
    try {
        const stats = await processSyncQueue({ batchLimit, dryRun });
        lastSyncReport = {
            timestamp: new Date().toISOString(),
            ...stats
        };
        return {
            status: 'SUCCESS',
            stats
        };
    } catch (err) {
        lastSyncReport = {
            timestamp: new Date().toISOString(),
            error: err.message
        };
        throw err;
    } finally {
        isProcessing = false;
    }
}

app.all(['/api/sync/run', '/api/sync/queue'], async (req, res) => {
    const limit = parseInt(req.query.limit || req.body?.limit || 50, 10);
    const dryRun = req.query.dryRun === 'true' || req.body?.dryRun === true;

    try {
        const result = await executeSync({ batchLimit: limit, dryRun });
        return res.status(200).json({
            success: true,
            ...result
        });
    } catch (err) {
        return res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

// ==============================================================================
// 4. STATUS DASHBOARD & INSTRUCCIONES
// ==============================================================================
app.get(['/', '/status', '/api/status'], async (req, res) => {
    let pendingCount = 0;
    try {
        const { rows } = await pool.query(
            "SELECT count(*) AS total FROM public.eor_sync_queue WHERE estado_sync = 'PENDIENTE'"
        );
        pendingCount = parseInt(rows[0]?.total || 0, 10);
    } catch (e) {
        pendingCount = -1;
    }

    const host = req.get('host') || 'eor-sync-worker.onrender.com';
    const proto = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
    const baseUrl = `${proto}://${host}`;

    res.status(200).json({
        app: 'EOR Sync Queue Microservice (Supabase -> Google Sheets)',
        service: 'eor-sync-worker',
        status: 'ONLINE',
        uptimeSeconds: Math.floor(process.uptime()),
        memoryUsageMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
        queue: {
            pendingMutations: pendingCount,
            isProcessing
        },
        lastSync: lastSyncReport,
        uptimeRobotConfig: {
            monitorType: 'HTTP(s)',
            friendlyName: 'EOR Sync Worker (SB -> Sheets)',
            monitorUrl: `${baseUrl}/health`,
            pingWithAutoSyncUrl: `${baseUrl}/uptimerobot?token=${MONITOR_TOKEN}`,
            recommendedInterval: '5 minutes',
            monitorToken: MONITOR_TOKEN
        },
        endpoints: {
            health: 'GET /health',
            uptimeRobot: `GET /uptimerobot?token=${MONITOR_TOKEN}`,
            manualRun: 'GET|POST /api/sync/run?limit=50',
            status: 'GET /status'
        }
    });
});

// ==============================================================================
// 5. AUTONOMOUS BACKGROUND RUNNER (Cada 90 segundos mientras esté activo)
// ==============================================================================
const POLLING_INTERVAL_MS = 90 * 1000;
setInterval(async () => {
    if (isProcessing) return;
    try {
        const { rows } = await pool.query(
            "SELECT count(*) AS total FROM public.eor_sync_queue WHERE estado_sync = 'PENDIENTE'"
        );
        const count = parseInt(rows[0]?.total || 0, 10);
        if (count > 0) {
            console.log(`\n⚡ [Auto-Runner] ${count} registros pendientes detectados en eor_sync_queue. Consumiendo...`);
            await executeSync({ batchLimit: 50, dryRun: false });
        }
    } catch (err) {
        console.warn('⚠️ [Auto-Runner] Error en sondeo periódico:', err.message);
    }
}, POLLING_INTERVAL_MS);

// ==============================================================================
// 6. INICIALIZACIÓN
// ==============================================================================
const server = app.listen(PORT, () => {
    console.log(`\n========================================================================`);
    console.log(`🚀 EOR SYNC WORKER MICROSERVICE ACTIVO`);
    console.log(`   • Puerto: ${PORT}`);
    console.log(`   • Health Check: http://localhost:${PORT}/health`);
    console.log(`   • UptimeRobot Ping: http://localhost:${PORT}/uptimerobot?token=${MONITOR_TOKEN}`);
    console.log(`   • Endpoint Manual: http://localhost:${PORT}/api/sync/run`);
    console.log(`   • Polling Interval: cada ${POLLING_INTERVAL_MS / 1000}s`);
    console.log(`========================================================================\n`);
});

// Cierre ordenado
process.on('SIGTERM', () => {
    console.log('🛑 [SIGTERM] Cerrando worker ordenadamente...');
    server.close(() => {
        pool.end();
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('🛑 [SIGINT] Cerrando worker ordenadamente...');
    server.close(() => {
        pool.end();
        process.exit(0);
    });
});
