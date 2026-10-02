/**
 * sync_to_new_supabase.js
 * Extrae la flota canónica, vencimientos, choferes y pareo del día
 * utilizando la lógica probada de diagramasnode, y los migra a la nueva base de datos de Supabase.
 * 
 * Uso:
 *   node sync_to_new_supabase.js [SUPABASE_KEY]
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const {
    fetchRango,
    serviceAccountAuth,
    ID_SPREADSHEET_MASTER,
    ID_SHEET_MOVIMIENTOS,
    normalizar,
    getFechaArgentina
} = require('./utils/shared');

const isDryRun = process.argv.includes('--dry-run');
const NEW_SUPABASE_URL = process.env.NEW_SUPABASE_URL || 'https://rsvajuxihvmpmrmlcbul.supabase.co';
const NEW_SUPABASE_KEY = process.env.NEW_SUPABASE_KEY || process.argv.find(a => !a.startsWith('--') && a !== process.argv[0] && a !== process.argv[1]);

if (!isDryRun && !NEW_SUPABASE_KEY) {
    console.error('❌ Error: Falta la clave de API de Supabase (Anon Key o Service Role Key).');
    console.log('   Uso: node sync_to_new_supabase.js <TU_SUPABASE_KEY>');
    console.log('   O prueba la extracción con: node sync_to_new_supabase.js --dry-run');
    console.log('   O agrégala en .env como: NEW_SUPABASE_KEY=sb_publishable_...');
    process.exit(1);
}

const supabase = (!isDryRun && NEW_SUPABASE_KEY) ? createClient(NEW_SUPABASE_URL, NEW_SUPABASE_KEY) : null;

const mesesAbrev = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
const mesesLargo = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

async function getTabName(spreadsheetId, keyword = "Mov.Unidades", defaultName = "OCTUBRE 2026- Mov.Unidades y Choferes") {
    try {
        const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`;
        const metaRes = await serviceAccountAuth.request({ url: metaUrl });
        const sheets = (metaRes.data.sheets || []).map(s => s.properties.title);
        if (!sheets || sheets.length === 0) return defaultName;

        const hoyAr = getFechaArgentina();
        const mesNombre = mesesLargo[hoyAr.getMonth()].toLowerCase();
        const mesAbrev = mesesAbrev[hoyAr.getMonth()].toLowerCase();
        const normKw = keyword.toLowerCase().replace(/\s+/g, '');

        const foundCurrent = sheets.slice().reverse().find(s => {
            const low = s.toLowerCase();
            return (low.includes(mesNombre) || low.includes(mesAbrev)) && low.replace(/\s+/g, '').includes(normKw);
        });
        if (foundCurrent) return foundCurrent;

        const foundLast = sheets.slice().reverse().find(s => s.toLowerCase().replace(/\s+/g, '').includes(normKw));
        return foundLast || defaultName;
    } catch (e) {
        console.warn('⚠️ Error resolviendo pestaña mensual:', e.message);
        return defaultName;
    }
}

function parseFechaISO(str) {
    if (!str) return null;
    const s = String(str).trim();
    const parts = s.split(/[\/\-]/);
    if (parts.length === 3) {
        let y = parseInt(parts[2], 10);
        if (y < 100) y += 2000;
        const m = String(parseInt(parts[1], 10)).padStart(2, '0');
        const d = String(parseInt(parts[0], 10)).padStart(2, '0');
        if (!isNaN(y) && !isNaN(m) && !isNaN(d)) return `${y}-${m}-${d}`;
    }
    return null;
}

async function ejecutarMigracion() {
    const t0 = Date.now();
    console.log('\n===============================================================');
    console.log(`🚀 INICIANDO MIGRACIÓN A NUEVA DB: ${NEW_SUPABASE_URL}`);
    console.log('===============================================================\n');

    // 1. Marcas de Tractores y Semis
    console.log('📥 1/5 Cargando marcas desde TRACTORES y SEMIS...');
    const [rowsTractores, rowsSemis] = await Promise.all([
        fetchRango(ID_SPREADSHEET_MASTER, "'TRACTORES'!C2:D").catch(() => []),
        fetchRango(ID_SPREADSHEET_MASTER, "'SEMIS'!C2:D").catch(() => [])
    ]);

    const marcasTractores = {};
    const marcasSemis = {};
    rowsTractores.forEach(r => {
        let p = String(r[0] || '').trim().toUpperCase().replace(/\s+/g, '');
        let m = String(r[1] || '').trim();
        if (p && m && p !== 'DOMINIO') marcasTractores[p] = m;
    });
    rowsSemis.forEach(r => {
        let p = String(r[0] || '').trim().toUpperCase().replace(/\s+/g, '');
        let m = String(r[1] || '').trim();
        if (p && m && p !== 'DOMINIO') marcasSemis[p] = m;
    });
    console.log(`   ✅ Marcas indexadas: ${Object.keys(marcasTractores).length} tractores, ${Object.keys(marcasSemis).length} semis.`);

    // 2. Vencimientos de Patentes (Uni QM + Vencimientos.)
    console.log('📥 2/5 Cargando catálogo de vencimientos (base datos Uni QM + Vencimientos.)...');
    const [rowsUniQM, rowsVenc] = await Promise.all([
        fetchRango(ID_SHEET_MOVIMIENTOS, "'base datos Uni QM'!A3:F").catch(() => []),
        fetchRango(ID_SHEET_MOVIMIENTOS, "'Vencimientos.'!A2:N").catch(() => [])
    ]);

    const vencimientosPorPatente = {};
    rowsUniQM.forEach(row => {
        let p = String(row[0] || '').trim().toUpperCase().replace(/\s+/g, '');
        if (!p || p === 'PATENTE') return;
        vencimientosPorPatente[p] = {
            mas: parseFechaISO(row[1]),
            vtv: parseFechaISO(row[2]),
            esp_es: String(row[3] || '').trim(),
            vi: String(row[4] || '').trim(),
            ve: String(row[5] || '').trim()
        };
    });

    rowsVenc.forEach(r => {
        let tr = String(r[1] || '').trim().toUpperCase().replace(/\s+/g, '');
        let se = String(r[2] || '').trim().toUpperCase().replace(/\s+/g, '');
        if (tr && tr !== 'TRACTOR') {
            if (!vencimientosPorPatente[tr]) vencimientosPorPatente[tr] = {};
            if (r[6]) vencimientosPorPatente[tr].mas = parseFechaISO(r[6]);
            if (r[7]) vencimientosPorPatente[tr].vtv = parseFechaISO(r[7]);
        }
        if (se && se !== 'SEMI') {
            if (!vencimientosPorPatente[se]) vencimientosPorPatente[se] = {};
            if (r[9]) vencimientosPorPatente[se].mas = parseFechaISO(r[9]);
            if (r[10]) vencimientosPorPatente[se].vtv = parseFechaISO(r[10]);
            if (r[11]) vencimientosPorPatente[se].esp_es = String(r[11] || '').trim();
            if (r[12]) vencimientosPorPatente[se].vi = String(r[12] || '').trim();
            if (r[13]) vencimientosPorPatente[se].ve = String(r[13] || '').trim();
        }
    });
    console.log(`   ✅ Base de datos de vencimientos indexada: ${Object.keys(vencimientosPorPatente).length} patentes.`);

    // 3. Choferes: Se extraen directamente desde la hoja de Movimientos
    console.log('ℹ️ 3/4 Omitiendo dni y LEGAJOS (los choferes se extraen directamente de Movimientos)...');

    // 4. Extracción de Flota Canónica y Pareo Diario de Movimientos
    const tabName = await getTabName(ID_SHEET_MOVIMIENTOS, "Mov.Unidades", "OCTUBRE 2026- Mov.Unidades y Choferes");
    console.log(`📥 4/5 Leyendo planilla mensual: [${tabName}]...`);
    const rowsMov = await fetchRango(ID_SHEET_MOVIMIENTOS, `'${tabName}'!A1:ZZ350`);

    if (!rowsMov || rowsMov.length === 0) {
        throw new Error(`La hoja '${tabName}' está vacía o no se pudo leer.`);
    }

    // Detectar columna de hoy
    const hoyAr = getFechaArgentina();
    const targetD = hoyAr.getDate();
    const targetM = hoyAr.getMonth();
    const targetY = hoyAr.getFullYear();
    const regexFecha = new RegExp(`\\b0?${targetD}\\s+${mesesLargo[targetM]}\\b`, 'i');

    let colFechaHoy = -1;
    if (rowsMov[0]) {
        for (let c = 0; c < rowsMov[0].length; c++) {
            let v = String(rowsMov[0][c] || '').toLowerCase().trim();
            if (regexFecha.test(v) || v.includes(`${targetD}/${targetM + 1}/`) || v.includes(`${String(targetD).padStart(2, '0')}/${String(targetM + 1).padStart(2, '0')}/`)) {
                colFechaHoy = c;
                break;
            }
        }
    }

    const colChoferHoy = colFechaHoy >= 3 ? colFechaHoy - 3 : 27; // Stride offset
    console.log(`   📅 Fecha operativa: ${targetD} de ${mesesLargo[targetM]} de ${targetY} (Columna chofer: ${colChoferHoy}, Fecha: ${colFechaHoy})`);

    const unitsToInsert = [];
    const choferesToInsertMap = new Map();
    const asignacionesHoy = [];
    let currentSrv = 'GENERAL';

    for (let i = 1; i < rowsMov.length; i++) {
        const row = rowsMov[i];
        if (!row || row.length === 0) continue;

        const col0 = String(row[0] || '').trim();
        const col2 = String(row[2] || '').trim();
        const col4 = String(row[4] || '').trim();
        const col5 = String(row[5] || '').trim();

        // Cabecera de Categoría
        if (col0 && !col2 && !col4 && !col5) {
            const up = col0.toUpperCase();
            if (!up.includes('FECHA') && !up.includes('N°') && !mesesLargo.some(m => up.includes(m.toUpperCase()))) {
                currentSrv = up;
            }
            continue;
        }

        const tractor = col4.toUpperCase().replace(/\s+/g, '');
        const semi = col5.toUpperCase().replace(/\s+/g, '');
        const nUte = col2;
        const cist = String(row[3] || '').trim();

        if (!tractor && !semi && !nUte) continue;
        if (tractor === 'TRACTOR' || semi === 'SEMI') continue;

        // Vencimientos asociados
        const vTr = vencimientosPorPatente[tractor] || {};
        const vSe = vencimientosPorPatente[semi] || {};

        // Chofer de hoy
        const rawChofer = String(row[colChoferHoy] || '').trim();
        const tieneChofer = Boolean(rawChofer && rawChofer !== '1' && rawChofer.length >= 3 && /[a-zA-Z]/.test(rawChofer));

        const dispoHoy = colChoferHoy + 1 < row.length ? String(row[colChoferHoy + 1] || '').trim() : '';
        const diagHoy = colChoferHoy + 2 < row.length ? String(row[colChoferHoy + 2] || '').trim() : '';

        const unitRecord = {
            tractor: tractor || null,
            semi: semi || null,
            n_ute: nUte || null,
            servicio: currentSrv,
            estado: tieneChofer ? 'circulando' : 'disponible',
            marca_tr: marcasTractores[tractor] || null,
            marca_semi: marcasSemis[semi] || null,
            cisternado: cist || null,
            mas_tr: vTr.mas || null,
            vtv_tr: vTr.vtv || null,
            mas_semi: vSe.mas || null,
            vtv_semi: vSe.vtv || null,
            esp_es: vTr.esp_es || vSe.esp_es || null,
            vi: vTr.vi || vSe.vi || null,
            ve: vTr.ve || vSe.ve || null
        };

        unitsToInsert.push(unitRecord);

        if (tieneChofer) {
            const normCh = normalizar(rawChofer);
            const nombreLimpio = rawChofer.trim().toUpperCase();
            
            if (!choferesToInsertMap.has(normCh)) {
                choferesToInsertMap.set(normCh, {
                    nombre: nombreLimpio,
                    c_servicio: currentSrv,
                    estado: 'circulando'
                });
            }

            asignacionesHoy.push({
                tractor,
                semi,
                choferNorm: normCh,
                choferNombre: nombreLimpio,
                dispo: dispoHoy,
                diag: diagHoy
            });
        }
    }

    // Escanear todas las columnas de choferes del mes para tener el catálogo completo de choferes activos
    for (let c = 27; c < (rowsMov[0] || []).length; c += 13) {
        for (let i = 1; i < rowsMov.length; i++) {
            const rawNom = String(rowsMov[i][c] || '').trim();
            if (rawNom && rawNom !== '1' && rawNom.length >= 3 && /[a-zA-Z]/.test(rawNom)) {
                const normCh = normalizar(rawNom);
                if (!choferesToInsertMap.has(normCh)) {
                    choferesToInsertMap.set(normCh, {
                        nombre: rawNom.toUpperCase(),
                        c_servicio: 'S/A',
                        estado: 'inactivo'
                    });
                }
            }
        }
    }

    console.log(`   ✅ Flota extraída: ${unitsToInsert.length} unidades/equipos canónicos.`);
    console.log(`   ✅ Choferes extraídos del mes: ${choferesToInsertMap.size} choferes únicos.`);
    console.log(`   ✅ Asignaciones activas de hoy: ${asignacionesHoy.length} unidades con chofer en ruta.`);

    if (isDryRun) {
        console.log('\n🏁 [DRY-RUN] Extracción completada con éxito. No se realizaron escrituras en Supabase.');
        console.log(`   • Unidades procesadas: ${unitsToInsert.length}`);
        console.log(`   • Choferes procesados: ${choferesToInsertMap.size}`);
        console.log(`   • Asignaciones de hoy: ${asignacionesHoy.length}`);
        console.log(`   • Tiempo transcurrido: ${Date.now() - t0}ms\n`);
        return;
    }

    // 5. Escritura en Supabase
    console.log('\n📤 5/5 Escribiendo en Supabase...');

    // A. Sincronizar unidades
    console.log('   • Sincronizando unidades en Supabase...');
    const { data: existingUnits, error: errFetchU } = await supabase.from('unidades').select('id, tractor, semi');
    if (errFetchU) console.error('   ❌ Error consultando unidades existentes:', errFetchU.message);

    if (!existingUnits || existingUnits.length === 0) {
        // Carga inicial directa
        const { error: errIns } = await supabase.from('unidades').insert(unitsToInsert);
        if (errIns) console.error('   ❌ Error insertando unidades:', errIns.message);
        else console.log(`   ✅ ${unitsToInsert.length} unidades insertadas exitosamente.`);
    } else {
        // Mapear por tractor para actualizar o insertar
        const existMap = new Map();
        existingUnits.forEach(u => {
            if (u.tractor) existMap.set(u.tractor, u.id);
            else if (u.semi) existMap.set(u.semi, u.id);
        });

        const toInsert = [];
        let updatedCount = 0;

        for (const u of unitsToInsert) {
            const key = u.tractor || u.semi;
            if (existMap.has(key)) {
                const existingId = existMap.get(key);
                await supabase.from('unidades').update(u).eq('id', existingId);
                updatedCount++;
            } else {
                toInsert.push(u);
            }
        }

        if (toInsert.length > 0) {
            await supabase.from('unidades').insert(toInsert);
        }
        console.log(`   ✅ Unidades sincronizadas: ${updatedCount} actualizadas, ${toInsert.length} nuevas.`);
    }

    // B. Sincronizar choferes
    console.log('   • Sincronizando choferes en Supabase...');
    const choferesArray = Array.from(choferesToInsertMap.values());
    const { data: existingChoferes, error: errFetchC } = await supabase.from('choferes').select('id, nombre');
    if (errFetchC) console.error('   ❌ Error consultando choferes existentes:', errFetchC.message);

    if (!existingChoferes || existingChoferes.length === 0) {
        const { error: errChIns } = await supabase.from('choferes').insert(choferesArray);
        if (errChIns) console.error('   ❌ Error insertando choferes:', errChIns.message);
        else console.log(`   ✅ ${choferesArray.length} choferes insertados exitosamente.`);
    } else {
        const existChMap = new Map();
        existingChoferes.forEach(c => existChMap.set(c.nombre.toUpperCase().trim(), c.id));

        const toInsertCh = [];
        let updatedChCount = 0;

        for (const ch of choferesArray) {
            const key = ch.nombre.toUpperCase().trim();
            if (existChMap.has(key)) {
                const idCh = existChMap.get(key);
                await supabase.from('choferes').update(ch).eq('id', idCh);
                updatedChCount++;
            } else {
                toInsertCh.push(ch);
            }
        }

        if (toInsertCh.length > 0) {
            await supabase.from('choferes').insert(toInsertCh);
        }
        console.log(`   ✅ Choferes sincronizados: ${updatedChCount} actualizados, ${toInsertCh.length} nuevos.`);
    }

    // C. Mapear y registrar movimientos de hoy
    console.log('   • Vinculando y registrando movimientos activos de hoy...');
    const { data: freshUnits } = await supabase.from('unidades').select('id, tractor, semi');
    const { data: freshChoferes } = await supabase.from('choferes').select('id, nombre');

    const unitMap = new Map();
    freshUnits?.forEach(u => {
        if (u.tractor) unitMap.set(u.tractor, u.id);
        if (u.semi) unitMap.set(u.semi, u.id);
    });

    const choferMap = new Map();
    freshChoferes?.forEach(c => {
        choferMap.set(normalizar(c.nombre), c.id);
    });

    const movsToInsert = [];
    asignacionesHoy.forEach(asig => {
        const uId = unitMap.get(asig.tractor) || unitMap.get(asig.semi);
        const cId = choferMap.get(asig.choferNorm);

        if (uId && cId) {
            movsToInsert.push({
                id_unidad: uId,
                id_chofer: cId
            });
        }
    });

    // Limpiar pareos anteriores e insertar la asignación activa de hoy
    await supabase.from('movimientos').delete().neq('id', '00000000-0000-0000-0000-000000000000');

    if (movsToInsert.length > 0) {
        const { error: errMov } = await supabase.from('movimientos').insert(movsToInsert);
        if (errMov) console.error('   ❌ Error insertando movimientos:', errMov.message);
        else console.log(`   ✅ ${movsToInsert.length} movimientos activos registrados exitosamente (solo id_unidad, id_chofer).`);
    }

    const duracion = Date.now() - t0;
    console.log('\n===============================================================');
    console.log(`🎉 MIGRACIÓN COMPLETADA EN ${duracion}ms`);
    console.log(`   • Unidades en base:    ${unitsToInsert.length}`);
    console.log(`   • Choferes en base:    ${choferesArray.length}`);
    console.log(`   • Movimientos activos: ${movsToInsert.length}`);
    console.log('===============================================================\n');
}

ejecutarMigracion().catch(err => {
    console.error('❌ Error fatal en migración:', err);
    process.exit(1);
});
