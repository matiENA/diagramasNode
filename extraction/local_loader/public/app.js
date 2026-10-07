// ==============================================================================
// 🚛 LOCAL ETL HUB & CONTROL PANEL — CLIENT LOGIC
// ==============================================================================

const MODULE_DEFINITIONS = {
    master: {
        id: 'master',
        name: 'Marcas Master',
        icon: '🏷️',
        sheet: 'Planilla Master (Tractores & Semis)',
        tables: 'public.tractores, public.semis',
        file: 'master_brands.json'
    },
    vencimientos: {
        id: 'vencimientos',
        name: 'Vencimientos',
        icon: '⏳',
        sheet: 'base datos Uni QM + Vencimientos',
        tables: 'vtv, mas, esp_es, vi, ve en tractores/semis',
        file: 'vencimientos.json'
    },
    flota: {
        id: 'flota',
        name: 'Flota y Movimientos',
        icon: '🚛',
        sheet: 'Movimientos (Mes Operativo)',
        tables: 'public.unidades, public.tractores, public.semis',
        file: 'movimientos_flota.json'
    },
    choferes: {
        id: 'choferes',
        name: 'Choferes Consolidados',
        icon: '👨‍✈️',
        sheet: 'Diagramas Detalle + Asignaciones Movimientos',
        tables: 'public.choferes, servicios_choferes',
        file: 'diagramas.json + flota.json'
    },
    movimientos: {
        id: 'movimientos',
        name: 'Movimientos Activos de Hoy',
        icon: '📍',
        sheet: 'Pareo Operativo Diario Unidad <-> Chofer',
        tables: 'public.movimientos, choferes.unidad_id',
        file: 'movimientos_flota.json'
    },
    diagramas: {
        id: 'diagramas',
        name: 'Diagramas Detalle (60d RAM)',
        icon: '📅',
        sheet: 'Planilla Diagramas (Pestañas Mensuales)',
        tables: 'public.diagramas (histórico), RAM Hot Cache',
        file: 'diagramas.json'
    },
    kilometros: {
        id: 'kilometros',
        name: 'Kilómetros y Viajes (6 meses)',
        icon: '🛣️',
        sheet: 'Planilla Kilómetros (Hojas de Ruta)',
        tables: 'public.movimientos_km, Hot RAM 2 meses',
        file: 'kilometros.json'
    },
    legajos: {
        id: 'legajos',
        name: 'Legajos y Documentación',
        icon: '📋',
        sheet: 'Documentos, Habilitaciones, Aptos, Observaciones',
        tables: 'public.chofer_documentacion, chofer_observaciones',
        file: 'legajos.json'
    }
};

let currentStatus = null;
let currentDataModule = 'flota';
let loadedModuleData = null;
let activeViewerMode = 'table';
let logCount = 0;
let eventSource = null;

// ==============================================================================
// 🚀 INICIALIZACIÓN
// ==============================================================================
document.addEventListener('DOMContentLoaded', () => {
    setupTabs();
    initSSE();
    fetchStatus();
});

// ==============================================================================
// 📑 SISTEMA DE PESTAÑAS
// ==============================================================================
function setupTabs() {
    const tabButtons = document.querySelectorAll('.tab-btn');
    tabButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            tabButtons.forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));

            btn.classList.add('active');
            const targetId = btn.getAttribute('data-tab');
            const pane = document.getElementById(targetId);
            if (pane) pane.classList.add('active');

            if (targetId === 'tab-data' && !loadedModuleData) {
                loadSelectedModuleData();
            }
        });
    });

    const searchInput = document.getElementById('inspector-search');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            filterTableData(e.target.value);
        });
    }
}

// ==============================================================================
// 📡 SERVER-SENT EVENTS (SSE)
// ==============================================================================
function initSSE() {
    if (eventSource) eventSource.close();

    eventSource = new EventSource('/api/events');

    eventSource.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            handleServerEvent(data);
        } catch (e) {
            console.error('Error parseando evento SSE:', e);
        }
    };

    eventSource.onerror = () => {
        const pill = document.getElementById('server-status-pill');
        if (pill) {
            pill.querySelector('.dot').className = 'dot red';
            document.getElementById('server-status-text').textContent = 'Reconectando...';
        }
        setTimeout(initSSE, 4000);
    };
}

function handleServerEvent(data) {
    if (data.type === 'init') {
        updateUIStatus(data.status);
        if (Array.isArray(data.recentLogs)) {
            data.recentLogs.forEach(entry => appendLogToTerminal(entry));
        }
    } else if (data.type === 'log') {
        appendLogToTerminal(data.entry);
    } else if (data.type === 'job_start') {
        showProgress(data.job);
        updateUIStatus(data.status);
        showToast('info', `▶️ Iniciado: ${data.job.type.toUpperCase()} (${data.job.module})`);
    } else if (data.type === 'job_complete') {
        hideProgress();
        updateUIStatus(data.status);
        showToast('success', `🏁 Finalizado: ${data.job.type.toUpperCase()} (${data.job.module}) en ${data.job.durationMs}ms`);
        if (document.getElementById('tab-data').classList.contains('active')) {
            loadSelectedModuleData();
        }
    } else if (data.type === 'job_error') {
        hideProgress();
        updateUIStatus(data.status);
        showToast('error', `❌ Error: ${data.job.error}`);
    }
}

// ==============================================================================
// 📊 ESTADO Y RENDERIZADO DE CARDS
// ==============================================================================
async function fetchStatus() {
    try {
        const res = await fetch('/api/status');
        const json = await res.json();
        if (json.success) {
            updateUIStatus(json);
        }
    } catch (e) {
        console.warn('No se pudo consultar /api/status:', e.message);
    }
}

function updateUIStatus(status) {
    if (!status) return;
    currentStatus = status;

    // Header Pills
    const serverPill = document.getElementById('server-status-pill');
    if (serverPill) {
        serverPill.querySelector('.dot').className = 'dot green';
        document.getElementById('server-status-text').textContent = 'Local: Activo';
    }

    const pipePill = document.getElementById('pipeline-status-pill');
    const pipeText = document.getElementById('pipeline-status-text');
    if (pipePill && pipeText) {
        if (status.isBusy) {
            pipePill.querySelector('.dot').className = 'dot amber';
            pipeText.textContent = `Procesando: ${status.currentJob?.module || ''}`;
        } else {
            pipePill.querySelector('.dot').className = 'dot green';
            pipeText.textContent = 'Listo';
        }
    }

    // Memoria
    const memEl = document.getElementById('memory-usage-text');
    if (memEl && status.memoryUsage) {
        const rssMb = Math.round(status.memoryUsage.rss / 1024 / 1024);
        memEl.textContent = `RAM: ${rssMb} MB`;
    }

    // Renderizar Cards de Extracción e Inyección
    renderExtractCards(status.modules);
    renderInjectCards(status.modules);
    renderInspectorFiles(status.modules);
}

function renderExtractCards(modules = {}) {
    const container = document.getElementById('extract-cards-list');
    if (!container) return;

    const extractKeys = ['master', 'vencimientos', 'flota', 'diagramas', 'kilometros', 'legajos'];
    let html = '';

    extractKeys.forEach(k => {
        const def = MODULE_DEFINITIONS[k] || { name: k, icon: '📦', sheet: '' };
        const mod = modules[k] || {};

        const isBusy = currentStatus?.isBusy;
        const statusClass = mod.status === 'extracted' ? 'extracted' : (mod.status === 'error' ? 'error' : 'idle');
        const statusText = mod.status === 'extracted' ? 'Extraído' : (mod.status === 'error' ? 'Error' : 'Pendiente');
        const extractedDate = mod.extractedAt ? new Date(mod.extractedAt).toLocaleString('es-AR') : 'Nunca';
        const records = mod.recordsExtracted || 0;
        const fileSize = mod.fileSizeFormatted || '0 B';

        html += `
            <div class="module-card">
                <div class="card-info">
                    <div class="card-title-row">
                        <span class="card-icon">${def.icon}</span>
                        <span class="card-name">${def.name}</span>
                        <span class="badge-status ${statusClass}">${statusText}</span>
                    </div>
                    <p class="card-desc">${def.sheet}</p>
                    <div class="card-meta-row">
                        <span class="meta-item">Registros: <strong>${records.toLocaleString('es-AR')}</strong></span>
                        <span class="meta-item">Archivo: <strong>${fileSize}</strong></span>
                        <span class="meta-item">Fecha: <strong>${extractedDate}</strong></span>
                    </div>
                </div>
                <div class="card-actions">
                    <button class="btn btn-sm btn-outline" ${isBusy ? 'disabled' : ''} onclick="triggerExtract('${k}')">
                        <span>📥 Extraer</span>
                    </button>
                </div>
            </div>
        `;
    });

    container.innerHTML = html;
}

function renderInjectCards(modules = {}) {
    const container = document.getElementById('inject-cards-list');
    if (!container) return;

    const injectKeys = ['flota', 'choferes', 'movimientos', 'diagramas', 'kilometros', 'legajos'];
    let html = '';

    injectKeys.forEach(k => {
        const def = MODULE_DEFINITIONS[k] || { name: k, icon: '📦', tables: '' };
        const mod = modules[k] || {};

        const isBusy = currentStatus?.isBusy;
        const statusClass = mod.status === 'injected' ? 'injected' : (mod.status === 'error' ? 'error' : 'idle');
        const statusText = mod.status === 'injected' ? 'Inyectado' : (mod.status === 'error' ? 'Error' : 'Pendiente');
        const injectedDate = mod.injectedAt ? new Date(mod.injectedAt).toLocaleString('es-AR') : 'Nunca';
        const records = mod.recordsInjected || 0;

        html += `
            <div class="module-card">
                <div class="card-info">
                    <div class="card-title-row">
                        <span class="card-icon">${def.icon}</span>
                        <span class="card-name">${def.name}</span>
                        <span class="badge-status ${statusClass}">${statusText}</span>
                    </div>
                    <p class="card-desc">Tablas: ${def.tables}</p>
                    <div class="card-meta-row">
                        <span class="meta-item">Afectados: <strong>${records.toLocaleString('es-AR')}</strong></span>
                        <span class="meta-item">Fecha: <strong>${injectedDate}</strong></span>
                    </div>
                </div>
                <div class="card-actions">
                    <button class="btn btn-sm btn-outline" ${isBusy ? 'disabled' : ''} onclick="triggerInject('${k}')">
                        <span>📤 Inyectar</span>
                    </button>
                    <button class="btn btn-sm btn-ghost" title="Simular inyección sin escribir en Supabase" ${isBusy ? 'disabled' : ''} onclick="triggerInject('${k}', true)">
                        <span>🔍 Simular</span>
                    </button>
                </div>
            </div>
        `;
    });

    container.innerHTML = html;
}

// ==============================================================================
// ⚡ DISPARADORES DE ACCIÓN
// ==============================================================================
async function triggerExtract(moduleKey) {
    if (currentStatus?.isBusy) {
        showToast('warning', 'Ya hay una operación en curso. Por favor espera.');
        return;
    }

    try {
        const res = await fetch(`/api/extract/${moduleKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        const json = await res.json();
        if (!json.success) {
            showToast('error', json.error || 'Error al iniciar extracción');
        }
    } catch (e) {
        showToast('error', `Error de conexión: ${e.message}`);
    }
}

async function triggerInject(moduleKey, forceDryRun = false) {
    if (currentStatus?.isBusy) {
        showToast('warning', 'Ya hay una operación en curso. Por favor espera.');
        return;
    }

    const isDryRun = forceDryRun || document.getElementById('global-dry-run').checked;

    try {
        const res = await fetch(`/api/inject/${moduleKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dryRun: isDryRun })
        });
        const json = await res.json();
        if (!json.success) {
            showToast('error', json.error || 'Error al iniciar inyección');
        }
    } catch (e) {
        showToast('error', `Error de conexión: ${e.message}`);
    }
}

async function triggerSync(moduleKey) {
    if (currentStatus?.isBusy) {
        showToast('warning', 'Ya hay una operación en curso. Por favor espera.');
        return;
    }

    const isDryRun = document.getElementById('global-dry-run').checked;

    try {
        const res = await fetch(`/api/sync/${moduleKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dryRun: isDryRun })
        });
        const json = await res.json();
        if (!json.success) {
            showToast('error', json.error || 'Error al iniciar sincronización');
        }
    } catch (e) {
        showToast('error', `Error de conexión: ${e.message}`);
    }
}

function showProgress(job) {
    const bar = document.getElementById('global-progress-bar');
    const label = document.getElementById('progress-label');
    if (bar && label) {
        bar.style.display = 'block';
        label.textContent = `Procesando [${job.type.toUpperCase()}] para módulo '${job.module}'...`;
    }
    document.querySelectorAll('.btn').forEach(b => {
        if (!b.classList.contains('tab-btn')) b.setAttribute('disabled', 'true');
    });
}

function hideProgress() {
    const bar = document.getElementById('global-progress-bar');
    if (bar) bar.style.display = 'none';
    document.querySelectorAll('.btn').forEach(b => {
        b.removeAttribute('disabled');
    });
}

// ==============================================================================
// 🔍 VISOR DE DATOS LOCALES
// ==============================================================================
function renderInspectorFiles(modules = {}) {
    const list = document.getElementById('inspector-file-list');
    if (!list) return;

    const fileKeys = ['master', 'vencimientos', 'flota', 'diagramas', 'kilometros', 'legajos'];
    let html = '';

    fileKeys.forEach(k => {
        const def = MODULE_DEFINITIONS[k] || { name: k, icon: '📄' };
        const mod = modules[k] || {};
        const activeClass = k === currentDataModule ? 'active' : '';
        const size = mod.fileSizeFormatted || '0 B';

        html += `
            <div class="file-item ${activeClass}" onclick="selectModuleForInspection('${k}')">
                <span>${def.icon} ${def.name}</span>
                <span class="file-size">${size}</span>
            </div>
        `;
    });

    list.innerHTML = html;
}

function selectModuleForInspection(moduleKey) {
    currentDataModule = moduleKey;
    document.querySelectorAll('.file-item').forEach(el => el.classList.remove('active'));
    renderInspectorFiles(currentStatus?.modules || {});
    loadSelectedModuleData();
}

async function loadSelectedModuleData() {
    const titleEl = document.getElementById('inspector-filename');
    const metaEl = document.getElementById('inspector-meta');
    const jsonCodeEl = document.getElementById('inspector-json-code');

    titleEl.textContent = `Cargando datos de '${currentDataModule}'...`;

    try {
        const res = await fetch(`/api/data/${currentDataModule}`);
        if (!res.ok) {
            titleEl.textContent = `${currentDataModule}.json (No generado aún)`;
            metaEl.textContent = 'Este archivo aún no ha sido extraído a local. Haz clic en "Extraer" primero.';
            jsonCodeEl.textContent = '// Archivo no encontrado. Ejecuta la extracción de este módulo.';
            document.getElementById('data-table-header').innerHTML = '';
            document.getElementById('data-table-body').innerHTML = '<tr><td style="color:#9ca3af;text-align:center;padding:2rem;">Sin datos. Realiza una extracción previa.</td></tr>';
            loadedModuleData = null;
            return;
        }

        const json = await res.json();
        loadedModuleData = json.data;

        const modMeta = currentStatus?.modules?.[currentDataModule] || {};
        titleEl.textContent = `${modMeta.file || currentDataModule + '.json'}`;
        metaEl.textContent = `Tamaño: ${modMeta.fileSizeFormatted || '--'} | Registros: ${modMeta.recordsExtracted || '--'} | Última extracción: ${modMeta.extractedAt ? new Date(modMeta.extractedAt).toLocaleString('es-AR') : '--'}`;

        // Render JSON
        jsonCodeEl.textContent = JSON.stringify(loadedModuleData, null, 2);

        // Render Table View
        renderTablePreview(loadedModuleData);
    } catch (e) {
        titleEl.textContent = 'Error al cargar';
        metaEl.textContent = e.message;
    }
}

function renderTablePreview(data) {
    const headerEl = document.getElementById('data-table-header');
    const bodyEl = document.getElementById('data-table-body');
    if (!headerEl || !bodyEl) return;

    let items = [];
    if (data.units && Array.isArray(data.units)) items = data.units;
    else if (data.choferesDetalleList && Array.isArray(data.choferesDetalleList)) items = data.choferesDetalleList;
    else if (data.all6mTrips && Array.isArray(data.all6mTrips)) items = data.all6mTrips;
    else if (data.documentacion && Array.isArray(data.documentacion)) items = data.documentacion;
    else if (data.asignacionesHoy && Array.isArray(data.asignacionesHoy)) items = data.asignacionesHoy;
    else if (data.marcasTractores) {
        items = Object.entries(data.marcasTractores).map(([patente, marca]) => ({ tipo: 'Tractor', patente, marca }));
    } else if (data.vencimientosPorPatente) {
        items = Object.entries(data.vencimientosPorPatente).map(([patente, vals]) => ({ patente, ...vals }));
    }

    if (items.length === 0) {
        headerEl.innerHTML = '<th>Clave</th><th>Valor</th>';
        bodyEl.innerHTML = Object.entries(data).slice(0, 50).map(([k, v]) => `
            <tr>
                <td><strong>${k}</strong></td>
                <td>${typeof v === 'object' ? JSON.stringify(v).substring(0, 100) + '...' : v}</td>
            </tr>
        `).join('');
        return;
    }

    const sample = items[0] || {};
    const cols = Object.keys(sample).filter(k => typeof sample[k] !== 'object' || sample[k] === null).slice(0, 8);

    headerEl.innerHTML = cols.map(c => `<th>${c.toUpperCase()}</th>`).join('');

    const maxRows = 200;
    bodyEl.innerHTML = items.slice(0, maxRows).map(item => `
        <tr>
            ${cols.map(c => `<td>${item[c] !== null && item[c] !== undefined ? item[c] : '-'}</td>`).join('')}
        </tr>
    `).join('');
}

function filterTableData(term) {
    const search = (term || '').toLowerCase().trim();
    const rows = document.querySelectorAll('#data-table-body tr');
    rows.forEach(r => {
        const text = r.textContent.toLowerCase();
        r.style.display = (!search || text.includes(search)) ? '' : 'none';
    });
}

function setViewerMode(mode) {
    activeViewerMode = mode;
    document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
    document.querySelector(`.mode-btn[data-mode="${mode}"]`)?.classList.add('active');

    const tableSection = document.getElementById('inspector-table-view');
    const jsonSection = document.getElementById('inspector-json-view');

    if (mode === 'table') {
        tableSection.classList.add('active');
        jsonSection.classList.remove('active');
    } else {
        tableSection.classList.remove('active');
        jsonSection.classList.add('active');
    }
}

function downloadSelectedJson() {
    window.location.href = `/api/data/${currentDataModule}/download`;
}

function copySelectedJson() {
    if (!loadedModuleData) return;
    navigator.clipboard.writeText(JSON.stringify(loadedModuleData, null, 2))
        .then(() => showToast('success', 'JSON copiado al portapapeles'))
        .catch(() => showToast('error', 'No se pudo copiar'));
}

// ==============================================================================
// 💻 CONSOLA EN VIVO (TERMINAL)
// ==============================================================================
function appendLogToTerminal(entry) {
    const term = document.getElementById('terminal-output');
    if (!term) return;

    logCount++;
    const badge = document.getElementById('log-count-badge');
    if (badge) badge.textContent = logCount;

    const div = document.createElement('div');
    div.className = 'log-entry';
    div.innerHTML = `
        <span class="log-ts">[${entry.timeFormatted || new Date().toLocaleTimeString('es-AR')}]</span>
        <span class="log-lvl ${entry.level}">[${entry.level.toUpperCase()}]</span>
        <span class="log-msg">${escapeHtml(entry.message)}</span>
    `;

    term.appendChild(div);

    const autoscroll = document.getElementById('terminal-autoscroll')?.checked;
    if (autoscroll) {
        term.scrollTop = term.scrollHeight;
    }
}

function clearTerminal() {
    const term = document.getElementById('terminal-output');
    if (term) term.innerHTML = '';
    logCount = 0;
    const badge = document.getElementById('log-count-badge');
    if (badge) badge.textContent = '0';
}

function copyTerminalLogs() {
    const term = document.getElementById('terminal-output');
    if (!term) return;
    const text = term.innerText;
    navigator.clipboard.writeText(text)
        .then(() => showToast('success', 'Logs copiados al portapapeles'))
        .catch(() => showToast('error', 'No se pudo copiar'));
}

// ==============================================================================
// 🍞 TOAST NOTIFICATIONS
// ==============================================================================
function showToast(type, message) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const icon = type === 'success' ? '✅' : (type === 'error' ? '❌' : (type === 'warning' ? '⚠️' : 'ℹ️'));
    toast.innerHTML = `<span>${icon}</span><span>${escapeHtml(message)}</span>`;

    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(100%)';
        toast.style.transition = 'all 0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
