const fs = require('fs');
const path = require('path');
const { getAuthClient, normalizar, parseFechaISO, getFechaArgentina } = require('../utils/sheets');

const ID_SHEET_KILOMETROS = process.env.ID_SHEET_KILOMETROS || '1Wr-_P4mDvldif_cAx08sp7yT8uTUrajI2HQAJF6tnGM';
const CACHE_DIR = path.join(__dirname, '..', 'cache');
const CACHE_FILE = path.join(CACHE_DIR, 'kilometros_2meses.json');

const parseNum = (val) => {
    if (!val) return 0;
    const clean = String(val).replace(/,/g, '.').replace(/[^0-9.-]/g, '');
    const n = parseFloat(clean);
    return isNaN(n) ? 0 : n;
};

function parseFechaRow(val) {
    if (!val) return null;
    const clean = String(val).split(' - ')[0].trim();
    const parts = clean.split(/[\/\-]/);
    if (parts.length === 3) {
        let y = parseInt(parts[2], 10);
        if (y < 100) y += 2000;
        const m = String(parseInt(parts[1], 10)).padStart(2, '0');
        const d = String(parseInt(parts[0], 10)).padStart(2, '0');
        if (!isNaN(y) && !isNaN(parseInt(m, 10)) && !isNaN(parseInt(d, 10))) {
            return `${y}-${m}-${d}`;
        }
    }
    return parseFechaISO(clean);
}

/**
 * Calcula la fecha de corte para los últimos 2 meses en Hot RAM (primer día del mes anterior)
 */
function getCutoff2Meses() {
    const hoy = getFechaArgentina();
    const fechaCorte = new Date(hoy.getFullYear(), hoy.getMonth() - 1, 1);
    const y = fechaCorte.getFullYear();
    const m = String(fechaCorte.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}-01`;
}

/**
 * Calcula la fecha de corte para los últimos 6 meses (primer día del mes hace 5 meses)
 */
function getCutoff6Meses() {
    const hoy = getFechaArgentina();
    const fechaCorte = new Date(hoy.getFullYear(), hoy.getMonth() - 5, 1);
    const y = fechaCorte.getFullYear();
    const m = String(fechaCorte.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}-01`;
}

/**
 * Construye las estructuras indexadas en RAM (porUnidad, porChofer, resumen)
 * exclusivamente con km_totales y hoja_ruta.
 */
function buildRamStructures(trips, unidades = [], choferes = [], durationMs = 0) {
    const unitMapById = new Map();
    const unitMapByDom = new Map();
    (unidades || []).forEach(u => {
        if (u.id) unitMapById.set(u.id, u);
        const trPat = (u.tractor || u.tractores?.patente || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
        const sePat = (u.semi || u.semis?.patente || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (trPat) unitMapByDom.set(trPat, u);
        if (sePat) unitMapByDom.set(sePat, u);
        if (u.n_ute) unitMapByDom.set(String(u.n_ute).trim().toUpperCase().replace(/[^A-Z0-9]/g, ''), u);
    });

    const choferMapById = new Map();
    const choferMapByName = new Map();
    (choferes || []).forEach(c => {
        if (c.id) choferMapById.set(c.id, c);
        if (c.nombre) {
            choferMapByName.set(normalizar(c.nombre), c);
            if (c.nombre.includes('ñ')) {
                choferMapByName.set(normalizar(c.nombre.replace(/ñ/g, 'n')), c);
            }
        }
    });

    const porUnidad = new Map();
    const porChofer = new Map();
    let totalKmsFlota = 0;
    const mesesSet = new Set();

    trips.forEach(row => {
        totalKmsFlota += row.km_totales;

        const mesKey = row.fecha.substring(0, 7);
        mesesSet.add(mesKey);

        // A. Resolución de Unidad
        const uObj = (row.id_unidad && unitMapById.get(row.id_unidad)) ||
                     (row.dominio && unitMapByDom.get(row.dominio.replace(/[^A-Z0-9]/g, ''))) || null;
        const idUnidad = row.id_unidad || (uObj ? uObj.id : null);
        const keyUnidad = idUnidad || row.dominio || 'SIN_DOMINIO';

        if (!porUnidad.has(keyUnidad)) {
            porUnidad.set(keyUnidad, {
                id_unidad: idUnidad,
                dominio: row.dominio || (uObj ? (uObj.tractor || uObj.semi) : 'S/D'),
                n_ute: uObj ? uObj.n_ute : null,
                servicio: uObj ? uObj.servicio : 'S/A',
                total_km: 0,
                viajes_count: 0,
                por_mes: {},
                viajes: []
            });
        }
        const uItem = porUnidad.get(keyUnidad);
        uItem.total_km += row.km_totales;
        uItem.viajes_count++;
        uItem.por_mes[mesKey] = (uItem.por_mes[mesKey] || 0) + row.km_totales;

        // B. Resolución de Chofer
        const isSinChofer = !row.chofer_nombre || row.chofer_nombre === '1' || row.chofer_nombre === 'Sin Chofer Asignado';
        const cObj = (row.id_chofer && choferMapById.get(row.id_chofer)) ||
                     (!isSinChofer && choferMapByName.get(normalizar(row.chofer_nombre))) || null;
        const idChofer = row.id_chofer || (cObj ? cObj.id : null);
        const choferNombre = isSinChofer ? 'Sin Chofer Asignado' : (cObj ? cObj.nombre : row.chofer_nombre);
        const keyChofer = idChofer || normalizar(choferNombre);

        if (!porChofer.has(keyChofer)) {
            porChofer.set(keyChofer, {
                id_chofer: idChofer,
                nombre: choferNombre,
                legajo: cObj ? cObj.legajo : null,
                c_servicio: cObj ? cObj.c_servicio : 'S/A',
                total_km: 0,
                viajes_count: 0,
                por_mes: {},
                viajes: []
            });
        }
        const cItem = porChofer.get(keyChofer);
        cItem.total_km += row.km_totales;
        cItem.viajes_count++;
        cItem.por_mes[mesKey] = (cItem.por_mes[mesKey] || 0) + row.km_totales;

        // C. Viajes en Hot RAM (solo km_totales y hoja_ruta)
        uItem.viajes.push({
            fecha: row.fecha,
            id_chofer: idChofer,
            chofer_nombre: choferNombre,
            km_totales: +row.km_totales.toFixed(2),
            hoja_ruta: row.hoja_ruta
        });
        cItem.viajes.push({
            fecha: row.fecha,
            id_unidad: idUnidad,
            dominio: row.dominio,
            km_totales: +row.km_totales.toFixed(2),
            hoja_ruta: row.hoja_ruta
        });
    });

    // Redondeos y ordenamiento
    porUnidad.forEach(u => {
        u.total_km = +u.total_km.toFixed(2);
        u.viajes.sort((a, b) => b.fecha.localeCompare(a.fecha));
    });

    porChofer.forEach(c => {
        c.total_km = +c.total_km.toFixed(2);
        c.viajes.sort((a, b) => b.fecha.localeCompare(a.fecha));
    });

    const mesesHotRam = Array.from(mesesSet).sort().reverse();
    const mesActual = mesesHotRam[0] || null;

    // Generar la lista de los 6 meses disponibles para navegación
    const cutoff6m = getCutoff6Meses();
    const todosMeses6m = [];
    const dt = new Date(cutoff6m + 'T00:00:00Z');
    const hoy = getFechaArgentina();
    while (dt <= hoy) {
        const ym = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
        if (!todosMeses6m.includes(ym)) todosMeses6m.push(ym);
        dt.setUTCMonth(dt.getUTCMonth() + 1);
    }
    todosMeses6m.sort().reverse();

    const resumen = {
        total_kms_flota: +totalKmsFlota.toFixed(2),
        total_viajes: trips.length,
        total_unidades: porUnidad.size,
        total_choferes: porChofer.size,
        fecha_corte_ram: getCutoff2Meses(),
        fecha_corte_historico: cutoff6m,
        mes_actual: mesActual,
        meses_en_ram: mesesHotRam,
        meses_disponibles: todosMeses6m,
        last_sync: new Date().toISOString(),
        duration_ms: durationMs
    };

    return {
        resumen,
        porUnidad,
        porChofer,
        filasTotales: trips.length
    };
}

/**
 * Hidrata rápidamente los 2 meses de Hot RAM directamente desde public.movimientos_km en PostgreSQL
 */
async function hydrateKmFromSupabase(pool, unidades = [], choferes = []) {
    const tInicio = Date.now();
    const cutoffDate = getCutoff2Meses();
    console.log(`\n⚡ [KM-Hydrator] Hidratando 2 meses de Hot RAM desde Supabase (>= ${cutoffDate})...`);

    const res = await pool.query(`
        SELECT 
            TO_CHAR(fecha, 'YYYY-MM-DD') as fecha,
            id_unidad,
            id_chofer,
            dominio,
            chofer_nombre,
            km_totales::float,
            array_to_string(hoja_ruta, ', ') as hoja_ruta
        FROM public.view_calendario_km
        WHERE fecha >= $1
        ORDER BY fecha DESC;
    `, [cutoffDate]);

    console.log(`   📥 Filas de los últimos 2 meses cargadas desde Supabase: ${res.rows.length} en ${Date.now() - tInicio}ms`);

    const resultado = buildRamStructures(res.rows, unidades, choferes, Date.now() - tInicio);
    guardarEnDisco(resultado);
    return resultado;
}

/**
 * Extrae de Google Sheets los últimos 6 meses, empareja con los UUIDs reales de Supabase,
 * sincroniza la tabla public.movimientos_km en Supabase (solo km_totales y hoja_ruta),
 * y carga los 2 meses más recientes en Hot RAM.
 */
async function extractKilometros(unidades = [], choferes = [], pool = null) {
    const tInicio = Date.now();
    console.log(`\n🚀 [KM-Extractor] Iniciando sincronización de Kilómetros desde Google Sheets...`);
    console.log(`   Planilla ID: ${ID_SHEET_KILOMETROS} (Hoja 'KM')`);

    // 1. Mapeos de búsqueda rápida O(1) con UUIDs
    const tractorMap = new Map();
    const semiMap = new Map();
    const uteMap = new Map();
    const choferMap = new Map();

    const formacionMap = new Map();

    if (pool) {
        try {
            const [uRes, cRes, tRes] = await Promise.all([
                pool.query(`
                    SELECT u.id, u.tractor_id, t.patente AS tractor, u.semi_id, s.patente AS semi, u.n_ute
                    FROM public.unidades u
                    LEFT JOIN public.tractores t ON u.tractor_id = t.id
                    LEFT JOIN public.semis s ON u.semi_id = s.id
                `),
                pool.query(`SELECT id, nombre FROM public.choferes WHERE nombre IS NOT NULL`),
                pool.query(`SELECT id, patente FROM public.tractores WHERE patente IS NOT NULL`)
            ]);
            uRes.rows.forEach(u => {
                const item = {
                    id_unidad: u.id,
                    tractor_id: u.tractor_id,
                    tractor_patente: u.tractor,
                    semi_id: u.semi_id,
                    cisterna_patente: u.semi,
                    n_ute: u.n_ute
                };
                if (u.tractor) {
                    const trClean = u.tractor.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
                    tractorMap.set(trClean, u.id);
                    formacionMap.set(trClean, item);
                }
                if (u.semi) {
                    const seClean = u.semi.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
                    semiMap.set(seClean, u.id);
                    if (!formacionMap.has(seClean)) formacionMap.set(seClean, item);
                }
                if (u.n_ute) {
                    const uteClean = String(u.n_ute).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
                    uteMap.set(uteClean, u.id);
                    if (!formacionMap.has(uteClean)) formacionMap.set(uteClean, item);
                }
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
            cRes.rows.forEach(c => {
                const norm = normalizar(c.nombre);
                choferMap.set(norm, c.id);
                if (c.nombre.includes('ñ')) choferMap.set(normalizar(c.nombre.replace(/ñ/g, 'n')), c.id);
            });
        } catch (dbMapErr) {
            console.warn('⚠️ [KM-Extractor] Error leyendo mapeo relacional desde pool, usando argumentos recibidos:', dbMapErr.message);
        }
    }

    (unidades || []).forEach(u => {
        const trPat = (u.tractor || u.tractores?.patente || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
        const sePat = (u.semi || u.semis?.patente || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
        const ute = u.n_ute ? String(u.n_ute).trim().toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
        if (trPat && !tractorMap.has(trPat)) tractorMap.set(trPat, u.id);
        if (sePat && !semiMap.has(sePat)) semiMap.set(sePat, u.id);
        if (ute && !uteMap.has(ute)) uteMap.set(ute, u.id);
    });

    (choferes || []).forEach(c => {
        if (c.nombre) {
            const norm = normalizar(c.nombre);
            if (!choferMap.has(norm)) choferMap.set(norm, c.id);
            if (c.nombre.includes('ñ')) {
                const sinEnie = normalizar(c.nombre.replace(/ñ/g, 'n'));
                if (!choferMap.has(sinEnie)) choferMap.set(sinEnie, c.id);
            }
        }
    });

    const cutoff6m = getCutoff6Meses();
    const cutoff2m = getCutoff2Meses();
    console.log(`   📅 Rango completo: >= ${cutoff6m} | Ventana Hot RAM: >= ${cutoff2m}`);

    const auth = getAuthClient();
    const batchSize = 30000;
    let startRow = 2;
    const all6mTrips = [];
    const hotRamTrips = [];

    while (true) {
        const endRow = startRow + batchSize - 1;
        const range = `'KM'!A${startRow}:T${endRow}`;
        const url = `https://sheets.googleapis.com/v4/spreadsheets/${ID_SHEET_KILOMETROS}/values/${encodeURIComponent(range)}`;

        try {
            const res = await auth.request({ url });
            const rows = res.data.values || [];
            if (rows.length === 0) break;

            for (const r of rows) {
                const fRaw = r[1];
                if (!fRaw) continue;
                const iso = parseFechaRow(fRaw);
                if (iso && iso >= cutoff6m && iso <= '2029-12-31') {
                    const domRaw = (r[0] || '').trim().toUpperCase();
                    const domClean = domRaw.replace(/[^A-Z0-9]/g, '');
                    const chRaw = (r[2] || '').trim();

                    const idUnidad = tractorMap.get(domClean) || semiMap.get(domClean) || uteMap.get(domClean) || null;

                    let idChofer = null;
                    let choferNombre = chRaw;
                    if (chRaw && chRaw !== '1') {
                        const norm = normalizar(chRaw);
                        if (choferMap.has(norm)) {
                            idChofer = choferMap.get(norm);
                        }
                    } else if (!chRaw || chRaw === '1') {
                        choferNombre = 'Sin Chofer Asignado';
                    }

                    const kmTotales = parseNum(r[16]) || parseNum(r[10]);
                    const hojaRuta = (r[19] || '').trim();

                    if (kmTotales > 0 || hojaRuta) {
                        const tripObj = {
                            fecha: iso,
                            id_unidad: idUnidad,
                            id_chofer: idChofer,
                            dominio: domRaw || null,
                            chofer_nombre: choferNombre || null,
                            km_totales: +kmTotales.toFixed(2),
                            hoja_ruta: hojaRuta || null
                        };

                        all6mTrips.push(tripObj);
                        if (iso >= cutoff2m) {
                            hotRamTrips.push(tripObj);
                        }
                    }
                }
            }

            if (rows.length < batchSize) break;
            startRow += batchSize;
        } catch (err) {
            console.error(`   ⚠️ Error descargando lote ${range}:`, err.message);
            break;
        }
    }

    console.log(`   📥 Filas de los últimos 6 meses recuperadas: ${all6mTrips.length} (Hot RAM 2m: ${hotRamTrips.length})`);

    // 2. Si hay conexión pool a PostgreSQL, sincronizar choferes_km_mensual y cisternas_km
    if (pool && all6mTrips.length > 0) {
        try {
            const client = await pool.connect();
            try {
                console.log(`   ⚡ Consolidando buckets mensuales en public.choferes_km_mensual (${all6mTrips.length} viajes)...`);
                await upsertChoferesKmMensual(client, all6mTrips);
                console.log(`   ✅ Consolidación en public.choferes_km_mensual completada.`);

                console.log(`   🛢️ Sincronizando trazabilidad en public.cisternas_km...`);
                await upsertCisternasKm(client, all6mTrips, { formacionMap });
                console.log(`   ✅ Trazabilidad en public.cisternas_km sincronizada.`);
            } finally {
                client.release();
            }
        } catch (dbErr) {
            console.error(`   ❌ Error persistiendo en Supabase:`, dbErr.message);
        }
    }

    // 3. Indexar en Memoria exclusivamente los últimos 2 meses para Hot RAM
    const resultadoHotRam = buildRamStructures(hotRamTrips, unidades, choferes, Date.now() - tInicio);
    guardarEnDisco(resultadoHotRam);

    console.log(`   ✅ [KM-Extractor] Proceso finalizado en ${resultadoHotRam.resumen.duration_ms}ms.`);
    console.log(`      • Total KMs en Hot RAM (2m): ${resultadoHotRam.resumen.total_kms_flota.toLocaleString('es-AR')} km`);
    console.log(`      • Unidades en RAM: ${resultadoHotRam.porUnidad.size} | Choferes en RAM: ${resultadoHotRam.porChofer.size}`);

    return resultadoHotRam;
}

function guardarEnDisco(resultado) {
    try {
        if (!fs.existsSync(CACHE_DIR)) {
            fs.mkdirSync(CACHE_DIR, { recursive: true });
        }
        const dataToSave = {
            resumen: resultado.resumen,
            unidades: Array.from(resultado.porUnidad.entries()),
            choferes: Array.from(resultado.porChofer.entries())
        };
        fs.writeFileSync(CACHE_FILE, JSON.stringify(dataToSave), 'utf8');
        console.log(`   💾 [KM-Extractor] Caché local 2 meses persistida en disco: ${CACHE_FILE}`);
    } catch (e) {
        console.warn(`   ⚠️ No se pudo guardar caché local en disco:`, e.message);
    }
}

function cargarDesdeDisco() {
    try {
        if (fs.existsSync(CACHE_FILE)) {
            const raw = fs.readFileSync(CACHE_FILE, 'utf8');
            const parsed = JSON.parse(raw);
            return {
                resumen: parsed.resumen,
                porUnidad: new Map(parsed.unidades),
                porChofer: new Map(parsed.choferes)
            };
        }
    } catch (e) {
        console.warn(`   ⚠️ No se pudo leer caché local desde disco:`, e.message);
    }
    return null;
}

async function upsertChoferesKmMensual(client, allTrips) {
    const MESES_ES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
    const buckets = new Map();

    allTrips.forEach(t => {
        if (!t.id_chofer || !t.fecha) return;
        let d;
        let iso;
        if (t.fecha instanceof Date) {
            d = t.fecha;
            iso = d.toISOString().split('T')[0];
        } else {
            iso = String(t.fecha).split('T')[0];
            d = new Date(iso + 'T12:00:00Z');
        }
        if (isNaN(d.getTime())) return;

        const anio = d.getUTCFullYear();
        const mesNumero = d.getUTCMonth() + 1;
        const mesTab = `${MESES_ES[d.getUTCMonth()]}-${String(anio).slice(-2)}`;
        const key = `${t.id_chofer}__${mesTab}`;

        if (!buckets.has(key)) {
            buckets.set(key, {
                chofer_id: t.id_chofer,
                mes_tab: mesTab,
                anio,
                mes_numero: mesNumero,
                km_mes_total: 0,
                cant_viajes: 0,
                dias_km: {},
                fechasList: []
            });
        }
        const b = buckets.get(key);
        const km = parseFloat(t.km_totales) || 0;
        b.km_mes_total += km;
        b.cant_viajes += 1;

        if (!b.dias_km[iso]) {
            b.dias_km[iso] = {
                km: 0,
                hr: t.hoja_ruta || '',
                id_unidad: t.id_unidad || null,
                tractor: t.dominio || null
            };
            b.fechasList.push(iso);
        }
        b.dias_km[iso].km = Math.round((b.dias_km[iso].km + km) * 100) / 100;
        if (t.hoja_ruta && !b.dias_km[iso].hr.includes(t.hoja_ruta)) {
            b.dias_km[iso].hr = b.dias_km[iso].hr ? `${b.dias_km[iso].hr}, ${t.hoja_ruta}` : t.hoja_ruta;
        }
    });

    const rowsToInsert = [];
    buckets.forEach(b => {
        b.km_mes_total = Math.round(b.km_mes_total * 100) / 100;
        const sortedFechas = b.fechasList.sort();
        const rangos = [];
        let rangoActual = null;

        sortedFechas.forEach(fStr => {
            const curDate = new Date(fStr + 'T12:00:00Z');
            if (!rangoActual) {
                rangoActual = { desde: fStr, hasta: fStr, dias: 1, km: b.dias_km[fStr].km };
            } else {
                const prevDate = new Date(rangoActual.hasta + 'T12:00:00Z');
                const diffDays = Math.round((curDate - prevDate) / (1000 * 3600 * 24));
                if (diffDays === 1) {
                    rangoActual.hasta = fStr;
                    rangoActual.dias += 1;
                    rangoActual.km = Math.round((rangoActual.km + b.dias_km[fStr].km) * 100) / 100;
                } else {
                    rangos.push(rangoActual);
                    rangoActual = { desde: fStr, hasta: fStr, dias: 1, km: b.dias_km[fStr].km };
                }
            }
        });
        if (rangoActual) rangos.push(rangoActual);

        rowsToInsert.push({
            chofer_id: b.chofer_id,
            mes_tab: b.mes_tab,
            anio: b.anio,
            mes_numero: b.mes_numero,
            km_mes_total: b.km_mes_total,
            cant_viajes: b.cant_viajes,
            dias_km: JSON.stringify(b.dias_km),
            rangos: JSON.stringify(rangos)
        });
    });

    const BATCH_SIZE = 100;
    for (let i = 0; i < rowsToInsert.length; i += BATCH_SIZE) {
        const batch = rowsToInsert.slice(i, i + BATCH_SIZE);
        const valueStrings = [];
        const values = [];

        batch.forEach((r, idx) => {
            const base = idx * 8;
            valueStrings.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}::jsonb, $${base + 8}::jsonb)`);
            values.push(r.chofer_id, r.mes_tab, r.anio, r.mes_numero, r.km_mes_total, r.cant_viajes, r.dias_km, r.rangos);
        });

        const insertSql = `
            INSERT INTO public.choferes_km_mensual (
                chofer_id, mes_tab, anio, mes_numero, km_mes_total, cant_viajes, dias_km, rangos
            ) VALUES ${valueStrings.join(', ')}
            ON CONFLICT (chofer_id, mes_tab) DO UPDATE SET
                km_mes_total = EXCLUDED.km_mes_total,
                cant_viajes = EXCLUDED.cant_viajes,
                dias_km = EXCLUDED.dias_km,
                rangos = EXCLUDED.rangos,
                actualizado_el = NOW();
        `;
        await client.query(insertSql, values);
    }
}

async function upsertCisternasKm(client, allTrips, { formacionMap = new Map() } = {}) {
    const tripsToInsert = [];
    allTrips.forEach(t => {
        if (!t.fecha || !t.dominio) return;
        const domClean = String(t.dominio).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
        const formacion = formacionMap.get(domClean) || (t.id_unidad ? formacionMap.get(t.id_unidad) : null);

        const tractorPatente = t.dominio.trim().toUpperCase();
        const tractorId = formacion ? formacion.tractor_id : null;
        const idUnidad = t.id_unidad || (formacion ? formacion.id_unidad : null);
        const semiId = formacion ? formacion.semi_id : null;
        const cisternaPatente = formacion ? formacion.cisterna_patente : null;
        const estadoAsignacion = semiId ? 'confirmado' : 'pendiente';

        tripsToInsert.push({
            fecha: t.fecha,
            tractor_id: tractorId,
            tractor_patente: tractorPatente,
            id_unidad: idUnidad,
            semi_id: semiId,
            cisterna_patente: cisternaPatente,
            id_chofer: t.id_chofer || null,
            km_totales: parseFloat(t.km_totales) || 0,
            hoja_ruta: t.hoja_ruta || null,
            estado_asignacion: estadoAsignacion,
            origen_dato: 'sheets_km'
        });
    });

    const BATCH_SIZE = 250;
    for (let i = 0; i < tripsToInsert.length; i += BATCH_SIZE) {
        const batch = tripsToInsert.slice(i, i + BATCH_SIZE);
        const valueStrings = [];
        const values = [];

        batch.forEach((r, idx) => {
            const b = idx * 11;
            valueStrings.push(`($${b+1}, $${b+2}, $${b+3}, $${b+4}, $${b+5}, $${b+6}, $${b+7}, $${b+8}, $${b+9}, $${b+10}, $${b+11})`);
            values.push(r.fecha, r.tractor_id, r.tractor_patente, r.id_unidad, r.semi_id, r.cisterna_patente, r.id_chofer, r.km_totales, r.hoja_ruta, r.estado_asignacion, r.origen_dato);
        });

        const sql = `
            INSERT INTO public.cisternas_km (
                fecha, tractor_id, tractor_patente, id_unidad, semi_id, cisterna_patente, id_chofer, km_totales, hoja_ruta, estado_asignacion, origen_dato
            ) VALUES ${valueStrings.join(', ')}
            ON CONFLICT (fecha, tractor_patente, COALESCE(cisterna_patente, ''), COALESCE(hoja_ruta, ''))
            DO UPDATE SET
                semi_id = COALESCE(EXCLUDED.semi_id, cisternas_km.semi_id),
                id_unidad = COALESCE(EXCLUDED.id_unidad, cisternas_km.id_unidad),
                id_chofer = COALESCE(EXCLUDED.id_chofer, cisternas_km.id_chofer),
                km_totales = EXCLUDED.km_totales,
                estado_asignacion = CASE WHEN EXCLUDED.semi_id IS NOT NULL THEN 'confirmado' ELSE cisternas_km.estado_asignacion END,
                actualizado_el = NOW();
        `;
        await client.query(sql, values);
    }
}

module.exports = {
    extractKilometros,
    hydrateKmFromSupabase,
    upsertChoferesKmMensual,
    upsertCisternasKm,
    buildRamStructures,
    cargarDesdeDisco,
    getCutoff2Meses,
    getCutoff6Meses,
    CACHE_FILE
};
