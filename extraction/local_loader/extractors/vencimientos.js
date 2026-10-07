const path = require('path');
const fs = require('fs');
const { fetchRange, parseFechaISO, resolveTabNameMovimientos } = require('../utils/sheets');

/**
 * Extrae vencimientos técnicos y habilitaciones de patentes.
 * SpreadSheet ID: ID_SHEET_MOVIMIENTOS
 * Delimitado estrictamente a las patentes contenidas en 'YYYY- Mov.Unidades y Choferes'.
 * 
 * @param {string} spreadsheetId 
 * @param {Set<string>|Array<string>|null} patentesPermitidas Patentes activas a extraer
 */
async function extractVencimientos(spreadsheetId, patentesPermitidas = null) {
    const vencimientosPorPatente = {};

    try {
        let setPatentesValidas = null;
        if (patentesPermitidas instanceof Set && patentesPermitidas.size > 0) {
            setPatentesValidas = patentesPermitidas;
        } else if (Array.isArray(patentesPermitidas) && patentesPermitidas.length > 0) {
            setPatentesValidas = new Set(patentesPermitidas.map(p => String(p).trim().toUpperCase().replace(/\s+/g, '')));
        }

        // Si no se proveyeron patentes, intentar cargarlas desde la caché local de flota o directamente desde Sheets
        if (!setPatentesValidas) {
            const posiblesRutasFlota = [
                path.join(__dirname, '../data/movimientos_flota.json'),
                path.join(__dirname, 'data/movimientos_flota.json'),
                path.join(__dirname, '../../data/movimientos_flota.json')
            ];

            for (const ruta of posiblesRutasFlota) {
                if (fs.existsSync(ruta)) {
                    try {
                        const raw = JSON.parse(fs.readFileSync(ruta, 'utf8'));
                        if (Array.isArray(raw.units) && raw.units.length > 0) {
                            setPatentesValidas = new Set();
                            raw.units.forEach(u => {
                                if (u.tractor) setPatentesValidas.add(String(u.tractor).trim().toUpperCase().replace(/\s+/g, ''));
                                if (u.semi) setPatentesValidas.add(String(u.semi).trim().toUpperCase().replace(/\s+/g, ''));
                            });
                            console.log(`   📋 [Vencimientos] Patentes objetivo cargadas desde caché de Movimientos (${setPatentesValidas.size} patentes activas).`);
                            break;
                        }
                    } catch (_) {}
                }
            }
        }

        // Fallback: leer directamente las columnas de tractores y semis de la planilla del mes
        if (!setPatentesValidas) {
            try {
                const tabName = await resolveTabNameMovimientos(spreadsheetId);
                console.log(`   📋 [Vencimientos] Delimitando extracción a patentes de [${tabName}]...`);
                const rowsMov = await fetchRange(spreadsheetId, `'${tabName}'!A1:F350`);
                setPatentesValidas = new Set();
                for (let i = 1; i < rowsMov.length; i++) {
                    const tr = String(rowsMov[i][4] || '').trim().toUpperCase().replace(/\s+/g, '');
                    const se = String(rowsMov[i][5] || '').trim().toUpperCase().replace(/\s+/g, '');
                    if (tr && tr !== 'TRACTOR') setPatentesValidas.add(tr);
                    if (se && se !== 'SEMI') setPatentesValidas.add(se);
                }
                console.log(`   📋 [Vencimientos] ${setPatentesValidas.size} patentes detectadas en planilla mensual.`);
            } catch (errMov) {
                console.warn('⚠️ [Vencimientos] No se pudo leer la planilla mensual de Movimientos, extrayendo sin filtro:', errMov.message);
            }
        }

        console.log("   • Leyendo catálogo técnico 'base datos Uni QM'...");
        const rowsUniQM = await fetchRange(spreadsheetId, "'base datos Uni QM'!A3:F1000");

        let totalOmitidas = 0;
        rowsUniQM.forEach(row => {
            const pat = String(row[0] || '').trim().toUpperCase().replace(/\s+/g, '');
            if (!pat || pat === 'PATENTE') return;

            // Filtrar estrictamente: solo patentes contenidas en Mov.Unidades y Choferes
            if (setPatentesValidas && setPatentesValidas.size > 0 && !setPatentesValidas.has(pat)) {
                totalOmitidas++;
                return;
            }

            vencimientosPorPatente[pat] = {
                mas: parseFechaISO(row[1]),
                vtv: parseFechaISO(row[2]),
                esp_es: String(row[3] || '').trim() || null,
                vi: String(row[4] || '').trim() || null,
                ve: String(row[5] || '').trim() || null
            };
        });

        // Enriquecer con pestaña 'Vencimientos.' complementaria (solo para patentes permitidas)
        try {
            const rowsVenc = await fetchRange(spreadsheetId, "'Vencimientos.'!A2:N1000");
            (rowsVenc || []).forEach(r => {
                const tr = String(r[1] || '').trim().toUpperCase().replace(/\s+/g, '');
                const se = String(r[2] || '').trim().toUpperCase().replace(/\s+/g, '');

                if (tr && tr !== 'TRACTOR' && (!setPatentesValidas || setPatentesValidas.has(tr))) {
                    if (!vencimientosPorPatente[tr]) vencimientosPorPatente[tr] = { mas: null, vtv: null, esp_es: null, vi: null, ve: null };
                    if (r[6]) vencimientosPorPatente[tr].mas = parseFechaISO(r[6]);
                    if (r[7]) vencimientosPorPatente[tr].vtv = parseFechaISO(r[7]);
                }
                if (se && se !== 'SEMI' && (!setPatentesValidas || setPatentesValidas.has(se))) {
                    if (!vencimientosPorPatente[se]) vencimientosPorPatente[se] = { mas: null, vtv: null, esp_es: null, vi: null, ve: null };
                    if (r[9]) vencimientosPorPatente[se].mas = parseFechaISO(r[9]);
                    if (r[10]) vencimientosPorPatente[se].vtv = parseFechaISO(r[10]);
                    if (r[11]) vencimientosPorPatente[se].esp_es = String(r[11] || '').trim() || null;
                    if (r[12]) vencimientosPorPatente[se].vi = String(r[12] || '').trim() || null;
                    if (r[13]) vencimientosPorPatente[se].ve = String(r[13] || '').trim() || null;
                }
            });
        } catch (_) {}

        console.log(`   ✅ Vencimientos indexados y delimitados a Mov.Unidades: ${Object.keys(vencimientosPorPatente).length} patentes activas (${totalOmitidas} omitidas por no estar en la flota del mes).`);
    } catch (err) {
        console.warn('⚠️ Error extrayendo vencimientos desde base datos Uni QM:', err.message);
    }

    return vencimientosPorPatente;
}

module.exports = { extractVencimientos };
