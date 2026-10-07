const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const MANIFEST_FILE = path.join(DATA_DIR, 'manifest.json');

const INITIAL_MODULES = {
    master: {
        id: 'master',
        name: 'Marcas Master',
        sheet: 'Planilla Master',
        file: 'master_brands.json',
        extractedAt: null,
        injectedAt: null,
        recordsExtracted: 0,
        recordsInjected: 0,
        fileSizeBytes: 0,
        status: 'idle',
        lastError: null
    },
    vencimientos: {
        id: 'vencimientos',
        name: 'Vencimientos',
        sheet: 'base datos Uni QM + Vencimientos.',
        file: 'vencimientos.json',
        extractedAt: null,
        injectedAt: null,
        recordsExtracted: 0,
        recordsInjected: 0,
        fileSizeBytes: 0,
        status: 'idle',
        lastError: null
    },
    flota: {
        id: 'flota',
        name: 'Flota Canónica y Pareo Hoy',
        sheet: 'Movimientos (Mes Operativo)',
        file: 'movimientos_flota.json',
        extractedAt: null,
        injectedAt: null,
        recordsExtracted: 0,
        recordsInjected: 0,
        fileSizeBytes: 0,
        status: 'idle',
        lastError: null
    },
    diagramas: {
        id: 'diagramas',
        name: 'Diagramas Detalle (60d RAM)',
        sheet: 'Planilla Diagramas',
        file: 'diagramas.json',
        extractedAt: null,
        injectedAt: null,
        recordsExtracted: 0,
        recordsInjected: 0,
        fileSizeBytes: 0,
        status: 'idle',
        lastError: null
    },
    kilometros: {
        id: 'kilometros',
        name: 'Kilómetros y Viajes (6 meses)',
        sheet: 'Planilla Kilómetros',
        file: 'kilometros.json',
        extractedAt: null,
        injectedAt: null,
        recordsExtracted: 0,
        recordsInjected: 0,
        fileSizeBytes: 0,
        status: 'idle',
        lastError: null
    },
    legajos: {
        id: 'legajos',
        name: 'Legajos, Vencimientos y Docs',
        sheet: 'Documentos, Habilitaciones, Aptos',
        file: 'legajos.json',
        extractedAt: null,
        injectedAt: null,
        recordsExtracted: 0,
        recordsInjected: 0,
        fileSizeBytes: 0,
        status: 'idle',
        lastError: null
    }
};

function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (!fs.existsSync(MANIFEST_FILE)) {
        const initial = {
            version: '1.0.0',
            updatedAt: new Date().toISOString(),
            modules: INITIAL_MODULES
        };
        fs.writeFileSync(MANIFEST_FILE, JSON.stringify(initial, null, 2), 'utf8');
    }
}

function getManifest() {
    ensureDataDir();
    try {
        const raw = fs.readFileSync(MANIFEST_FILE, 'utf8');
        return JSON.parse(raw);
    } catch (err) {
        console.error('⚠️ Error leyendo manifest.json:', err.message);
        return { version: '1.0.0', updatedAt: new Date().toISOString(), modules: INITIAL_MODULES };
    }
}

function updateManifest(moduleKey, patch) {
    ensureDataDir();
    try {
        const manifest = getManifest();
        if (!manifest.modules[moduleKey]) {
            manifest.modules[moduleKey] = { id: moduleKey, ...patch };
        } else {
            manifest.modules[moduleKey] = {
                ...manifest.modules[moduleKey],
                ...patch
            };
        }
        manifest.updatedAt = new Date().toISOString();
        fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2), 'utf8');
        return manifest.modules[moduleKey];
    } catch (err) {
        console.error(`⚠️ Error actualizando manifest para ${moduleKey}:`, err.message);
    }
}

function saveData(moduleKey, data) {
    ensureDataDir();
    const manifest = getManifest();
    const modConfig = manifest.modules[moduleKey] || INITIAL_MODULES[moduleKey] || { file: `${moduleKey}.json` };
    const filePath = path.join(DATA_DIR, modConfig.file);

    const jsonString = JSON.stringify(data, null, 2);
    fs.writeFileSync(filePath, jsonString, 'utf8');

    const stats = fs.statSync(filePath);
    let recordCount = 0;
    if (Array.isArray(data)) {
        recordCount = data.length;
    } else if (data && typeof data === 'object') {
        if (data.totalTractores !== undefined && data.totalSemis !== undefined) {
            recordCount = data.totalTractores + data.totalSemis;
        } else if (data.totalPatentes !== undefined) {
            recordCount = data.totalPatentes;
        } else if (data.totalUnits !== undefined) {
            recordCount = data.totalUnits;
        } else if (data.totalChoferes !== undefined) {
            recordCount = data.totalChoferes;
        } else if (data.totalViajes6m !== undefined) {
            recordCount = data.totalViajes6m;
        } else if (data.totalDocumentacion !== undefined) {
            recordCount = data.totalDocumentacion;
        } else if (data.records && Array.isArray(data.records)) {
            recordCount = data.records.length;
        } else if (data.units && Array.isArray(data.units)) {
            recordCount = data.units.length;
        } else if (data.choferes && Array.isArray(data.choferes)) {
            recordCount = data.choferes.length;
        } else if (data.trips && Array.isArray(data.trips)) {
            recordCount = data.trips.length;
        } else if (data.documentacion && Array.isArray(data.documentacion)) {
            recordCount = data.documentacion.length;
        } else {
            recordCount = Object.keys(data).length;
        }
    }

    updateManifest(moduleKey, {
        extractedAt: new Date().toISOString(),
        recordsExtracted: recordCount,
        fileSizeBytes: stats.size,
        status: 'extracted',
        lastError: null
    });

    return {
        file: modConfig.file,
        filePath,
        bytes: stats.size,
        records: recordCount
    };
}

function loadData(moduleKey) {
    ensureDataDir();
    const manifest = getManifest();
    const modConfig = manifest.modules[moduleKey] || INITIAL_MODULES[moduleKey];
    if (!modConfig) return null;

    const filePath = path.join(DATA_DIR, modConfig.file);
    if (!fs.existsSync(filePath)) return null;

    try {
        const raw = fs.readFileSync(filePath, 'utf8');
        return JSON.parse(raw);
    } catch (err) {
        console.error(`⚠️ Error leyendo archivo ${filePath}:`, err.message);
        return null;
    }
}

function getDataStats() {
    ensureDataDir();
    const manifest = getManifest();
    const result = {};
    for (const [key, mod] of Object.entries(manifest.modules)) {
        const filePath = path.join(DATA_DIR, mod.file);
        const exists = fs.existsSync(filePath);
        result[key] = {
            ...mod,
            exists,
            fileSizeFormatted: exists ? formatBytes(fs.statSync(filePath).size) : '0 B'
        };
    }
    return result;
}

function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

module.exports = {
    DATA_DIR,
    MANIFEST_FILE,
    ensureDataDir,
    getManifest,
    updateManifest,
    saveData,
    loadData,
    getDataStats,
    formatBytes
};
