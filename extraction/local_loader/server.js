const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const pipelineManager = require('./services/pipelineManager');
const storage = require('./services/storageHelper');
const agentRunner = require('./services/agentRunner');
const syncQueueConsumer = require('./services/syncQueueConsumer');

const app = express();
const PORT = parseInt(process.env.LOADER_PORT || process.env.PORT, 10) || 3010;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Servir archivos estáticos del panel de control
app.use(express.static(path.join(__dirname, 'public')));

// ==============================================================================
// 📡 SERVER-SENT EVENTS (SSE) - STREAMING DE LOGS Y EVENTOS EN TIEMPO REAL
// ==============================================================================
app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    // Enviar estado inicial y logs recientes
    const initialPayload = {
        type: 'init',
        status: pipelineManager.getStatus(),
        recentLogs: pipelineManager.getRecentLogs(50)
    };
    res.write(`data: ${JSON.stringify(initialPayload)}\n\n`);

    const logListener = (entry) => {
        res.write(`data: ${JSON.stringify({ type: 'log', entry })}\n\n`);
    };

    const startListener = (job) => {
        res.write(`data: ${JSON.stringify({ type: 'job_start', job, status: pipelineManager.getStatus() })}\n\n`);
    };

    const completeListener = (job) => {
        res.write(`data: ${JSON.stringify({ type: 'job_complete', job, status: pipelineManager.getStatus() })}\n\n`);
    };

    const errorListener = (job) => {
        res.write(`data: ${JSON.stringify({ type: 'job_error', job, status: pipelineManager.getStatus() })}\n\n`);
    };

    pipelineManager.on('log', logListener);
    pipelineManager.on('job_start', startListener);
    pipelineManager.on('job_complete', completeListener);
    pipelineManager.on('job_error', errorListener);

    // Keep-alive heartbeat cada 25 segundos
    const heartbeat = setInterval(() => {
        res.write(': keepalive\n\n');
    }, 25000);

    req.on('close', () => {
        clearInterval(heartbeat);
        pipelineManager.removeListener('log', logListener);
        pipelineManager.removeListener('job_start', startListener);
        pipelineManager.removeListener('job_complete', completeListener);
        pipelineManager.removeListener('job_error', errorListener);
    });
});

// ==============================================================================
// 🚦 ENDPOINTS MODULARES DE EXTRACCIÓN (Google Sheets -> Local JSON)
// ==============================================================================
app.post('/api/extract/:module', async (req, res) => {
    const { module } = req.params;
    const { webhookUrl } = req.body || {};

    try {
        const job = await pipelineManager.extract(module, { webhookUrl });
        res.status(200).json({
            success: true,
            message: `Extracción del módulo '${module}' finalizada con éxito.`,
            job
        });
    } catch (err) {
        const status = err.statusCode || 500;
        res.status(status).json({
            success: false,
            error: err.message,
            module
        });
    }
});

// ==============================================================================
// 📤 ENDPOINTS MODULARES DE INYECCIÓN (Local JSON -> Supabase)
// ==============================================================================
app.post('/api/inject/:module', async (req, res) => {
    const { module } = req.params;
    const dryRun = req.body?.dryRun === true || req.query.dryRun === 'true';
    const { webhookUrl } = req.body || {};

    try {
        const job = await pipelineManager.inject(module, { dryRun, webhookUrl });
        res.status(200).json({
            success: true,
            dryRun,
            message: `Inyección del módulo '${module}' a Supabase finalizada con éxito.`,
            job
        });
    } catch (err) {
        const status = err.statusCode || 500;
        res.status(status).json({
            success: false,
            error: err.message,
            module
        });
    }
});

// ==============================================================================
// ⚡ SYNC QUEUE CONSUMER (eor_sync_queue -> Google Sheets Batch Writer)
// ==============================================================================
app.post('/api/sync/queue', async (req, res) => {
    const dryRun = req.body?.dryRun === true || req.query.dryRun === 'true';
    const batchLimit = parseInt(req.body?.batchLimit || req.query.batchLimit, 10) || 50;

    try {
        const stats = await syncQueueConsumer.processSyncQueue({ batchLimit, dryRun });
        res.status(200).json({
            success: true,
            dryRun,
            stats
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

// ==============================================================================
// 🔄 ENDPOINTS DE PIPELINE CONJUNTO (Extracción + Inyección)
// ==============================================================================
app.post('/api/sync/:module', async (req, res) => {
    const { module } = req.params;
    const dryRun = req.body?.dryRun === true || req.query.dryRun === 'true';
    const { webhookUrl } = req.body || {};

    try {
        const job = await pipelineManager.sync(module, { dryRun, webhookUrl });
        res.status(200).json({
            success: true,
            dryRun,
            message: `Pipeline conjunto para '${module}' ejecutado con éxito.`,
            job
        });
    } catch (err) {
        const status = err.statusCode || 500;
        res.status(status).json({
            success: false,
            error: err.message,
            module
        });
    }
});

// Endpoint global /sync compatible con bat anterior
app.post('/sync', async (req, res) => {
    const dryRun = req.body?.dryRun === true || req.query.dryRun === 'true';
    try {
        const job = await pipelineManager.sync('all', { dryRun });
        res.status(200).json({ success: true, job });
    } catch (err) {
        res.status(err.statusCode || 500).json({ success: false, error: err.message });
    }
});

// ==============================================================================
// 🤖 AGENTIC WORKFLOW RUNNER (Node.js & Python para n8n)
// ==============================================================================
app.post('/agent/run-task', async (req, res) => {
    // Extender timeout HTTP en caso de ejecución síncrona larga
    req.setTimeout(900000);
    res.setTimeout(900000);

    try {
        const { task, module, engine, scriptPath, args, options, async: isAsync } = req.body || {};
        
        // Modo Asíncrono no-bloqueante (Recomendado para n8n)
        if (isAsync === true || req.query.async === 'true') {
            const taskMeta = agentRunner.startAsyncTask({
                task,
                module,
                engine,
                scriptPath,
                args,
                options
            });
            return res.status(202).json({
                success: true,
                status: 'running',
                taskId: taskMeta.taskId,
                statusUrl: `/agent/tasks/${taskMeta.taskId}`,
                message: `Tarea [${taskMeta.taskId}] iniciada en segundo plano.`
            });
        }

        // Modo Síncrono tradicional
        const taskResult = await agentRunner.executeAgentTask({
            task,
            module,
            engine,
            scriptPath,
            args,
            options
        });
        res.status(200).json({
            success: true,
            task: taskResult
        });
    } catch (err) {
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

app.get('/agent/tasks/:taskId', (req, res) => {
    const task = agentRunner.getTask(req.params.taskId);
    if (!task) {
        return res.status(404).json({
            success: false,
            error: `Tarea con ID '${req.params.taskId}' no encontrada.`
        });
    }
    res.status(200).json({
        success: true,
        task
    });
});

app.get('/agent/health', (req, res) => {
    res.status(200).json(agentRunner.getHealth());
});

app.get('/agent/tasks', (req, res) => {
    const limit = parseInt(req.query.limit, 10) || 20;
    res.status(200).json({
        success: true,
        tasks: agentRunner.getTasksHistory(limit)
    });
});

// ==============================================================================
// 📊 ESTADO, METADATOS Y LOGS
// ==============================================================================
app.get('/api/status', (req, res) => {
    res.status(200).json({
        success: true,
        ...pipelineManager.getStatus()
    });
});

app.get('/api/logs', (req, res) => {
    const limit = parseInt(req.query.limit, 10) || 100;
    res.status(200).json({
        success: true,
        logs: pipelineManager.getRecentLogs(limit)
    });
});

// ==============================================================================
// 📁 INSPECCIÓN Y DESCARGA DE DATOS LOCALES (JSON)
// ==============================================================================
app.get('/api/data/:module', (req, res) => {
    const { module } = req.params;
    const data = storage.loadData(module);
    if (!data) {
        return res.status(404).json({
            success: false,
            error: `No se encontraron datos locales para el módulo '${module}'. Ejecuta la extracción primero.`
        });
    }
    res.status(200).json({
        success: true,
        module,
        data
    });
});

app.get('/api/data/:module/download', (req, res) => {
    const { module } = req.params;
    const manifest = storage.getManifest();
    const modConfig = manifest.modules[module];
    if (!modConfig) {
        return res.status(404).json({ success: false, error: `Módulo '${module}' no existe.` });
    }
    const filePath = path.join(storage.DATA_DIR, modConfig.file);
    res.download(filePath, modConfig.file);
});

// ==============================================================================
// 🩺 HEALTH CHECK
// ==============================================================================
app.get('/health', (req, res) => {
    const status = pipelineManager.getStatus();
    res.status(200).json({
        status: 'ok',
        service: 'local-supabase-loader',
        port: PORT,
        isBusy: status.isBusy,
        currentJob: status.currentJob,
        lastJob: status.lastJob ? {
            type: status.lastJob.type,
            module: status.lastJob.module,
            status: status.lastJob.status,
            completedAt: status.lastJob.completedAt
        } : null,
        uptimeSeconds: status.uptimeSeconds
    });
});

// ==============================================================================
// 🚀 ARRANQUE DEL SERVIDOR
// ==============================================================================
const server = app.listen(PORT, () => {
    console.log('\n===============================================================');
    console.log(`🌐 [LOCAL SUPABASE LOADER] Servidor Activo en: http://localhost:${PORT}`);
    console.log(`   • Panel Web de Control:    http://localhost:${PORT}/`);
    console.log(`   • Health Check:            http://localhost:${PORT}/health`);
    console.log(`   • Estado del Pipeline:     http://localhost:${PORT}/api/status`);
    console.log(`   • Eventos SSE (Logs):      http://localhost:${PORT}/api/events`);
    console.log(`   • Extracción por módulo:   POST http://localhost:${PORT}/api/extract/:module`);
    console.log(`   • Inyección por módulo:    POST http://localhost:${PORT}/api/inject/:module`);
    console.log(`   • Sync Conjunto:           POST http://localhost:${PORT}/api/sync/:module`);
    console.log(`   • Consumo de Datos (n8n):  GET  http://localhost:${PORT}/api/data/:module`);
    console.log('===============================================================\n');
});

// Manejo de errores de puerto en uso
server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`\n❌ Error: El puerto ${PORT} ya está en uso.`);
        console.error(`   Cierra el proceso anterior o define otro puerto en .env (ej. PORT=3012).\n`);
    } else {
        console.error('❌ Error fatal en servidor HTTP:', err.message);
    }
});

module.exports = { app, server };
