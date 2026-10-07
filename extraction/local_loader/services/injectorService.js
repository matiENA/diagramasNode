require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { Pool } = require('pg');
const http = require('http');
const storage = require('./storageHelper');
const { normalizar, mesesAbrev } = require('../utils/sheets');
const { upsertChoferesKmMensual, upsertCisternasKm } = require('../extractors/kilometros');

function defaultLog(level, msg) {
    const ts = new Date().toLocaleTimeString('es-AR');
    console.log(`[${ts}] [${level.toUpperCase()}] ${msg}`);
}

const chunkArray = (arr, size) => {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
    }
    return chunks;
};

class InjectorService {
    constructor() {
        this.supabaseUrl = process.env.SUPABASE_URL || 'https://rsvajuxihvmpmrmlcbul.supabase.co';
        this.supabaseKey = process.env.SUPABASE_KEY;
        this.databaseUrl = process.env.DATABASE_URL;

        this.supabase = (this.supabaseUrl && this.supabaseKey)
            ? createClient(this.supabaseUrl, this.supabaseKey)
            : null;

        this.pool = this.databaseUrl ? new Pool({
            connectionString: this.databaseUrl,
            ssl: { rejectUnauthorized: false },
            max: 5
        }) : null;
    }

    _checkClient(dryRun = false) {
        if (dryRun) return true;
        if (!this.supabase) {
            throw new Error('No se puede inyectar en Supabase: falta SUPABASE_KEY o SUPABASE_URL en .env');
        }
        return true;
    }

    /**
     * 0A. Inyectar Marcas Master (tractores y semis en Supabase)
     */
    async injectMaster({ dryRun = false, log = defaultLog } = {}) {
        const t0 = Date.now();
        log('info', `📤 [Inyector Master] Iniciando inyección de marcas a Supabase ${dryRun ? '(SIMULACIÓN)' : ''}...`);
        this._checkClient(dryRun);

        const masterData = storage.loadData('master');
        if (!masterData || (!masterData.marcasTractores && !masterData.marcasSemis)) {
            throw new Error("No hay datos locales de marcas. Ejecuta la extracción de 'master' primero.");
        }

        const marcasTractores = masterData.marcasTractores || {};
        const marcasSemis = masterData.marcasSemis || {};
        const tractoresRows = Object.entries(marcasTractores).map(([patente, marca]) => ({
            patente: patente.trim().toUpperCase().replace(/\s+/g, ''),
            marca
        })).filter(r => r.patente);

        const semisRows = Object.entries(marcasSemis).map(([patente, marca]) => ({
            patente: patente.trim().toUpperCase().replace(/\s+/g, ''),
            marca
        })).filter(r => r.patente);

        if (dryRun) {
            log('info', `   🔍 [SIMULACIÓN] Se inyectarían marcas para ${tractoresRows.length} tractores y ${semisRows.length} semis.`);
            return { success: true, dryRun: true, module: 'master', records: tractoresRows.length + semisRows.length, durationMs: Date.now() - t0 };
        }

        const BATCH_SIZE = 50;
        let count = 0;

        for (const batch of chunkArray(tractoresRows, BATCH_SIZE)) {
            const { error } = await this.supabase.from('tractores').upsert(batch, { onConflict: 'patente' });
            if (error) log('error', `   ❌ Error inyectando marcas de tractores: ${error.message}`);
            else count += batch.length;
        }

        for (const batch of chunkArray(semisRows, BATCH_SIZE)) {
            const { error } = await this.supabase.from('semis').upsert(batch, { onConflict: 'patente' });
            if (error) log('error', `   ❌ Error inyectando marcas de semis: ${error.message}`);
            else count += batch.length;
        }

        const duration = Date.now() - t0;
        log('success', `✅ [Inyector Master] Finalizado en ${duration}ms. ${count} marcas de tractores y semis sincronizadas en Supabase.`);
        storage.updateManifest('master', { injectedAt: new Date().toISOString(), recordsInjected: count, status: 'injected' });

        if (!dryRun) {
            this._notifyRamServer(log);
        }

        return {
            success: true,
            module: 'master',
            records: count,
            durationMs: duration
        };
    }

    /**
     * 0B. Inyectar Vencimientos Técnicos (Uni QM -> tractores y semis en Supabase)
     */
    async injectVencimientos({ dryRun = false, log = defaultLog } = {}) {
        const t0 = Date.now();
        log('info', `📤 [Inyector Vencimientos] Iniciando inyección de vencimientos Uni QM a Supabase ${dryRun ? '(SIMULACIÓN)' : ''}...`);
        this._checkClient(dryRun);

        const vencData = storage.loadData('vencimientos');
        if (!vencData || !vencData.vencimientosPorPatente) {
            throw new Error("No hay datos locales de vencimientos. Ejecuta la extracción de 'vencimientos' primero.");
        }

        const vencimientos = vencData.vencimientosPorPatente;
        const patentes = Object.keys(vencimientos);

        if (dryRun) {
            log('info', `   🔍 [SIMULACIÓN] Se inyectarían vencimientos para ${patentes.length} patentes.`);
            return { success: true, dryRun: true, module: 'vencimientos', records: patentes.length, durationMs: Date.now() - t0 };
        }

        const { data: dbTractores } = await this.supabase.from('tractores').select('id, patente');
        const { data: dbSemis } = await this.supabase.from('semis').select('id, patente');

        const trSet = new Set((dbTractores || []).map(t => t.patente.toUpperCase()));
        const seSet = new Set((dbSemis || []).map(s => s.patente.toUpperCase()));

        const tractoresUpdates = [];
        const semisUpdates = [];

        const flotaData = storage.loadData('flota');
        const flotaUnits = (flotaData && flotaData.units) || [];
        const flotaTrSet = new Set(flotaUnits.map(u => (u.tractor || '').toUpperCase().trim()).filter(Boolean));
        const flotaSeSet = new Set(flotaUnits.map(u => (u.semi || '').toUpperCase().trim()).filter(Boolean));

        patentes.forEach(p => {
            const pat = p.trim().toUpperCase().replace(/\s+/g, '');
            const v = vencimientos[p];
            if (!pat || !v) return;

            if (trSet.has(pat) || flotaTrSet.has(pat)) {
                tractoresUpdates.push({
                    patente: pat,
                    vtv: v.vtv || null,
                    mas: v.mas || null
                });
            } else if (seSet.has(pat) || flotaSeSet.has(pat)) {
                semisUpdates.push({
                    patente: pat,
                    vtv: v.vtv || null,
                    mas: v.mas || null,
                    esp_es: v.esp_es || null,
                    vi: v.vi || null,
                    ve: v.ve || null
                });
            }
        });

        const BATCH_SIZE = 50;
        let count = 0;

        for (const batch of chunkArray(tractoresUpdates, BATCH_SIZE)) {
            const { error } = await this.supabase.from('tractores').upsert(batch, { onConflict: 'patente' });
            if (error) log('error', `   ❌ Error inyectando vencimientos en tractores: ${error.message}`);
            else count += batch.length;
        }

        for (const batch of chunkArray(semisUpdates, BATCH_SIZE)) {
            const { error } = await this.supabase.from('semis').upsert(batch, { onConflict: 'patente' });
            if (error) log('error', `   ❌ Error inyectando vencimientos en semis: ${error.message}`);
            else count += batch.length;
        }

        const duration = Date.now() - t0;
        log('success', `✅ [Inyector Vencimientos] Finalizado en ${duration}ms. ${count} vencimientos técnicos sincronizados en Supabase.`);
        storage.updateManifest('vencimientos', { injectedAt: new Date().toISOString(), recordsInjected: count, status: 'injected' });

        if (!dryRun) {
            this._notifyRamServer(log);
        }

        return {
            success: true,
            module: 'vencimientos',
            records: count,
            durationMs: duration
        };
    }

    /**
     * 1. Inyectar Flota (Servicios, Tractores, Semis, Unidades)
     */
    async injectFlota({ dryRun = false, log = defaultLog } = {}) {
        const t0 = Date.now();
        log('info', `📤 [Inyector Flota] Iniciando inyección de flota a Supabase ${dryRun ? '(MODO SIMULACIÓN)' : ''}...`);
        this._checkClient(dryRun);

        const flotaData = storage.loadData('flota');
        if (!flotaData || !flotaData.units) {
            throw new Error("No hay datos locales de flota. Ejecuta la extracción de 'flota' primero.");
        }

        const masterData = storage.loadData('master') || { marcasTractores: {}, marcasSemis: {} };
        const vencData = storage.loadData('vencimientos') || { vencimientosPorPatente: {} };

        const units = flotaData.units;
        const marcasTractores = masterData.marcasTractores || {};
        const marcasSemis = masterData.marcasSemis || {};
        const vencimientosPorPatente = vencData.vencimientosPorPatente || {};

        if (dryRun) {
            log('info', `   🔍 [SIMULACIÓN] Se inyectarían ${units.length} unidades, marcas y vencimientos asociados.`);
            return { success: true, dryRun: true, module: 'flota', records: units.length, durationMs: Date.now() - t0 };
        }

        const BATCH_SIZE = 50;

        // A. Servicios Unidades
        log('info', '   • Sincronizando catálogo `servicios_unidades`...');
        const serviciosUnidadesSet = new Set();
        units.forEach(u => {
            const s = (u.servicio || '').trim().toUpperCase();
            if (s) serviciosUnidadesSet.add(s);
        });
        for (const srv of serviciosUnidadesSet) {
            await this.supabase.from('servicios_unidades').upsert({ denominacion: srv }, { onConflict: 'denominacion' });
        }
        const { data: suList } = await this.supabase.from('servicios_unidades').select('id, denominacion');
        const serviciosUnidadesMap = new Map();
        (suList || []).forEach(su => serviciosUnidadesMap.set(su.denominacion.toUpperCase(), su.id));

        // B. Tractores
        log('info', '   • Sincronizando catálogo maestro `tractores`...');
        const tractoresMap = new Map();
        units.forEach(u => {
            const p = (u.tractor || '').trim().toUpperCase().replace(/\s+/g, '');
            if (p && !tractoresMap.has(p)) {
                const srvId = serviciosUnidadesMap.get((u.servicio || '').trim().toUpperCase()) || null;
                tractoresMap.set(p, {
                    patente: p,
                    marca: u.marca_tr || marcasTractores[p] || null,
                    vtv: u.vtv_tr || vencimientosPorPatente[p]?.vtv || null,
                    mas: u.mas_tr || vencimientosPorPatente[p]?.mas || null,
                    estado: u.estado || 'disponible',
                    servicio_id: srvId
                });
            }
        });
        Object.keys(marcasTractores).forEach(p => {
            const pat = p.trim().toUpperCase().replace(/\s+/g, '');
            if (pat && !tractoresMap.has(pat)) {
                tractoresMap.set(pat, {
                    patente: pat,
                    marca: marcasTractores[p],
                    vtv: vencimientosPorPatente[pat]?.vtv || null,
                    mas: vencimientosPorPatente[pat]?.mas || null,
                    estado: 'disponible',
                    servicio_id: null
                });
            }
        });

        const tractoresArray = Array.from(tractoresMap.values());
        for (const batch of chunkArray(tractoresArray, BATCH_SIZE)) {
            await this.supabase.from('tractores').upsert(batch, { onConflict: 'patente' });
        }
        const { data: dbTractores } = await this.supabase.from('tractores').select('id, patente');
        const tractorIdByPatente = new Map();
        (dbTractores || []).forEach(t => tractorIdByPatente.set(t.patente.toUpperCase(), t.id));
        log('success', `   ✅ ${tractoresArray.length} tractores sincronizados en public.tractores.`);

        // C. Semis
        log('info', '   • Sincronizando catálogo maestro `semis`...');
        const semisMap = new Map();
        units.forEach(u => {
            const p = (u.semi || '').trim().toUpperCase().replace(/\s+/g, '');
            if (p && !semisMap.has(p)) {
                const srvId = serviciosUnidadesMap.get((u.servicio || '').trim().toUpperCase()) || null;
                semisMap.set(p, {
                    patente: p,
                    marca: u.marca_semi || marcasSemis[p] || null,
                    cisternado: u.cisternado || null,
                    esp_es: u.esp_es || vencimientosPorPatente[p]?.esp_es || null,
                    vi: u.vi || vencimientosPorPatente[p]?.vi || null,
                    ve: u.ve || vencimientosPorPatente[p]?.ve || null,
                    vtv: u.vtv_semi || vencimientosPorPatente[p]?.vtv || null,
                    mas: u.mas_semi || vencimientosPorPatente[p]?.mas || null,
                    estado: u.estado || 'disponible',
                    servicio_id: srvId
                });
            }
        });
        Object.keys(marcasSemis).forEach(p => {
            const pat = p.trim().toUpperCase().replace(/\s+/g, '');
            if (pat && !semisMap.has(pat)) {
                semisMap.set(pat, {
                    patente: pat,
                    marca: marcasSemis[p],
                    cisternado: null,
                    esp_es: vencimientosPorPatente[pat]?.esp_es || null,
                    vi: vencimientosPorPatente[pat]?.vi || null,
                    ve: vencimientosPorPatente[pat]?.ve || null,
                    vtv: vencimientosPorPatente[pat]?.vtv || null,
                    mas: vencimientosPorPatente[pat]?.mas || null,
                    estado: 'disponible',
                    servicio_id: null
                });
            }
        });

        const semisArray = Array.from(semisMap.values());
        for (const batch of chunkArray(semisArray, BATCH_SIZE)) {
            await this.supabase.from('semis').upsert(batch, { onConflict: 'patente' });
        }
        const { data: dbSemis } = await this.supabase.from('semis').select('id, patente');
        const semiIdByPatente = new Map();
        (dbSemis || []).forEach(s => semiIdByPatente.set(s.patente.toUpperCase(), s.id));
        log('success', `   ✅ ${semisArray.length} semis sincronizados en public.semis.`);

        // D. Unidades (Formaciones con IDs)
        log('info', '   • Sincronizando tabla `unidades`...');
        const { data: existingUnits, error: errFetchU } = await this.supabase.from('unidades').select('id, n_ute, tractor_id, semi_id, servicio_id, fecha_acople, estado');
        if (errFetchU) throw new Error(`Error consultando unidades: ${errFetchU.message}`);

        const existingUnitByTractorId = new Map();
        const existingUnitBySemiId = new Map();
        const existingUnitByUte = new Map();
        (existingUnits || []).forEach(u => {
            if (u.tractor_id) existingUnitByTractorId.set(u.tractor_id, u);
            if (u.semi_id) existingUnitBySemiId.set(u.semi_id, u);
            if (u.n_ute && !u.tractor_id && !u.semi_id) existingUnitByUte.set(String(u.n_ute).trim(), u);
        });

        const unitsToUpdate = [];
        const unitsToInsert = [];
        for (const u of units) {
            const trPat = (u.tractor || '').trim().toUpperCase().replace(/\s+/g, '');
            const sePat = (u.semi || '').trim().toUpperCase().replace(/\s+/g, '');
            const uteStr = String(u.n_ute || '').trim();

            const tId = trPat ? tractorIdByPatente.get(trPat) || null : null;
            const sId = sePat ? semiIdByPatente.get(sePat) || null : null;
            const srvId = serviciosUnidadesMap.get((u.servicio || '').trim().toUpperCase()) || null;

            let existing = null;
            if (tId && existingUnitByTractorId.has(tId)) {
                existing = existingUnitByTractorId.get(tId);
            } else if (sId && existingUnitBySemiId.has(sId)) {
                existing = existingUnitBySemiId.get(sId);
            } else if (uteStr && existingUnitByUte.has(uteStr)) {
                existing = existingUnitByUte.get(uteStr);
            }

            const isAcopleCambiado = existing && (existing.semi_id !== sId || existing.tractor_id !== tId);
            const fechaAcople = (!existing || isAcopleCambiado) ? new Date().toISOString() : (existing.fecha_acople || new Date().toISOString());

            const payload = {
                n_ute: uteStr || null,
                servicio_id: srvId,
                tractor_id: tId,
                semi_id: sId,
                fecha_acople: fechaAcople,
                estado: u.estado || 'disponible'
            };

            if (existing) {
                payload.id = existing.id;
                unitsToUpdate.push(payload);
            } else {
                unitsToInsert.push(payload);
            }
        }

        for (const batch of chunkArray(unitsToUpdate, BATCH_SIZE)) {
            const { error: errUpU } = await this.supabase.from('unidades').upsert(batch);
            if (errUpU) log('error', `   ❌ Error actualizando lote unidades: ${errUpU.message}`);
        }
        for (const batch of chunkArray(unitsToInsert, BATCH_SIZE)) {
            const { error: errInsU } = await this.supabase.from('unidades').insert(batch);
            if (errInsU) log('error', `   ❌ Error insertando lote unidades: ${errInsU.message}`);
        }

        const duration = Date.now() - t0;
        log('success', `✅ [Inyector Flota] Finalizado en ${duration}ms. ${unitsToUpdate.length} actualizadas, ${unitsToInsert.length} creadas.`);
        storage.updateManifest('flota', { injectedAt: new Date().toISOString(), recordsInjected: unitsToUpdate.length + unitsToInsert.length, status: 'injected' });

        return {
            success: true,
            module: 'flota',
            records: unitsToUpdate.length + unitsToInsert.length,
            durationMs: duration
        };
    }

    /**
     * 2. Inyectar Choferes (Diagramas + Movimientos consolidados)
     */
    async injectChoferes({ dryRun = false, log = defaultLog } = {}) {
        const t0 = Date.now();
        log('info', `📤 [Inyector Choferes] Iniciando inyección de Choferes a Supabase ${dryRun ? '(SIMULACIÓN)' : ''}...`);
        this._checkClient(dryRun);

        const diagData = storage.loadData('diagramas');
        const flotaData = storage.loadData('flota');

        const choferesDetalleList = (diagData && diagData.choferesDetalleList) || [];
        const choferesEnMovimientos = (flotaData && flotaData.choferesEnMovimientos) || {};

        if (choferesDetalleList.length === 0 && Object.keys(choferesEnMovimientos).length === 0) {
            throw new Error("No hay datos locales de Choferes. Ejecuta la extracción de 'diagramas' o 'flota' primero.");
        }

        // Consolidación de Choferes
        const choferesFinalMap = new Map();
        for (const diagCh of choferesDetalleList) {
            choferesFinalMap.set(diagCh.norm, {
                nombre: diagCh.nombre,
                legajo: diagCh.legajo,
                dni: null,
                telefono: null,
                c_servicio: diagCh.c_servicio,
                diagrama_tipo: diagCh.diagrama_tipo,
                estado: 'inactivo',
                diagrama_json: diagCh.diagrama_json,
                contabilizador: diagCh.contabilizador
            });
        }

        for (const [norm, movCh] of Object.entries(choferesEnMovimientos)) {
            if (choferesFinalMap.has(norm)) {
                const existing = choferesFinalMap.get(norm);
                existing.estado = 'circulando';
                if (existing.c_servicio === 'S/A' && movCh.c_servicio) {
                    existing.c_servicio = movCh.c_servicio;
                }
            } else {
                choferesFinalMap.set(norm, {
                    nombre: movCh.nombre,
                    legajo: null,
                    dni: null,
                    telefono: null,
                    c_servicio: movCh.c_servicio,
                    diagrama_tipo: null,
                    estado: 'circulando',
                    diagrama_json: null,
                    contabilizador: null
                });
            }
        }

        const choferesArray = Array.from(choferesFinalMap.values());

        if (dryRun) {
            log('info', `   🔍 [SIMULACIÓN] Se inyectarían ${choferesArray.length} choferes consolidados.`);
            return { success: true, dryRun: true, module: 'choferes', records: choferesArray.length, durationMs: Date.now() - t0 };
        }

        // Servicios Choferes
        const serviciosChoferesSet = new Set();
        choferesArray.forEach(c => {
            const s = (c.c_servicio || '').trim().toUpperCase();
            if (s) serviciosChoferesSet.add(s);
        });

        const { data: suList } = await this.supabase.from('servicios_unidades').select('id, denominacion');
        const serviciosUnidadesMap = new Map();
        (suList || []).forEach(su => serviciosUnidadesMap.set(su.denominacion.toUpperCase(), su.id));

        for (const srv of serviciosChoferesSet) {
            let suId = serviciosUnidadesMap.get(srv) || null;
            if (!suId) {
                if (srv === 'LIV') suId = serviciosUnidadesMap.get('LIVIANO') || null;
                else if (srv === 'ABAST') suId = serviciosUnidadesMap.get('ABASTECEDORES') || null;
                else if (srv === 'GRALES' || srv === 'GRALES.') suId = serviciosUnidadesMap.get('C. GENERALES') || null;
            }
            await this.supabase.from('servicios_choferes').upsert({
                denominacion: srv,
                servicio_unidad_id: suId
            }, { onConflict: 'denominacion' });
        }

        const { data: scList } = await this.supabase.from('servicios_choferes').select('id, denominacion');
        const serviciosChoferesMap = new Map();
        (scList || []).forEach(sc => serviciosChoferesMap.set(sc.denominacion.toUpperCase(), sc.id));

        // Actualizar Choferes
        const { data: existingChoferes, error: errFetchC } = await this.supabase.from('choferes').select('id, nombre, dni, foto');
        if (errFetchC) throw new Error(`Error consultando choferes: ${errFetchC.message}`);

        const choferKeyMap = new Map();
        (existingChoferes || []).forEach(c => {
            choferKeyMap.set(normalizar(c.nombre), c);
        });

        const choferesToUpdate = [];
        const choferesToInsert = [];

        for (const c of choferesArray) {
            const normKey = normalizar(c.nombre);
            const srvChoferId = serviciosChoferesMap.get((c.c_servicio || '').trim().toUpperCase()) || null;
            const payload = {
                nombre: c.nombre,
                legajo: c.legajo,
                dni: c.dni,
                telefono: c.telefono,
                c_servicio: c.c_servicio,
                servicio_id: srvChoferId,
                diagrama_tipo: c.diagrama_tipo,
                estado: c.estado,
                diagrama_json: c.diagrama_json,
                contabilizador: c.contabilizador
            };

            if (choferKeyMap.has(normKey)) {
                const existing = choferKeyMap.get(normKey);
                const mergedPayload = { ...payload };
                if (!mergedPayload.dni && existing.dni) mergedPayload.dni = existing.dni;
                if (!mergedPayload.foto && existing.foto) mergedPayload.foto = existing.foto;
                choferesToUpdate.push({ id: existing.id, ...mergedPayload });
            } else {
                choferesToInsert.push(payload);
            }
        }

        const BATCH_SIZE = 50;
        for (const batch of chunkArray(choferesToUpdate, BATCH_SIZE)) {
            const { error } = await this.supabase.from('choferes').upsert(batch);
            if (error) log('error', `   ❌ Error actualizando lote choferes: ${error.message}`);
        }
        for (const batch of chunkArray(choferesToInsert, BATCH_SIZE)) {
            const { error } = await this.supabase.from('choferes').insert(batch);
            if (error) log('error', `   ❌ Error insertando lote choferes: ${error.message}`);
        }

        const duration = Date.now() - t0;
        log('success', `✅ [Inyector Choferes] Finalizado en ${duration}ms. ${choferesToUpdate.length} actualizados, ${choferesToInsert.length} creados.`);
        storage.updateManifest('diagramas', { injectedAt: new Date().toISOString(), recordsInjected: choferesArray.length, status: 'injected' });

        return {
            success: true,
            module: 'choferes',
            records: choferesArray.length,
            durationMs: duration
        };
    }

    /**
     * 3. Inyectar Movimientos (Pareos Activos Unidad <-> Chofer de Hoy)
     */
    async injectMovimientos({ dryRun = false, log = defaultLog } = {}) {
        const t0 = Date.now();
        log('info', `📤 [Inyector Movimientos] Sincronizando pareos activos diarios a Supabase ${dryRun ? '(SIMULACIÓN)' : ''}...`);
        this._checkClient(dryRun);

        const flotaData = storage.loadData('flota');
        if (!flotaData || !flotaData.asignacionesHoy) {
            throw new Error("No hay asignaciones de hoy en los datos locales. Extrae 'flota' primero.");
        }

        const asignacionesHoy = flotaData.asignacionesHoy;

        if (dryRun) {
            log('info', `   🔍 [SIMULACIÓN] Se registrarían ${asignacionesHoy.length} asignaciones operativas.`);
            return { success: true, dryRun: true, module: 'movimientos', records: asignacionesHoy.length, durationMs: Date.now() - t0 };
        }

        const { data: dbTractores } = await this.supabase.from('tractores').select('id, patente');
        const { data: dbSemis } = await this.supabase.from('semis').select('id, patente');
        const { data: freshUnits } = await this.supabase.from('unidades').select('id, tractor_id, semi_id, n_ute');
        const { data: freshChoferes } = await this.supabase.from('choferes').select('id, nombre, legajo');

        const idToTractorPatente = new Map();
        (dbTractores || []).forEach(t => idToTractorPatente.set(t.id, (t.patente || '').toUpperCase().replace(/\s+/g, '')));
        const idToSemiPatente = new Map();
        (dbSemis || []).forEach(s => idToSemiPatente.set(s.id, (s.patente || '').toUpperCase().replace(/\s+/g, '')));

        const freshUnitMap = new Map();
        (freshUnits || []).forEach(u => {
            if (u.tractor_id && idToTractorPatente.has(u.tractor_id)) {
                freshUnitMap.set(idToTractorPatente.get(u.tractor_id), u.id);
            }
            if (u.semi_id && idToSemiPatente.has(u.semi_id)) {
                freshUnitMap.set(idToSemiPatente.get(u.semi_id), u.id);
            }
            if (u.n_ute) {
                freshUnitMap.set(String(u.n_ute).trim(), u.id);
            }
        });

        const freshChoferMap = new Map();
        (freshChoferes || []).forEach(c => freshChoferMap.set(normalizar(c.nombre), c.id));

        function resolveChoferId(rawNorm) {
            if (!rawNorm) return null;
            const norm = normalizar(rawNorm);
            if (freshChoferMap.has(norm)) return freshChoferMap.get(norm);
            const sinEnie = norm.includes('Ñ') ? norm.replace(/Ñ/g, 'N') : null;
            if (sinEnie && freshChoferMap.has(sinEnie)) return freshChoferMap.get(sinEnie);
            const palabras = norm.split(/\s+/).filter(w => w.length >= 3);
            if (palabras.length >= 2) {
                const found = (freshChoferes || []).find(c => {
                    const cNorm = normalizar(c.nombre);
                    return palabras.every(p => cNorm.includes(p));
                });
                if (found) return found.id;
            }
            return null;
        }

        const movsToInsert = [];
        const choferesConUnidad = new Map();

        for (const asig of asignacionesHoy) {
            const trClean = (asig.tractor || '').toUpperCase().replace(/\s+/g, '');
            const seClean = (asig.semi || '').toUpperCase().replace(/\s+/g, '');
            const uteClean = asig.nUte ? String(asig.nUte).trim() : null;

            const idUnidad = (trClean && freshUnitMap.get(trClean)) || (seClean && freshUnitMap.get(seClean)) || (uteClean ? freshUnitMap.get(uteClean) : null);
            let idChofer = resolveChoferId(asig.choferNorm);

            // Auto-crear chofer mínimo si viene de movimientos pero aún no fue sincronizado desde diagramas
            if (!idChofer && asig.choferNombre && asig.choferNombre.length > 2) {
                if (this.pool) {
                    try {
                        const insertCh = await this.pool.query(
                            `INSERT INTO choferes (nombre, estado, actualizado_el) VALUES ($1, 'circulando', NOW()) RETURNING id`,
                            [asig.choferNombre.trim().toUpperCase()]
                        );
                        if (insertCh.rows[0]) {
                            idChofer = insertCh.rows[0].id;
                            freshChoferMap.set(normalizar(asig.choferNombre), idChofer);
                            log('info', `   ✨ Chofer creado al vuelo desde Movimientos: ${asig.choferNombre}`);
                        }
                    } catch (eCh) {
                        log('warn', `   ⚠️ No se pudo crear chofer al vuelo '${asig.choferNombre}': ${eCh.message}`);
                    }
                }
            }

            if (idUnidad && idChofer) {
                movsToInsert.push({ id_unidad: idUnidad, id_chofer: idChofer });
            }
        }

        // Deduplicar asignaciones para respetar restricciones UNIQUE (uq_movimientos_unidad, uq_movimientos_chofer)
        const uniqueMovsMap = new Map();
        const seenChoferesSet = new Set();
        for (const m of movsToInsert) {
            if (uniqueMovsMap.has(m.id_unidad) || seenChoferesSet.has(m.id_chofer)) {
                log('warn', `   ⚠️ Asignación duplicada omitida en movimientos: unidad ${m.id_unidad}, chofer ${m.id_chofer}`);
                continue;
            }
            uniqueMovsMap.set(m.id_unidad, m);
            seenChoferesSet.add(m.id_chofer);
            choferesConUnidad.set(m.id_chofer, m.id_unidad);
        }
        const deduplicatedMovs = Array.from(uniqueMovsMap.values());

        // Limpiar pareos anteriores e insertar la foto de hoy
        if (this.pool) {
            await this.pool.query(`DELETE FROM movimientos WHERE id != '00000000-0000-0000-0000-000000000000'`);
            if (deduplicatedMovs.length > 0) {
                const BATCH_PG = 100;
                for (let i = 0; i < deduplicatedMovs.length; i += BATCH_PG) {
                    const chunk = deduplicatedMovs.slice(i, i + BATCH_PG);
                    const values = [];
                    const params = [];
                    chunk.forEach((m, idx) => {
                        params.push(m.id_unidad, m.id_chofer);
                        values.push(`($${idx * 2 + 1}, $${idx * 2 + 2})`);
                    });
                    await this.pool.query(`
                        INSERT INTO movimientos (id_unidad, id_chofer) 
                        VALUES ${values.join(', ')}
                        ON CONFLICT (id_unidad) DO UPDATE SET 
                            id_chofer = EXCLUDED.id_chofer,
                            actualizado_el = NOW()
                    `, params);
                }
            }
            // 1. Limpiar unidad_id de choferes que ya no tienen asignación activa
            await this.pool.query(`
                UPDATE choferes 
                SET unidad_id = NULL, 
                    estado = CASE WHEN estado = 'circulando' THEN 'inactivo' ELSE estado END,
                    actualizado_el = NOW() 
                WHERE unidad_id IS NOT NULL
            `);
            // 2. Asignar unidad_id a los choferes con asignación activa hoy (Batch optimizado en 1 sola query)
            const entries = Array.from(choferesConUnidad.entries());
            if (entries.length > 0) {
                const values = entries.map(([idCh, idUn], idx) => `($${idx * 2 + 1}::uuid, $${idx * 2 + 2}::uuid)`).join(', ');
                const params = entries.flatMap(([idCh, idUn]) => [idCh, idUn]);
                await this.pool.query(`
                    UPDATE choferes AS c
                    SET unidad_id = v.unidad_id,
                        estado = 'circulando',
                        actualizado_el = NOW()
                    FROM (VALUES ${values}) AS v(chofer_id, unidad_id)
                    WHERE c.id = v.chofer_id
                `, params);
            }
            // 3. Sincronizar estado de las unidades: si no tienen chofer hoy, quedan disponibles
            await this.pool.query(`
                UPDATE unidades 
                SET estado = 'disponible' 
                WHERE estado = 'circulando' AND id NOT IN (SELECT id_unidad FROM movimientos)
            `);
            await this.pool.query(`
                UPDATE unidades 
                SET estado = 'circulando' 
                WHERE id IN (SELECT id_unidad FROM movimientos)
            `);
        } else {
            await this.supabase.from('movimientos').delete().neq('id', '00000000-0000-0000-0000-000000000000');
            const BATCH_SIZE = 50;
            for (const batch of chunkArray(movsToInsert, BATCH_SIZE)) {
                await this.supabase.from('movimientos').insert(batch);
            }
            await this.supabase.from('choferes').update({ unidad_id: null, estado: 'inactivo', actualizado_el: new Date().toISOString() }).not('unidad_id', 'is', null);
            for (const [idChofer, idUnidad] of choferesConUnidad.entries()) {
                await this.supabase.from('choferes').update({ unidad_id: idUnidad, estado: 'circulando', actualizado_el: new Date().toISOString() }).eq('id', idChofer);
            }
        }

        const duration = Date.now() - t0;
        log('success', `✅ [Inyector Movimientos] Finalizado en ${duration}ms. ${movsToInsert.length} movimientos activos pareados.`);

        return {
            success: true,
            module: 'movimientos',
            records: movsToInsert.length,
            durationMs: duration
        };
    }

    /**
     * 4. Inyectar Diagramas Históricos (Tabla 'diagramas')
     */
    async injectDiagramas({ dryRun = false, log = defaultLog } = {}) {
        const t0 = Date.now();
        log('info', `📤 [Inyector Diagramas] Inyectando histórico en tabla 'diagramas' ${dryRun ? '(SIMULACIÓN)' : ''}...`);
        this._checkClient(dryRun);

        const diagData = storage.loadData('diagramas');
        if (!diagData || !diagData.choferesDetalleList) {
            throw new Error("No hay diagramas detallados en datos locales. Extrae 'diagramas' primero.");
        }

        const { choferesDetalleList } = diagData;

        if (dryRun) {
            log('info', `   🔍 [SIMULACIÓN] Se inyectarían diagramas históricos de ${choferesDetalleList.length} choferes.`);
            return { success: true, dryRun: true, module: 'diagramas', records: choferesDetalleList.length, durationMs: Date.now() - t0 };
        }

        const { error: checkErr } = await this.supabase.from('diagramas').select('id').limit(1);
        if (checkErr) {
            log('info', `   ℹ️ Tabla 'diagramas' no habilitada en Supabase (${checkErr.message}). Omitiendo inserción histórica.`);
            return { success: true, module: 'diagramas', records: 0, durationMs: Date.now() - t0 };
        }

        const { data: freshChoferes } = await this.supabase.from('choferes').select('id, nombre');
        const freshChoferMap = new Map();
        (freshChoferes || []).forEach(c => freshChoferMap.set(normalizar(c.nombre), c.id));

        const rowsDiagramas = [];
        for (const ch of choferesDetalleList) {
            const choferId = freshChoferMap.get(ch.norm) || null;
            const meses = ch.diagrama_json?.meses || {};
            for (const [mesTab, mesData] of Object.entries(meses)) {
                const parts = mesTab.split('-');
                const mIdx = mesesAbrev.findIndex(m => m.toLowerCase() === parts[0].toLowerCase());
                const anio = parseInt('20' + parts[1].replace(/\D/g, ''), 10);
                rowsDiagramas.push({
                    chofer_id: choferId,
                    chofer_nombre: ch.nombre,
                    legajo: ch.legajo,
                    servicio: ch.c_servicio,
                    diagrama_tipo: ch.diagrama_tipo,
                    mes_tab: mesTab,
                    anio,
                    mes_numero: mIdx + 1,
                    dias: mesData.dias,
                    tira_dias: mesData.tira,
                    contabilizador: mesData.contabilizador
                });
            }
        }

        const BATCH_SIZE = 100;
        for (const batch of chunkArray(rowsDiagramas, BATCH_SIZE)) {
            await this.supabase.from('diagramas').upsert(batch, { onConflict: 'chofer_nombre,mes_tab' });
        }

        const duration = Date.now() - t0;
        log('success', `✅ [Inyector Diagramas] Finalizado en ${duration}ms. ${rowsDiagramas.length} registros mensuales sincronizados.`);

        return {
            success: true,
            module: 'diagramas',
            records: rowsDiagramas.length,
            durationMs: duration
        };
    }

    /**
     * 5. Inyectar Kilómetros (choferes_km_mensual y cisternas_km)
     */
    async injectKilometros({ dryRun = false, log = defaultLog } = {}) {
        const t0 = Date.now();
        log('info', `📤 [Inyector Kilómetros] Inyectando datos a choferes_km_mensual y cisternas_km ${dryRun ? '(SIMULACIÓN)' : ''}...`);
        this._checkClient(dryRun);

        const kmData = storage.loadData('kilometros');
        if (!kmData || !kmData.all6mTrips) {
            throw new Error("No hay datos locales de viajes de kilómetros. Extrae 'kilometros' primero.");
        }

        const allTrips = kmData.all6mTrips;

        if (dryRun) {
            log('info', `   🔍 [SIMULACIÓN] Se inyectarían ${allTrips.length} viajes a choferes_km_mensual y cisternas_km.`);
            return { success: true, dryRun: true, module: 'kilometros', records: allTrips.length, durationMs: Date.now() - t0 };
        }

        if (this.pool && allTrips.length > 0) {
            const client = await this.pool.connect();
            try {
                log('info', `   ⚡ Consolidando buckets mensuales en public.choferes_km_mensual...`);
                await upsertChoferesKmMensual(client, allTrips);

                log('info', `   🛢️ Sincronizando trazabilidad en public.cisternas_km...`);
                const [uRes, tRes] = await Promise.all([
                    client.query(`
                        SELECT u.id, u.tractor_id, t.patente AS tractor, u.semi_id, s.patente AS semi, u.n_ute
                        FROM public.unidades u
                        LEFT JOIN public.tractores t ON u.tractor_id = t.id
                        LEFT JOIN public.semis s ON u.semi_id = s.id
                    `),
                    client.query(`SELECT id, patente FROM public.tractores WHERE patente IS NOT NULL`)
                ]);
                const formacionMap = new Map();
                uRes.rows.forEach(u => {
                    const item = {
                        id_unidad: u.id,
                        tractor_id: u.tractor_id,
                        tractor_patente: u.tractor,
                        semi_id: u.semi_id,
                        cisterna_patente: u.semi,
                        n_ute: u.n_ute
                    };
                    if (u.tractor) formacionMap.set(u.tractor.trim().toUpperCase().replace(/[^A-Z0-9]/g, ''), item);
                    if (u.id) formacionMap.set(u.id, item);
                });
                tRes.rows.forEach(t => {
                    const trClean = t.patente.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
                    if (!formacionMap.has(trClean)) {
                        formacionMap.set(trClean, {
                            id_unidad: null,
                            tractor_id: t.id,
                            tractor_patente: t.patente,
                            semi_id: null,
                            cisterna_patente: null,
                            n_ute: null
                        });
                    }
                });
                await upsertCisternasKm(client, allTrips, { formacionMap });
            } finally {
                client.release();
            }
        }

        const duration = Date.now() - t0;
        log('success', `✅ [Inyector Kilómetros] Finalizado en ${duration}ms. ${allTrips.length} viajes sincronizados en choferes_km_mensual y cisternas_km.`);
        storage.updateManifest('kilometros', { injectedAt: new Date().toISOString(), recordsInjected: allTrips.length, status: 'injected' });

        return {
            success: true,
            module: 'kilometros',
            records: allTrips.length,
            durationMs: duration
        };
    }

    /**
     * 6. Inyectar Legajos y Observaciones
     */
    async injectLegajos({ dryRun = false, log = defaultLog } = {}) {
        const t0 = Date.now();
        log('info', `📤 [Inyector Legajos] Inyectando documentación y observaciones a Supabase ${dryRun ? '(SIMULACIÓN)' : ''}...`);
        this._checkClient(dryRun);

        const legajosData = storage.loadData('legajos');
        if (!legajosData || !legajosData.documentacion) {
            throw new Error("No hay datos locales de Legajos. Extrae 'legajos' primero.");
        }

        const { documentacion, observaciones } = legajosData;

        if (dryRun) {
            log('info', `   🔍 [SIMULACIÓN] Se inyectarían ${documentacion.length} legajos y ${observaciones.length} observaciones.`);
            return { success: true, dryRun: true, module: 'legajos', records: documentacion.length + observaciones.length, durationMs: Date.now() - t0 };
        }

        // Asociar chofer_id fresco desde Supabase
        const { data: supaChoferes } = await this.supabase.from('choferes').select('id, nombre, dni');
        const supaByName = new Map();
        const supaByDni = new Map();
        (supaChoferes || []).forEach(c => {
            supaByName.set(normalizar(c.nombre), c);
            const d = String(c.dni || '').replace(/\D/g, '');
            if (d) supaByDni.set(d, c);
        });

        const docsWithId = documentacion.map(doc => {
            let ch = supaByName.get(normalizar(doc.nombre)) || null;
            if (!ch && doc.dni) {
                ch = supaByDni.get(String(doc.dni).replace(/\D/g, '')) || null;
            }
            return {
                ...doc,
                chofer_id: ch ? ch.id : doc.chofer_id
            };
        }).filter(d => d.chofer_id);

        let upsertedDocs = 0;
        const BATCH_SIZE = 100;
        for (const batch of chunkArray(docsWithId, BATCH_SIZE)) {
            const cleanBatch = batch.map(({ nombre, ...rest }) => rest);
            const { error } = await this.supabase.from('chofer_documentacion').upsert(cleanBatch, { onConflict: 'chofer_id' });
            if (!error) upsertedDocs += cleanBatch.length;
            else log('error', `   ❌ Error upserting documentación: ${error.message}`);
        }

        // Observaciones
        const obsWithId = observaciones.map(obs => {
            const ch = supaByName.get(normalizar(obs.chofer_nombre)) || null;
            return {
                ...obs,
                chofer_id: ch ? ch.id : obs.chofer_id
            };
        }).filter(o => o.chofer_id);

        await this.supabase.from('chofer_observaciones').delete().neq('id', '00000000-0000-0000-0000-000000000000');
        let insertedObs = 0;
        for (const batch of chunkArray(obsWithId, BATCH_SIZE)) {
            const cleanBatch = batch.map(({ chofer_nombre, ...rest }) => rest);
            const { error } = await this.supabase.from('chofer_observaciones').insert(cleanBatch);
            if (!error) insertedObs += cleanBatch.length;
            else log('error', `   ❌ Error insertando observaciones: ${error.message}`);
        }

        const duration = Date.now() - t0;
        log('success', `✅ [Inyector Legajos] Finalizado en ${duration}ms. ${upsertedDocs} legajos y ${insertedObs} observaciones sincronizadas.`);
        storage.updateManifest('legajos', { injectedAt: new Date().toISOString(), recordsInjected: upsertedDocs + insertedObs, status: 'injected' });

        return {
            success: true,
            module: 'legajos',
            records: upsertedDocs + insertedObs,
            durationMs: duration
        };
    }

    /**
     * Inyectar TODOS los módulos en orden de dependencia relacional
     */
    async injectAll({ dryRun = false, log = defaultLog } = {}) {
        const t0 = Date.now();
        log('info', '===============================================================');
        log('info', `🚀 INICIANDO INYECCIÓN TOTAL A SUPABASE ${dryRun ? '(MODO SIMULACIÓN)' : ''}`);
        log('info', '===============================================================');

        const results = {};

        // 1. Flota (Tractores, Semis, Unidades)
        results.flota = await this.injectFlota({ dryRun, log });

        // 2. Choferes
        results.choferes = await this.injectChoferes({ dryRun, log });

        // 3. Movimientos (Pareos Activos)
        results.movimientos = await this.injectMovimientos({ dryRun, log });

        // 4. Diagramas Históricos
        try {
            results.diagramas = await this.injectDiagramas({ dryRun, log });
        } catch (eDiag) {
            log('error', `⚠️ Inyección de diagramas históricos falló: ${eDiag.message}`);
            results.diagramas = { success: false, error: eDiag.message };
        }

        // 5. Kilómetros
        try {
            results.kilometros = await this.injectKilometros({ dryRun, log });
        } catch (eKm) {
            log('error', `⚠️ Inyección de kilómetros falló: ${eKm.message}`);
            results.kilometros = { success: false, error: eKm.message };
        }

        // 6. Legajos
        try {
            results.legajos = await this.injectLegajos({ dryRun, log });
        } catch (eLeg) {
            log('error', `⚠️ Inyección de legajos falló: ${eLeg.message}`);
            results.legajos = { success: false, error: eLeg.message };
        }

        // 7. Notificar al backend de RAM (puerto 3005) si no fue simulación
        if (!dryRun) {
            this._notifyRamServer(log);
        }

        const totalDuration = Date.now() - t0;
        log('info', '===============================================================');
        log('success', `🎉 INYECCIÓN TOTAL FINALIZADA EN ${totalDuration}ms`);
        log('info', '===============================================================');

        return {
            success: true,
            dryRun,
            totalDurationMs: totalDuration,
            results
        };
    }

    _notifyRamServer(log = defaultLog) {
        try {
            const postData = JSON.stringify({ forceFull: true });
            const req = http.request({
                hostname: '127.0.0.1',
                port: 3005,
                path: '/api/db/refresh',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData)
                },
                timeout: 3000
            }, (res) => {
                log('info', `📡 [RAM Refresh] Backend RAM notificado (HTTP ${res.statusCode}).`);
            });
            req.on('error', () => {
                // Servidor 3005 no activo en este host
            });
            req.write(postData);
            req.end();
        } catch (e) {}
    }

    async injectModule(moduleKey, options = {}, log = defaultLog) {
        switch ((moduleKey || '').toLowerCase()) {
            case 'master':
            case 'marcas':
                return this.injectMaster({ ...options, log });
            case 'vencimientos':
            case 'uniqm':
                return this.injectVencimientos({ ...options, log });
            case 'flota':
            case 'unidades':
            case 'pareos': {
                log('info', '🚢 [Inyector Flota & Pareos] Sincronizando catálogo de Unidades y Pareos Activos de Hoy...');
                const flotaRes = await this.injectFlota({ ...options, log });
                const movRes = await this.injectMovimientos({ ...options, log });
                return {
                    success: true,
                    module: 'flota',
                    records: (flotaRes.records || 0) + (movRes.records || 0),
                    durationMs: (flotaRes.durationMs || 0) + (movRes.durationMs || 0),
                    subResults: { flota: flotaRes, movimientos: movRes }
                };
            }
            case 'choferes':
                return this.injectChoferes({ ...options, log });
            case 'movimientos':
                return this.injectMovimientos({ ...options, log });
            case 'diagramas':
                return this.injectDiagramas({ ...options, log });
            case 'kilometros':
            case 'km':
                return this.injectKilometros({ ...options, log });
            case 'legajos':
            case 'documentacion':
                return this.injectLegajos({ ...options, log });
            case 'all':
            case 'todas':
            case 'todos':
                return this.injectAll({ ...options, log });
            default:
                throw new Error(`Módulo de inyección desconocido: '${moduleKey}'. Opciones válidas: master, vencimientos, flota, choferes, movimientos, diagramas, kilometros, legajos, all.`);
        }
    }
}

module.exports = new InjectorService();
