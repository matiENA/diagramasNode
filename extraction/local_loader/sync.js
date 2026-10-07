require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { extractMasterBrands } = require('./extractors/masterBrands');
const { extractVencimientos } = require('./extractors/vencimientos');
const { extractDiagramasDetalle } = require('./extractors/diagramasDetalle');
const { extractMovimientosFlota } = require('./extractors/movimientosFlota');
const { extractKilometros } = require('./extractors/kilometros');
const { syncChoferesLegajoSupabase } = require('./extractors/choferesLegajo');
const { normalizar, mesesAbrev } = require('./utils/sheets');
const { Pool } = require('pg');

const pool = process.env.DATABASE_URL ? new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
}) : null;

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://rsvajuxihvmpmrmlcbul.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const isDryRun = process.argv.includes('--dry-run');

if (!isDryRun && !SUPABASE_KEY) {
    console.error('❌ Error: Falta SUPABASE_KEY en las variables de entorno (.env).');
    process.exit(1);
}

const supabase = (!isDryRun && SUPABASE_KEY) ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;

async function syncAll() {
    const t0 = Date.now();
    console.log('\n===============================================================');
    console.log(`🚀 INICIANDO EXTRACCIÓN Y SINCRONIZACIÓN A SUPABASE`);
    console.log(`   Destino: ${SUPABASE_URL}`);
    console.log(`   Modo: ${isDryRun ? 'DRY-RUN (Simulación, sin escrituras)' : 'PRODUCCIÓN (Escritura en BD)'}`);
    console.log('===============================================================\n');

    // 1. Extraer Marcas de Master
    console.log('📥 1/4 Extrayendo marcas desde Planilla Master...');
    const { marcasTractores, marcasSemis } = await extractMasterBrands(process.env.ID_SPREADSHEET_MASTER);
    console.log(`   ✅ Marcas indexadas: ${Object.keys(marcasTractores).length} tractores, ${Object.keys(marcasSemis).length} semis.`);

    // 2. Extraer Vencimientos
    console.log('📥 2/4 Extrayendo catálogo de vencimientos (base datos Uni QM + Vencimientos.)...');
    const vencimientosPorPatente = await extractVencimientos(process.env.ID_SHEET_MOVIMIENTOS);
    console.log(`   ✅ Vencimientos indexados: ${Object.keys(vencimientosPorPatente).length} patentes.`);

    // 3. Extraer Diagramas Detallado (Caracteres, Contabilizador de días y 60 días para RAM)
    console.log('📥 3/4 Extrayendo Caracteres y Contabilizadores desde Diagramas (1mhfXpFCF6upMlnRnZjDdBVS_wqTx5q8v0qQArNCnNAU)...');
    const { choferesDetalleList, diagramas60DiasRAM, monthTabs } = await extractDiagramasDetalle(process.env.ID_SPREADSHEET_DIAGRAMAS);
    console.log(`   ✅ Diagramas procesados: ${choferesDetalleList.length} choferes a lo largo de ${monthTabs.length} meses.`);
    console.log(`   📅 Ventana 60 días Hot RAM: ${diagramas60DiasRAM.desde} -> ${diagramas60DiasRAM.hasta}`);

    // 4. Extraer Flota Canónica y Pareo Diario desde Movimientos (1Bwj8WCykMn_FbZhQ_FqnDH3K_WCod52YTSvsaxIDNS8)
    console.log('📥 4/4 Extrayendo Flota Canónica y Movimientos operativos...');
    const { units, asignacionesHoy, choferesEnMovimientos, tabName: tabMovimientos } = await extractMovimientosFlota(
        process.env.ID_SHEET_MOVIMIENTOS,
        marcasTractores,
        marcasSemis,
        vencimientosPorPatente
    );

    // 5. Consolidación de Choferes (Diagramas Detalle + Movimientos)
    console.log('\n🔄 Consolidando catálogo unificado de Choferes con JSON de Diagramas...');
    const choferesFinalMap = new Map();

    // Primero, todos los choferes de Diagramas Detalle (con JSON, contabilizador y meses)
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

    // Segundo, incorporar o actualizar con asignaciones operativas de Movimientos
    for (const [norm, movCh] of choferesEnMovimientos.entries()) {
        if (choferesFinalMap.has(norm)) {
            const existing = choferesFinalMap.get(norm);
            existing.estado = 'circulando'; // Si está en la unidad hoy, está circulando
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
    console.log(`   ✅ Total Choferes Consolidados: ${choferesArray.length}`);
    console.log(`   ✅ Unidades Canónicas: ${units.length}`);
    console.log(`   ✅ Asignaciones de Hoy: ${asignacionesHoy.length}`);

    if (isDryRun) {
        console.log('\n🏁 [DRY-RUN] Simulación exitosa. No se aplicaron cambios a Supabase.');
        console.log(`   • Pestañas Diagramas: [${monthTabs.join(', ')}]`);
        console.log(`   • Pestaña Movimientos: [${tabMovimientos}]`);
        console.log(`   • 60 Días RAM: ${diagramas60DiasRAM.desde} -> ${diagramas60DiasRAM.hasta}`);
        console.log(`   • Tiempo total: ${Date.now() - t0}ms\n`);
        return { units, choferes: choferesArray, asignacionesHoy, diagramas60DiasRAM };
    }

    // 6. Escritura en Supabase
    console.log('\n📤 Sincronizando con Supabase...');

    // 6. Escritura en Supabase (Arquitectura Relacional: Servicios, Tractores, Semis, Unidades con solo IDs)
    console.log('\n📤 Sincronizando con Supabase en arquitectura relacional...');

    const chunkArray = (arr, size) => {
        const chunks = [];
        for (let i = 0; i < arr.length; i += size) {
            chunks.push(arr.slice(i, i + size));
        }
        return chunks;
    };
    const BATCH_SIZE = 50;

    // A. Sincronizar Catálogo de Servicios (servicios_unidades y servicios_choferes)
    console.log('   • Sincronizando catálogo `servicios_unidades`...');
    const serviciosUnidadesSet = new Set();
    units.forEach(u => {
        const s = (u.servicio || '').trim().toUpperCase();
        if (s) serviciosUnidadesSet.add(s);
    });
    for (const srv of serviciosUnidadesSet) {
        await supabase.from('servicios_unidades').upsert({ denominacion: srv }, { onConflict: 'denominacion' });
    }
    const { data: suList } = await supabase.from('servicios_unidades').select('id, denominacion');
    const serviciosUnidadesMap = new Map();
    (suList || []).forEach(su => serviciosUnidadesMap.set(su.denominacion.toUpperCase(), su.id));

    console.log('   • Sincronizando catálogo `servicios_choferes`...');
    const serviciosChoferesSet = new Set();
    choferesArray.forEach(c => {
        const s = (c.c_servicio || '').trim().toUpperCase();
        if (s) serviciosChoferesSet.add(s);
    });
    for (const srv of serviciosChoferesSet) {
        let suId = serviciosUnidadesMap.get(srv) || null;
        if (!suId) {
            if (srv === 'LIV') suId = serviciosUnidadesMap.get('LIVIANO') || null;
            else if (srv === 'ABAST') suId = serviciosUnidadesMap.get('ABASTECEDORES') || null;
            else if (srv === 'GRALES' || srv === 'GRALES.') suId = serviciosUnidadesMap.get('C. GENERALES') || null;
        }
        await supabase.from('servicios_choferes').upsert({ 
            denominacion: srv,
            servicio_unidad_id: suId
        }, { onConflict: 'denominacion' });
    }
    const { data: scList } = await supabase.from('servicios_choferes').select('id, denominacion, servicio_unidad_id');
    const serviciosChoferesMap = new Map();
    (scList || []).forEach(sc => serviciosChoferesMap.set(sc.denominacion.toUpperCase(), sc.id));

    // B. Sincronizar Catálogo Canónico de TRACTORES
    console.log('   • Sincronizando catálogo maestro `tractores`...');
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
        await supabase.from('tractores').upsert(batch, { onConflict: 'patente' });
    }
    const { data: dbTractores } = await supabase.from('tractores').select('id, patente');
    const tractorIdByPatente = new Map();
    (dbTractores || []).forEach(t => tractorIdByPatente.set(t.patente.toUpperCase(), t.id));
    console.log(`   ✅ ${tractoresArray.length} tractores sincronizados en public.tractores.`);

    // C. Sincronizar Catálogo Canónico de SEMIS
    console.log('   • Sincronizando catálogo maestro `semis`...');
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
        await supabase.from('semis').upsert(batch, { onConflict: 'patente' });
    }
    const { data: dbSemis } = await supabase.from('semis').select('id, patente');
    const semiIdByPatente = new Map();
    (dbSemis || []).forEach(s => semiIdByPatente.set(s.patente.toUpperCase(), s.id));
    console.log(`   ✅ ${semisArray.length} semis sincronizados en public.semis.`);

    // D. Sincronizar UNIDADES (Únicamente IDs de formación)
    console.log('   • Actualizando tabla `unidades` (únicamente con IDs de formación)...');
    const { data: existingUnits, error: errFetchU } = await supabase.from('unidades').select('id, n_ute, tractor_id, semi_id, servicio_id, fecha_acople, estado');
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
        const { error: errUpU } = await supabase.from('unidades').upsert(batch);
        if (errUpU) console.error('   ❌ Error actualizando lote unidades:', errUpU.message);
    }
    for (const batch of chunkArray(unitsToInsert, BATCH_SIZE)) {
        const { error: errInsU } = await supabase.from('unidades').insert(batch);
        if (errInsU) console.error('   ❌ Error insertando lote unidades:', errInsU.message);
    }
    console.log(`   ✅ Unidades sincronizadas estrictamente desde Mov.Unidades: ${unitsToUpdate.length} actualizadas, ${unitsToInsert.length} nuevas.`);

    // E. Sincronizar Choferes (con servicio_id y diagramas)
    console.log('   • Actualizando tabla `choferes` (con servicio_id relacional y JSON)...');
    const { data: existingChoferes, error: errFetchC } = await supabase.from('choferes').select('id, nombre, dni, foto');
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

    for (const batch of chunkArray(choferesToUpdate, BATCH_SIZE)) {
        const { error: errUpC } = await supabase.from('choferes').upsert(batch);
        if (errUpC) console.error('   ❌ Error actualizando lote choferes:', errUpC.message);
    }
    for (const batch of chunkArray(choferesToInsert, BATCH_SIZE)) {
        const { error: errInsC } = await supabase.from('choferes').insert(batch);
        if (errInsC) console.error('   ❌ Error insertando lote choferes:', errInsC.message);
    }
    console.log(`   ✅ Choferes sincronizados: ${choferesToUpdate.length} actualizados (con servicio_id), ${choferesToInsert.length} nuevos.`);

    // F. Sincronizar Movimientos (Pareos Activos Unidad <-> Chofer)
    console.log('   • Actualizando tabla `movimientos` (solo id, id_unidad, id_chofer)...');
    const { data: freshUnits } = await supabase.from('unidades').select('id, tractor_id, semi_id, n_ute, servicio_id');
    const { data: freshChoferes } = await supabase.from('choferes').select('id, nombre, legajo, c_servicio, servicio_id, unidad_id, estado');

    const idToTractorPatente = new Map();
    (dbTractores || []).forEach(t => idToTractorPatente.set(t.id, t.patente.toUpperCase()));
    const idToSemiPatente = new Map();
    (dbSemis || []).forEach(s => idToSemiPatente.set(s.id, s.patente.toUpperCase()));

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
    (freshChoferes || []).forEach(c => {
        freshChoferMap.set(normalizar(c.nombre), c.id);
    });

    function resolveChoferId(rawNorm) {
        if (!rawNorm) return null;
        if (freshChoferMap.has(rawNorm)) return freshChoferMap.get(rawNorm);
        
        const sinEnie = rawNorm.includes('ñ') ? rawNorm.replace(/ñ/g, 'n') : null;
        if (sinEnie && freshChoferMap.has(sinEnie)) return freshChoferMap.get(sinEnie);

        const palabras = rawNorm.split(/\s+/).filter(w => w.length >= 3);
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
    const choferesConUnidad = new Map(); // idChofer -> idUnidad
    for (const asig of asignacionesHoy) {
        const idUnidad = freshUnitMap.get(asig.tractor) || freshUnitMap.get(asig.semi) || (asig.nUte ? freshUnitMap.get(String(asig.nUte).trim()) : null);
        const idChofer = resolveChoferId(asig.choferNorm);

        if (idUnidad && idChofer) {
            movsToInsert.push({
                id_unidad: idUnidad,
                id_chofer: idChofer
            });
            choferesConUnidad.set(idChofer, idUnidad);
        }
    }

    // Limpiar pareos anteriores e insertar la foto operativa actual reflejando fielmente la planilla
    if (pool) {
        await pool.query(`DELETE FROM movimientos WHERE id != '00000000-0000-0000-0000-000000000000'`);
    } else {
        const { error: errDelMov } = await supabase.from('movimientos').delete().neq('id', '00000000-0000-0000-0000-000000000000');
        if (errDelMov) console.error('   ❌ Error eliminando movimientos antiguos:', errDelMov.message);
    }

    if (movsToInsert.length > 0) {
        if (pool) {
            const BATCH_PG = 100;
            for (let i = 0; i < movsToInsert.length; i += BATCH_PG) {
                const chunk = movsToInsert.slice(i, i + BATCH_PG);
                const values = [];
                const params = [];
                chunk.forEach((m, idx) => {
                    params.push(m.id_unidad, m.id_chofer);
                    values.push(`($${idx * 2 + 1}, $${idx * 2 + 2})`);
                });
                await pool.query(`INSERT INTO movimientos (id_unidad, id_chofer) VALUES ${values.join(', ')}`, params);
            }
        } else {
            for (const batch of chunkArray(movsToInsert, BATCH_SIZE)) {
                const { error: errInsMov } = await supabase.from('movimientos').insert(batch);
                if (errInsMov) console.error('   ❌ Error insertando lote movimientos:', errInsMov.message);
            }
        }
        console.log(`   ✅ ${movsToInsert.length} movimientos activos registrados desde Sheets.`);
    }

    // Mantener choferes.unidad_id sincronizado con los movimientos activos
    if (pool) {
        // 1. Limpiar unidad_id de choferes que ya no tienen asignación activa
        await pool.query(`
            UPDATE choferes 
            SET unidad_id = NULL, 
                estado = CASE WHEN estado = 'circulando' THEN 'inactivo' ELSE estado END 
            WHERE unidad_id IS NOT NULL
        `);
        // 2. Establecer unidad_id para las asignaciones activas de hoy
        for (const [idChofer, idUnidad] of choferesConUnidad.entries()) {
            await pool.query(`UPDATE choferes SET unidad_id = $1, estado = 'circulando' WHERE id = $2`, [idUnidad, idChofer]);
        }
        console.log(`   🔄 Sincronizados ${choferesConUnidad.size} choferes con su unidad_id vía Postgres directo.`);
    } else {
        // Fallback con cliente Supabase usando update explícito (evitando el error NOT NULL de upsert)
        await supabase.from('choferes').update({ unidad_id: null, estado: 'inactivo' }).not('unidad_id', 'is', null);
        for (const [idChofer, idUnidad] of choferesConUnidad.entries()) {
            await supabase.from('choferes').update({ unidad_id: idUnidad, estado: 'circulando' }).eq('id', idChofer);
        }
        console.log(`   🔄 Sincronizados ${choferesConUnidad.size} choferes con su unidad_id vía Supabase update.`);
    }

    // D. Opcional: Sincronizar tabla `diagramas` histórica si existe
    try {
        const { error: checkDiagErr } = await supabase.from('diagramas').select('id').limit(1);
        if (!checkDiagErr) {
            console.log('   • Sincronizando tabla histórica `diagramas`...');
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
            if (rowsDiagramas.length > 0) {
                // Upsert por lote de 100
                const BATCH_SIZE = 100;
                for (let i = 0; i < rowsDiagramas.length; i += BATCH_SIZE) {
                    const batch = rowsDiagramas.slice(i, i + BATCH_SIZE);
                    await supabase.from('diagramas').upsert(batch, { onConflict: 'chofer_nombre,mes_tab' });
                }
                console.log(`   ✅ ${rowsDiagramas.length} registros históricos sincronizados en tabla 'diagramas'.`);
            }
        }
    } catch (eDiag) {
        console.error('   ⚠️ Error sincronizando tabla diagramas:', eDiag.message);
    }

    // 7. Extraer e indexar Kilómetros (Últimos 6 meses -> Supabase + 2 meses en Hot RAM)
    let kmSyncResult = null;
    try {
        const enrichedFreshUnits = (freshUnits || []).map(u => ({
            ...u,
            tractor: u.tractor_id && idToTractorPatente.has(u.tractor_id) ? idToTractorPatente.get(u.tractor_id) : null,
            semi: u.semi_id && idToSemiPatente.has(u.semi_id) ? idToSemiPatente.get(u.semi_id) : null
        }));
        kmSyncResult = await extractKilometros(enrichedFreshUnits, freshChoferes, pool);
    } catch (eKm) {
        console.error('   ⚠️ Error extrayendo kilómetros en sincronización:', eKm.message);
    }

    // 8. Extraer y Sincronizar Legajos, Documentación, Vencimientos y Observaciones
    let legajoSyncResult = null;
    if (!isDryRun && supabase) {
        try {
            console.log('📥 6/6 Sincronizando Legajos, Vencimientos y Observaciones...');
            legajoSyncResult = await syncChoferesLegajoSupabase(supabase);
        } catch (eLegajo) {
            console.error('   ⚠️ Error sincronizando legajos/observaciones:', eLegajo.message);
        }
    }

    const duration = Date.now() - t0;
    console.log('\n===============================================================');
    console.log(`🎉 SINCRONIZACIÓN EXITOSA EN ${duration}ms`);
    console.log(`   • Unidades:       ${units.length}`);
    console.log(`   • Choferes:       ${choferesArray.length}`);
    console.log(`   • Movimientos:    ${movsToInsert.length}`);
    console.log(`   • 60 Días en RAM: ${diagramas60DiasRAM.desde} -> ${diagramas60DiasRAM.hasta} (${diagramas60DiasRAM.totalChoferes} choferes)`);
    if (kmSyncResult && kmSyncResult.resumen) {
        console.log(`   • Kilómetros (6m): ${kmSyncResult.resumen.total_kms_flota.toLocaleString('es-AR')} km (${kmSyncResult.resumen.total_viajes} viajes)`);
    }
    if (legajoSyncResult && legajoSyncResult.success) {
        console.log(`   • Legajos/Docs:   ${legajoSyncResult.upsertedDocs} registrados en chofer_documentacion`);
        console.log(`   • Observaciones:  ${legajoSyncResult.insertedObs} eventos registrados en chofer_observaciones`);
    }
    console.log('===============================================================\n');

    // 9. Notificar al servidor RAM (puerto 3005) para refresco en caliente y emisión WebSocket
    try {
        const http = require('http');
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
            timeout: 5000
        }, (res) => {
            console.log(`📡 [RAM Refresh] Servidor RAM notificado con éxito (código HTTP ${res.statusCode}).`);
        });
        req.on('error', () => {
            // Servidor 3005 no activo localmente o corriendo en otro host
        });
        req.write(postData);
        req.end();
    } catch (eRefresh) {}

    return {
        units,
        choferes: choferesArray,
        movimientos: movsToInsert,
        diagramas60DiasRAM,
        duration
    };
}

if (require.main === module) {
    syncAll().catch(err => {
        console.error('❌ Error fatal en ejecución:', err);
        process.exit(1);
    });
}

module.exports = { syncAll };
