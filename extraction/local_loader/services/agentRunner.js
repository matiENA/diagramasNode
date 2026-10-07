/**
 * services/agentRunner.js
 * 
 * Estandarización de Runner de Agentes (Agentic Workflow).
 * Permite ejecutar, supervisar y auto-recuperar tareas tanto en Node.js como en Python,
 * reportando métricas estructuradas, logs en streaming y anomalías detectadas
 * hacia n8n y el panel de control.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const EventEmitter = require('events');
const pipelineManager = require('./pipelineManager');
const extractorService = require('./extractorService');
const injectorService = require('./injectorService');
const storage = require('./storageHelper');

class AgentRunner extends EventEmitter {
    constructor() {
        super();
        this.tasksHistory = [];
        this.maxHistory = 50;
        this.runningTasks = new Map();
        this.tasksMap = new Map();
        
        // Detectar binario de Python
        this.pythonBinary = this._detectPythonBinary();
    }

    _detectPythonBinary() {
        // En Windows puede ser 'python' o 'py'
        return process.env.PYTHON_PATH || 'python';
    }

    validateAndHealExtraction(moduleKey, data) {
        const anomalies = [];

        // Módulo general 'all'
        if (moduleKey === 'all') {
            const results = (data && data.results) ? data.results : data;
            if (!results || typeof results !== 'object' || Object.keys(results).length === 0) {
                anomalies.push({
                    type: 'EMPTY_ALL_DATA',
                    severity: 'high',
                    message: 'El módulo general retornó un conjunto de resultados vacío.'
                });
                return { isValid: false, anomalies, healedData: data };
            }

            let totalRecords = 0;
            for (const [subMod, subRes] of Object.entries(results)) {
                if (subRes && subRes.records) {
                    totalRecords += subRes.records;
                }
                if (subRes && subRes.success === false) {
                    anomalies.push({
                        type: 'SUBMODULE_WARNING',
                        severity: 'low',
                        message: `Submódulo '${subMod}' advirtió: ${subRes.error || 'falla parcial no crítica'}.`,
                        autoHealed: true
                    });
                }
            }

            if (totalRecords === 0) {
                anomalies.push({
                    type: 'ZERO_RECORDS',
                    severity: 'high',
                    message: 'No se encontraron registros en ninguna planilla.'
                });
            }

            return {
                isValid: anomalies.filter(a => a.severity === 'high').length === 0,
                anomalies,
                healedData: results
            };
        }

        if (!data) {
            anomalies.push({
                type: 'EMPTY_DATA',
                severity: 'high',
                message: `El módulo '${moduleKey}' retornó un dataset vacío o nulo.`
            });
            return { isValid: false, anomalies, healedData: data };
        }

        // Reglas de auto-recuperación por módulo
        if (moduleKey === 'master') {
            const tractores = data.marcasTractores || {};
            const semis = data.marcasSemis || {};
            const total = Object.keys(tractores).length + Object.keys(semis).length;
            if (total === 0) {
                anomalies.push({
                    type: 'MISSING_BRANDS',
                    severity: 'high',
                    message: 'No se encontraron marcas de tractores ni semis en la planilla Master.'
                });
            }
        }

        if (moduleKey === 'vencimientos') {
            const patentes = data.vencimientosPorPatente || {};
            const count = Object.keys(patentes).length;
            if (count < 10) {
                anomalies.push({
                    type: 'LOW_RECORD_COUNT',
                    severity: 'medium',
                    message: `Se extrajeron solo ${count} patentes con vencimientos. Verificar nombres de pestañas en Uni QM.`
                });
            }
        }

        if (moduleKey === 'legajos') {
            const choferes = data.choferes || [];
            let docsSinDni = 0;
            choferes.forEach(c => {
                if (!c.dni && !c.cuil) docsSinDni++;
            });
            if (docsSinDni > 0) {
                anomalies.push({
                    type: 'DOCS_WITHOUT_IDENTIFIER',
                    severity: 'low',
                    message: `${docsSinDni} registros de chofer no poseen DNI ni CUIL válidos (se intentará fuzzy match por nombre).`,
                    autoHealed: true
                });
            }
        }

        return {
            isValid: anomalies.filter(a => a.severity === 'high').length === 0,
            anomalies,
            healedData: data
        };
    }

    /**
     * Ejecuta una tarea en Python capturando stdout/stderr y retornando métricas estructuradas
     */
    async runPythonScript(scriptPath, args = [], options = {}, logFn = null) {
        const log = logFn || ((lvl, msg) => console.log(`[PYTHON] [${lvl.toUpperCase()}] ${msg}`));
        const fullPath = path.isAbsolute(scriptPath) ? scriptPath : path.resolve(process.cwd(), scriptPath);

        if (!fs.existsSync(fullPath)) {
            throw new Error(`El script de Python no existe en la ruta: ${fullPath}`);
        }

        const t0 = Date.now();
        log('info', `🐍 Iniciando ejecución de Python: ${path.basename(fullPath)} con ${args.length} argumentos...`);

        return new Promise((resolve, reject) => {
            const child = spawn(this.pythonBinary, [fullPath, ...args], {
                cwd: path.dirname(fullPath),
                env: { ...process.env, PYTHONIOENCODING: 'utf-8', ...options.env }
            });

            let stdoutRaw = '';
            let stderrRaw = '';
            const logsCaptured = [];

            child.stdout.on('data', (chunk) => {
                const text = chunk.toString('utf-8');
                stdoutRaw += text;
                const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
                lines.forEach(line => {
                    log('info', `[PyOut] ${line}`);
                    logsCaptured.push({ stream: 'stdout', message: line, timestamp: new Date().toISOString() });
                });
            });

            child.stderr.on('data', (chunk) => {
                const text = chunk.toString('utf-8');
                stderrRaw += text;
                const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
                lines.forEach(line => {
                    log('warn', `[PyErr] ${line}`);
                    logsCaptured.push({ stream: 'stderr', message: line, timestamp: new Date().toISOString() });
                });
            });

            // Timeout de seguridad (por defecto 3 minutos)
            const timeoutMs = options.timeoutMs || 180000;
            const timer = setTimeout(() => {
                child.kill('SIGTERM');
                reject(new Error(`Timeout de ejecución excedido (${timeoutMs / 1000}s) para script Python: ${fullPath}`));
            }, timeoutMs);

            child.on('close', (code) => {
                clearTimeout(timer);
                const durationMs = Date.now() - t0;

                // Intentar parsear si el script devolvió JSON en su última línea o bloque
                let parsedOutput = null;
                try {
                    const trimmed = stdoutRaw.trim();
                    const lastJsonStart = trimmed.lastIndexOf('{');
                    if (lastJsonStart !== -1) {
                        parsedOutput = JSON.parse(trimmed.substring(lastJsonStart));
                    }
                } catch (e) {
                    // No es JSON estructurado, se devuelve texto crudo
                }

                if (code === 0) {
                    log('success', `🏁 Script Python finalizado con éxito (código 0) en ${durationMs}ms`);
                    resolve({
                        success: true,
                        exitCode: code,
                        durationMs,
                        script: path.basename(fullPath),
                        data: parsedOutput || { rawOutput: stdoutRaw.trim() },
                        logs: logsCaptured
                    });
                } else {
                    const errMsg = `El script Python terminó con código de error ${code}. Detalle: ${stderrRaw.trim() || stdoutRaw.trim()}`;
                    log('error', `❌ ${errMsg}`);
                    reject(new Error(errMsg));
                }
            });

            child.on('error', (err) => {
                clearTimeout(timer);
                log('error', `❌ Error spawning proceso Python: ${err.message}`);
                reject(err);
            });
        });
    }

    /**
     * Endpoint central de ejecución de tareas de agente para n8n
     */
    async executeAgentTask({
        taskId: customTaskId = null,
        task = 'extract',       // 'extract' | 'inject' | 'sync' | 'python'
        module = 'all',         // 'master' | 'vencimientos' | 'flota' | 'diagramas' | 'kilometros' | 'legajos' | 'all'
        engine = 'node',        // 'node' | 'python'
        scriptPath = null,
        args = [],
        options = {}
    }) {
        const taskId = customTaskId || `agent_${task}_${module}_${Date.now()}`;
        const t0 = Date.now();
        const logs = [];

        const taskLog = (level, message, meta = {}) => {
            const entry = pipelineManager.log(level, `[Agente ${task.toUpperCase()}] ${message}`, { taskId, ...meta });
            logs.push(entry);
            this.emit('task_log', { taskId, entry });
        };

        taskLog('info', `Iniciando tarea agente [${task}] en módulo [${module}] con motor [${engine}]`);

        const taskMeta = {
            taskId,
            task,
            module,
            engine,
            status: 'running',
            startedAt: new Date().toISOString()
        };
        this.runningTasks.set(taskId, taskMeta);
        this.tasksMap.set(taskId, taskMeta);

        try {
            let resultData = null;
            let anomalies = [];

            // 1. Ejecución de script Python
            if (engine === 'python' || task === 'python') {
                if (!scriptPath) {
                    throw new Error("Para tareas con motor 'python' se requiere el parámetro 'scriptPath'.");
                }
                const pyRes = await this.runPythonScript(scriptPath, args, options, taskLog);
                resultData = pyRes;
            } 
            // 2. Extracción Node.js (Chunk 1 / Agente A)
            else if (task === 'extract') {
                const jobRes = await pipelineManager.extract(module, options);
                const rawData = (module === 'all')
                    ? (jobRes.result?.results || jobRes.result)
                    : (jobRes.result?.data || jobRes.result);

                // Validación y auto-recuperación
                const healReport = this.validateAndHealExtraction(module, rawData);
                anomalies = healReport.anomalies;

                // Sanitizar payload para que la respuesta HTTP a n8n sea liviana (<5KB en vez de 30MB)
                const sanitizedJobRes = { ...jobRes };
                if (sanitizedJobRes.result && sanitizedJobRes.result.data) {
                    const { data, ...summary } = sanitizedJobRes.result;
                    sanitizedJobRes.result = summary;
                }
                if (sanitizedJobRes.result && sanitizedJobRes.result.results) {
                    const cleanSubResults = {};
                    for (const [k, v] of Object.entries(sanitizedJobRes.result.results)) {
                        if (v && v.data) {
                            const { data, ...subMeta } = v;
                            cleanSubResults[k] = subMeta;
                        } else {
                            cleanSubResults[k] = v;
                        }
                    }
                    sanitizedJobRes.result = {
                        ...sanitizedJobRes.result,
                        results: cleanSubResults
                    };
                }

                resultData = {
                    ...sanitizedJobRes,
                    anomaliesCount: anomalies.length,
                    anomalies
                };
            } 
            // 3. Inyección a Supabase Node.js (Chunk 2 / Agente B)
            else if (task === 'inject') {
                const jobRes = await pipelineManager.inject(module, options);
                resultData = jobRes;
            } 
            // 4. Pipeline Completo (Sync Extracción + Inyección)
            else if (task === 'sync') {
                const jobRes = await pipelineManager.sync(module, options);
                resultData = jobRes;
            } 
            // 5. Consumo de Cola de Sincronización (Agente C: eor_sync_queue -> Google Sheets)
            else if (task === 'sync-queue' || task === 'queue-consumer') {
                const syncQueueConsumer = require('./syncQueueConsumer');
                const queueStats = await syncQueueConsumer.processSyncQueue({
                    batchLimit: options.batchLimit || 50,
                    dryRun: options.dryRun || false
                });
                resultData = queueStats;
            } else {
                throw new Error(`Tipo de tarea desconocida: ${task}`);
            }

            const durationMs = Date.now() - t0;
            const completedTask = {
                taskId,
                task,
                module,
                engine,
                status: anomalies.some(a => a.severity === 'high') ? 'warning' : 'success',
                durationMs,
                completedAt: new Date().toISOString(),
                anomalies,
                result: resultData,
                logsCount: logs.length
            };

            this.runningTasks.delete(taskId);
            this.tasksMap.set(taskId, completedTask);
            this.tasksHistory.unshift(completedTask);
            if (this.tasksHistory.length > this.maxHistory) this.tasksHistory.pop();

            taskLog('success', `🏁 Tarea [${taskId}] completada en ${durationMs}ms (Estado: ${completedTask.status})`);
            return completedTask;

        } catch (error) {
            const durationMs = Date.now() - t0;
            const failedTask = {
                taskId,
                task,
                module,
                engine,
                status: 'error',
                durationMs,
                completedAt: new Date().toISOString(),
                error: error.message,
                logsCount: logs.length
            };

            this.runningTasks.delete(taskId);
            this.tasksMap.set(taskId, failedTask);
            this.tasksHistory.unshift(failedTask);
            if (this.tasksHistory.length > this.maxHistory) this.tasksHistory.pop();

            taskLog('error', `❌ Tarea [${taskId}] falló: ${error.message}`);
            throw error;
        }
    }

    /**
     * Inicia una tarea en modo asíncrono no-bloqueante (retorna inmediatamente para n8n)
     */
    startAsyncTask(taskParams) {
        const taskId = `agent_${taskParams.task || 'task'}_${taskParams.module || 'all'}_${Date.now()}`;
        const taskMeta = {
            taskId,
            task: taskParams.task || 'extract',
            module: taskParams.module || 'all',
            engine: taskParams.engine || 'node',
            status: 'running',
            startedAt: new Date().toISOString()
        };
        this.runningTasks.set(taskId, taskMeta);
        this.tasksMap.set(taskId, taskMeta);

        // Disparar en segundo plano sin esperar
        (async () => {
            try {
                await this.executeAgentTask({ ...taskParams, taskId });
            } catch (err) {
                // El error ya es capturado y guardado en tasksMap
            }
        })();

        return taskMeta;
    }

    /**
     * Obtiene el estado o resultado de una tarea por su taskId
     */
    getTask(taskId) {
        if (this.tasksMap.has(taskId)) {
            return this.tasksMap.get(taskId);
        }
        const fromHistory = this.tasksHistory.find(t => t.taskId === taskId);
        return fromHistory || null;
    }

    getTasksHistory(limit = 20) {
        return this.tasksHistory.slice(0, limit);
    }

    getHealth() {
        return {
            status: 'ok',
            pythonBinary: this.pythonBinary,
            activeTasksCount: this.runningTasks.size,
            activeTasks: Array.from(this.runningTasks.values()),
            historyCount: this.tasksHistory.length
        };
    }
}

module.exports = new AgentRunner();
