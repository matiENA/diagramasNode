const express = require('express');
const path = require('path');
const cors = require('cors');
const http = require('http'); 
const { Server } = require('socket.io');

// 👉 NUEVO: Librerías para conexión directa a Sheets
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

const app = express();
const server = http.createServer(app); 
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json({ type: ['application/json', 'text/plain'] }));
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// 1. CONFIGURACIÓN DE CONEXIONES
// ==========================================
const GAS_URL = "https://script.google.com/macros/s/AKfycbzqk-ag2kmaEsGrScmN4s8SPjpwwEybyuF7Fy_vad8fiGuF_rbDsU5Iw_bZO3WvKrY/exec";

// Autenticación Directa de Google (Variables configuradas en Render)
const serviceAccountAuth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    // Este replace es VITAL para que los \n de la llave privada funcionen en Render
    key: process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') : '',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

// Reemplaza esto por el ID real de tu planilla (lo sacas de la URL de Sheets)
const ID_PLANILLA = process.env.SPREADSHEET_ID || 'T1eQ9Y5diL5fwxYTxvseNgZJFbX-lSUQ13axbp3cLiqPc'; 
const doc = new GoogleSpreadsheet(ID_PLANILLA, serviceAccountAuth);

let cacheDatosGlobales = { diagramas: null, tds: null, nombresMesActual: [], ultimaActualizacion: null };

// ==========================================
// 👉 FUNCIÓN MIGRADA 1: Obtener TDs Directo
// ==========================================
async function obtenerTDsDirecto() {
    try {
        await doc.loadInfo(); 
        const sheetTDs = doc.sheetsByTitle['TD']; // Asegúrate de que la pestaña se llama exactamente 'TD'
        if (!sheetTDs) throw new Error("No se encontró la pestaña 'TD'");

        const filas = await sheetTDs.getRows();
        let tdsMapeados = {};
        
        filas.forEach(fila => {
            // ATENCIÓN: 'Nombre' y 'TD' deben ser exactamente los textos de la Fila 1 (Encabezados)
            let nombreChofer = fila.get('Nombre') || fila.get('Chofer'); 
            let codigoTD = fila.get('TD') || fila.get('Código');
            
            if (nombreChofer && codigoTD) {
                tdsMapeados[nombreChofer] = codigoTD;
            }
        });
        
        console.log(`✅ Lectura Directa TDs exitosa: ${Object.keys(tdsMapeados).length} TDs cargados.`);
        return tdsMapeados;
    } catch (err) {
        console.error("❌ Error leyendo TDs directamente de Sheets:", err.message);
        return null;
    }
}

// ==========================================
// 2. EL WORKER DE NODE (Sincronización Híbrida)
// ==========================================
// 2. EL WORKER DE NODE (Sincronización Híbrida - Fase 0)
async function actualizarCacheDesdeGoogle() {
    try {
        console.log("Sincronizando DB...");
        
        // Helper blindado
        const fetchSeguro = async (url, nombre) => {
            try {
                const r = await fetch(url);
                const text = await r.text();
                if (text.trim().startsWith('<')) {
                    console.error(`❌ Alerta en [${nombre}]: GAS devolvió HTML. (Requiere New Deployment)`);
                    return null;
                }
                return JSON.parse(text);
            } catch (err) {
                console.error(`❌ Error parseando JSON en [${nombre}]:`, err.message);
                return null;
            }
        };

        // 👉 DEVOLVEMOS LOS TDs A GOOGLE MIENTRAS LOGRAMOS LA ESTABILIDAD 
        const [resDiag, resNombresMes, resViajesDirecto, resTDs] = await Promise.all([
            fetchSeguro(`${GAS_URL}?action=obtenerDiagramasCacheados`, 'Diagramas'),
            fetchSeguro(`${GAS_URL}?action=obtenerNombresMesActual`, 'Mes Actual'),
            fetchSeguro(`${GAS_URL}?action=obtenerViajesYHRDirecto`, 'Lectura HR'),
            fetchSeguro(`${GAS_URL}?action=obtenerTDs`, 'TDs Legacy')
        ]);

        if (resDiag) {
            if (resViajesDirecto) {
                console.log(`✅ Lectura Directa HR exitosa: ${Object.keys(resViajesDirecto).length} choferes.`);
                resDiag.nuevaSeccionViajes = resViajesDirecto; 
            } else {
                resDiag.nuevaSeccionViajes = {}; 
            }
            cacheDatosGlobales.diagramas = resDiag;
        }

        // 👉 BLINDAJE ANTI-CRASH: Si Google falla, enviamos el esqueleto vacío en lugar de null
        cacheDatosGlobales.tds = resTDs || { campo: {}, infinia: {}, liviano: {}, euro: {}, estados: {}, codigosExtra: {} };
        cacheDatosGlobales.nombresMesActual = resNombresMes || [];
        cacheDatosGlobales.ultimaActualizacion = new Date().toISOString();
        
        console.log("Caché global actualizado con éxito.");
        io.emit('datos_actualizados', cacheDatosGlobales);

    } catch (error) {
        console.error("Error crítico general:", error);
    }
}

// Arranca el ciclo del backend por primera vez
actualizarCacheDesdeGoogle();

// Polling General cada 45 segundos (Reemplaza a los Webhooks por ahora)
const TIEMPO_POLLING = 45000; 
setInterval(() => {
    console.log("🔄 [POLLING] Ejecutando sincronización automática...");
    actualizarCacheDesdeGoogle();
}, TIEMPO_POLLING); 

// ==========================================
// 3. RUTAS DE LA API
// ==========================================
app.get('/api/datos', (req, res) => {
    if (!cacheDatosGlobales.diagramas) return res.status(503).json({ error: "Cargando DB..." });
    res.json({ success: true, diagramas: cacheDatosGlobales.diagramas, tds: cacheDatosGlobales.tds, timestamp: cacheDatosGlobales.ultimaActualizacion });
});

app.post('/api/proxy', async (req, res) => {
    try {
        const respuestaGoogle = await fetch(GAS_URL, {
            method: 'POST',
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: JSON.stringify(req.body)
        }).then(r => r.json());

        if (req.body && req.body.action !== 'login') {
            actualizarCacheDesdeGoogle();
        }
        res.json(respuestaGoogle);
    } catch (error) {
        res.status(500).json({ success: false, error: "Fallo en la DB" });
    }
});

app.get('/api/maestro-choferes', (req, res) => {
    if (!cacheDatosGlobales.diagramas || !cacheDatosGlobales.diagramas.diagramas) {
        return res.status(503).send("La base de datos aún se está cargando. Recarga en unos segundos.");
    }
    const html = `
    <!DOCTYPE html><html><head><meta charset="UTF-8"><title>Maestro</title></head><body>
    <pre id="json-output">${JSON.stringify(cacheDatosGlobales.diagramas.diagramas, null, 2)}</pre>
    </body></html>`;
    res.send(html);
});

app.get('*', (req, res) => {
    if (req.path === '/extractor') res.sendFile(path.join(__dirname, 'public', 'extractor.html'));
    else res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor Híbrido corriendo en puerto ${PORT}`);
});