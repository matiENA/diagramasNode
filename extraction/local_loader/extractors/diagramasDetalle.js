const { fetchRange, getSheetTitles, getFechaArgentina, normalizar, mesesAbrev } = require('../utils/sheets');

/**
 * Obtiene el estado base eliminando cualquier sufijo o más (ej: 'F+1' -> 'F', 'E+23' -> 'E', 'O+30' -> 'O')
 */
function getBaseState(val) {
    if (val === undefined || val === null) return '';
    const str = String(val).trim().toUpperCase();
    if (str.includes('+')) {
        return str.split('+')[0].trim();
    }
    return str;
}

/**
 * Motor Contabilizador Canónico de Días
 * Evalúa cualquier mapa de { 'YYYY-MM-DD': 'CARACTER' }
 * Regla de Oro: Todo carácter con '+' se contabiliza estrictamente como 1 en su categoría base.
 */
function contabilizarDias(diasMap) {
    let trabajados = 0;
    let francos = 0;
    let vacaciones = 0;
    let ausencias = 0;
    let inactivos = 0;
    const desglose = {
        enfermedad: 0,
        art: 0,
        indisposicion: 0,
        suspension: 0,
        ausencia: 0,
        permiso: 0,
        otros: 0
    };

    const entries = Object.entries(diasMap || {});
    for (const [, val] of entries) {
        if (!val || val === '-' || val === '0' || val === 'NULL' || val === 'UNDEFINED') {
            inactivos++;
            continue;
        }

        const base = getBaseState(val);

        // 1. Actividad / Días Trabajados (caracteres numéricos o 'O' / 'OPERATIVO')
        if ((!isNaN(base) && base !== '') || base === 'O' || base === 'OPERATIVO') {
            trabajados++;
        }
        // 2. Francos
        else if (['F', 'FSF', 'FRANCO', 'RPT'].includes(base)) {
            francos++;
        }
        // 3. Vacaciones
        else if (['V', 'VSF', 'VACACIONES'].includes(base)) {
            vacaciones++;
        }
        // 4. Ausencias / Licencias / Inactividad médica
        else if (['E', 'ART', 'IND', 'IIND', 'A', 'S', 'P', 'MED', 'SUSP', 'LIC'].some(k => base.includes(k))) {
            ausencias++;
            if (base === 'E' || base.startsWith('MED')) desglose.enfermedad++;
            else if (base === 'ART') desglose.art++;
            else if (base.startsWith('IND')) desglose.indisposicion++;
            else if (base === 'S' || base.startsWith('SUSP')) desglose.suspension++;
            else if (base === 'A') desglose.ausencia++;
            else if (base === 'P') desglose.permiso++;
            else desglose.otros++;
        } else {
            desglose.otros++;
        }
    }

    return {
        total_evaluados: entries.length,
        trabajados,
        francos,
        vacaciones,
        ausencias,
        inactivos,
        desglose
    };
}

/**
 * Extrae los caracteres de todos los meses de la planilla de Diagramas (1mhfXpFCF6upMlnRnZjDdBVS_wqTx5q8v0qQArNCnNAU),
 * construye la ventana de 60 días para RAM, los cortes de ciclo 26-25 y el JSON listo para Supabase tabla `choferes`.
 */
async function extractDiagramasDetalle(spreadsheetId) {
    console.log(`📋 Extrayendo caracteres y contabilizadores desde Diagramas (ID: ${spreadsheetId})...`);
    const allTitles = await getSheetTitles(spreadsheetId);

    // Filtrar solo las pestañas mensuales (ej. 'Ene-26', 'Feb-26', ..., 'Dic-26')
    const monthTabs = allTitles.filter(t => {
        const low = t.toLowerCase();
        return mesesAbrev.some(m => low.includes(m.toLowerCase())) && /\d{2}/.test(t);
    });

    console.log(`   • Pestañas mensuales encontradas: ${monthTabs.length} (${monthTabs.join(', ')})`);

    const hoyAr = getFechaArgentina();
    const hoyIso = hoyAr.toISOString().split('T')[0];

    // Ventana de 60 días en RAM: 30 días atrás + hoy + 29 días adelante
    const dInicio60 = new Date(hoyAr);
    dInicio60.setDate(dInicio60.getDate() - 30);
    const dFin60 = new Date(hoyAr);
    dFin60.setDate(dFin60.getDate() + 29);

    const fInicio60Iso = dInicio60.toISOString().split('T')[0];
    const fFin60Iso = dFin60.toISOString().split('T')[0];

    const dias60List = [];
    for (let d = new Date(dInicio60); d <= dFin60; d.setDate(d.getDate() + 1)) {
        dias60List.push(d.toISOString().split('T')[0]);
    }

    // Ventana de ciclo 26-25 (del 26 del mes anterior al 25 del mes actual)
    const fCicloInicio = new Date(hoyAr.getFullYear(), hoyAr.getMonth() - 1, 26, 12, 0, 0);
    const fCicloFin = new Date(hoyAr.getFullYear(), hoyAr.getMonth(), 25, 12, 0, 0);
    const diasCicloList = [];
    for (let d = new Date(fCicloInicio); d <= fCicloFin; d.setDate(d.getDate() + 1)) {
        diasCicloList.push(d.toISOString().split('T')[0]);
    }

    const choferesMap = new Map();

    for (const tab of monthTabs) {
        const rows = await fetchRange(spreadsheetId, `'${tab}'!A1:AL350`);
        if (!rows || rows.length < 6) continue;

        const parts = tab.split('-');
        const mIdx = mesesAbrev.findIndex(m => m.toLowerCase() === parts[0].toLowerCase());
        if (mIdx === -1) continue;
        const mesNum = mIdx + 1;
        const anio = parseInt('20' + parts[1].replace(/\D/g, ''), 10);
        const mesStr = String(mesNum).padStart(2, '0');
        const maxDays = new Date(anio, mesNum, 0).getDate();

        // 1. Mapeo dinámico de columnas de días (filas 1 a 5)
        let dayColMap = {};
        for (let r = 0; r < Math.min(6, rows.length); r++) {
            if (!rows[r]) continue;
            const tempMap = {};
            let matchCount = 0;
            for (let c = 0; c < rows[r].length; c++) {
                const val = String(rows[r][c] || '').trim();
                const m = val.match(/^0*([1-9]|[12][0-9]|3[01])[\/\-](0*([1-9]|1[0-2]))$/);
                if (m && parseInt(m[2], 10) === mesNum) {
                    tempMap[parseInt(m[1], 10)] = c;
                    matchCount++;
                }
            }
            if (matchCount >= 15) {
                dayColMap = tempMap;
                break;
            }
        }

        // Fallback: Si no coincide regex, día 1 empieza en Col 4 (E)
        if (Object.keys(dayColMap).length === 0) {
            for (let d = 1; d <= maxDays; d++) dayColMap[d] = 4 + (d - 1);
        }

        // 2. Extraer choferes (Row 6+, índice 5)
        for (let i = 5; i < rows.length; i++) {
            const r = rows[i];
            if (!r || r.length < 2) continue;

            const rawLegajo = r[0] ? String(r[0]).trim() : '';
            const rawNombre = r[1] ? String(r[1]).trim() : '';

            if (!rawNombre || rawNombre.length < 3 || /^\d+$/.test(rawNombre)) continue;
            if (['APELLIDO Y NOMBRE', 'PERSONAL ACTIVO', 'LEGAJO'].includes(rawNombre.toUpperCase())) continue;

            const norm = normalizar(rawNombre);
            if (!choferesMap.has(norm)) {
                choferesMap.set(norm, {
                    nombre: rawNombre.toUpperCase(),
                    legajo: rawLegajo || null,
                    norm,
                    c_servicio: r[2] ? String(r[2]).trim().toUpperCase() : 'S/A',
                    diagrama_tipo: r[3] ? String(r[3]).trim().toUpperCase() : null,
                    diasIso: {},
                    meses: {}
                });
            }

            const ch = choferesMap.get(norm);
            if (!ch.legajo && rawLegajo) ch.legajo = rawLegajo;
            if (ch.c_servicio === 'S/A' && r[2]) ch.c_servicio = String(r[2]).trim().toUpperCase();
            if (!ch.diagrama_tipo && r[3]) ch.diagrama_tipo = String(r[3]).trim().toUpperCase();

            // Guardar caracteres del mes
            const diasMesMap = {};
            const tiraArr = [];

            for (let dia = 1; dia <= maxDays; dia++) {
                const col = dayColMap[dia];
                const rawVal = (col !== undefined && col < r.length && r[col]) ? String(r[col]).trim().toUpperCase() : '-';
                const isoDate = `${anio}-${mesStr}-${String(dia).padStart(2, '0')}`;
                ch.diasIso[isoDate] = rawVal;
                diasMesMap[isoDate] = rawVal;
                tiraArr.push(rawVal);
            }

            ch.meses[tab] = {
                tira: tiraArr.join(','),
                dias: diasMesMap,
                contabilizador: contabilizarDias(diasMesMap)
            };
        }
    }

    console.log(`   ✅ Choferes únicos consolidados desde Diagramas: ${choferesMap.size}`);

    // 3. Ensamblar los objetos finales con los 60 días en RAM y el JSON para Supabase
    const choferesDetalleList = [];
    const diagramas60DiasChoferes = [];

    for (const [norm, ch] of choferesMap.entries()) {
        // A. Caracteres y Contabilizador de los 60 días exactos
        const caracteres60Dias = {};
        for (const iso of dias60List) {
            caracteres60Dias[iso] = ch.diasIso[iso] || '-';
        }
        const contabilizador60Dias = contabilizarDias(caracteres60Dias);

        // B. Contabilizador del ciclo de corte 26-25
        const caracteresCiclo = {};
        for (const iso of diasCicloList) {
            caracteresCiclo[iso] = ch.diasIso[iso] || '-';
        }
        const contabilizadorCiclo = contabilizarDias(caracteresCiclo);

        // C. Estructura JSON para la tabla `choferes` en Supabase
        const diagramaJson = {
            rango_60_dias: {
                desde: fInicio60Iso,
                hasta: fFin60Iso,
                total_dias: 60,
                fecha_referencia: hoyIso
            },
            caracteres_60_dias: caracteres60Dias,
            contabilizador_60_dias: contabilizador60Dias,
            ciclo_26_25: {
                desde: diasCicloList[0],
                hasta: diasCicloList[diasCicloList.length - 1],
                total_dias: diasCicloList.length,
                contabilizador: contabilizadorCiclo
            },
            meses: ch.meses
        };

        const item = {
            norm,
            nombre: ch.nombre,
            legajo: ch.legajo,
            c_servicio: ch.c_servicio,
            diagrama_tipo: ch.diagrama_tipo,
            diagrama_json: diagramaJson,
            contabilizador: contabilizador60Dias,
            // Datos directos de los 60 días para RAM
            dias_60: caracteres60Dias
        };

        choferesDetalleList.push(item);

        diagramas60DiasChoferes.push({
            norm,
            nombre: ch.nombre,
            legajo: ch.legajo,
            c_servicio: ch.c_servicio,
            diagrama_tipo: ch.diagrama_tipo,
            caracteres: caracteres60Dias,
            contabilizador: contabilizador60Dias,
            ciclo_26_25: {
                rango: `${diasCicloList[0]} -> ${diasCicloList[diasCicloList.length - 1]}`,
                contabilizador: contabilizadorCiclo
            }
        });
    }

    const diagramas60DiasRAM = {
        desde: fInicio60Iso,
        hasta: fFin60Iso,
        totalDias: 60,
        fechaActual: hoyIso,
        totalChoferes: diagramas60DiasChoferes.length,
        choferes: diagramas60DiasChoferes
    };

    return {
        choferesDetalleList,
        diagramas60DiasRAM,
        monthTabs
    };
}

module.exports = {
    extractDiagramasDetalle,
    contabilizarDias,
    getBaseState
};
