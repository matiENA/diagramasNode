const express = require('express');
const path = require('path');
const cors = require('cors');
// 👉 NUEVO: Importamos HTTP y Socket.io
const http = require('http'); 
const { Server } = require('socket.io');

const app = express();
// 👉 NUEVO: Creamos el servidor HTTP envolviendo a Express
const server = http.createServer(app); 
// 👉 NUEVO: Inicializamos los Sockets
const io = new Server(server, {
    cors: { origin: "*" }
});

app.use(cors());
app.use(express.json({ type: ['application/json', 'text/plain'] }));
app.use(express.static(path.join(__dirname, 'public')));

const GAS_URL = "https://script.google.com/macros/s/AKfycbzqk-ag2kmaEsGrScmN4s8SPjpwwEybyuF7Fy_vad8fiGuF_rbDsU5Iw_bZO3WvKrY/exec";

let cacheDatosGlobales = { diagramas: null, tds: null, nombresMesActual: [], ultimaActualizacion: null };

// 2. EL WORKER DE NODE (El único que hace Polling a Google)
async function actualizarCacheDesdeGoogle() {
    try {
        console.log("Sincronizando con Google Sheets...");
        
        const [resDiag, resTDs, resNombresMes, resViajesDirecto] = await Promise.all([
            fetch(`${GAS_URL}?action=obtenerDiagramasCacheados`).then(r => r.json()),
            fetch(`${GAS_URL}?action=obtenerTDs`).then(r => r.json()),
            fetch(`${GAS_URL}?action=obtenerNombresMesActual`).then(r => r.json()).catch(() => []),
            // Si falla la lectura directa, capturamos el error para verlo en consola
            fetch(`${GAS_URL}?action=obtenerViajesYHRDirecto`).then(r => r.json()).catch(e => {
                console.error("❌ Fallo la lectura directa en Google. ¿Hiciste un New Deployment?");
                return null;
            })
        ]);

        if (resDiag) {
            if (resViajesDirecto) {
                console.log(`✅ Lectura Directa HR exitosa: ${Object.keys(resViajesDirecto).length} choferes encontrados.`);
                resDiag.nuevaSeccionViajes = resViajesDirecto; // Sobrescribe con la data real
            } else {
                console.log("⚠️ Usando objeto vacío para forzar la eliminación de la Fila 12.");
                resDiag.nuevaSeccionViajes = {}; // MATAMOS EL FANTASMA DE LA FILA 12
            }
        }

        cacheDatosGlobales.diagramas = resDiag;
        cacheDatosGlobales.tds = resTDs;
        cacheDatosGlobales.nombresMesActual = resNombresMes || [];
        cacheDatosGlobales.ultimaActualizacion = new Date().toISOString();
        
        console.log("Caché actualizado con éxito.");
        
        // Le avisamos a todos los navegadores conectados que hay data nueva
        io.emit('datos_actualizados', cacheDatosGlobales);

    } catch (error) {
        console.error("Error crítico leyendo de Google:", error);
    }
}

// Arranca el ciclo del backend por primera vez
actualizarCacheDesdeGoogle();
// Dejamos un Polling de respaldo muy largo (ej. cada 5 minutos) por si falla la red
setInterval(actualizarCacheDesdeGoogle, 300000); 

// ==========================================
// 👉 NUEVO: WEBHOOK DESDE GOOGLE SHEETS
// ==========================================
app.post('/api/webhook/google', async (req, res) => {
    console.log("🔔 Alerta recibida desde Google Sheets. Actualizando sistema...");
    res.json({ received: true }); // Le respondemos rápido a Google para no hacerlo esperar
    
    // Disparamos la actualización (esto emitirá el socket cuando termine)
    await actualizarCacheDesdeGoogle();
});


// Rutas normales de la API
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

        // Si guardamos algo desde el Front, actualizamos (esto también disparará el socket a los DEMÁS usuarios)
        if (req.body && req.body.action !== 'login') {
            actualizarCacheDesdeGoogle();
        }
        res.json(respuestaGoogle);
    } catch (error) {
        res.status(500).json({ success: false, error: "Fallo en la DB" });
    }
});

app.get('/api/maestro-choferes', (req, res) => {
    // ... (Tu código exacto del extractor se mantiene intacto aquí) ...
});

app.get('*', (req, res) => {
    if (req.path === '/extractor') res.sendFile(path.join(__dirname, 'public', 'extractor.html'));
    else res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 👉 NUEVO: Escuchamos con 'server' en lugar de 'app' para que funcionen los sockets
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor Híbrido + WebSockets corriendo en puerto ${PORT}`);
});
