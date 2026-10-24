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
     * Hidrata todos los almacenes Hot RAM directamente desde las vistas relacionales de PostgreSQL
     * @param {Object} db - Instancia de utils/db
     */
    async hydrateFromDatabase(db) {
        if (!db || !db.isConfigured()) return false;
        const t0 = Date.now();

        try {
            const [
                rDiaria,
                rFlota,
                rRetorno,
                rIndividual,
                rDiagramaMensual,
                rCalendario
            ] = await Promise.all([
                db.query('SELECT * FROM public.view_diaria_operativa ORDER BY nombre ASC')
                    .catch(e => { console.warn('⚠️ [HotRAM] Error view_diaria_operativa:', e.message); return { rows: [] }; }),
                db.query('SELECT * FROM public.view_flota_operativa ORDER BY tractor ASC NULLS LAST, semi ASC NULLS LAST')
                    .catch(e => { console.warn('⚠️ [HotRAM] Error view_flota_operativa:', e.message); return { rows: [] }; }),
                db.query('SELECT * FROM public.view_personal_retorno ORDER BY fecha_retorno ASC, nombre ASC')
                    .catch(e => { console.warn('⚠️ [HotRAM] Error view_personal_retorno:', e.message); return { rows: [] }; }),
                db.query('SELECT * FROM public.view_individual_chofer ORDER BY nombre ASC')
                    .catch(e => { console.warn('⚠️ [HotRAM] Error view_individual_chofer:', e.message); return { rows: [] }; }),
                db.query('SELECT * FROM public.view_diagrama_mensual ORDER BY chofer_nombre ASC')
                    .catch(e => { console.warn('⚠️ [HotRAM] Error view_diagrama_mensual:', e.message); return { rows: [] }; }),
                db.query(`
                    SELECT diagrama_id, chofer_id, mes_tab, anio, mes_numero, tira_dias, contabilizador, km_mes_total, cant_viajes_mes, dias_km
                    FROM public.view_calendario_diagrama_km
                    ORDER BY anio ASC, mes_numero ASC
                `).catch(e => { console.warn('⚠️ [HotRAM] Error view_calendario_diagrama_km:', e.message); return { rows: [] }; })
            ]);

            // 1. Vista Diaria
            this.diaria = rDiaria.rows || [];

            // 2. Vista Flota
            this.flota = rFlota.rows || [];

            // 3. Vista Retorno
            this.retorno = rRetorno.rows || [];

            // 4. Catálogo y Fichas Individuales
            const indRows = rIndividual.rows || [];
            this.individualPorId.clear();
            this.catalogoChoferes = indRows.map(c => {
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

            // 5. Diagrama Mensual indexado por mes_tab
            this.diagramaMensual.clear();
            (rDiagramaMensual.rows || []).forEach(row => {
                const tab = row.mes_tab || 'GENERAL';
                if (!this.diagramaMensual.has(tab)) {
                    this.diagramaMensual.set(tab, []);
                }
                this.diagramaMensual.get(tab).push(row);
            });

            // 6. Calendario Diagrama + KM indexado por chofer_id
            this.calendarioPorChofer.clear();
            (rCalendario.rows || []).forEach(row => {
                const chId = String(row.chofer_id);
                if (!this.calendarioPorChofer.has(chId)) {
                    this.calendarioPorChofer.set(chId, []);
                }
                this.calendarioPorChofer.get(chId).push(row);
            });

            // Actualizar estadísticas y versionado
            this.stats.totalDiaria = this.diaria.length;
            this.stats.totalFlota = this.flota.length;
            this.stats.totalRetorno = this.retorno.length;
            this.stats.totalChoferes = this.catalogoChoferes.length;
            this.stats.totalCalendarios = rCalendario.rows.length;
            this.stats.totalDiagramaMes = rDiagramaMensual.rows.length;

            this.touch();
            this.isReady = true;

            const duracion = Date.now() - t0;
            console.log(`⚡ [HotRAM] Hidratación completa en ${duracion}ms (${this.stats.totalDiaria} diaria, ${this.stats.totalFlota} flota, ${this.stats.totalRetorno} retorno, ${this.stats.totalCalendarios} calendarios). ETag: ${this.getEtag()}`);
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
        } else if (alerta === 'UNIDAD_VENCIDA') {
            items = items.filter(d => d.alerta_docs_unidad === 'VENCIDO');
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
            dItem.alerta_docs_unidad = (vtv_tr || vtv_semi) ? 'AL_DIA' : 'S_D';
        }

        this.touch();
    }

    /**
     * Actualiza pareo o asignación chofer <-> unidad
     */
    actualizarPareo(unidadId, choferId, { choferNombre, tractor, semi, n_ute } = {}) {
        if (!unidadId && !choferId) return;

        // 1. Desasignar chofer previo de la unidad en Diaria, Flota e Individual
        this.diaria.forEach(d => {
            if (d.unidad_id === unidadId && d.chofer_id !== choferId) {
                d.unidad_id = null;
                d.n_ute = null;
                d.tractor = null;
                d.semi = null;
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
        const targetChofer = this.diaria.find(d => d.chofer_id === choferId);
        if (targetChofer) {
            targetChofer.unidad_id = unidadId;
            if (tractor) targetChofer.tractor = tractor;
            if (semi) targetChofer.semi = semi;
            if (n_ute) targetChofer.n_ute = n_ute;
            targetChofer.estado_chofer = 'circulando';
        }

        // 3. Reflejar en Individual
        const targetInd = this.individualPorId.get(String(choferId));
        if (targetInd) {
            targetInd.unidad_id = unidadId;
            if (tractor) targetInd.tractor = tractor;
            if (semi) targetInd.semi = semi;
            if (n_ute) targetInd.n_ute = n_ute;
            targetInd.estado_chofer = 'circulando';
            targetInd.estado_unidad = 'circulando';
        }

        // 4. Reflejar en Flota
        const targetFlota = this.flota.find(f => f.unidad_id === unidadId);
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
}

const hotRamManager = new HotRamManager();
module.exports = hotRamManager;
