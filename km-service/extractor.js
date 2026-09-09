// ==============================================================
// 🚗 MOTOR DE EXTRACCIÓN E INDEXACIÓN — MICROSERVICIO KM
// Planilla Objetivo: 1Wr-_P4mDvldif_cAx08sp7yT8uTUrajI2HQAJF6tnGM ('KM'!A2:T)
// ==============================================================
const { JWT } = require('google-auth-library');
const { GoogleSpreadsheet } = require('google-spreadsheet');

// ID oficial de la planilla de Kilómetros
const ID_SHEET_KILOMETROS = process.env.SHEET_KM_ID || process.env.ID_SHEET_KILOMETROS || '1Wr-_P4mDvldif_cAx08sp7yT8uTUrajI2HQAJF6tnGM';

// Normalizador idéntico al sistema central para total coherencia de claves
const normalizar = (n) => {
    if (!n) return '';
    return String(n)
        .normalize('NFC')
        .replace(/__N_TILDE__/gi, 'ñ')
        .trim()
        .toLowerCase()
        .replace(/[áäàâ]/g, 'a')
        .replace(/[éëèê]/g, 'e')
        .replace(/[íïìî]/g, 'i')
        .replace(/[óöòô]/g, 'o')
        .replace(/[úüùû]/g, 'u')
        .replace(/\s+/g, ' ');
};

function getFechaArgentina() {
    const now = new Date();
    const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
    return new Date(utc - (3 * 3600000));
}

// Configuración de autenticación con Google
function getAuthInstance() {
    return new JWT({
        email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
        key: process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') : '',
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
}

const serviceAccountAuth = getAuthInstance();

// Descarga con reintentos exponenciales
async function fetchRango(spreadsheetId, rango, reintentos = 3) {
    for (let i = 0; i < reintentos; i++) {
        try {
            const res = await serviceAccountAuth.request({
                url: `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(rango)}`
            });
            return res.data.values || [];
        } catch (e) {
            if (e.response && e.response.status === 429) {
                const waitMs = (i + 1) * 2000;
                console.warn(`⚠️ [KM-Extractor] Cuota excedida (429). Reintentando en ${waitMs}ms...`);
                await new Promise(r => setTimeout(r, waitMs));
            } else {
                console.error(`❌ [KM-Extractor] Error en fetchRango (${rango}):`, e.message);
                return [];
            }
        }
    }
    return [];
}

// ==============================================================
// 🧠 ESTADO EN MEMORIA (RAM EXCLUSIVA KM)
// ==============================================================
let kmRam = {
    hotCache: {},     // Ventana activa de 12 meses { [choferNorm]: { [isoDate]: { dominio, km, campo, hoja_ruta } } }
    coldIndex: {},    // Historial completo indexado { [choferNorm]: [ { fecha, dominio, km, campo, hoja_ruta } ] }
    stats: {
        totalRows: 0,
        totalViajesHot: 0,
        choferesCount: 0,
        lastSync: null,
        durationMs: 0,
        isSyncing: false,
        memoryUsage: null
    }
};

const parseNum = (val) => parseFloat(String(val || '').replace(/,/g, '.').replace(/[^0-9.-]/g, '')) || 0;

/**
 * Extrae y procesa toda la hoja 'KM'!A2:T
 */
async function ejecutarExtraccionKM() {
    if (kmRam.stats.isSyncing) {
        console.log("⏳ [KM-Extractor] Extracción ya en curso, omitiendo ejecución superpuesta.");
        return kmRam;
    }

    kmRam.stats.isSyncing = true;
    const tInicio = Date.now();
    console.log(`🚀 [KM-Extractor] Iniciando extracción pesada de ${ID_SHEET_KILOMETROS} ('KM'!A2:T)...`);

    try {
        const rows = await fetchRango(ID_SHEET_KILOMETROS, "'KM'!A2:T");
        console.log(`📥 [KM-Extractor] ${rows.length} filas descargadas. Ensamblando partición de RAM...`);

        const hoyArKm = getFechaArgentina();
        const limite12MesesMs = hoyArKm.getTime() - (365 * 24 * 3600 * 1000);

        const nuevoHot = {};
        const nuevoCold = {};
        let contadorHot = 0;

        rows.forEach(row => {
            let fRaw = row[1], nRaw = row[2];
            if (!fRaw || !nRaw) return;

            let dObj;
            let parts = String(fRaw).split(' ')[0].split(/[\/\-]/);
            if (parts.length >= 3) {
                let aa = parts[2].length === 2 ? "20" + parts[2] : parts[2];
                dObj = new Date(aa, parseInt(parts[1], 10) - 1, parts[0]);
            } else {
                dObj = new Date(fRaw);
            }
            if (isNaN(dObj.getTime())) return;

            const isoDate = dObj.toISOString().split('T')[0];
            const choferNorm = normalizar(nRaw);
            const km = parseNum(row[16]) > 0 ? parseNum(row[16]) : parseNum(row[8]);
            const campo = parseNum(row[5]);
            const hojaStr = String(row[19] || "").trim();
            const dominio = String(row[0] || '').trim();

            if (km > 0 || campo > 0 || hojaStr !== "") {
                const itemViaje = {
                    dominio,
                    km,
                    campo,
                    hoja_ruta: hojaStr ? hojaStr.split(',').map(s => s.trim()).filter(Boolean) : []
                };

                // 1. Indexar en Cold Storage Completo
                if (!nuevoCold[choferNorm]) nuevoCold[choferNorm] = [];
                nuevoCold[choferNorm].push({ fecha: isoDate, ...itemViaje });

                // 2. Indexar en Hot Cache (últimos 12 meses)
                if (dObj.getTime() >= limite12MesesMs) {
                    if (!nuevoHot[choferNorm]) nuevoHot[choferNorm] = {};
                    if (!nuevoHot[choferNorm][isoDate]) {
                        nuevoHot[choferNorm][isoDate] = { dominio, km: 0, campo: 0, hoja_ruta: [] };
                        contadorHot++;
                    }
                    const target = nuevoHot[choferNorm][isoDate];
                    target.km += km;
                    target.campo += campo;
                    if (itemViaje.hoja_ruta.length > 0) {
                        itemViaje.hoja_ruta.forEach(h => {
                            if (!target.hoja_ruta.includes(h)) target.hoja_ruta.push(h);
                        });
                    }
                }
            }
        });

        // Enlazar alias fonéticos sin 'ñ' y sin signos de puntuación (comas, puntos) para búsquedas tolerantes
        Object.keys(nuevoHot).forEach(k => {
            const limpio = k.replace(/[,;.]/g, ' ').replace(/\s+/g, ' ').trim();
            if (limpio !== k && !nuevoHot[limpio]) {
                nuevoHot[limpio] = nuevoHot[k];
            }
            if (k.includes('ñ')) {
                const sinEnie = k.replace(/ñ/g, 'n');
                if (!nuevoHot[sinEnie]) nuevoHot[sinEnie] = nuevoHot[k];
                const limpioSinEnie = limpio.replace(/ñ/g, 'n');
                if (!nuevoHot[limpioSinEnie]) nuevoHot[limpioSinEnie] = nuevoHot[k];
            }
        });

        Object.keys(nuevoCold).forEach(k => {
            const limpio = k.replace(/[,;.]/g, ' ').replace(/\s+/g, ' ').trim();
            if (limpio !== k && !nuevoCold[limpio]) {
                nuevoCold[limpio] = nuevoCold[k];
            }
            if (k.includes('ñ')) {
                const sinEnie = k.replace(/ñ/g, 'n');
                if (!nuevoCold[sinEnie]) nuevoCold[sinEnie] = nuevoCold[k];
                const limpioSinEnie = limpio.replace(/ñ/g, 'n');
                if (!nuevoCold[limpioSinEnie]) nuevoCold[limpioSinEnie] = nuevoCold[k];
            }
        });

        const mem = process.memoryUsage();
        const durationMs = Date.now() - tInicio;

        kmRam.hotCache = nuevoHot;
        kmRam.coldIndex = nuevoCold;
        kmRam.stats = {
            totalRows: rows.length,
            totalViajesHot: contadorHot,
            choferesCount: Object.keys(nuevoHot).length,
            lastSync: new Date().toISOString(),
            durationMs,
            isSyncing: false,
            memoryUsage: {
                heapUsedMB: +(mem.heapUsed / 1024 / 1024).toFixed(2),
                heapTotalMB: +(mem.heapTotal / 1024 / 1024).toFixed(2),
                rssMB: +(mem.rss / 1024 / 1024).toFixed(2)
            }
        };

        console.log(`✅ [KM-Extractor] Partición de RAM ensamblada en ${durationMs}ms:`);
        console.log(`   - Filas procesadas: ${rows.length}`);
        console.log(`   - Choferes indexados: ${kmRam.stats.choferesCount}`);
        console.log(`   - Viajes activos (12m): ${contadorHot}`);
        console.log(`   - RAM Usada: ${kmRam.stats.memoryUsage.heapUsedMB} MB / Heap Total: ${kmRam.stats.memoryUsage.heapTotalMB} MB`);

        // Si está configurada la URL del servidor principal, enviarle ping de actualización
        notificarServidorPrincipal();

    } catch (err) {
        console.error("❌ [KM-Extractor] Error en extracción:", err);
        kmRam.stats.isSyncing = false;
    }

    return kmRam;
}

/**
 * Notifica al servidor principal (diagramasnode) que la partición de KM se actualizó
 */
async function notificarServidorPrincipal() {
    const mainBackendUrl = process.env.MAIN_BACKEND_URL;
    if (!mainBackendUrl) return;

    try {
        const pingUrl = `${mainBackendUrl.replace(/\/$/, '')}/api/webhook/km-updated`;
        console.log(`📡 [KM-Extractor] Notificando al backend principal: ${pingUrl}`);
        const res = await fetch(pingUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'km_service_synced',
                timestamp: kmRam.stats.lastSync,
                totalViajes: kmRam.stats.totalViajesHot
            })
        });
        if (res.ok) {
            console.log("✅ [KM-Extractor] Backend principal notificado con éxito.");
        } else {
            console.warn(`⚠️ [KM-Extractor] Respuesta inesperada del backend principal: ${res.status}`);
        }
    } catch (e) {
        console.warn(`⚠️ [KM-Extractor] No se pudo notificar al backend principal: ${e.message}`);
    }
}

/**
 * Consulta histórica rápida sobre la memoria indexada (O(1) por chofer)
 */
function buscarHistorialEnMemoria(chofer, desde, hasta) {
    if (!chofer) return { error: "Falta parámetro 'chofer'" };

    const nBuscado = normalizar(chofer);
    const nSinEnie = nBuscado.replace(/ñ/g, 'n');

    // 1. Verificar si está en Hot Cache y las fechas caen en la ventana
    const viajesHot = kmRam.hotCache[nBuscado] || kmRam.hotCache[nSinEnie] || null;
    const fechasHot = viajesHot ? Object.keys(viajesHot) : [];

    let necesitaCold = false;
    if (!viajesHot || fechasHot.length === 0) {
        necesitaCold = true;
    } else if (desde) {
        const minFechaHot = fechasHot.sort()[0];
        if (desde < minFechaHot) necesitaCold = true;
    }

    // Si basta con el Hot Cache
    if (!necesitaCold && viajesHot) {
        let filtrados = {};
        for (let f in viajesHot) {
            if ((!desde || f >= desde) && (!hasta || f <= hasta)) {
                filtrados[f] = viajesHot[f];
            }
        }
        return {
            success: true,
            fuente: "MICROSERVICIO_KM_HOT",
            chofer: nBuscado,
            data: filtrados
        };
    }

    // 2. Usar el índice Cold completo
    const listaCold = kmRam.coldIndex[nBuscado] || kmRam.coldIndex[nSinEnie] || [];
    let filtrados = {};

    listaCold.forEach(item => {
        if ((!desde || item.fecha >= desde) && (!hasta || item.fecha <= hasta)) {
            if (!filtrados[item.fecha]) {
                filtrados[item.fecha] = { dominio: item.dominio, km: 0, campo: 0, hoja_ruta: [] };
            }
            filtrados[item.fecha].km += item.km;
            filtrados[item.fecha].campo += item.campo;
            item.hoja_ruta.forEach(h => {
                if (!filtrados[item.fecha].hoja_ruta.includes(h)) {
                    filtrados[item.fecha].hoja_ruta.push(h);
                }
            });
        }
    });

    return {
        success: true,
        fuente: "MICROSERVICIO_KM_COLD",
        chofer: nBuscado,
        data: filtrados
    };
}

/**
 * Guarda hoja de ruta en Google Sheets y actualiza la memoria local
 */
async function guardarHojaRuta(tractor, curDateIso, endDateIso, nombreChofer, hojas, overwrite = false) {
    const nBuscado = normalizar(nombreChofer);
    const curDate = new Date(curDateIso + "T12:00:00");
    const endDate = new Date(endDateIso + "T12:00:00");
    const hojasEntrantes = Array.isArray(hojas) ? hojas : String(hojas || '').split(',').map(s => s.trim()).filter(Boolean);

    // Actualizar memoria local de inmediato
    let loopMem = new Date(curDate);
    while (loopMem <= endDate) {
        let isoStr = loopMem.toISOString().split('T')[0];
        if (!kmRam.hotCache[nBuscado]) kmRam.hotCache[nBuscado] = {};
        if (!kmRam.hotCache[nBuscado][isoStr]) {
            kmRam.hotCache[nBuscado][isoStr] = { dominio: tractor || '', km: 0, campo: 0, hoja_ruta: [] };
        }
        let target = kmRam.hotCache[nBuscado][isoStr];
        if (overwrite) {
            target.hoja_ruta = [...hojasEntrantes];
        } else {
            hojasEntrantes.forEach(h => {
                if (!target.hoja_ruta.includes(h)) target.hoja_ruta.push(h);
            });
        }
        loopMem.setDate(loopMem.getDate() + 1);
    }

    // Persistir en Google Sheets
    const rowsKM = (await serviceAccountAuth.request({
        url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SHEET_KILOMETROS}/values/'KM'!A:T`
    })).data.values || [];

    let reqs = [];
    const docKm = new GoogleSpreadsheet(ID_SHEET_KILOMETROS, serviceAccountAuth);
    let sheetLoaded = false;
    let loopDate = new Date(curDate);

    while (loopDate <= endDate) {
        let isoStr = loopDate.toISOString().split('T')[0];
        let targetStrSheet = `${String(loopDate.getDate()).padStart(2, '0')}/${String(loopDate.getMonth() + 1).padStart(2, '0')}/${String(loopDate.getFullYear()).slice(-2)}`;
        let filaIndex = -1;
        let hojasSheetExistentes = "";

        for (let i = 1; i < rowsKM.length; i++) {
            if (normalizar(rowsKM[i][2]) === nBuscado || normalizar(rowsKM[i][2]).replace(/ñ/g, 'n') === nBuscado.replace(/ñ/g, 'n')) {
                let fechaCelda = String(rowsKM[i][1] || '').trim();
                let celdaIso = "";
                let partes = fechaCelda.split(' ')[0].split(/[\/\-]/);
                if (partes.length >= 3) {
                    if (partes[0].length === 4) celdaIso = `${partes[0]}-${partes[1].padStart(2, '0')}-${partes[2].padStart(2, '0')}`;
                    else {
                        let aa = partes[2].length === 2 ? "20" + partes[2] : partes[2];
                        celdaIso = `${aa}-${partes[1].padStart(2, '0')}-${partes[0].padStart(2, '0')}`;
                    }
                }
                if (celdaIso === isoStr || fechaCelda === isoStr) {
                    filaIndex = i + 1;
                    hojasSheetExistentes = String(rowsKM[i][19] || "").trim();
                    break;
                }
            }
        }

        let finalHojasStr = "";
        if (overwrite) {
            finalHojasStr = hojasEntrantes.join(', ');
        } else {
            let arrExistentes = hojasSheetExistentes ? hojasSheetExistentes.split(',').map(s => s.trim()).filter(Boolean) : [];
            hojasEntrantes.forEach(h => {
                if (!arrExistentes.includes(h)) arrExistentes.push(h);
            });
            finalHojasStr = arrExistentes.join(', ');
        }

        if (filaIndex !== -1) {
            reqs.push(serviceAccountAuth.request({
                url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SHEET_KILOMETROS}/values/'KM'!T${filaIndex}?valueInputOption=USER_ENTERED`,
                method: 'PUT',
                data: { values: [[finalHojasStr]] }
            }));
        } else {
            if (!sheetLoaded) {
                await docKm.loadInfo();
                sheetLoaded = true;
            }
            let sheetTarget = docKm.sheetsByTitle['KM'] || docKm.sheetsByIndex[0];
            await sheetTarget.addRow([tractor || "", targetStrSheet, nombreChofer, "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", finalHojasStr]);
        }
        loopDate.setDate(loopDate.getDate() + 1);
    }

    if (reqs.length > 0) {
        await Promise.all(reqs).catch(e => console.error("Error al persistir en Sheets:", e));
    }

    // Notificar al backend principal para que sus clientes vean los cambios inmediatamente
    notificarServidorPrincipal();

    return { success: true, message: "Hojas de ruta guardadas y sincronizadas" };
}

/**
 * Inicia el cron de extracción periódica
 */
function iniciarPollingExtractor(intervaloMinutos = 15) {
    // Primera ejecución a los 2 segundos del arranque
    setTimeout(() => {
        ejecutarExtraccionKM();
    }, 2000);

    // Tarea periódica
    const intervalMs = intervaloMinutos * 60 * 1000;
    setInterval(() => {
        console.log(`⏱️ [KM-Extractor] Ejecución periódica programada (${intervaloMinutos} min)...`);
        ejecutarExtraccionKM();
    }, intervalMs);
}

module.exports = {
    normalizar,
    kmRam,
    ejecutarExtraccionKM,
    buscarHistorialEnMemoria,
    guardarHojaRuta,
    iniciarPollingExtractor,
    ID_SHEET_KILOMETROS
};
