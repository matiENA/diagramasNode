const { JWT } = require('google-auth-library');
const { GoogleSpreadsheet } = require('google-spreadsheet');

// ==============================================================
// 🔑 AUTENTICACIÓN CON CREDENCIALES DE RUTEO
// ==============================================================
const emailRuteo = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL_RUTEO || process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const keyRuteoRaw = process.env.GOOGLE_PRIVATE_KEY_RUTEO || process.env.GOOGLE_PRIVATE_KEY;
const keyRuteo = keyRuteoRaw ? keyRuteoRaw.replace(/\\n/g, '\n') : '';

const serviceAccountAuthRuteo = new JWT({
    email: emailRuteo,
    key: keyRuteo,
    scopes: [
        'https://www.googleapis.com/auth/spreadsheets',
        'https://www.googleapis.com/auth/drive.readonly'
    ],
});

// IDs de Carpetas de Google Drive proporcionadas
const FOLDERS_RUTEO = [
    '1VYE5WMlhkaC9Xkh-6idxlNaK-N3XbrO5', // MES ACTUAL
    '1qpXukDfaovrVltV74NL9WpBzr1Ig916z', // ROOT 1
    '1t60I3EeTDZKmLTnWxH-pn7u5XnJuYpW_'  // ROOT 2
];

/**
 * Petición HTTP autenticada liviana para la API de Google Drive
 */
async function driveRequest(url) {
    try {
        const tokenResponse = await serviceAccountAuthRuteo.getAccessToken();
        const res = await fetch(url, {
            headers: { Authorization: `Bearer ${tokenResponse.token}` }
        });
        return await res.json();
    } catch (err) {
        console.error("❌ Error en Drive Request:", err.message);
        return null;
    }
}

/**
 * Busca el archivo diario más reciente tipo Google Sheet dentro de las carpetas indicadas
 */
async function obtenerIdArchivoDiarioMasReciente() {
    for (const folderId of FOLDERS_RUTEO) {
        try {
            const query = `'${folderId}' in parents and mimeType='application/vnd.google-apps.spreadsheet' and trashed=false`;
            const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&orderBy=createdTime desc&pageSize=5&fields=files(id,name,createdTime,modifiedTime)`;
            const data = await driveRequest(url);

            if (data && data.files && data.files.length > 0) {
                console.log(`📌 Archivo diario hallado en carpeta (${folderId}): ${data.files[0].name} (${data.files[0].id})`);
                return data.files[0].id;
            }
        } catch (e) {
            console.error(`Error buscando archivo en folder ${folderId}:`, e);
        }
    }
    return null;
}

/**
 * Lee la pestaña 'DISPO' del archivo diario recuperando las columnas B, C, F y G
 */
async function leerDispoDeArchivoDiario(spreadsheetId) {
    if (!spreadsheetId) return [];
    try {
        const tokenResponse = await serviceAccountAuthRuteo.getAccessToken();
        const urlRango = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/'DISPO'!A1:Z500`;
        const res = await fetch(urlRango, {
            headers: { Authorization: `Bearer ${tokenResponse.token}` }
        });
        const json = await res.json();
        const rows = json.values || [];

        if (rows.length === 0) return [];

        const dispoData = [];
        // Ignoramos la cabecera si existe en la fila 1
        for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            const colB = String(row[1] || '').trim(); // Col B (index 1)
            const colC = String(row[2] || '').trim(); // Col C (index 2)
            const colF = String(row[5] || '').trim(); // Col F (index 5)
            const colG = String(row[6] || '').trim(); // Col G (index 6)

            if (!colB && !colC && !colF && !colG) continue;

            dispoData.push({
                id: `dispo_${i}_${Date.now()}`,
                colB: colB,
                colC: colC,
                colF: colF,
                colG: colG,
                timestamp: new Date().toISOString()
            });
        }
        return dispoData;
    } catch (e) {
        console.error("Error leyendo pestaña DISPO del archivo diario:", e);
        return [];
    }
}

/**
 * Inyecta el JSON diario resultante en la pestaña 'DISPO' del Spreadsheet Principal
 */
async function inyectarDispoEnSheetPrincipal(ID_SPREADSHEET_MASTER, dispoJsonArray) {
    try {
        const doc = new GoogleSpreadsheet(ID_SPREADSHEET_MASTER, serviceAccountAuthRuteo);
        await doc.loadInfo();
        let sheet = doc.sheetsByTitle['DISPO'];
        if (!sheet) {
            sheet = await doc.addSheet({ title: 'DISPO', headerValues: ['id', 'json_data', 'actualizado'] });
        } else {
            await sheet.clear();
            await sheet.setHeaderRow(['id', 'json_data', 'actualizado']);
        }

        const jsonStr = JSON.stringify(dispoJsonArray);
        await sheet.addRow([
            `dispo_daily_${Date.now()}`,
            jsonStr,
            new Date().toISOString()
        ]);
        console.log("✅ JSON de DISPO inyectado exitosamente en el Sheet Principal ('DISPO').");
    } catch (e) {
        console.error("Error inyectando DISPO en Sheet Principal:", e);
    }
}

/**
 * Proceso integral de sincronización de la pestaña DISPO
 */
async function sincronizarDispoDiario(ID_SPREADSHEET_MASTER, cacheDatosGlobales, io) {
    try {
        console.log("⏳ [RUTEO] Buscando y procesando archivo diario de DISPO...");
        const fileId = await obtenerIdArchivoDiarioMasReciente();
        if (!fileId) {
            console.log("⚠️ No se encontró ningún archivo diario en las carpetas de Ruteo.");
            return;
        }

        const dispoData = await leerDispoDeArchivoDiario(fileId);
        if (dispoData.length > 0) {
            cacheDatosGlobales.dispo = dispoData;

            // Inyectar en el Sheet Principal
            await inyectarDispoEnSheetPrincipal(ID_SPREADSHEET_MASTER, dispoData);

            // Notificar a los clientes vía WebSocket
            if (io) {
                io.emit('dispo_actualizada', dispoData);
            }
        }
    } catch (error) {
        console.error("❌ Error en sincronización de DISPO:", error);
    }
}

/**
 * Inicia el polling para refrescar DISPO cada cierto tiempo (ej: cada 10 min)
 */
function iniciarPollingDispo(ID_SPREADSHEET_MASTER, cacheDatosGlobales, io, intervaloMs = 10 * 60 * 1000) {
    sincronizarDispoDiario(ID_SPREADSHEET_MASTER, cacheDatosGlobales, io);
    return setInterval(() => {
        sincronizarDispoDiario(ID_SPREADSHEET_MASTER, cacheDatosGlobales, io);
    }, intervaloMs);
}

module.exports = {
    serviceAccountAuthRuteo,
    sincronizarDispoDiario,
    iniciarPollingDispo
};
