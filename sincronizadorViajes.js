const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

const serviceAccountAuth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') : '',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const ID_PLANILLA = process.env.SPREADSHEET_ID || '1eQ9Y5diL5fwxYTxvseNgZJFbX-lSUQ13axbp3cLiqPc';
const doc = new GoogleSpreadsheet(ID_PLANILLA, serviceAccountAuth);

const normalizar = (n) => String(n || '').trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, ' ');

async function sincronizarViajesASupabase() {
    try {
        console.log("⏳ [Worker Viajes] Leyendo cachés de Google Sheets...");
        await doc.loadInfo();
        
        // 1. Obtener Choferes de Supabase para mapear nombres a UUIDs
        const { data: choferesDB, error: errC } = await supabase.from('choferes').select('id, nombre');
        if (errC) throw errC;
        
        const mapaChoferes = {};
        choferesDB.forEach(c => {
            mapaChoferes[normalizar(c.nombre)] = c.id;
        });

        // 2. Leer Hoja de Ruta Detallada (Fila 12 de API_CACHE_BASICO)
        const cacheSheet = doc.sheetsByTitle['API_CACHE_BASICO'];
        let viajesDetalleObj = {};
        if (cacheSheet) {
            await cacheSheet.loadCells('A12:Z12');
            let maxCol = cacheSheet.getLastColumn() || 1;
            let fila12Raw = [];
            for (let c = 0; c < maxCol; c++) {
                let val = cacheSheet.getCell(11, c).value;
                if (val) fila12Raw.push(String(val).replace(/^'/, ""));
            }
            let jsonHR = fila12Raw.join("");
            if (jsonHR) {
                try { viajesDetalleObj = JSON.parse(jsonHR); } catch(e) { console.error("Error parseando fila 12"); }
            }
        }

        // 3. Leer Kilómetros (Pestaña api_km vertical)
        const kmSheet = doc.sheetsByTitle['api_km'];
        let mapaKms = {};
        if (kmSheet) {
            const filasKm = await kmSheet.getRows();
            let kmStr = filasKm.map(r => r.toObject().api_km || r.get('api_km') || '').join("");
            if (kmStr) {
                try { mapaKms = JSON.parse(kmStr.replace(/^'/, "")); } catch(e) { console.error("Error parseando api_km"); }
            }
        }

        // 4. UNIFICAR ESTRUCTURAS EN UN DICCIONARIO INTERMEDIO
        // Estructura destino: choferId -> fechaIso -> campos
        const dbRows = {};

        // A) Procesar primero los viajes detallados (Fila 12)
        for (let choferNorm in viajesDetalleObj) {
            const choferId = mapaChoferes[normalizar(choferNorm)];
            if (!choferId) continue;

            if (!dbRows[choferId]) dbRows[choferId] = {};

            for (let fechaIso in viajesDetalleObj[choferNorm]) {
                const src = viajesDetalleObj[choferNorm][fechaIso];
                dbRows[choferId][fechaIso] = {
                    chofer_id: choferId,
                    fecha: fechaIso,
                    dominio: src.dominio || null,
                    km: 0,
                    liviano: src.liviano || 0,
                    euro: src.euro || 0,
                    campo: src.campo || 0,
                    infinia_d: src.infiniaD || 0,
                    hoja_ruta: src.hoja_ruta || []
                };
            }
        }

        // B) Inyectar los Kilómetros de la pestaña api_km
        for (let choferRaw in mapaKms) {
            const choferId = mapaChoferes[normalizar(choferRaw)];
            if (!choferId) continue;

            if (!dbRows[choferId]) dbRows[choferId] = {};

            mapaKms[choferRaw].forEach(reg => {
                // Convertir "DD/MM/YY" a "20YY-MM-DD"
                let partes = reg.fechaCorta.split('/');
                if (partes.length === 3) {
                    let fechaIso = `20${partes[2]}-${partes[1].padStart(2, '0')}-${partes[0].padStart(2, '0')}`;
                    
                    if (!dbRows[choferId][fechaIso]) {
                        dbRows[choferId][fechaIso] = {
                            chofer_id: choferId,
                            fecha: fechaIso,
                            dominio: null,
                            km: 0,
                            liviano: 0, euro: 0, campo: 0, infinia_d: 0,
                            hoja_ruta: []
                        };
                    }
                    dbRows[choferId][fechaIso].km = reg.km || 0;
                }
            });
        }

        // 5. VOLCAR TODO A SUPABASE (UPSERT MASIVO)
        const rowsParaInsertar = [];
        for (let chId in dbRows) {
            for (let fIso in dbRows[chId]) {
                rowsParaInsertar.push(dbRows[chId][fIso]);
            }
        }

        if (rowsParaInsertar.length === 0) return;

        console.log(`⏳ Volcando ${rowsParaInsertar.length} registros diarios a Supabase...`);
        
        // Hacemos chunks de 200 filas para no saturar Postgres de un solo golpe
        for (let i = 0; i < rowsParaInsertar.length; i += 200) {
            const chunk = rowsParaInsertar.slice(i, i + 200);
            const { error: errUpsert } = await supabase
                .from('registros_viajes_km')
                .upsert(chunk, { onConflict: 'chofer_id,fecha' });

            if (errUpsert) console.error("❌ Error en Upsert parcial de Viajes:", errUpsert.message);
        }

        console.log("✅ [Worker Viajes] Sincronización e Inyección SQL completada.");

    } catch (error) {
        console.error("❌ Error en sincronizador de Viajes:", error.message);
    }
}

module.exports = { sincronizarViajesASupabase };