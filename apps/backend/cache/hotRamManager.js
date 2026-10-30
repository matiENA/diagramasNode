/**
 * apps/backend/cache/hotRamManager.js
 * 
 * Motor de Memoria "Hot RAM" para Diagramas EOR (Opción B).
 * Mantiene en RAM las vistas operativas y entidades canónicas para servir lecturas en < 5ms,
 * reducir el Data Egress de Supabase a < 1.9 GB/mes (Free Tier) y evitar saturación del pool pg.
 * 
 * Soporta:
 *  - ETag / HTTP 304 Not Modified para respuesta sin consumo de ancho de banda.
 *  - Filtrado en memoria de alta velocidad (servicio, alerta, búsqueda, fecha, paginación).
 *  - Mutaciones optimistas en vivo sincronizadas con Supabase y WebSocket.
 *  - Fallback a base de datos si la memoria aún está en arranque en frío.
 */

const crypto = require('crypto');
const { normalizar } = require('../utils/shared');
const { clasificarIcm, clasificarIsp } = require('../utils/seguridadVialClassifier');

/**
 * Evalúa vigencia de un conjunto de fechas respecto al día actual (umbral 30 días = 1 mes).
 */
function calcularAlertaFechas(fechas, warningDays = 30) {
    let tieneFecha = false;
    let tienePorVencer = false;
    const now = new Date();
    now.setHours(0, 0, 0, 0);

    for (const f of fechas) {
        if (!f) continue;
        tieneFecha = true;
        const target = new Date(String(f).trim().split('T')[0] + 'T00:00:00');
        if (isNaN(target.getTime())) continue;
        const diffDays = Math.ceil((target - now) / 86400000);
        if (diffDays < 0) return 'VENCIDO';
        if (diffDays <= warningDays) tienePorVencer = true;
    }

    if (tienePorVencer) return 'POR_VENCER';
    return tieneFecha ? 'AL_DIA' : 'S_D';
}

class HotRamManager {
    constructor() {
        this.isReady = false;
        this.lastSync = null;
        this.versionHash = null;
        this.lastDbStats = null;
        this.stats = {
            totalDiaria: 0,
            totalFlota: 0,
            totalRetorno: 0,
            totalChoferes: 0,
            totalCalendarios: 0,
            totalDiagramaMes: 0,
            totalViajesKm: 0,
            totalKmFlota: 0
        };

        // Almacenes de Vistas Operativas
        this.diaria = [];
        this.flota = [];
        this.retorno = [];
        this.catalogoChoferes = [];
        this.individualPorId = new Map();
        this.calendarioPorChofer = new Map();
        this.diagramaMensual = new Map(); // mes_tab -> Array

        // Estructuras de 60 Días de Turnos y 2 Meses de KM
        this.diagramas60Dias = {
            desde: null,
            hasta: null,
            totalDias: 0,
            fechaActual: null,
            totalChoferes: 0,
            choferes: []
        };
        this.km = {
            resumen: null,
            porChofer: new Map(),
            porUnidad: new Map()
        };
        this.kmDiariaPorFecha = new Map();

        // Ventana activa en Hot RAM C1 y caché LRU C2 bajo demanda para histórico (6M/12M)
        this.windowMinYm = 0;
        this.windowMaxYm = 0;
        this.windowTabs = new Set();
        this.calendarioHistoricoLru = new Map(); // key -> { ts, datos }
        this.docsPorChofer = new Map();          // chofer_id -> row chofer_documentacion
        this.obsLru = new Map();                 // chofer_id -> { ts, datos }
        this.badgeCache = { count: 0, ts: 0 };
    }

    /**
     * Convierte una etiqueta 'Oct-26' a entero YYYYMM (ej: 202610)
     */
    parseTabYm(tab) {
        if (!tab) return null;
        const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
        const parts = String(tab).trim().split('-');
        if (parts.length !== 2) return null;
        const mIdx = MESES.indexOf(parts[0].toLowerCase());
        const yy = parseInt(parts[1], 10);
        if (mIdx === -1 || isNaN(yy)) return null;
        const yyyy = yy < 100 ? 2000 + yy : yy;
        return yyyy * 100 + (mIdx + 1);
    }

    /**
     * Verifica si una consulta de calendario está 100% cubierta por la ventana C1 en RAM
     */
    isCalendarioInWindow({ anio, tabs } = {}) {
        if (!this.isReady || !this.windowMinYm || !this.windowMaxYm) return false;
        if (tabs) {
            const list = String(tabs).split(',').map(t => t.trim()).filter(Boolean);
            if (list.length === 0) return false;
            // Garantizar que TODAS las pestañas consultadas estén efectivamente presentes en windowTabs
            return list.every(t => this.windowTabs.has(t));
        }
        if (anio) {
            const aNum = parseInt(anio, 10);
            if (isNaN(aNum)) return false;
            return (aNum * 100 + 1) >= this.windowMinYm && (aNum * 100 + 12) <= this.windowMaxYm;
        }
        return false;
    }

    /**
     * Invalida entradas del caché histórico LRU C2
     */
    invalidateCalendario(choferId = null) {
        if (choferId) {
            const prefix = `${choferId}|`;
            for (const k of this.calendarioHistoricoLru.keys()) {
                if (k.startsWith(prefix)) this.calendarioHistoricoLru.delete(k);
            }
        } else {
            this.calendarioHistoricoLru.clear();
        }
        this.touch();
    }

    /**
     * Refresca las métricas de Seguridad Vial en memoria RAM sin necesidad de rehidratar todo el sistema
     * @param {Object} db - Instancia de utils/db
     */
    async refreshSeguridadVial(db) {
        if (!db || !db.isConfigured()) return false;
        try {
            const yNow = new Date().getFullYear();
            // 1. Recalcular resumen anual
            const rSvAnual = await db.query(`
                SELECT chofer_id,
                       ROUND(AVG(icm)::numeric, 2) AS icm_promedio,
                       ROUND(AVG(isp)::numeric, 2) AS isp_promedio,
                       SUM(cant_infracciones)::int AS total_infracciones,
                       COUNT(*)::int AS meses_evaluados
                FROM public.seguridad_vial
                WHERE anio = $1
                GROUP BY chofer_id
            `, [yNow]).catch(e => { console.warn('⚠️ [HotRAM] Error refreshSeguridadVial anual:', e.message); return { rows: [] }; });

            const svAnualMap = new Map();
            (rSvAnual?.rows || []).forEach(row => {
                const icmVal = row.icm_promedio !== null ? Number(row.icm_promedio) : null;
                const ispVal = row.isp_promedio !== null ? Number(row.isp_promedio) : null;
                svAnualMap.set(String(row.chofer_id), {
                    anio: yNow,
                    icm_promedio: icmVal,
                    isp_promedio: ispVal,
                    total_infracciones: parseInt(row.total_infracciones, 10) || 0,
                    meses_evaluados: parseInt(row.meses_evaluados, 10) || 0,
                    icm_clasificacion: clasificarIcm(icmVal),
                    isp_clasificacion: clasificarIsp(ispVal)
                });
            });

            // Actualizar individualPorId en RAM
            for (const [id, chofer] of this.individualPorId.entries()) {
                const chId = String(chofer.chofer_id || id);
                if (svAnualMap.has(chId)) {
                    chofer.seguridad_vial_anual = svAnualMap.get(chId);
                }
            }

            // 2. Recalcular métricas de cada mes en los calendarios de la ventana activa
            const rSvMeses = await db.query(`
                SELECT chofer_id, anio, mes_numero, icm, isp, cant_infracciones, tiempo_conduccion_horas
                FROM public.seguridad_vial
                WHERE anio = $1
            `, [yNow]).catch(e => { console.warn('⚠️ [HotRAM] Error refreshSeguridadVial meses:', e.message); return { rows: [] }; });

            const svMesMap = new Map();
            (rSvMeses?.rows || []).forEach(row => {
                const key = `${row.chofer_id}|${row.anio}|${row.mes_numero}`;
                svMesMap.set(key, row);
            });

            for (const [chId, meses] of this.calendarioPorChofer.entries()) {
                meses.forEach(m => {
                    const key = `${chId}|${m.anio}|${m.mes_numero}`;
                    const sv = svMesMap.get(key);
                    if (sv) {
                        m.icm = sv.icm !== null && sv.icm !== undefined ? Number(sv.icm) : null;
                        m.isp = sv.isp !== null && sv.isp !== undefined ? Number(sv.isp) : null;
                        m.cant_infracciones = parseInt(sv.cant_infracciones, 10) || 0;
                        m.tiempo_conduccion_horas = parseFloat(sv.tiempo_conduccion_horas) || 0;
                        m.icm_clasificacion = clasificarIcm(m.icm);
                        m.isp_clasificacion = clasificarIsp(m.isp);
                    }
                });
            }

            // Purgar caché C2 LRU
            this.calendarioHistoricoLru.clear();
            this.touch();
            console.log(`⚡ [HotRAM] Seguridad vial actualizada en RAM para ${svAnualMap.size} choferes. ETag: ${this.getEtag()}`);
            return true;
        } catch (err) {
            console.error('❌ [HotRAM] Error al refrescar seguridad vial:', err.message);
            return false;
        }
    }

    getCalendarioC2(key, ttlMs = 10 * 60 * 1000) {
        const entry = this.calendarioHistoricoLru.get(key);
        if (!entry) return null;
        if (Date.now() - entry.ts > ttlMs) {
            this.calendarioHistoricoLru.delete(key);
            return null;
        }
        // Refresh LRU order
        this.calendarioHistoricoLru.delete(key);
        this.calendarioHistoricoLru.set(key, entry);
        return entry.datos;
    }

    setCalendarioC2(key, datos, maxEntries = 80) {
        if (this.calendarioHistoricoLru.has(key)) {
            this.calendarioHistoricoLru.delete(key);
        } else if (this.calendarioHistoricoLru.size >= maxEntries) {
            const oldestKey = this.calendarioHistoricoLru.keys().next().value;
            if (oldestKey !== undefined) this.calendarioHistoricoLru.delete(oldestKey);
        }
        this.calendarioHistoricoLru.set(key, { ts: Date.now(), datos });
    }

    /**
     * Genera un ETag consistente a partir de la versión actual en RAM
     */
    getEtag() {
        return `"${this.versionHash || 'v0'}"`;
    }

    /**
     * Regenera el hash de versión cuando ocurren cambios o hidrataciones
     */
    touch() {
        this.lastSync = new Date().toISOString();
        const base = `${this.lastSync}-${this.diaria.length}-${this.flota.length}-${this.retorno.length}-${this.individualPorId.size}-${this.calendarioPorChofer.size}`;
        this.versionHash = crypto.createHash('md5').update(base).digest('hex').substring(0, 16);
    }

    /**
     * Hidrata los almacenes Hot RAM desde las vistas relacionales de PostgreSQL
     * acotando series temporales a una ventana móvil activa (default: 4 meses: -2 a +1)
     * para evitar descargas masivas de historia cerrada (~90% menos Data Egress).
     * @param {Object} db - Instancia de utils/db
     * @param {Object} [options] - { skipCalendario?: boolean }
     */
    async hydrateFromDatabase(db, options = {}) {
        if (!db || !db.isConfigured()) return false;
        const t0 = Date.now();
        const skipCal = Boolean(options.skipCalendario && this.calendarioPorChofer.size > 0);

        const hoy = new Date();
        const yNow = hoy.getFullYear();
        const mNow = hoy.getMonth();
        const dNow = hoy.getDate();

        const monthsBack = Math.max(parseInt(process.env.HOT_RAM_MONTHS_BACK, 10) || 2, 2);
        const monthsFwd = Math.max(parseInt(process.env.HOT_RAM_MONTHS_FWD, 10) || 1, 1);
        const dMinWin = new Date(yNow, mNow - monthsBack, 1);
        const dMaxWin = new Date(yNow, mNow + monthsFwd, 1);
        const minYm = dMinWin.getFullYear() * 100 + (dMinWin.getMonth() + 1);
        const maxYm = dMaxWin.getFullYear() * 100 + (dMaxWin.getMonth() + 1);

        try {
            const corePromises = [
                db.query('SELECT * FROM public.view_diaria_operativa ORDER BY nombre ASC')
                    .catch(e => { console.warn('⚠️ [HotRAM] Error view_diaria_operativa:', e.message); return { rows: [] }; }),
                db.query('SELECT * FROM public.view_flota_operativa ORDER BY tractor ASC NULLS LAST, semi ASC NULLS LAST')
                    .catch(e => { console.warn('⚠️ [HotRAM] Error view_flota_operativa:', e.message); return { rows: [] }; }),
                db.query('SELECT * FROM public.view_personal_retorno ORDER BY fecha_retorno ASC, nombre ASC')
                    .catch(e => { console.warn('⚠️ [HotRAM] Error view_personal_retorno:', e.message); return { rows: [] }; }),
                db.query('SELECT * FROM public.view_individual_chofer ORDER BY nombre ASC')
                    .catch(e => { console.warn('⚠️ [HotRAM] Error view_individual_chofer:', e.message); return { rows: [] }; }),
                db.query(`
                    SELECT chofer_id,
                           ROUND(AVG(icm)::numeric, 2) AS icm_promedio,
                           ROUND(AVG(isp)::numeric, 2) AS isp_promedio,
                           SUM(cant_infracciones)::int AS total_infracciones,
                           COUNT(*)::int AS meses_evaluados
                    FROM public.seguridad_vial
                    WHERE anio = $1
                    GROUP BY chofer_id
                `, [yNow]).catch(e => { console.warn('⚠️ [HotRAM] Error seguridad_vial_anual:', e.message); return { rows: [] }; })
            ];

            if (!skipCal) {
                corePromises.push(
                    db.query(`
                        SELECT registro_id, mes_tab, anio, mes_numero, servicio, diagrama_tipo,
                               chofer_id, chofer_nombre, tira_dias, contabilizador, actualizado_el
                        FROM public.view_diagrama_mensual
                        WHERE (anio * 100 + mes_numero) BETWEEN $1 AND $2
                        ORDER BY chofer_nombre ASC
                    `, [minYm, maxYm]).catch(e => { console.warn('⚠️ [HotRAM] Error view_diagrama_mensual:', e.message); return { rows: [] }; }),
                    db.query(`
                        SELECT diagrama_id, chofer_id, mes_tab, anio, mes_numero, tira_dias,
                               contabilizador, km_mes_total, cant_viajes_mes, dias_km,
                               icm, isp, cant_infracciones, tiempo_conduccion_horas
                        FROM public.view_calendario_diagrama_km
                        WHERE (anio * 100 + mes_numero) BETWEEN $1 AND $2
                        ORDER BY anio ASC, mes_numero ASC
                    `, [minYm, maxYm]).catch(e => { console.warn('⚠️ [HotRAM] Error view_calendario_diagrama_km (ventana activa):', e.message); return { rows: [] }; })
                );
            }

            const [
                rDiaria,
                rFlota,
                rRetorno,
                rIndividual,
                rSvAnual,
                rDiagramaMensual,
                rCalendario
            ] = await Promise.all(corePromises);

            // 1. Vista Diaria
            this.diaria = rDiaria.rows || [];

            // 2. Vista Flota
            this.flota = rFlota.rows || [];

            // 3. Vista Retorno
            this.retorno = rRetorno.rows || [];

            // 4. Catálogo y Fichas Individuales
            const svAnualMap = new Map();
            (rSvAnual?.rows || []).forEach(row => {
                const icmVal = row.icm_promedio !== null ? Number(row.icm_promedio) : null;
                const ispVal = row.isp_promedio !== null ? Number(row.isp_promedio) : null;
                svAnualMap.set(String(row.chofer_id), {
                    anio: yNow,
                    icm_promedio: icmVal,
                    isp_promedio: ispVal,
                    total_infracciones: parseInt(row.total_infracciones, 10) || 0,
                    meses_evaluados: parseInt(row.meses_evaluados, 10) || 0,
                    icm_clasificacion: clasificarIcm(icmVal),
                    isp_clasificacion: clasificarIsp(ispVal)
                });
            });

            const indRows = rIndividual.rows || [];
            this.individualPorId.clear();
            this.catalogoChoferes = indRows.map(c => {
                c.seguridad_vial_anual = svAnualMap.get(String(c.chofer_id)) || null;
                this.individualPorId.set(String(c.chofer_id), c);
                if (c.dni) this.individualPorId.set(String(c.dni).replace(/\D/g, ''), c);
                return {
                    chofer_id: c.chofer_id,
                    id: c.chofer_id,
                    nombre: c.nombre,
                    dni: c.dni,
                    servicio: c.servicio,
                    c_servicio: c.servicio,
                    foto: c.foto,
                    telefono: c.telefono,
                    estado_chofer: c.estado_chofer,
                    estado: c.estado_chofer
                };
            });

            if (!skipCal && rDiagramaMensual && rCalendario) {
                this.windowMinYm = minYm;
                this.windowMaxYm = maxYm;
                this.windowTabs.clear();
                this.calendarioHistoricoLru.clear();

                // 5. Diagrama Mensual indexado por mes_tab (ventana activa)
                this.diagramaMensual.clear();
                (rDiagramaMensual.rows || []).forEach(row => {
                    const tab = row.mes_tab || 'GENERAL';
                    this.windowTabs.add(tab);
                    if (!this.diagramaMensual.has(tab)) {
                        this.diagramaMensual.set(tab, []);
                    }
                    this.diagramaMensual.get(tab).push(row);
                });

                // 6. Calendario Diagrama + KM indexado por chofer_id y KMs diarios por fecha
                const prevCalendarioPorChofer = new Map(this.calendarioPorChofer);
                this.calendarioPorChofer.clear();
                this.kmDiariaPorFecha.clear();
                (rCalendario.rows || []).forEach(row => {
                    if (row.mes_tab) this.windowTabs.add(row.mes_tab);
                    const chId = String(row.chofer_id);

                    row.icm = row.icm !== null && row.icm !== undefined ? Number(row.icm) : null;
                    row.isp = row.isp !== null && row.isp !== undefined ? Number(row.isp) : null;
                    row.cant_infracciones = row.cant_infracciones !== null && row.cant_infracciones !== undefined ? Number(row.cant_infracciones) : 0;
                    row.tiempo_conduccion_horas = row.tiempo_conduccion_horas !== null && row.tiempo_conduccion_horas !== undefined ? Number(row.tiempo_conduccion_horas) : 0;
                    row.icm_clasificacion = clasificarIcm(row.icm);
                    row.isp_clasificacion = clasificarIsp(row.isp);

                    // 🛡️ Guardia defensiva: Si la base de datos devuelve 0 km o vacío pero en RAM previa existían KMs > 0 para este mes_tab, conservar los KMs previos
                    if ((!row.km_mes_total || Number(row.km_mes_total) === 0) && prevCalendarioPorChofer.has(chId)) {
                        const prevList = prevCalendarioPorChofer.get(chId);
                        const prevRow = prevList.find(p => p.mes_tab === row.mes_tab);
                        if (prevRow && Number(prevRow.km_mes_total) > 0) {
                            row.km_mes_total = prevRow.km_mes_total;
                            row.cant_viajes_mes = prevRow.cant_viajes_mes;
                            if (prevRow.dias_km && Object.keys(prevRow.dias_km).length > 0 && (!row.dias_km || Object.keys(row.dias_km).length === 0)) {
                                row.dias_km = prevRow.dias_km;
                            }
                        }
                    }

                    if (!this.calendarioPorChofer.has(chId)) {
                        this.calendarioPorChofer.set(chId, []);
                    }
                    this.calendarioPorChofer.get(chId).push(row);

                    const dias = row.dias_km;
                    if (dias && typeof dias === 'object') {
                        for (const [fIso, info] of Object.entries(dias)) {
                            if (!info) continue;
                            const kmVal = parseFloat(info.km) || 0;
                            const hrVal = String(info.hr || '').trim();
                            if (kmVal <= 0 && !hrVal) continue;

                            if (!this.kmDiariaPorFecha.has(fIso)) {
                                this.kmDiariaPorFecha.set(fIso, []);
                            }
                            this.kmDiariaPorFecha.get(fIso).push({
                                id_chofer: chId,
                                chofer_id: chId,
                                fecha: fIso,
                                km: kmVal,
                                km_totales: kmVal,
                                hoja_ruta: hrVal ? hrVal.split(',').map(s => s.trim()).filter(Boolean) : [],
                                dominio: info.tractor || null,
                                semi: info.semi || null,
                                id_unidad: info.id_unidad || null,
                                n_ute: info.n_ute || null
                            });
                        }
                    }
                });

                this.stats.totalCalendarios = rCalendario.rows.length;
                this.stats.totalDiagramaMes = rDiagramaMensual.rows.length;
            }

            // Invalidar cachés auxiliares C2 de observaciones y badge
            this.obsLru.clear();
            this.badgeCache.ts = 0;

            // 7. Pre-agregación en Hot RAM del Ciclo de Diagrama Operativo (del 26 al 25)
            const MESES_ABREV = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

            let dDesde, dHasta;
            if (dNow >= 26) {
                dDesde = new Date(yNow, mNow, 26);
                dHasta = new Date(yNow, mNow + 1, 25);
            } else {
                dDesde = new Date(yNow, mNow - 1, 26);
                dHasta = new Date(yNow, mNow, 25);
            }

            const startIsoActual = `${dDesde.getFullYear()}-${String(dDesde.getMonth() + 1).padStart(2, '0')}-26`;
            const endIsoActual = `${dHasta.getFullYear()}-${String(dHasta.getMonth() + 1).padStart(2, '0')}-25`;
            const labelActual = `${MESES_ABREV[dDesde.getMonth()]} 26 - ${MESES_ABREV[dHasta.getMonth()]} 25`;

            const dPrevDesde = new Date(dDesde.getFullYear(), dDesde.getMonth() - 1, 26);
            const dPrevHasta = new Date(dHasta.getFullYear(), dHasta.getMonth() - 1, 25);
            const startIsoPrev = `${dPrevDesde.getFullYear()}-${String(dPrevDesde.getMonth() + 1).padStart(2, '0')}-26`;
            const endIsoPrev = `${dPrevHasta.getFullYear()}-${String(dPrevHasta.getMonth() + 1).padStart(2, '0')}-25`;
            const labelPrev = `${MESES_ABREV[dPrevDesde.getMonth()]} 26 - ${MESES_ABREV[dPrevHasta.getMonth()]} 25`;

            for (const [chId, choferObj] of this.individualPorId.entries()) {
                const mesesChofer = this.calendarioPorChofer.get(chId) || [];
                let kmCicloActual = 0;
                let kmCicloPrevio = 0;

                mesesChofer.forEach(m => {
                    const dias = m.dias_km;
                    if (!dias || typeof dias !== 'object') return;
                    for (const [fIso, info] of Object.entries(dias)) {
                        if (!info) continue;
                        const k = parseFloat(info.km) || 0;
                        if (k > 0) {
                            if (fIso >= startIsoActual && fIso <= endIsoActual) kmCicloActual += k;
                            if (fIso >= startIsoPrev && fIso <= endIsoPrev) kmCicloPrevio += k;
                        }
                    }
                });

                if (kmCicloActual > 0) {
                    choferObj.km_ciclo = Math.round(kmCicloActual * 100) / 100;
                    choferObj.ciclo_label = labelActual;
                    choferObj.ciclo_desde = startIsoActual;
                    choferObj.ciclo_hasta = endIsoActual;
                } else if (kmCicloPrevio > 0) {
                    choferObj.km_ciclo = Math.round(kmCicloPrevio * 100) / 100;
                    choferObj.ciclo_label = labelPrev;
                    choferObj.ciclo_desde = startIsoPrev;
                    choferObj.ciclo_hasta = endIsoPrev;
                } else {
                    choferObj.km_ciclo = 0;
                    choferObj.ciclo_label = labelActual;
                    choferObj.ciclo_desde = startIsoActual;
                    choferObj.ciclo_hasta = endIsoActual;
                }
            }

            // Actualizar estadísticas y versionado
            this.stats.totalDiaria = this.diaria.length;
            this.stats.totalFlota = this.flota.length;
            this.stats.totalRetorno = this.retorno.length;
            this.stats.totalChoferes = this.catalogoChoferes.length;

            this.touch();
            this.isReady = true;

            const duracion = Date.now() - t0;
            console.log(`⚡ [HotRAM] Hidratación ${skipCal ? 'parcial (sin calendario)' : `ventana ${minYm}-${maxYm}`} en ${duracion}ms (${this.stats.totalDiaria} diaria, ${this.stats.totalFlota} flota, ${this.stats.totalRetorno} retorno, ${this.stats.totalCalendarios} calendarios). ETag: ${this.getEtag()}`);
            return true;
        } catch (err) {
            console.error('❌ [HotRAM] Error en hidratación:', err.message);
            return false;
        }
    }

    // =========================================================================
    // 🔍 MÉTODOS DE CONSULTA Y FILTRADO EN MEMORIA (O(1) / O(N) EN RAM < 3ms)
    // =========================================================================

    /**
     * Consulta y filtra la Vista Diaria en RAM
     */
    queryDiaria({ limit = 50, offset = 0, servicio, alerta, search }) {
        const limitNum = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 500);
        const offsetNum = Math.max(parseInt(offset, 10) || 0, 0);

        let items = this.diaria;

        // Filtro por servicio
        if (servicio && servicio !== 'TODOS') {
            const sUpper = servicio.trim().toUpperCase();
            if (sUpper === 'GRALES.' || sUpper === 'GRALES') {
                items = items.filter(d => ['GRALES', 'GRALES.'].includes((d.servicio || '').toUpperCase()));
            } else {
                items = items.filter(d => (d.servicio || '').toUpperCase() === sUpper);
            }
        }

        // Filtro por alerta
        if (alerta === 'DOCS_VENCIDOS') {
            items = items.filter(d => d.alerta_docs_chofer === 'VENCIDO');
        } else if (alerta === 'DOCS_POR_VENCER') {
            items = items.filter(d => d.alerta_docs_chofer === 'POR_VENCER');
        } else if (alerta === 'UNIDAD_VENCIDA') {
            items = items.filter(d => d.alerta_docs_unidad === 'VENCIDO');
        } else if (alerta === 'UNIDAD_POR_VENCER') {
            items = items.filter(d => d.alerta_docs_unidad === 'POR_VENCER');
        } else if (alerta === 'CUALQUIER_ALERTA') {
            items = items.filter(d => 
                ['VENCIDO', 'POR_VENCER'].includes(d.alerta_docs_chofer) ||
                ['VENCIDO', 'POR_VENCER'].includes(d.alerta_docs_unidad)
            );
        }

        // Búsqueda por texto (nombre, dni, tractor, semi, n_ute)
        if (search && search.trim().length > 0) {
            const term = normalizar(search.trim());
            items = items.filter(d => 
                normalizar(d.nombre || '').includes(term) ||
                (d.dni && String(d.dni).includes(term)) ||
                (d.tractor && normalizar(d.tractor).includes(term)) ||
                (d.semi && normalizar(d.semi).includes(term)) ||
                (d.n_ute && String(d.n_ute).includes(term))
            );
        }

        const total = items.length;
        const paged = items.slice(offsetNum, offsetNum + limitNum);

        return {
            total,
            limit: limitNum,
            offset: offsetNum,
            retornados: paged.length,
            hay_mas: (offsetNum + paged.length) < total,
            datos: paged
        };
    }

    /**
     * Devuelve los kilómetros y viajes del día para la Vista Diaria en O(1) desde RAM
     * @param {string} fechaIso - Fecha en formato YYYY-MM-DD
     */
    getDiariaKm(fechaIso) {
        if (!this.isReady) return null;
        const f = String(fechaIso || '').split('T')[0];
        const parts = f.split('-');
        if (parts.length >= 2 && this.windowMinYm && this.windowMaxYm) {
            const ym = parseInt(parts[0], 10) * 100 + parseInt(parts[1], 10);
            if (!isNaN(ym) && (ym < this.windowMinYm || ym > this.windowMaxYm)) {
                return null; // Fuera de ventana C1 -> delegar a fn_km_por_fecha en SQL (< 1ms)
            }
        }
        return this.kmDiariaPorFecha.get(f) || [];
    }

    /**
     * Consulta y filtra la Vista de Flota en RAM
     */
    queryFlota({ search, servicio }) {
        let items = this.flota;

        if (servicio && servicio !== 'TODOS') {
            const sUpper = servicio.trim().toUpperCase();
            if (sUpper === 'GRALES.' || sUpper === 'GRALES') {
                items = items.filter(f => ['GRALES', 'GRALES.'].includes((f.servicio || '').toUpperCase()));
            } else {
                items = items.filter(f => (f.servicio || '').toUpperCase() === sUpper);
            }
        }

        if (search && search.trim().length > 0) {
            const term = normalizar(search.trim());
            items = items.filter(f => 
                (f.tractor && normalizar(f.tractor).includes(term)) ||
                (f.semi && normalizar(f.semi).includes(term)) ||
                (f.chofer_nombre && normalizar(f.chofer_nombre).includes(term)) ||
                (f.dia_diagrama && normalizar(f.dia_diagrama).includes(term)) ||
                (f.n_ute && String(f.n_ute).includes(term))
            );
        }

        return items;
    }

    /**
     * Consulta y filtra la Vista de Personal que Retorna en RAM
     */
    queryRetorno({ tipo, servicio, search }) {
        let items = this.retorno;

        if (tipo) {
            const tUpper = tipo.trim().toUpperCase();
            if (tUpper === 'HOY') {
                items = items.filter(r => r.retorna_cuando === 'HOY' || r.dias_para_retorno === 0);
            } else if (tUpper === 'MANANA' || tUpper === 'MAÑANA') {
                items = items.filter(r => r.retorna_cuando === 'MANANA' || r.retorna_cuando === 'MAÑANA' || r.dias_para_retorno === 1);
            } else if (['2', '2_DIAS', 'EN 2 DÍAS'].includes(tUpper)) {
                items = items.filter(r => r.dias_para_retorno === 2);
            } else if (['3', '3_DIAS', 'EN 3 DÍAS'].includes(tUpper)) {
                items = items.filter(r => r.dias_para_retorno === 3);
            } else if (['4', '4_DIAS', 'EN 4 DÍAS'].includes(tUpper)) {
                items = items.filter(r => r.dias_para_retorno === 4);
            }
        }

        if (servicio && servicio !== 'TODOS') {
            const sUpper = servicio.trim().toUpperCase();
            if (sUpper === 'GRALES.' || sUpper === 'GRALES') {
                items = items.filter(r => ['GRALES', 'GRALES.'].includes((r.servicio || '').toUpperCase()));
            } else {
                items = items.filter(r => (r.servicio || '').toUpperCase() === sUpper);
            }
        }

        if (search && search.trim().length > 0) {
            const term = normalizar(search.trim());
            items = items.filter(r => 
                (r.nombre && normalizar(r.nombre).includes(term)) ||
                (r.dni && String(r.dni).includes(term)) ||
                (r.tractor && normalizar(r.tractor).includes(term)) ||
                (r.n_ute && String(r.n_ute).includes(term))
            );
        }

        const vuelvenHoy = items.filter(r => r.retorna_cuando === 'HOY' || r.dias_para_retorno === 0).length;
        const vuelvenManana = items.filter(r => r.retorna_cuando === 'MANANA' || r.retorna_cuando === 'MAÑANA' || r.dias_para_retorno === 1).length;
        const vuelven2Dias = items.filter(r => r.dias_para_retorno === 2).length;
        const vuelven3Dias = items.filter(r => r.dias_para_retorno === 3).length;
        const vuelven4Dias = items.filter(r => r.dias_para_retorno === 4).length;

        return {
            total: items.length,
            resumen: {
                vuelven_hoy: vuelvenHoy,
                vuelven_manana: vuelvenManana,
                vuelven_2dias: vuelven2Dias,
                vuelven_3dias: vuelven3Dias,
                vuelven_4dias: vuelven4Dias
            },
            datos: items
        };
    }

    /**
     * Catálogo ligero de choferes para el selector lateral
     */
    queryCatalogoChoferes() {
        return this.catalogoChoferes;
    }

    /**
     * Ficha individual completa de un Chofer
     */
    queryIndividualChofer(choferId) {
        if (!choferId) return null;
        const clean = String(choferId).trim();
        return this.individualPorId.get(clean) || this.individualPorId.get(clean.replace(/\D/g, '')) || null;
    }

    /**
     * Calendario Diagrama + KM por chofer
     */
    queryCalendario(choferId, { anio, tabs } = {}) {
        if (!choferId) return [];
        const chId = String(choferId).trim();
        let items = this.calendarioPorChofer.get(chId) || [];

        if (tabs) {
            const tabList = tabs.split(',').map(t => t.trim());
            items = items.filter(c => tabList.includes(c.mes_tab));
        } else if (anio) {
            const aNum = parseInt(anio, 10);
            items = items.filter(c => c.anio === aNum);
        }

        return items;
    }

    /**
     * Grilla operativa mensual de diagrama
     */
    queryDiagramaMensual(mesTab = 'Sep-26', { servicio, search, limit = 500 } = {}) {
        let items = this.diagramaMensual.get(mesTab.trim()) || [];

        if (servicio && servicio !== 'TODOS') {
            const sUpper = servicio.trim().toUpperCase();
            if (sUpper === 'GRALES.' || sUpper === 'GRALES') {
                items = items.filter(d => ['GRALES', 'GRALES.'].includes((d.servicio || '').toUpperCase()));
            } else {
                items = items.filter(d => (d.servicio || '').toUpperCase() === sUpper);
            }
        }

        if (search && search.trim().length > 0) {
            const term = normalizar(search.trim());
            items = items.filter(d => 
                (d.chofer_nombre && normalizar(d.chofer_nombre).includes(term)) ||
                (d.tractor && normalizar(d.tractor).includes(term))
            );
        }

        const limitNum = Math.min(Math.max(parseInt(limit, 10) || 500, 1), 1000);
        return items.slice(0, limitNum);
    }

    // =========================================================================
    // ⚡ MUTACIONES ATÓMICAS EN RAM (OPTIMISTIC WRITES SIN ESPERAR RE-POLLING)
    // =========================================================================

    /**
     * Actualiza el acople de una unidad en RAM
     */
    actualizarAcople(unidadId, { tractor_id, semi_id, tractor, semi, cisternado, vtv_tr, mas_tr, vtv_semi, mas_semi, estado }) {
        if (!unidadId) return;

        // Actualizar en Flota
        const fItem = this.flota.find(u => u.unidad_id === unidadId);
        if (fItem) {
            if (tractor !== undefined) fItem.tractor = tractor;
            if (semi !== undefined) fItem.semi = semi;
            if (vtv_tr !== undefined) fItem.vtv_tr = vtv_tr;
            if (mas_tr !== undefined) fItem.mas_tr = mas_tr;
            if (vtv_semi !== undefined) fItem.vtv_semi = vtv_semi;
            if (mas_semi !== undefined) fItem.mas_semi = mas_semi;
            fItem.alerta_docs_unidad = calcularAlertaFechas([fItem.vtv_tr, fItem.mas_tr, fItem.vtv_semi, fItem.mas_semi], 30);
        }

        // Actualizar en Diaria
        const dItem = this.diaria.find(d => d.unidad_id === unidadId);
        if (dItem) {
            if (tractor !== undefined) dItem.tractor = tractor;
            if (semi !== undefined) dItem.semi = semi;
            if (vtv_tr !== undefined) dItem.vtv_tr = vtv_tr;
            if (mas_tr !== undefined) dItem.mas_tr = mas_tr;
            if (vtv_semi !== undefined) dItem.vtv_semi = vtv_semi;
            if (mas_semi !== undefined) dItem.mas_semi = mas_semi;
            dItem.alerta_docs_unidad = calcularAlertaFechas([dItem.vtv_tr, dItem.mas_tr, dItem.vtv_semi, dItem.mas_semi], 30);
        }

        this.touch();
    }

    /**
     * Actualiza pareo o asignación chofer <-> unidad
     */
    actualizarPareo(unidadId, choferId, { choferNombre, tractor, semi, n_ute } = {}) {
        if (!unidadId && !choferId) return;

        const targetFlota = this.flota.find(f => String(f.unidad_id) === String(unidadId));

        // 1. Desasignar chofer previo de la unidad en Diaria, Flota e Individual
        this.diaria.forEach(d => {
            if (String(d.unidad_id) === String(unidadId) && String(d.chofer_id) !== String(choferId)) {
                d.unidad_id = null;
                d.n_ute = null;
                d.tractor = null;
                d.semi = null;
                d.vtv_tr = null;
                d.mas_tr = null;
                d.vtv_semi = null;
                d.mas_semi = null;
                d.alerta_docs_unidad = 'S_D';
                d.estado_chofer = 'inactivo';

                const prevInd = this.individualPorId.get(String(d.chofer_id));
                if (prevInd) {
                    prevInd.unidad_id = null;
                    prevInd.n_ute = null;
                    prevInd.tractor = null;
                    prevInd.semi = null;
                    prevInd.estado_unidad = 'disponible';
                }
            }
        });

        // 2. Asignar nuevo chofer a la unidad en Diaria
        const targetChofer = this.diaria.find(d => String(d.chofer_id) === String(choferId));
        if (targetChofer) {
            targetChofer.unidad_id = unidadId;
            targetChofer.tractor = tractor || targetChofer.tractor || null;
            targetChofer.semi = semi || targetChofer.semi || null;
            targetChofer.n_ute = n_ute || targetChofer.n_ute || null;
            targetChofer.estado_chofer = 'circulando';
            if (targetFlota) {
                targetChofer.vtv_tr = targetFlota.vtv_tr || targetChofer.vtv_tr || null;
                targetChofer.mas_tr = targetFlota.mas_tr || targetChofer.mas_tr || null;
                targetChofer.vtv_semi = targetFlota.vtv_semi || targetChofer.vtv_semi || null;
                targetChofer.mas_semi = targetFlota.mas_semi || targetChofer.mas_semi || null;
                targetChofer.alerta_docs_unidad = calcularAlertaFechas([targetChofer.vtv_tr, targetChofer.mas_tr, targetChofer.vtv_semi, targetChofer.mas_semi], 30);
            }
        }

        // 3. Reflejar en Individual
        const targetInd = this.individualPorId.get(String(choferId));
        if (targetInd) {
            targetInd.unidad_id = unidadId;
            targetInd.tractor = tractor || targetInd.tractor || null;
            targetInd.semi = semi || targetInd.semi || null;
            targetInd.n_ute = n_ute || targetInd.n_ute || null;
            targetInd.estado_chofer = 'circulando';
            targetInd.estado_unidad = 'circulando';
        }

        // 4. Reflejar en Flota
        if (targetFlota) {
            targetFlota.chofer_id = choferId;
            if (choferNombre) targetFlota.chofer_nombre = choferNombre;
        }

        this.touch();
    }

    /**
     * Aplica una desunión explícita
     */
    desasignarUnidad(unidadId) {
        if (!unidadId) return;

        this.diaria.forEach(d => {
            if (d.unidad_id === unidadId) {
                d.unidad_id = null;
                d.n_ute = null;
                d.tractor = null;
                d.semi = null;
                d.vtv_tr = null;
                d.mas_tr = null;
                d.vtv_semi = null;
                d.mas_semi = null;
                d.alerta_docs_unidad = 'S_D';
                d.estado_chofer = 'inactivo';

                const ind = this.individualPorId.get(String(d.chofer_id));
                if (ind) {
                    ind.unidad_id = null;
                    ind.n_ute = null;
                    ind.tractor = null;
                    ind.semi = null;
                    ind.estado_unidad = 'disponible';
                }
            }
        });

        const targetFlota = this.flota.find(f => f.unidad_id === unidadId);
        if (targetFlota) {
            targetFlota.chofer_id = null;
            targetFlota.chofer_nombre = '';
            targetFlota.dia_diagrama = '-';
        }

        this.touch();
    }

    /**
     * Aplica una desunión explícita por choferId
     */
    desasignarChofer(choferId) {
        if (!choferId) return;

        this.diaria.forEach(d => {
            if (String(d.chofer_id) === String(choferId)) {
                const uId = d.unidad_id;
                d.unidad_id = null;
                d.n_ute = null;
                d.tractor = null;
                d.semi = null;
                d.estado_chofer = 'inactivo';

                if (uId) {
                    const targetFlota = this.flota.find(f => f.unidad_id === uId);
                    if (targetFlota) {
                        targetFlota.chofer_id = null;
                        targetFlota.chofer_nombre = '';
                        targetFlota.dia_diagrama = '-';
                    }
                }
            }
        });

        const ind = this.individualPorId.get(String(choferId));
        if (ind) {
            ind.unidad_id = null;
            ind.n_ute = null;
            ind.tractor = null;
            ind.semi = null;
            ind.estado_chofer = 'inactivo';
            ind.estado_unidad = 'disponible';
        }

        this.touch();
    }
}

const hotRamManager = new HotRamManager();
module.exports = hotRamManager;
