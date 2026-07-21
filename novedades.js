const express = require('express');
const { GoogleSpreadsheet } = require('google-spreadsheet');

// ==============================================================
// 1. CARGA E INSPECCIÓN DE NOVEDADES EN RAM
// ==============================================================
async function cargarNovedades(fetchRango, ID_SPREADSHEET_MASTER, cacheDatosGlobales) {
    try {
        const rowsNov = await fetchRango(ID_SPREADSHEET_MASTER, "'novedades'!A:B");
        
        let temporalNovedades = [];
        if (rowsNov.length > 0) {
            rowsNov.forEach(row => {
                let id = row[0];
                let jsonStr = row[1];
                
                if(!id || id === 'id' || !jsonStr) return; 
                
                try {
                    let novedadParseada = JSON.parse(jsonStr);
                    temporalNovedades.push(novedadParseada);
                } catch(parseError) {
                    console.error(`Error parseando el JSON del ID ${id}:`, parseError);
                }
            });
        }

        // Verificamos si cambió el contenido con respecto a la RAM previa
        const previoStr = JSON.stringify(cacheDatosGlobales.novedades || []);
        const nuevoStr = JSON.stringify(temporalNovedades);
        const huboCambio = previoStr !== nuevoStr;

        cacheDatosGlobales.novedades = temporalNovedades;
        return huboCambio;
    } catch (e) { 
        console.error("Error leyendo Novedades:", e); 
        return false;
    }
}

// ==============================================================
// 2. POLLING PERIÓDICO DE NOVEDADES
// ==============================================================
function iniciarPollingNovedades(fetchRango, ID_SPREADSHEET_MASTER, cacheDatosGlobales, io, intervaloMs = 30000) {
    console.log(`⏱️ Polling de Novedades activado (frecuencia: ${Math.round(intervaloMs / 1000)}s)...`);
    
    return setInterval(async () => {
        try {
            const huboCambio = await cargarNovedades(fetchRango, ID_SPREADSHEET_MASTER, cacheDatosGlobales);
            if (huboCambio) {
                console.log("⚡ [Polling Novedades] Se detectaron cambios externos en DB / Google Sheets. Notificando a clientes...");
                io.emit('novedades_actualizadas', cacheDatosGlobales.novedades);
            }
        } catch (error) {
            console.error("❌ Error en Polling Novedades:", error);
        }
    }, intervaloMs);
}

// ==============================================================
// 3. ENDPOINTS DE LA API (Router)
// ==============================================================
function createNovedadesRouter(cacheDatosGlobales, io, serviceAccountAuth, ID_SPREADSHEET_MASTER, fetchRango) {
    const router = express.Router();

    // GET: Leer novedades en vivo
    router.get('/', (req, res) => {
        res.json({ success: true, data: cacheDatosGlobales.novedades || [] });
    });

    // POST: Crear o Resolver novedades
    router.post('/actualizar', async (req, res) => {
        try {
            const { action, id_novedad, payload } = req.body;
            if (!cacheDatosGlobales.novedades) cacheDatosGlobales.novedades = [];

            if (action === 'nueva') {
                const nuevaNovedad = { id: String(Date.now()), resuelto: false, ...payload, timestamp: new Date().toISOString() };
                
                // Optimistic Server RAM
                cacheDatosGlobales.novedades.unshift(nuevaNovedad);
                io.emit('novedades_actualizadas', cacheDatosGlobales.novedades);
                res.json({ success: true, data: nuevaNovedad });

                // Guardado en Sheets (como JSON)
                try {
                    const docNov = new GoogleSpreadsheet(ID_SPREADSHEET_MASTER, serviceAccountAuth);
                    await docNov.loadInfo();
                    let sheet = docNov.sheetsByTitle['novedades'];
                    
                    if (!sheet) sheet = await docNov.addSheet({ title: 'novedades', headerValues: ['id', 'json_data'] });
                    await sheet.addRow([ nuevaNovedad.id, JSON.stringify(nuevaNovedad) ]);
                } catch(e) { console.error("Error Escribiendo JSON Novedades:", e); }
            } 
            else if (action === 'resolver') {
                let index = cacheDatosGlobales.novedades.findIndex(n => String(n.id) === String(id_novedad));
                if(index > -1) {
                    cacheDatosGlobales.novedades[index].resuelto = true;
                    cacheDatosGlobales.novedades[index].fecha_resolucion = new Date().toISOString();
                    let novedadActualizada = cacheDatosGlobales.novedades[index];
                    
                    io.emit('novedades_actualizadas', cacheDatosGlobales.novedades);
                    res.json({ success: true });

                    // Re-escritura en Sheets
                    try {
                        const rowsNov = await fetchRango(ID_SPREADSHEET_MASTER, "'novedades'!A:B");
                        let rIdx = -1;
                        for (let i = 0; i < rowsNov.length; i++) { 
                            if (String(rowsNov[i][0]) === String(id_novedad)) { rIdx = i + 1; break; } 
                        }
                        
                        if (rIdx !== -1) {
                            await serviceAccountAuth.request({ 
                                url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SPREADSHEET_MASTER}/values/'novedades'!B${rIdx}?valueInputOption=USER_ENTERED`, 
                                method: 'PUT', 
                                data: { values: [[JSON.stringify(novedadActualizada)]] } 
                            });
                        }
                    } catch(e) { console.error("Error Resolviendo Novedad:", e); }
                } else { 
                    res.status(404).json({ success: false, error: "No encontrada" }); 
                }
            }
        } catch (err) { res.status(500).json({ success: false, error: "Error en servidor" }); }
    });

    return router;
}

module.exports = { cargarNovedades, iniciarPollingNovedades, createNovedadesRouter };