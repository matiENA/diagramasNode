require('dotenv').config();
const { extractMasterBrands } = require('../extractors/masterBrands');
const { extractVencimientos } = require('../extractors/vencimientos');
const { extractMovimientosFlota } = require('../extractors/movimientosFlota');
const { extractDiagramasDetalle } = require('../extractors/diagramasDetalle');
const { extractKilometros } = require('../extractors/kilometros');
const { extractChoferesLegajo } = require('../extractors/choferesLegajo');
const storage = require('./storageHelper');
const { Pool } = require('pg');

const pool = process.env.DATABASE_URL ? new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
}) : null;

function defaultLog(level, msg) {
    const ts = new Date().toLocaleTimeString('es-AR');
    console.log(`[${ts}] [${level.toUpperCase()}] ${msg}`);
}

class ExtractorService {
    constructor() {
        storage.ensureDataDir();
    }

    /**
     * 1. Extraer Marcas Master -> master_brands.json
     */
    async extractMaster(log = defaultLog) {
        const t0 = Date.now();
        log('info', '📥 [Master] Iniciando extracción de marcas desde Planilla Master...');
        try {
            const spreadsheetId = process.env.ID_SPREADSHEET_MASTER || process.env.SPREADSHEET_ID;
            const { marcasTractores, marcasSemis } = await extractMasterBrands(spreadsheetId);
            const tractoresCount = Object.keys(marcasTractores).length;
            const semisCount = Object.keys(marcasSemis).length;

            const payload = {
                extractedAt: new Date().toISOString(),
                spreadsheetId,
                totalTractores: tractoresCount,
                totalSemis: semisCount,
                marcasTractores,
                marcasSemis
            };

            const saved = storage.saveData('master', payload);
            const duration = Date.now() - t0;
            log('success', `✅ [Master] Finalizado en ${duration}ms. ${tractoresCount} tractores y ${semisCount} semis indexados (${saved.file}, ${storage.formatBytes(saved.bytes)}).`);

            return {
                success: true,
                module: 'master',
                records: tractoresCount + semisCount,
                durationMs: duration,
                data: payload
            };
        } catch (err) {
            log('error', `❌ [Master] Error: ${err.message}`);
            storage.updateManifest('master', { status: 'error', lastError: err.message });
            throw err;
        }
    }

    /**
     * 2. Extraer Vencimientos -> vencimientos.json
     */
    async extractVencimientos(log = defaultLog) {
        const t0 = Date.now();
        log('info', '📥 [Vencimientos] Extrayendo catálogo de vencimientos delimitado a Mov.Unidades...');
        try {
            const spreadsheetId = process.env.ID_SHEET_MOVIMIENTOS;
            let patentesPermitidas = null;
            const flotaData = storage.loadData('flota');
            if (flotaData && Array.isArray(flotaData.units) && flotaData.units.length > 0) {
                patentesPermitidas = new Set();
                flotaData.units.forEach(u => {
                    if (u.tractor) patentesPermitidas.add(String(u.tractor).trim().toUpperCase().replace(/\s+/g, ''));
                    if (u.semi) patentesPermitidas.add(String(u.semi).trim().toUpperCase().replace(/\s+/g, ''));
                });
                log('info', `   🔍 Filtrando contra ${patentesPermitidas.size} patentes de flota activa en caché local.`);
            }

            const vencimientosPorPatente = await extractVencimientos(spreadsheetId, patentesPermitidas);
            const count = Object.keys(vencimientosPorPatente).length;

            const payload = {
                extractedAt: new Date().toISOString(),
                spreadsheetId,
                totalPatentes: count,
                vencimientosPorPatente
            };

            const saved = storage.saveData('vencimientos', payload);
            const duration = Date.now() - t0;
            log('success', `✅ [Vencimientos] Finalizado en ${duration}ms. ${count} patentes con vencimientos guardadas en ${saved.file}.`);

            return {
                success: true,
                module: 'vencimientos',
                records: count,
                durationMs: duration,
                data: payload
            };
        } catch (err) {
            log('error', `❌ [Vencimientos] Error: ${err.message}`);
            storage.updateManifest('vencimientos', { status: 'error', lastError: err.message });
            throw err;
        }
    }

    /**
     * 3. Extraer Flota y Movimientos Operativos -> movimientos_flota.json
     */
    async extractFlota(log = defaultLog) {
        const t0 = Date.now();
        log('info', '📥 [Flota] Extrayendo Flota Canónica y Pareo Diario de Movimientos...');
        try {
            // Cargar o extraer marcas y vencimientos necesarios para enriquecer la flota
            let masterData = storage.loadData('master');
            let vencData = storage.loadData('vencimientos');

            if (!masterData) {
                log('info', '   ℹ️ Marcas no encontradas en caché local. Extrayendo automáticamente...');
                const res = await this.extractMaster(log);
                masterData = res.data;
            }
            if (!vencData) {
                log('info', '   ℹ️ Vencimientos no encontrados en caché local. Extrayendo automáticamente...');
                const res = await this.extractVencimientos(log);
                vencData = res.data;
            }

            const spreadsheetId = process.env.ID_SHEET_MOVIMIENTOS;
            const { units, asignacionesHoy, choferesEnMovimientos, tabName } = await extractMovimientosFlota(
                spreadsheetId,
                masterData.marcasTractores || {},
                masterData.marcasSemis || {},
                vencData.vencimientosPorPatente || {}
            );

            // Convertir Map a objeto para serialización limpia JSON
            const choferesMapObj = {};
            for (const [key, val] of choferesEnMovimientos.entries()) {
                choferesMapObj[key] = val;
            }

            const payload = {
                extractedAt: new Date().toISOString(),
                spreadsheetId,
                tabName,
                totalUnits: units.length,
                totalAsignacionesHoy: asignacionesHoy.length,
                totalChoferesMovimientos: choferesEnMovimientos.size,
                units,
                asignacionesHoy,
                choferesEnMovimientos: choferesMapObj
            };

            const saved = storage.saveData('flota', payload);
            const duration = Date.now() - t0;
            log('success', `✅ [Flota] Finalizado en ${duration}ms. ${units.length} unidades y ${asignacionesHoy.length} asignaciones guardadas en ${saved.file}.`);

            return {
                success: true,
                module: 'flota',
                records: units.length,
                durationMs: duration,
                data: payload
            };
        } catch (err) {
            log('error', `❌ [Flota] Error: ${err.message}`);
            storage.updateManifest('flota', { status: 'error', lastError: err.message });
            throw err;
        }
    }

    /**
     * 4. Extraer Diagramas Detalle -> diagramas.json
     */
    async extractDiagramas(log = defaultLog) {
        const t0 = Date.now();
        log('info', '📥 [Diagramas] Extrayendo Diagramas Detalle y Ventana 60 días Hot RAM...');
        try {
            const spreadsheetId = process.env.ID_SPREADSHEET_DIAGRAMAS;
            const { choferesDetalleList, diagramas60DiasRAM, monthTabs } = await extractDiagramasDetalle(spreadsheetId);

            const payload = {
                extractedAt: new Date().toISOString(),
                spreadsheetId,
                monthTabs,
                totalChoferes: choferesDetalleList.length,
                diagramas60DiasRAM,
                choferesDetalleList
            };

            const saved = storage.saveData('diagramas', payload);
            const duration = Date.now() - t0;
            log('success', `✅ [Diagramas] Finalizado en ${duration}ms. ${choferesDetalleList.length} choferes a lo largo de ${monthTabs.length} meses guardados en ${saved.file}.`);

            return {
                success: true,
                module: 'diagramas',
                records: choferesDetalleList.length,
                durationMs: duration,
                data: payload
            };
        } catch (err) {
            log('error', `❌ [Diagramas] Error: ${err.message}`);
            storage.updateManifest('diagramas', { status: 'error', lastError: err.message });
            throw err;
        }
    }

    /**
     * 5. Extraer Kilómetros (6 meses y 2 meses Hot RAM) -> kilometros.json
     */
    async extractKilometros(log = defaultLog) {
        const t0 = Date.now();
        log('info', '📥 [Kilómetros] Extrayendo viajes y KMs de los últimos 6 meses desde Google Sheets...');
        try {
            // Usamos unidades y choferes de la caché local si existen para enriquecer
            const flotaData = storage.loadData('flota');
            const diagData = storage.loadData('diagramas');

            const unidades = flotaData ? flotaData.units : [];
            const choferes = diagData ? diagData.choferesDetalleList : [];

            // Llamamos a extractKilometros pasando pool si está disponible para resolver UUIDs canónicos
            const kmResult = await extractKilometros(unidades, choferes, pool);

            const payload = {
                extractedAt: new Date().toISOString(),
                resumen: kmResult.resumen,
                totalViajes6m: kmResult.all6mTrips ? kmResult.all6mTrips.length : 0,
                totalViajesHotRam: kmResult.hotRamTrips ? kmResult.hotRamTrips.length : 0,
                porUnidadCount: kmResult.porUnidad ? kmResult.porUnidad.size : 0,
                porChoferCount: kmResult.porChofer ? kmResult.porChofer.size : 0,
                all6mTrips: kmResult.all6mTrips || [],
                hotRamTrips: kmResult.hotRamTrips || [],
                unidades: kmResult.porUnidad ? Array.from(kmResult.porUnidad.entries()) : [],
                choferes: kmResult.porChofer ? Array.from(kmResult.porChofer.entries()) : []
            };

            const saved = storage.saveData('kilometros', payload);
            const duration = Date.now() - t0;
            log('success', `✅ [Kilómetros] Finalizado en ${duration}ms. ${payload.totalViajes6m} viajes extraídos y guardados en ${saved.file}.`);

            return {
                success: true,
                module: 'kilometros',
                records: payload.totalViajes6m,
                durationMs: duration,
                data: payload
            };
        } catch (err) {
            log('error', `❌ [Kilómetros] Error: ${err.message}`);
            storage.updateManifest('kilometros', { status: 'error', lastError: err.message });
            throw err;
        }
    }

    /**
     * 6. Extraer Legajos, Documentación y Observaciones -> legajos.json
     */
    async extractLegajos(log = defaultLog) {
        const t0 = Date.now();
        log('info', '📥 [Legajos] Extrayendo legajos, aptos médicos, habilitaciones y observaciones...');
        try {
            // Extrae desde Google Sheets sin requerir escritura directa
            const { documentacion, observaciones, stats } = await extractChoferesLegajo(null);

            const payload = {
                extractedAt: new Date().toISOString(),
                stats,
                totalDocumentacion: documentacion.length,
                totalObservaciones: observaciones.length,
                documentacion,
                observaciones
            };

            const saved = storage.saveData('legajos', payload);
            const duration = Date.now() - t0;
            log('success', `✅ [Legajos] Finalizado en ${duration}ms. ${documentacion.length} legajos y ${observaciones.length} observaciones guardadas en ${saved.file}.`);

            return {
                success: true,
                module: 'legajos',
                records: documentacion.length + observaciones.length,
                durationMs: duration,
                data: payload
            };
        } catch (err) {
            log('error', `❌ [Legajos] Error: ${err.message}`);
            storage.updateManifest('legajos', { status: 'error', lastError: err.message });
            throw err;
        }
    }

    /**
     * Extraer TODOS los módulos secuencialmente
     */
    async extractAll(log = defaultLog) {
        const t0 = Date.now();
        log('info', '===============================================================');
        log('info', '🚀 INICIANDO EXTRACCIÓN TOTAL DE PLANILLAS A ALMACENAMIENTO LOCAL');
        log('info', '===============================================================');

        const results = {};

        // 1. Master Brands
        results.master = await this.extractMaster(log);

        // 2. Vencimientos
        results.vencimientos = await this.extractVencimientos(log);

        // 3. Flota y Movimientos
        results.flota = await this.extractFlota(log);

        // 4. Diagramas Detalle
        results.diagramas = await this.extractDiagramas(log);

        // 5. Kilómetros
        try {
            results.kilometros = await this.extractKilometros(log);
        } catch (eKm) {
            log('error', `⚠️ Extracción de kilómetros falló (no crítica): ${eKm.message}`);
            results.kilometros = { success: false, error: eKm.message };
        }

        // 6. Legajos
        try {
            results.legajos = await this.extractLegajos(log);
        } catch (eLeg) {
            log('error', `⚠️ Extracción de legajos falló (no crítica): ${eLeg.message}`);
            results.legajos = { success: false, error: eLeg.message };
        }

        const totalDuration = Date.now() - t0;
        log('info', '===============================================================');
        log('success', `🎉 EXTRACCIÓN TOTAL FINALIZADA CON ÉXITO EN ${totalDuration}ms`);
        log('info', '===============================================================');

        return {
            success: true,
            totalDurationMs: totalDuration,
            results
        };
    }

    /**
     * Dispatcher por nombre de módulo
     */
    async extractModule(moduleKey, log = defaultLog) {
        switch ((moduleKey || '').toLowerCase()) {
            case 'master':
            case 'marcas':
                return this.extractMaster(log);
            case 'vencimientos':
                return this.extractVencimientos(log);
            case 'flota':
            case 'movimientos':
            case 'pareos':
                return this.extractFlota(log);
            case 'diagramas':
                return this.extractDiagramas(log);
            case 'kilometros':
            case 'km':
                return this.extractKilometros(log);
            case 'legajos':
            case 'documentacion':
                return this.extractLegajos(log);
            case 'all':
            case 'todas':
            case 'todos':
                return this.extractAll(log);
            default:
                throw new Error(`Módulo de extracción desconocido: '${moduleKey}'. Opciones válidas: master, vencimientos, flota, diagramas, kilometros, legajos, all.`);
        }
    }
}

module.exports = new ExtractorService();
