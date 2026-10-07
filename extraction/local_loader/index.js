require('dotenv').config();
const http = require('http');
const { createClient } = require('@supabase/supabase-js');
const { syncAll } = require('./sync');
const { extractDiagramasDetalle, contabilizarDias } = require('./extractors/diagramasDetalle');
const { extractKilometros, hydrateKmFromSupabase, cargarDesdeDisco } = require('./extractors/kilometros');
const { normalizar, getFechaArgentina } = require('./utils/sheets');
const { Pool } = require('pg');

const PORT = process.env.PORT || 3005;
const SYNC_INTERVAL_MS = (parseInt(process.env.SYNC_INTERVAL_MINUTES, 10) || 15) * 60 * 1000;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const pool = process.env.DATABASE_URL ? new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 5
}) : null;

// Manejo global de excepciones para prevenir caídas del servidor
process.on('uncaughtException', (err) => {
    console.error('💥 Uncaught Exception interceptada:', err.message || err);
    if (err.stack) console.error(err.stack);
});
process.on('unhandledRejection', (reason) => {
    console.error('💥 Unhandled Rejection interceptada:', reason);
});

// RAM Cache local en memoria
const ramStorage = {
    lastSync: null,
    isSyncing: false,
    isSyncingKm: false,
    unidades: [],
    choferes: [],
    movimientos: [],
    diagramas60Dias: {
        desde: null,
        hasta: null,
        totalDias: 60,
        fechaActual: null,
        totalChoferes: 0,
        choferes: []
    },
    // Partición en memoria de Kilómetros (Últimos 6 meses)
    km: {
        resumen: null,
        porUnidad: new Map(),
        porChofer: new Map()
    },
    // Mapa indexado en memoria O(1) de choferes para búsquedas instantáneas
    choferesMapNorm: new Map(),
    stats: {
        totalUnidades: 0,
        totalChoferes: 0,
        totalMovimientos: 0,
        totalDiagramas60Dias: 0,
        totalKmFlota: 0,
        totalViajesKm: 0
    }
};

async function reloadRamCache(inMemorySyncResult = null) {
    try {
        console.log('⚡ Recargando RAM Cache desde Supabase...');
        if (pool) {
            const [uRes, cRes, mRes] = await Promise.all([
                pool.query(`
                    SELECT u.*, t.patente AS tractor, s.patente AS semi, su.denominacion AS servicio
                    FROM public.unidades u
                    LEFT JOIN public.tractores t ON u.tractor_id = t.id
                    LEFT JOIN public.semis s ON u.semi_id = s.id
                    LEFT JOIN public.servicios_unidades su ON u.servicio_id = su.id
                `),
                pool.query('SELECT * FROM public.choferes'),
                pool.query('SELECT * FROM public.movimientos')
            ]);
            ramStorage.unidades = uRes.rows || [];
            ramStorage.choferes = cRes.rows || [];
            ramStorage.movimientos = mRes.rows || [];
        } else {
            const [uRes, cRes, mRes] = await Promise.all([
                supabase.from('unidades').select('*, tractores(patente), semis(patente), servicios_unidades(denominacion)'),
                supabase.from('choferes').select('*'),
                supabase.from('movimientos').select('*')
            ]);
            ramStorage.unidades = (uRes.data || []).map(u => ({
                ...u,
                tractor: u.tractores?.patente || null,
                semi: u.semis?.patente || null,
                servicio: u.servicios_unidades?.denominacion || null
            }));
            ramStorage.choferes = cRes.data || [];
            ramStorage.movimientos = mRes.data || [];
        }

        // Si tenemos los 60 días directos de una sincronización reciente, los conservamos
        if (inMemorySyncResult && inMemorySyncResult.diagramas60DiasRAM) {
            ramStorage.diagramas60Dias = inMemorySyncResult.diagramas60DiasRAM;
        } else if (!ramStorage.diagramas60Dias.desde) {
            // Hidratar desde Sheets si aún no se ha ejecutado un ciclo
            try {
                console.log('⚡ Hidratando ventana inicial de 60 días de Diagramas para Hot RAM...');
                const { diagramas60DiasRAM } = await extractDiagramasDetalle(process.env.ID_SPREADSHEET_DIAGRAMAS);
                ramStorage.diagramas60Dias = diagramas60DiasRAM;
            } catch (eDiag) {
                console.warn('⚠️ No se pudo hidratar los 60 días de diagramas en RAM inicial:', eDiag.message);
            }
        }

        // Construir índice rápido en memoria O(1) por nombre normalizado
        ramStorage.choferesMapNorm.clear();
        (ramStorage.choferes || []).forEach(c => {
            const norm = normalizar(c.nombre);
            ramStorage.choferesMapNorm.set(norm, c);
        });

        // Vincular los 60 días de RAM a los choferes si no vinieron de Supabase
        if (ramStorage.diagramas60Dias && Array.isArray(ramStorage.diagramas60Dias.choferes)) {
            ramStorage.diagramas60Dias.choferes.forEach(dCh => {
                const norm = normalizar(dCh.nombre);
                if (ramStorage.choferesMapNorm.has(norm)) {
                    const ch = ramStorage.choferesMapNorm.get(norm);
                    if (!ch.diagrama_json) {
                        ch.diagrama_json = {
                            rango_60_dias: {
                                desde: ramStorage.diagramas60Dias.desde,
                                hasta: ramStorage.diagramas60Dias.hasta,
                                total_dias: 60
                            },
                            caracteres_60_dias: dCh.caracteres,
                            contabilizador_60_dias: dCh.contabilizador,
                            ciclo_26_25: dCh.ciclo_26_25
                        };
                    }
                    if (!ch.contabilizador) ch.contabilizador = dCh.contabilizador;
                    if (!ch.diagrama_tipo && dCh.diagrama_tipo) ch.diagrama_tipo = dCh.diagrama_tipo;
                }
            });
        }

        // Hidratar o extraer Kilómetros (Últimos 2 meses en Hot RAM)
        if (!ramStorage.km.resumen) {
            const cachedKm = cargarDesdeDisco();
            if (cachedKm) {
                console.log('⚡ Caché de Kilómetros (2 meses) cargada desde disco.');
                ramStorage.km = cachedKm;
            } else if (pool) {
                try {
                    console.log('⚡ Hidratando Kilómetros (2 meses) desde Supabase para Hot RAM...');
                    ramStorage.km = await hydrateKmFromSupabase(pool, ramStorage.unidades, ramStorage.choferes);
                } catch (eKm) {
                    console.warn('⚠️ No se pudo hidratar kilómetros desde Supabase:', eKm.message);
                }
            } else {
                try {
                    console.log('⚡ Extrayendo Kilómetros (2 meses) para Hot RAM...');
                    ramStorage.km = await extractKilometros(ramStorage.unidades, ramStorage.choferes, pool);
                } catch (eKm) {
                    console.warn('⚠️ No se pudo extraer kilómetros en inicio:', eKm.message);
                }
            }
        }
        if (ramStorage.km && ramStorage.km.resumen) {
            ramStorage.stats.totalKmFlota = ramStorage.km.resumen.total_kms_flota;
            ramStorage.stats.totalViajesKm = ramStorage.km.resumen.total_viajes;
        }

        ramStorage.stats.totalUnidades = ramStorage.unidades.length;
        ramStorage.stats.totalChoferes = ramStorage.choferes.length;
        ramStorage.stats.totalMovimientos = ramStorage.movimientos.length;
        ramStorage.stats.totalDiagramas60Dias = ramStorage.diagramas60Dias.choferes ? ramStorage.diagramas60Dias.choferes.length : 0;
        ramStorage.lastSync = new Date().toISOString();

        console.log(`⚡ RAM Cache lista: ${ramStorage.stats.totalUnidades} unidades, ${ramStorage.stats.totalChoferes} choferes, ${ramStorage.stats.totalMovimientos} movimientos, ${ramStorage.stats.totalDiagramas60Dias} diagramas 60d, ${ramStorage.stats.totalKmFlota.toLocaleString('es-AR')} km en ${ramStorage.stats.totalViajesKm} viajes (Hot RAM 2 meses).`);
    } catch (e) {
        console.error('❌ Error recargando RAM Cache:', e.message);
    }
}

async function runScheduledSync() {
    if (ramStorage.isSyncing) {
        console.log('⚠️ Sincronización en curso, omitiendo ciclo programado.');
        return { success: false, message: 'Sincronización ya en curso' };
    }
    ramStorage.isSyncing = true;
    try {
        const syncResult = await syncAll();
        await reloadRamCache(syncResult);
        return { success: true, syncResult };
    } catch (err) {
        console.error('❌ Error en ciclo de sincronización programada:', err.message);
        return { success: false, error: err.message };
    } finally {
        ramStorage.isSyncing = false;
    }
}

// Servidor HTTP ligero para Health Check, Hot RAM y Consultas bajo demanda
const server = http.createServer(async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);

    // 1. Health Check
    if (url.pathname === '/health' || url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            service: 'storage_ram_db',
            lastSync: ramStorage.lastSync,
            isSyncing: ramStorage.isSyncing,
            stats: ramStorage.stats,
            ram60DiasRango: {
                desde: ramStorage.diagramas60Dias.desde,
                hasta: ramStorage.diagramas60Dias.hasta,
                totalDias: ramStorage.diagramas60Dias.totalDias
            }
        }, null, 2));
        return;
    }

    // 2. Disparador manual / Webhook de Sincronización (/sync o /trigger)
    if ((url.pathname === '/sync' || url.pathname === '/trigger') && (req.method === 'POST' || req.method === 'GET')) {
        const wait = url.searchParams.get('wait') === 'true';
        if (wait) {
            console.log('⚡ Disparo de sincronización sincrónico (?wait=true)...');
            const syncRes = await runScheduledSync();
            res.writeHead(syncRes.success ? 200 : 500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(syncRes, null, 2));
            return;
        } else {
            res.writeHead(202, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'accepted',
                message: 'Sincronización hacia Supabase disparada en segundo plano',
                timestamp: new Date().toISOString()
            }));
            runScheduledSync();
            return;
        }
    }

    // 3. Endpoint RAM completa (Unidades, Choferes con JSON, Movimientos y 60 Días)
    if (url.pathname === '/ram') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            timestamp: new Date().toISOString(),
            lastSync: ramStorage.lastSync,
            stats: ramStorage.stats,
            unidades: ramStorage.unidades,
            choferes: ramStorage.choferes,
            movimientos: ramStorage.movimientos,
            diagramas60Dias: ramStorage.diagramas60Dias
        }));
        return;
    }

    // 4. Endpoint dedicado: 60 Días en Hot RAM (< 5ms)
    if (url.pathname === '/ram/diagramas') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            timestamp: new Date().toISOString(),
            fuente: 'HOT_RAM_NODEJS',
            latenciaMs: '<5ms',
            desde: ramStorage.diagramas60Dias.desde,
            hasta: ramStorage.diagramas60Dias.hasta,
            totalDias: ramStorage.diagramas60Dias.totalDias,
            fechaReferencia: ramStorage.diagramas60Dias.fechaActual,
            totalChoferes: ramStorage.diagramas60Dias.totalChoferes,
            choferes: ramStorage.diagramas60Dias.choferes
        }));
        return;
    }

    // 5. Endpoint dedicado: 60 Días en Hot RAM para un chofer específico
    if (url.pathname.startsWith('/ram/diagramas/chofer/')) {
        const queryVal = decodeURIComponent(url.pathname.replace('/ram/diagramas/chofer/', '')).trim();
        const norm = normalizar(queryVal);

        const foundCh = (ramStorage.diagramas60Dias.choferes || []).find(c => {
            return normalizar(c.nombre) === norm || String(c.legajo) === queryVal;
        });

        if (!foundCh) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Chofer '${queryVal}' no encontrado en los 60 días de RAM.` }));
            return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            fuente: 'HOT_RAM_NODEJS',
            rango: {
                desde: ramStorage.diagramas60Dias.desde,
                hasta: ramStorage.diagramas60Dias.hasta,
                total_dias: 60
            },
            chofer: foundCh
        }));
        return;
    }

    // 6. Endpoint 'Resto Consulta': Consultas bajo demanda por rango de fechas y filtros avanzados
    // GET /diagramas/consulta?desde=YYYY-MM-DD&hasta=YYYY-MM-DD&chofer=...&legajo=...&servicio=...&diagrama_tipo=...&formato=...&limit=...&offset=...
    if (url.pathname === '/diagramas/consulta') {
        const desde = url.searchParams.get('desde');
        const hasta = url.searchParams.get('hasta');
        const choferFiltro = url.searchParams.get('chofer') || url.searchParams.get('nombre');
        const legajoFiltro = url.searchParams.get('legajo');
        const servicioFiltro = url.searchParams.get('servicio');
        const diagramaFiltro = url.searchParams.get('diagrama_tipo') || url.searchParams.get('tipo');
        const formato = (url.searchParams.get('formato') || 'completo').toLowerCase(); // 'completo' | 'resumido'
        const limitParam = parseInt(url.searchParams.get('limit') || url.searchParams.get('limite'), 10);
        const offsetParam = parseInt(url.searchParams.get('offset') || '0', 10);

        if (!desde || !hasta) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: "Debe proveer los parámetros de fecha obligatorios 'desde' y 'hasta' (formato YYYY-MM-DD).",
                ejemplo: "/diagramas/consulta?desde=2026-08-01&hasta=2026-08-31&servicio=METANOL",
                parametros_disponibles: [
                    "desde (YYYY-MM-DD, obligatorio)",
                    "hasta (YYYY-MM-DD, obligatorio)",
                    "chofer / nombre (opcional)",
                    "legajo (opcional)",
                    "servicio (opcional, ej: METANOL, LIVIANO, CAMPO, GLP)",
                    "diagrama_tipo (opcional, ej: 22X6, 14X7)",
                    "formato ('completo' con días o 'resumido' solo totales, opcional)",
                    "limit / limite (número entero, opcional)",
                    "offset (número entero, opcional)"
                ]
            }));
            return;
        }

        const tInicio = Date.now();
        console.log(`🔍 [Resto Consulta] Consultando rango: ${desde} -> ${hasta} (Chofer: ${choferFiltro || '*'}, Srv: ${servicioFiltro || '*'}, Tipo: ${diagramaFiltro || '*'})...`);

        // Generar lista de días en el rango
        const dCurrent = new Date(desde + 'T12:00:00');
        const dEnd = new Date(hasta + 'T12:00:00');
        if (isNaN(dCurrent.getTime()) || isNaN(dEnd.getTime()) || dCurrent > dEnd) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: "Rango de fechas inválido. Formato requerido: YYYY-MM-DD y 'desde' <= 'hasta'." }));
            return;
        }

        const diasRango = [];
        for (let d = new Date(dCurrent); d <= dEnd; d.setDate(d.getDate() + 1)) {
            diasRango.push(d.toISOString().split('T')[0]);
        }

        // Búsqueda en Supabase / RAM filtrando por todos los parámetros
        let targetChoferes = ramStorage.choferes;

        if (choferFiltro) {
            const normFiltro = normalizar(choferFiltro);
            targetChoferes = targetChoferes.filter(c => normalizar(c.nombre).includes(normFiltro) || String(c.legajo) === choferFiltro);
        }
        if (legajoFiltro) {
            targetChoferes = targetChoferes.filter(c => String(c.legajo).trim() === String(legajoFiltro).trim());
        }
        if (servicioFiltro) {
            const srvUpper = servicioFiltro.trim().toUpperCase();
            targetChoferes = targetChoferes.filter(c => (c.c_servicio || '').toUpperCase() === srvUpper);
        }
        if (diagramaFiltro) {
            const diagUpper = diagramaFiltro.trim().toUpperCase();
            targetChoferes = targetChoferes.filter(c => (c.diagrama_tipo || '').toUpperCase() === diagUpper);
        }

        const totalCoincidencias = targetChoferes.length;

        // Paginación
        let choferesPaginados = targetChoferes;
        if (!isNaN(offsetParam) && offsetParam > 0) {
            choferesPaginados = choferesPaginados.slice(offsetParam);
        }
        if (!isNaN(limitParam) && limitParam > 0) {
            choferesPaginados = choferesPaginados.slice(0, limitParam);
        }

        const resultados = [];
        for (const c of choferesPaginados) {
            const diagJson = c.diagrama_json;
            const caracteresRango = {};

            diasRango.forEach(iso => {
                let car = '-';
                if (diagJson && diagJson.caracteres_60_dias && diagJson.caracteres_60_dias[iso]) {
                    car = diagJson.caracteres_60_dias[iso];
                } else if (diagJson && diagJson.meses) {
                    for (const mesKey in diagJson.meses) {
                        if (diagJson.meses[mesKey].dias && diagJson.meses[mesKey].dias[iso]) {
                            car = diagJson.meses[mesKey].dias[iso];
                            break;
                        }
                    }
                }
                caracteresRango[iso] = car;
            });

            const contabilizadorRango = contabilizarDias(caracteresRango);

            const item = {
                chofer_id: c.id,
                nombre: c.nombre,
                legajo: c.legajo,
                servicio: c.c_servicio,
                diagrama_tipo: c.diagrama_tipo,
                contabilizador: contabilizadorRango
            };

            if (formato !== 'resumido') {
                item.caracteres = caracteresRango;
            }

            resultados.push(item);
        }

        const duracion = Date.now() - tInicio;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            fuente: 'SUPABASE_RESTO_CONSULTA',
            latenciaMs: `${duracion}ms`,
            parametros_aplicados: {
                desde,
                hasta,
                total_dias: diasRango.length,
                chofer: choferFiltro || null,
                legajo: legajoFiltro || null,
                servicio: servicioFiltro || null,
                diagrama_tipo: diagramaFiltro || null,
                formato,
                limit: limitParam || null,
                offset: offsetParam || 0
            },
            paginacion: {
                total_registros: totalCoincidencias,
                retornados: resultados.length,
                offset: offsetParam || 0,
                hay_mas: (!isNaN(limitParam) && limitParam > 0) ? (offsetParam + resultados.length < totalCoincidencias) : false
            },
            resultados
        }));
        return;
    }

    // 7. Endpoint: Consulta de un mes completo desde tabla Supabase `diagramas`
    // GET /diagramas/mes/:mesTab?servicio=...&limite=...
    if (url.pathname.startsWith('/diagramas/mes/')) {
        const mesTab = decodeURIComponent(url.pathname.replace('/diagramas/mes/', '')).trim();
        const servicioFiltro = url.searchParams.get('servicio');
        const limitParam = parseInt(url.searchParams.get('limit') || url.searchParams.get('limite') || '500', 10);

        const tInicio = Date.now();
        let query = supabase.from('diagramas').select('*').eq('mes_tab', mesTab);
        if (servicioFiltro) {
            query = query.eq('servicio', servicioFiltro.trim().toUpperCase());
        }
        query = query.limit(limitParam);

        const { data: rowsMes, error: errMes } = await query;
        if (errMes) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: errMes.message }));
            return;
        }

        const duracion = Date.now() - tInicio;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            fuente: 'SUPABASE_TABLA_DIAGRAMAS',
            mes_tab: mesTab,
            servicio: servicioFiltro || 'TODOS',
            latenciaMs: `${duracion}ms`,
            total: rowsMes.length,
            diagramas: rowsMes
        }));
        return;
    }

    // 8. Endpoint: Diccionario de Parámetros de Consultas Bajo Demanda
    // GET /diagramas/parametros
    if (url.pathname === '/diagramas/parametros') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            servicio: "Consultas de Diagramas Bajo Demanda (Supabase + Hot RAM)",
            descripcion: "Permite consultar cualquier rango de fechas histórico o futuro, evaluar el contabilizador canónico y filtrar por chofer, servicio o tipo de diagrama.",
            endpoints: [
                {
                    ruta: "GET /diagramas/consulta",
                    descripcion: "Consulta bajo demanda por rango de fechas arbitrario con cálculo dinámico del contabilizador.",
                    parametros: {
                        desde: { tipo: "String (YYYY-MM-DD)", requerido: true, descripcion: "Fecha inicial del rango.", ejemplo: "2026-08-01" },
                        hasta: { tipo: "String (YYYY-MM-DD)", requerido: true, descripcion: "Fecha final del rango (>= desde).", ejemplo: "2026-08-31" },
                        chofer: { tipo: "String", requerido: false, descripcion: "Filtro por nombre parcial o completo del chofer (insensible a tildes/mayúsculas).", ejemplo: "ACUÑA" },
                        legajo: { tipo: "String", requerido: false, descripcion: "Filtro exacto por número de legajo.", ejemplo: "744" },
                        servicio: { tipo: "String", requerido: false, descripcion: "Filtro por servicio de flota.", opciones: ["METANOL", "LIVIANO", "CAMPO", "GLP"] },
                        diagrama_tipo: { tipo: "String", requerido: false, descripcion: "Filtro por esquema de rotación.", opciones: ["22X6", "14X7"] },
                        formato: { tipo: "String", requerido: false, default: "completo", opciones: ["completo (incluye mapa día por día)", "resumido (solo totales del contabilizador)"] },
                        limit: { tipo: "Integer", requerido: false, descripcion: "Límite de resultados retornados para paginación." },
                        offset: { tipo: "Integer", requerido: false, default: 0, descripcion: "Salto de registros para paginación." }
                    }
                },
                {
                    ruta: "GET /diagramas/mes/:mesTab",
                    descripcion: "Obtiene los registros mensuales completos persistidos en la tabla Supabase 'diagramas'.",
                    parametros: {
                        mesTab: { tipo: "Path String", requerido: true, descripcion: "Pestaña mensual.", ejemplo: "Sep-26" },
                        servicio: { tipo: "Query String", requerido: false, descripcion: "Filtro por servicio." },
                        limit: { tipo: "Query Integer", requerido: false, default: 500, descripcion: "Límite de registros." }
                    }
                },
                {
                    ruta: "GET /diagramas/chofer/:idOrNombre",
                    descripcion: "Consulta el historial completo y JSON de un chofer específico por ID, Legajo o Nombre.",
                    parametros: {
                        idOrNombre: { tipo: "Path String", requerido: true, descripcion: "ID UUID, número de legajo o Nombre.", ejemplo: "ACUÑA RAFAEL SANTIAGO" }
                    }
                },
                {
                    ruta: "GET /ram/diagramas",
                    descripcion: "Lectura instantánea (<5ms) de la ventana de 60 días activos en Hot RAM.",
                    parametros: {}
                }
            ],
            contabilizador_reglas: {
                trabajados: "Números (1-35), 'O', 'OPERATIVO'",
                francos: "'F', 'FSF', 'FRANCO', 'RPT', 'F+...'",
                vacaciones: "'V', 'VSF', 'VACACIONES', 'V+...'",
                ausencias: "'E'/'MED' (enfermedad), 'ART', 'IND' (indisposición), 'S' (suspensión), 'A' (ausente), 'P' (permiso), 'LIC'",
                inactivos: "'-', '0', vacío",
                regla_modificador_plus: "Cualquier código con '+' (ej: F+1, E+23, O+30) se preserva textual en caracteres y cuenta estrictamente como 1 día en su categoría base."
            }
        }, null, 2));
        return;
    }

    // 9. Endpoint: Consulta de historial completo por chofer
    // GET /diagramas/chofer/:idOrNombre
    if (url.pathname.startsWith('/diagramas/chofer/')) {
        const queryVal = decodeURIComponent(url.pathname.replace('/diagramas/chofer/', '')).trim();
        const norm = normalizar(queryVal);

        const foundCh = ramStorage.choferes.find(c => {
            return c.id === queryVal || normalizar(c.nombre) === norm || String(c.legajo) === queryVal;
        });

        if (!foundCh) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Chofer '${queryVal}' no encontrado.` }));
            return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            fuente: 'CHOFER_DIAGRAMA_JSON',
            chofer: {
                id: foundCh.id,
                nombre: foundCh.nombre,
                legajo: foundCh.legajo,
                servicio: foundCh.c_servicio,
                diagrama_tipo: foundCh.diagrama_tipo,
                estado: foundCh.estado,
                unidad_id: foundCh.unidad_id,
                contabilizador: foundCh.contabilizador,
                diagrama_json: foundCh.diagrama_json
            }
        }));
        return;
    }

    // =========================================================================
    // 🚗 ENDPOINTS KILÓMETROS (HÍBRIDO: 2 MESES EN HOT RAM + 4 MESES ON-DEMAND)
    // =========================================================================

    // 10. Endpoint: Resumen Global y KPIs de Kilómetros
    // GET /api/km/resumen
    if (url.pathname === '/api/km/resumen') {
        const resumenRam = ramStorage.km.resumen || {};
        let totales6m = null;

        if (pool) {
            try {
                const r6m = await pool.query(`
                    SELECT 
                        COUNT(*)::int as total_viajes,
                        ROUND(SUM(km_totales))::float as total_kms_flota,
                        COUNT(DISTINCT id_unidad)::int as total_unidades,
                        COUNT(DISTINCT id_chofer)::int as total_choferes
                    FROM public.view_calendario_km;
                `);
                totales6m = r6m.rows[0];
            } catch (e6m) {
                console.warn('⚠️ Error consultando agregados 6m en Supabase:', e6m.message);
            }
        }

        const resumenFinal = {
            ...resumenRam,
            total_kms_flota: totales6m ? totales6m.total_kms_flota : resumenRam.total_kms_flota,
            total_viajes: totales6m ? totales6m.total_viajes : resumenRam.total_viajes,
            total_unidades: totales6m ? totales6m.total_unidades : resumenRam.total_unidades,
            total_choferes: totales6m ? totales6m.total_choferes : resumenRam.total_choferes,
            totales_6m: totales6m,
            totales_2m_ram: {
                total_kms: resumenRam.total_kms_flota,
                total_viajes: resumenRam.total_viajes,
                meses: resumenRam.meses_en_ram
            }
        };

        const topUnidades = Array.from(ramStorage.km.porUnidad.values())
            .sort((a, b) => b.total_km - a.total_km)
            .slice(0, 10)
            .map(u => ({ id_unidad: u.id_unidad, dominio: u.dominio, n_ute: u.n_ute, servicio: u.servicio, total_km: u.total_km, viajes_count: u.viajes_count }));

        const topChoferes = Array.from(ramStorage.km.porChofer.values())
            .filter(c => c.nombre !== 'Sin Chofer Asignado')
            .sort((a, b) => b.total_km - a.total_km)
            .slice(0, 10)
            .map(c => ({ id_chofer: c.id_chofer, nombre: c.nombre, legajo: c.legajo, c_servicio: c.c_servicio, total_km: c.total_km, viajes_count: c.viajes_count }));

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            resumen: resumenFinal,
            topUnidades,
            topChoferes
        }));
        return;
    }

    // 11. Endpoint: Listado de Unidades con KMs (acumulados o por mes)
    // GET /api/km/unidades?mes=...&search=...&servicio=...&limit=...&offset=...
    if (url.pathname === '/api/km/unidades') {
        const search = (url.searchParams.get('search') || '').trim().toUpperCase();
        const mes = (url.searchParams.get('mes') || '').trim();
        const servicio = (url.searchParams.get('servicio') || '').trim().toUpperCase();
        const limit = parseInt(url.searchParams.get('limit') || '500', 10);
        const offset = parseInt(url.searchParams.get('offset') || '0', 10);

        const mesesEnRam = ramStorage.km.resumen?.meses_en_ram || ['2026-09', '2026-08'];
        let list = [];
        let fuente = 'HOT_RAM_2M';

        if (mes && mesesEnRam.includes(mes)) {
            // Servir 100% desde Hot RAM (< 2ms, 0 bytes egress)
            list = Array.from(ramStorage.km.porUnidad.values()).map(u => ({
                id_unidad: u.id_unidad,
                dominio: u.dominio,
                n_ute: u.n_ute,
                servicio: u.servicio,
                total_km: u.total_km,
                km_periodo: +(u.por_mes[mes] || 0).toFixed(2),
                viajes_count: u.viajes_count,
                por_mes: u.por_mes,
                ultimo_viaje: u.viajes[0] || null
            })).filter(u => u.km_periodo > 0);
        } else if (pool) {
            // Consulta agregada bajo demanda a Supabase (< 36 KB egress)
            fuente = 'SUPABASE_ON_DEMAND';
            try {
                let q = `
                    SELECT 
                        id_unidad,
                        dominio,
                        SUM(km_totales)::numeric(10,2) as km_periodo,
                        COUNT(*)::int as viajes_count
                    FROM public.view_calendario_km
                `;
                const params = [];
                if (mes && mes !== 'TODOS') {
                    q += ` WHERE TO_CHAR(fecha, 'YYYY-MM') = $1 `;
                    params.push(mes);
                }
                q += ` GROUP BY id_unidad, dominio ORDER BY km_periodo DESC `;
                const dbRes = await pool.query(q, params);

                // Enriquecer con catálogo de unidades en memoria
                const unitMap = new Map();
                (ramStorage.unidades || []).forEach(u => {
                    if (u.id) unitMap.set(u.id, u);
                    if (u.tractor) unitMap.set(u.tractor.toUpperCase().replace(/[^A-Z0-9]/g, ''), u);
                });

                list = dbRes.rows.map(r => {
                    const uObj = (r.id_unidad && unitMap.get(r.id_unidad)) ||
                                 (r.dominio && unitMap.get(r.dominio.replace(/[^A-Z0-9]/g, ''))) || null;
                    const kmVal = parseFloat(r.km_periodo) || 0;
                    return {
                        id_unidad: r.id_unidad || (uObj ? uObj.id : null),
                        dominio: r.dominio || (uObj ? uObj.tractor : 'S/D'),
                        n_ute: uObj ? uObj.n_ute : null,
                        servicio: uObj ? uObj.servicio : 'S/A',
                        total_km: kmVal,
                        km_periodo: kmVal,
                        viajes_count: r.viajes_count,
                        por_mes: {}
                    };
                });
            } catch (dbErr) {
                console.error('❌ Error consultando unidades en Supabase:', dbErr.message);
                list = Array.from(ramStorage.km.porUnidad.values());
            }
        } else {
            list = Array.from(ramStorage.km.porUnidad.values());
        }

        if (servicio && servicio !== 'TODOS') {
            list = list.filter(u => u.servicio === servicio);
        }
        if (search) {
            list = list.filter(u => 
                (u.dominio && u.dominio.includes(search)) || 
                (u.n_ute && String(u.n_ute).includes(search))
            );
        }

        list.sort((a, b) => b.km_periodo - a.km_periodo);
        const total = list.length;
        const paginated = list.slice(offset, offset + limit);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            total,
            offset,
            limit,
            fuente,
            mes_filtrado: mes || 'TODOS_6_MESES',
            unidades: paginated
        }));
        return;
    }

    // 12. Endpoint: Listado de Choferes con KMs (acumulados o por mes)
    // GET /api/km/choferes?mes=...&search=...&servicio=...&limit=...&offset=...
    if (url.pathname === '/api/km/choferes') {
        const search = (url.searchParams.get('search') || '').trim();
        const normSearch = normalizar(search);
        const mes = (url.searchParams.get('mes') || '').trim();
        const servicio = (url.searchParams.get('servicio') || '').trim().toUpperCase();
        const limit = parseInt(url.searchParams.get('limit') || '500', 10);
        const offset = parseInt(url.searchParams.get('offset') || '0', 10);

        const mesesEnRam = ramStorage.km.resumen?.meses_en_ram || ['2026-09', '2026-08'];
        let list = [];
        let fuente = 'HOT_RAM_2M';

        if (mes && mesesEnRam.includes(mes)) {
            // Servir 100% desde Hot RAM (< 2ms, 0 bytes egress)
            list = Array.from(ramStorage.km.porChofer.values()).map(c => ({
                id_chofer: c.id_chofer,
                nombre: c.nombre,
                legajo: c.legajo,
                c_servicio: c.c_servicio,
                total_km: c.total_km,
                km_periodo: +(c.por_mes[mes] || 0).toFixed(2),
                viajes_count: c.viajes_count,
                por_mes: c.por_mes,
                ultimo_viaje: c.viajes[0] || null
            })).filter(c => c.km_periodo > 0);
        } else if (pool) {
            // Consulta agregada bajo demanda a Supabase (< 36 KB egress)
            fuente = 'SUPABASE_ON_DEMAND';
            try {
                let q = `
                    SELECT 
                        id_chofer,
                        chofer_nombre,
                        SUM(km_totales)::numeric(10,2) as km_periodo,
                        COUNT(*)::int as viajes_count
                    FROM public.view_calendario_km
                `;
                const params = [];
                if (mes && mes !== 'TODOS') {
                    q += ` WHERE TO_CHAR(fecha, 'YYYY-MM') = $1 `;
                    params.push(mes);
                }
                q += ` GROUP BY id_chofer, chofer_nombre ORDER BY km_periodo DESC `;
                const dbRes = await pool.query(q, params);

                // Enriquecer con catálogo de choferes en memoria
                const choferMap = new Map();
                (ramStorage.choferes || []).forEach(c => {
                    if (c.id) choferMap.set(c.id, c);
                    if (c.nombre) choferMap.set(normalizar(c.nombre), c);
                });

                list = dbRes.rows.map(r => {
                    const cObj = (r.id_chofer && choferMap.get(r.id_chofer)) ||
                                 (r.chofer_nombre && choferMap.get(normalizar(r.chofer_nombre))) || null;
                    const kmVal = parseFloat(r.km_periodo) || 0;
                    return {
                        id_chofer: r.id_chofer || (cObj ? cObj.id : null),
                        nombre: r.chofer_nombre || (cObj ? cObj.nombre : 'Sin Chofer'),
                        legajo: cObj ? cObj.legajo : null,
                        c_servicio: cObj ? cObj.c_servicio : 'S/A',
                        total_km: kmVal,
                        km_periodo: kmVal,
                        viajes_count: r.viajes_count,
                        por_mes: {}
                    };
                });
            } catch (dbErr) {
                console.error('❌ Error consultando choferes en Supabase:', dbErr.message);
                list = Array.from(ramStorage.km.porChofer.values());
            }
        } else {
            list = Array.from(ramStorage.km.porChofer.values());
        }

        if (servicio && servicio !== 'TODOS') {
            list = list.filter(c => c.c_servicio === servicio);
        }
        if (normSearch) {
            list = list.filter(c => 
                normalizar(c.nombre).includes(normSearch) || 
                (c.legajo && String(c.legajo).includes(normSearch))
            );
        }

        list.sort((a, b) => b.km_periodo - a.km_periodo);
        const total = list.length;
        const paginated = list.slice(offset, offset + limit);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            success: true,
            total,
            offset,
            limit,
            fuente,
            mes_filtrado: mes || 'TODOS_6_MESES',
            choferes: paginated
        }));
        return;
    }

    // 13. Endpoint: Detalle individual de Unidad con fusión (Hot RAM 2m + Supabase 4m histórico)
    // GET /api/km/unidad/:idOrDominio
    if (url.pathname.startsWith('/api/km/unidad/')) {
        const idOrDominio = decodeURIComponent(url.pathname.replace('/api/km/unidad/', '')).trim().toUpperCase();
        let ramUnit = null;
        for (const [key, u] of ramStorage.km.porUnidad.entries()) {
            if (u.id_unidad === idOrDominio || (u.dominio && u.dominio.toUpperCase() === idOrDominio) || key.toUpperCase() === idOrDominio) {
                ramUnit = u;
                break;
            }
        }
        const catUnit = (ramStorage.unidades || []).find(u => 
            u.id === idOrDominio || (u.tractor && u.tractor.toUpperCase() === idOrDominio) || (u.semi && u.semi.toUpperCase() === idOrDominio)
        );

        if (!ramUnit && !catUnit) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Unidad no encontrada en el registro de kilómetros.' }));
            return;
        }

        const unitId = (ramUnit && ramUnit.id_unidad) || (catUnit && catUnit.id);
        const dominio = (ramUnit && ramUnit.dominio) || (catUnit && (catUnit.tractor || catUnit.semi));
        const n_ute = (ramUnit && ramUnit.n_ute) || (catUnit && catUnit.n_ute);
        const servicio = (ramUnit && ramUnit.servicio) || (catUnit && catUnit.servicio);

        const hotRamTrips = ramUnit ? ramUnit.viajes : [];
        let historicalTrips = [];
        const fechaCorteRam = ramStorage.km.resumen?.fecha_corte_ram || '2026-08-01';

        if (pool) {
            try {
                const hRes = await pool.query(`
                    SELECT 
                        TO_CHAR(fecha, 'YYYY-MM-DD') as fecha,
                        id_chofer,
                        chofer_nombre,
                        km_totales::float,
                        array_to_string(hoja_ruta, ', ') as hoja_ruta
                    FROM public.view_calendario_km
                    WHERE (id_unidad = $1 OR dominio = $2) AND fecha < $3
                    ORDER BY fecha DESC;
                `, [unitId, dominio, fechaCorteRam]);
                historicalTrips = hRes.rows;
            } catch (eH) {
                console.warn('⚠️ Error buscando viajes históricos de unidad:', eH.message);
            }
        }

        const allViajes = [...hotRamTrips, ...historicalTrips];
        allViajes.sort((a, b) => b.fecha.localeCompare(a.fecha));

        let total_km = 0;
        const por_mes = {};
        allViajes.forEach(v => {
            total_km += v.km_totales;
            const ym = v.fecha.substring(0, 7);
            por_mes[ym] = (por_mes[ym] || 0) + v.km_totales;
        });

        const fullUnit = {
            id_unidad: unitId,
            dominio,
            n_ute,
            servicio,
            total_km: +total_km.toFixed(2),
            viajes_count: allViajes.length,
            por_mes,
            viajes_hot_ram_count: hotRamTrips.length,
            viajes_historicos_count: historicalTrips.length,
            viajes: allViajes
        };

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, unidad: fullUnit }));
        return;
    }

    // 14. Endpoint: Detalle individual de Chofer con fusión (Hot RAM 2m + Supabase 4m histórico)
    // GET /api/km/chofer/:idOrNombre
    if (url.pathname.startsWith('/api/km/chofer/')) {
        const idOrNombre = decodeURIComponent(url.pathname.replace('/api/km/chofer/', '')).trim();
        const norm = normalizar(idOrNombre);
        let ramChofer = null;
        for (const [key, c] of ramStorage.km.porChofer.entries()) {
            if (c.id_chofer === idOrNombre || normalizar(c.nombre) === norm || String(c.legajo) === idOrNombre || normalizar(key) === norm) {
                ramChofer = c;
                break;
            }
        }
        const catChofer = (ramStorage.choferes || []).find(c =>
            c.id === idOrNombre || normalizar(c.nombre) === norm || String(c.legajo) === idOrNombre
        );

        if (!ramChofer && !catChofer) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Chofer no encontrado en el registro de kilómetros.' }));
            return;
        }

        const choferId = (ramChofer && ramChofer.id_chofer) || (catChofer && catChofer.id);
        const choferNombre = (ramChofer && ramChofer.nombre) || (catChofer && catChofer.nombre);
        const legajo = (ramChofer && ramChofer.legajo) || (catChofer && catChofer.legajo);
        const c_servicio = (ramChofer && ramChofer.c_servicio) || (catChofer && catChofer.c_servicio);

        const hotRamTrips = ramChofer ? ramChofer.viajes : [];
        let historicalTrips = [];
        const fechaCorteRam = ramStorage.km.resumen?.fecha_corte_ram || '2026-08-01';

        if (pool) {
            try {
                const hRes = await pool.query(`
                    SELECT 
                        TO_CHAR(fecha, 'YYYY-MM-DD') as fecha,
                        id_unidad,
                        dominio,
                        km_totales::float,
                        array_to_string(hoja_ruta, ', ') as hoja_ruta
                    FROM public.view_calendario_km
                    WHERE (id_chofer = $1 OR chofer_nombre = $2) AND fecha < $3
                    ORDER BY fecha DESC;
                `, [choferId, choferNombre, fechaCorteRam]);
                historicalTrips = hRes.rows;
            } catch (eH) {
                console.warn('⚠️ Error buscando viajes históricos de chofer:', eH.message);
            }
        }

        const allViajes = [...hotRamTrips, ...historicalTrips];
        allViajes.sort((a, b) => b.fecha.localeCompare(a.fecha));

        let total_km = 0;
        const por_mes = {};
        allViajes.forEach(v => {
            total_km += v.km_totales;
            const ym = v.fecha.substring(0, 7);
            por_mes[ym] = (por_mes[ym] || 0) + v.km_totales;
        });

        const fullChofer = {
            id_chofer: choferId,
            nombre: choferNombre,
            legajo,
            c_servicio,
            total_km: +total_km.toFixed(2),
            viajes_count: allViajes.length,
            por_mes,
            viajes_hot_ram_count: hotRamTrips.length,
            viajes_historicos_count: historicalTrips.length,
            viajes: allViajes
        };

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, chofer: fullChofer }));
        return;
    }

    // 15. Endpoint: Disparador de re-sincronización de Kilómetros
    // POST /api/km/sync
    if (url.pathname === '/api/km/sync' && req.method === 'POST') {
        if (ramStorage.isSyncingKm) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'Extracción de kilómetros ya en curso.' }));
            return;
        }
        ramStorage.isSyncingKm = true;
        (async () => {
            try {
                ramStorage.km = await extractKilometros(ramStorage.unidades, ramStorage.choferes, pool);
                ramStorage.stats.totalKmFlota = ramStorage.km.resumen.total_kms_flota;
                ramStorage.stats.totalViajesKm = ramStorage.km.resumen.total_viajes;
            } catch (err) {
                console.error('❌ Error en re-extracción de kilómetros:', err.message);
            } finally {
                ramStorage.isSyncingKm = false;
            }
        })();
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Extracción de kilómetros iniciada en segundo plano.' }));
        return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Ruta no encontrada' }));
});

server.listen(PORT, async () => {
    console.log(`🌐 Servidor storage_ram_db escuchando en el puerto ${PORT}`);
    console.log(`   • GET  /health                      -> Diagnóstico del servicio`);
    console.log(`   • GET  /ram                         -> RAM instantánea completa (unidades, choferes, movimientos, diagramas60Dias)`);
    console.log(`   • GET  /ram/diagramas               -> 60 días exactos en Hot RAM (< 5ms)`);
    console.log(`   • GET  /ram/diagramas/chofer/:nom   -> 60 días en RAM para un chofer específico`);
    console.log(`   • GET  /diagramas/consulta          -> 'Resto Consulta' bajo demanda (?desde=...&hasta=...&chofer=...)`);
    console.log(`   • GET  /diagramas/chofer/:id        -> Historial y JSON completo de un chofer`);
    console.log(`   • GET  /api/km/resumen              -> KPIs globales de kilómetros (6 meses)`);
    console.log(`   • GET  /api/km/unidades             -> Lista de unidades con KMs acumulados`);
    console.log(`   • GET  /api/km/choferes             -> Lista de choferes con KMs acumulados`);
    console.log(`   • GET  /api/km/unidad/:id           -> Desglose de viajes de una unidad`);
    console.log(`   • GET  /api/km/chofer/:id           -> Desglose de viajes de un chofer`);
    console.log(`   • POST /api/km/sync                 -> Re-extracción de kilómetros en segundo plano`);
    console.log(`   • POST /sync                        -> Disparador manual de sincronización`);

    // Cargar RAM Cache inicial y ejecutar ciclo si está configurado
    await reloadRamCache();

    // Intervalo de sincronización automática continua
    setInterval(runScheduledSync, SYNC_INTERVAL_MS);
    console.log(`⏰ Sincronizador automático programado cada ${SYNC_INTERVAL_MS / 60000} minutos.`);
});
