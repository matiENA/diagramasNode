const EventEmitter = require('events');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const extractorService = require('./extractorService');
const injectorService = require('./injectorService');
const storage = require('./storageHelper');

class PipelineManager extends EventEmitter {
    constructor() {
        super();
        this.isBusy = false;
        this.currentJob = null;
        this.lastJob = null;
        this.history = [];
        this.logs = [];
        this.maxLogs = 300;
        this.maxHistory = 30;
    }

    log(level, message, meta = {}) {
        const entry = {
            id: Date.now() + Math.random().toString(36).substring(2, 6),
            timestamp: new Date().toISOString(),
            timeFormatted: new Date().toLocaleTimeString('es-AR'),
            level: level.toLowerCase(), // 'info' | 'success' | 'warn' | 'warning' | 'error'
            message,
            meta
        };

        this.logs.push(entry);
        if (this.logs.length > this.maxLogs) {
            this.logs.shift();
        }

        // Print to node console
        const prefix = `[${entry.timeFormatted}] [${entry.level.toUpperCase()}]`;
        if (entry.level === 'error') {
            console.error(`${prefix} ${message}`);
        } else if (entry.level === 'warn' || entry.level === 'warning') {
            console.warn(`${prefix} ${message}`);
        } else {
            console.log(`${prefix} ${message}`);
        }

        // Emit for SSE clients
        this.emit('log', entry);
        return entry;
    }

    getRecentLogs(limit = 100) {
        return this.logs.slice(-Math.min(limit, this.logs.length));
    }

    getStatus() {
        return {
            isBusy: this.isBusy,
            currentJob: this.currentJob,
            lastJob: this.lastJob,
            modules: storage.getDataStats(),
            uptimeSeconds: Math.floor(process.uptime()),
            memoryUsage: process.memoryUsage()
        };
    }

    async _executeJob(type, moduleKey, options = {}, executeFn) {
        if (this.isBusy) {
            const err = new Error(`Hay una operación ya en curso: ${this.currentJob?.type} (${this.currentJob?.module}) iniciada hace ${Math.round((Date.now() - (this.currentJob?.startTime || Date.now())) / 1000)}s`);
            err.statusCode = 409;
            throw err;
        }

        const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        this.isBusy = true;
        this.currentJob = {
            id: jobId,
            type, // 'extract' | 'inject' | 'sync'
            module: moduleKey,
            options,
            startTime: Date.now(),
            status: 'running'
        };

        this.log('info', `▶️ Iniciando trabajo [${type.toUpperCase()}] para módulo '${moduleKey}' (ID: ${jobId})`);
        this.emit('job_start', this.currentJob);

        const customLogger = (lvl, msg) => this.log(lvl, msg, { jobId, module: moduleKey });

        try {
            const result = await executeFn(customLogger);
            const durationMs = Date.now() - this.currentJob.startTime;

            const completedJob = {
                ...this.currentJob,
                status: 'success',
                durationMs,
                completedAt: new Date().toISOString(),
                result
            };

            this.lastJob = completedJob;
            this.history.unshift(completedJob);
            if (this.history.length > this.maxHistory) this.history.pop();

            this.log('success', `🏁 Trabajo [${type.toUpperCase()} / ${moduleKey}] finalizado con éxito en ${durationMs}ms`);
            this.emit('job_complete', completedJob);

            if (options.webhookUrl) {
                this._notifyWebhook(options.webhookUrl, completedJob);
            }

            return completedJob;
        } catch (err) {
            const durationMs = Date.now() - this.currentJob.startTime;
            const failedJob = {
                ...this.currentJob,
                status: 'error',
                durationMs,
                completedAt: new Date().toISOString(),
                error: err.message
            };

            this.lastJob = failedJob;
            this.history.unshift(failedJob);
            if (this.history.length > this.maxHistory) this.history.pop();

            this.log('error', `❌ Error en trabajo [${type.toUpperCase()} / ${moduleKey}]: ${err.message}`);
            this.emit('job_error', failedJob);

            if (options.webhookUrl) {
                this._notifyWebhook(options.webhookUrl, failedJob);
            }

            throw err;
        } finally {
            this.isBusy = false;
            this.currentJob = null;
        }
    }

    /**
     * Disparar extracción a archivos locales
     */
    async extract(moduleKey = 'all', options = {}) {
        return this._executeJob('extract', moduleKey, options, async (log) => {
            return await extractorService.extractModule(moduleKey, log);
        });
    }

    /**
     * Disparar inyección a Supabase
     */
    async inject(moduleKey = 'all', options = {}) {
        return this._executeJob('inject', moduleKey, options, async (log) => {
            return await injectorService.injectModule(moduleKey, options, log);
        });
    }

    /**
     * Disparar sincronización conjunta (Extracción + Inyección)
     */
    async sync(moduleKey = 'all', options = {}) {
        return this._executeJob('sync', moduleKey, options, async (log) => {
            log('info', `🔄 [Sync Pipeline] Paso 1/2: Extrayendo '${moduleKey}' a datos locales...`);
            const extractResult = await extractorService.extractModule(moduleKey, log);

            log('info', `🔄 [Sync Pipeline] Paso 2/2: Inyectando '${moduleKey}' a Supabase...`);
            const injectResult = await injectorService.injectModule(moduleKey, options, log);

            return {
                extract: extractResult,
                inject: injectResult
            };
        });
    }

    _notifyWebhook(webhookUrl, payload) {
        try {
            const urlObj = new URL(webhookUrl);
            const client = urlObj.protocol === 'https:' ? https : http;
            const body = JSON.stringify(payload);

            const req = client.request({
                hostname: urlObj.hostname,
                port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
                path: urlObj.pathname + urlObj.search,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                    'User-Agent': 'StorageRamDB-LocalLoader/1.0'
                },
                timeout: 10000
            }, (res) => {
                this.log('info', `🔔 Webhook notificado exitosamente a ${webhookUrl} (HTTP ${res.statusCode})`);
            });

            req.on('error', (e) => {
                this.log('warn', `⚠️ No se pudo enviar webhook a ${webhookUrl}: ${e.message}`);
            });

            req.write(body);
            req.end();
        } catch (err) {
            this.log('warn', `⚠️ URL de webhook inválida (${webhookUrl}): ${err.message}`);
        }
    }
}

module.exports = new PipelineManager();
