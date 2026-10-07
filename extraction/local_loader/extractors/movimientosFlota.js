const { fetchRange, resolveTabNameMovimientos, getFechaArgentina, normalizar, mesesLargo } = require('../utils/sheets');

/**
 * Extrae la flota canónica y las asignaciones diarias desde la planilla de Movimientos.
 * SpreadSheet ID: 1Bwj8WCykMn_FbZhQ_FqnDH3K_WCod52YTSvsaxIDNS8
 * 
 * Estructura de la planilla:
 * - Fila 1 (Cabecera):
 *   - Col A: Ícono / Estado
 *   - Col C: N° UTE
 *   - Col D: Cisternado
 *   - Col E: Tractor
 *   - Col F: Semi
 *   - A partir de Col 27: Bloques diarios de 13 columnas por día
 *     - Col Chofer = Col Fecha - 3 (o 27 + 13*(d-1))
 *     - Col Dispo  = Col Chofer + 1
 *     - Col Diag   = Col Chofer + 2
 *     - Col Fecha  = Col Chofer + 3
 * - Filas de Datos:
 *   - Filas de categoría (ej. 'LIVIANO', 'METANOL', 'CAMPO', 'GLP', 'SOCIO') cuando solo Col A tiene texto.
 *   - Filas de unidades: Col E (Tractor) y/o Col F (Semi).
 */
async function extractMovimientosFlota(spreadsheetId, marcasTractores = {}, marcasSemis = {}, vencimientosPorPatente = {}) {
    const tabName = await resolveTabNameMovimientos(spreadsheetId);
    console.log(`📋 Leyendo Flota Canónica y Movimientos desde [${tabName}] (ID: ${spreadsheetId})...`);

    const range = `'${tabName}'!A1:ZZ350`;
    const rows = await fetchRange(spreadsheetId, range);

    if (!rows || rows.length === 0) {
        throw new Error(`La hoja '${tabName}' está vacía o no se pudo leer.`);
    }

    const hoyAr = getFechaArgentina();
    const diaHoy = hoyAr.getDate();
    const mesHoy = hoyAr.getMonth();
    const regexFechaHoy = new RegExp(`\\b0?${diaHoy}\\s+${mesesLargo[mesHoy]}\\b`, 'i');

    // 1. Detectar columna de chofer para el día de hoy
    let colFechaHoy = -1;
    const row0 = rows[0] || [];
    for (let c = 0; c < row0.length; c++) {
        const val = String(row0[c] || '').toLowerCase().trim();
        if (regexFechaHoy.test(val) || val.includes(`${diaHoy}/${mesHoy + 1}/`) || val.includes(`${String(diaHoy).padStart(2, '0')}/${String(mesHoy + 1).padStart(2, '0')}/`)) {
            colFechaHoy = c;
            break;
        }
    }

    // Si encontró la columna de fecha, el chofer está 3 columnas antes. Si no, usa el stride: 27 + 13*(diaHoy-1)
    const colChoferHoy = colFechaHoy >= 3 ? (colFechaHoy - 3) : (27 + 13 * (diaHoy - 1));
    console.log(`   📅 Día operativo: ${diaHoy} de ${mesesLargo[mesHoy]} (Columna Chofer: ${colChoferHoy}, Fecha: ${colFechaHoy})`);

    const units = [];
    const asignacionesHoy = [];
    const choferesEnMovimientos = new Map();
    let currentServicio = 'GENERAL';

    for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row || row.length === 0) continue;

        const col0 = String(row[0] || '').trim();
        const col2 = String(row[2] || '').trim();
        const col4 = String(row[4] || '').trim();
        const col5 = String(row[5] || '').trim();

        // Detectar fila cabecera de categoría / servicio
        if (col0 && !col2 && !col4 && !col5) {
            const up = col0.toUpperCase();
            if (!up.includes('FECHA') && !up.includes('N°') && !up.includes('SEPTIEMBRE') && !up.includes('OCTUBRE')) {
                currentServicio = up;
            }
            continue;
        }

        const tractor = col4.toUpperCase().replace(/\s+/g, '');
        const semi = col5.toUpperCase().replace(/\s+/g, '');
        const nUte = col2;
        const cisternado = String(row[3] || '').trim();

        if (!tractor && !semi && !nUte) continue;
        if (tractor === 'TRACTOR' || semi === 'SEMI') continue;

        // Vencimientos y marcas
        const vTr = vencimientosPorPatente[tractor] || {};
        const vSe = vencimientosPorPatente[semi] || {};
        const marcaTr = marcasTractores[tractor] || null;
        const marcaSemi = marcasSemis[semi] || null;

        // Chofer asignado hoy
        const rawChofer = colChoferHoy < row.length ? String(row[colChoferHoy] || '').trim() : '';
        const tieneChofer = Boolean(rawChofer && rawChofer !== '1' && rawChofer.length >= 3 && /[a-zA-Z]/.test(rawChofer));

        const dispoHoy = colChoferHoy + 1 < row.length ? String(row[colChoferHoy + 1] || '').trim() : '';
        const diagHoy = colChoferHoy + 2 < row.length ? String(row[colChoferHoy + 2] || '').trim() : '';

        // Objeto unidad según el esquema Supabase (sin fecha_cambio_estado ni actualizado_el)
        const unitRecord = {
            tractor: tractor || null,
            semi: semi || null,
            n_ute: nUte || null,
            servicio: currentServicio,
            estado: tieneChofer ? 'circulando' : 'disponible',
            marca_tr: marcaTr,
            marca_semi: marcaSemi,
            cisternado: cisternado || null,
            mas_tr: vTr.mas || null,
            vtv_tr: vTr.vtv || null,
            mas_semi: vSe.mas || null,
            vtv_semi: vSe.vtv || null,
            esp_es: vTr.esp_es || vSe.esp_es || null,
            vi: vTr.vi || vSe.vi || null,
            ve: vTr.ve || vSe.ve || null
        };

        units.push(unitRecord);

        if (tieneChofer) {
            const normChofer = normalizar(rawChofer);
            const nombreLimpio = rawChofer.trim().toUpperCase();

            choferesEnMovimientos.set(normChofer, {
                nombre: nombreLimpio,
                c_servicio: currentServicio,
                estado: 'circulando'
            });

            asignacionesHoy.push({
                tractor,
                semi,
                nUte,
                choferNorm: normChofer,
                choferNombre: nombreLimpio,
                dispo: dispoHoy,
                diag: diagHoy
            });
        }
    }

    console.log(`   ✅ Flota extraída: ${units.length} unidades canónicas.`);
    console.log(`   ✅ Asignaciones activas de hoy: ${asignacionesHoy.length} unidades emparejadas con chofer.`);

    return {
        tabName,
        units,
        asignacionesHoy,
        choferesEnMovimientos
    };
}

module.exports = { extractMovimientosFlota };
