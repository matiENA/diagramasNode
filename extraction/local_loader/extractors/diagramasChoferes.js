const { fetchRange, resolveTabNameDiagramas, getFechaArgentina, normalizar } = require('../utils/sheets');

/**
 * Extrae el catálogo maestro de choferes y sus turnos desde la planilla de Diagramas.
 * SpreadSheet ID: 1mhfXpFCF6upMlnRnZjDdBVS_wqTx5q8v0qQArNCnNAU
 * 
 * Estructura de la hoja mensual (ej. 'Sep-26'):
 * - Fila 1 a 4: Metadatos (días de semana, fecha, conteo 'Personal Activo')
 * - Fila 5: Cabeceras de columnas (Col A: LEGAJO, Col B: APELLIDO Y NOMBRE, Col C: SERVICIO, Col D: DIAGRAMA, Col E+: 1-9, 2-9...)
 * - Fila 6 en adelante (Row 6+):
 *   - Col 0 (A): LEGAJO (numérico o texto, ej. '744', '759')
 *   - Col 1 (B): APELLIDO Y NOMBRE (ej. 'ACUÑA RAFAEL SANTIAGO')
 *   - Col 2 (C): SERVICIO (ej. 'METANOL', 'LIVIANO', 'CAMPO', 'GLP')
 *   - Col 3 (D): DIAGRAMA (ej. '22X6', '14X7')
 *   - Col 4 a 34 (E a AI): Códigos diarios de turno o estado ('12', 'F', 'ART', 'FSF', 'V', 'L', '-')
 */
async function extractDiagramasChoferes(spreadsheetId) {
    const tabName = await resolveTabNameDiagramas(spreadsheetId);
    console.log(`📋 Leyendo Diagramas desde [${tabName}] (ID: ${spreadsheetId})...`);

    const range = `'${tabName}'!A1:AL500`;
    const rows = await fetchRange(spreadsheetId, range);

    if (!rows || rows.length < 6) {
        console.warn(`⚠️ Pestaña '${tabName}' no contiene suficientes filas para procesar.`);
        return { tabName, choferesMap: new Map(), choferesList: [] };
    }

    const hoyAr = getFechaArgentina();
    const diaHoy = hoyAr.getDate();
    const mesHoy = hoyAr.getMonth() + 1; // 1-indexed

    // 1. Mapeo dinámico de columnas de días (Fila 1 a 5)
    let dayColMap = {};
    for (let r = 0; r < Math.min(6, rows.length); r++) {
        if (!rows[r]) continue;
        const tempMap = {};
        let matchesCount = 0;

        for (let c = 0; c < rows[r].length; c++) {
            const cellVal = String(rows[r][c] || '').trim();
            // Regex para formatos como '1-9', '01/09', '1/9'
            const m = cellVal.match(/^0*([1-9]|[12][0-9]|3[01])[\/\-](0*([1-9]|1[0-2]))$/);
            if (m) {
                const d = parseInt(m[1], 10);
                const mo = parseInt(m[2], 10);
                if (mo === mesHoy && tempMap[d] === undefined) {
                    tempMap[d] = c;
                    matchesCount++;
                }
            }
        }

        if (matchesCount >= 15) {
            dayColMap = tempMap;
            break;
        }
    }

    // Fallback si no hay regex coincidente: Día 1 comienza en Col 4 (E)
    if (Object.keys(dayColMap).length === 0) {
        for (let dia = 1; dia <= 31; dia++) {
            dayColMap[dia] = 4 + (dia - 1);
        }
    }

    const colHoy = dayColMap[diaHoy] !== undefined ? dayColMap[diaHoy] : (4 + diaHoy - 1);

    const choferesMap = new Map();
    const choferesList = [];

    // 2. Extraer Choferes a partir de la Fila 6 (índice 5)
    for (let i = 5; i < rows.length; i++) {
        const r = rows[i];
        if (!r || r.length < 2) continue;

        const rawLegajo = r[0] ? String(r[0]).trim() : null;
        const rawNombre = r[1] ? String(r[1]).trim() : '';

        // Filtro de cabeceras repetidas, filas vacías o basura
        if (!rawNombre || rawNombre.length < 3 || /^\d+$/.test(rawNombre)) continue;
        if (['APELLIDO Y NOMBRE', 'PERSONAL ACTIVO', 'LEGAJO'].includes(rawNombre.toUpperCase())) continue;

        const rawServicio = r[2] ? String(r[2]).trim().toUpperCase() : 'S/A';
        const rawDiagrama = r[3] ? String(r[3]).trim().toUpperCase() : null;
        const rawTurnoHoy = colHoy < r.length && r[colHoy] ? String(r[colHoy]).trim().toUpperCase() : '-';

        // Determinar estado de Diagrama para el día de hoy
        let estadoCalculado = 'inactivo';
        if (['F', 'FSF', 'FRANCO'].includes(rawTurnoHoy)) {
            estadoCalculado = 'franco';
        } else if (['ART', 'LIC', 'V', 'VACACIONES', 'MED', 'SUSP'].some(k => rawTurnoHoy.includes(k))) {
            estadoCalculado = 'licencia';
        } else if (rawTurnoHoy && rawTurnoHoy !== '-' && rawTurnoHoy !== '0') {
            estadoCalculado = 'circulando'; // Tiene turno asignado en el diagrama
        }

        // Tira completa de turnos del mes
        const turnosMes = {};
        for (let dia = 1; dia <= 31; dia++) {
            const col = dayColMap[dia];
            turnosMes[dia] = (col !== undefined && col < r.length && r[col]) ? String(r[col]).trim().toUpperCase() : '-';
        }

        const norm = normalizar(rawNombre);
        const choferObj = {
            fila: i + 1,
            legajo: rawLegajo || null,
            nombre: rawNombre.toUpperCase(),
            norm,
            c_servicio: rawServicio,
            diagrama_tipo: rawDiagrama,
            turno_hoy: rawTurnoHoy,
            estado: estadoCalculado,
            turnos_mes: turnosMes
        };

        choferesMap.set(norm, choferObj);
        choferesList.push(choferObj);
    }

    console.log(`   ✅ Choferes extraídos de Diagramas: ${choferesList.length} registros válidos.`);
    return { tabName, choferesMap, choferesList, colHoy, diaHoy };
}

module.exports = { extractDiagramasChoferes };
