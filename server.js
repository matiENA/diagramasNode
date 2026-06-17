const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors()); // Permite peticiones desde cualquier frontend
app.use(express.json());

// La URL de tu Google Apps Script actual
const GAS_URL = "https://script.google.com/macros/s/AKfycbzqk-ag2kmaEsGrScmN4s8SPjpwwEybyuF7Fy_vad8fiGuF_rbDsU5Iw_bZO3WvKrY/exec";

// Memoria RAM del servidor (Caché)
let cacheDatosGlobales = {
    diagramas: null,
    tds: null,
    ultimaActualizacion: null
};

// 1. EL WORKER DE NODE (El único que hace Polling a Google)
async function actualizarCacheDesdeGoogle() {
    try {
        console.log("Sincronizando con Google Sheets...");
        
        // Hacemos las dos peticiones a Google al mismo tiempo
        const [resDiag, resTDs] = await Promise.all([
            fetch(`${GAS_URL}?action=obtenerDiagramasCacheados`).then(r => r.json()),
            fetch(`${GAS_URL}?action=obtenerTDs`).then(r => r.json())
        ]);

        // Guardamos en la memoria RAM de Node.js
        cacheDatosGlobales.diagramas = resDiag;
        cacheDatosGlobales.tds = resTDs;
        cacheDatosGlobales.ultimaActualizacion = new Date().toISOString();
        
        console.log("Caché actualizado con éxito.");
    } catch (error) {
        console.error("Error leyendo de Google:", error);
    }
}

// Ejecutar por primera vez al iniciar el servidor
actualizarCacheDesdeGoogle();

// Configurar el Polling del Servidor (ej. cada 45 segundos)
setInterval(actualizarCacheDesdeGoogle, 45000);


// 2. EL ENDPOINT PARA EL FRONTEND (Responde en milisegundos)
app.get('/api/datos', (req, res) => {
    if (!cacheDatosGlobales.diagramas) {
        return res.status(503).json({ error: "El servidor aún está cargando la base de datos." });
    }
    
    // Le entrega al front la memoria RAM al instante
    res.json({
        success: true,
        diagramas: cacheDatosGlobales.diagramas,
        tds: cacheDatosGlobales.tds,
        timestamp: cacheDatosGlobales.ultimaActualizacion
    });
});

// 3. PASARELA PARA GUARDAR DATOS (Frontend -> Node -> Google)
// Así proteges la URL de Google y evitas problemas de CORS en el Front
app.post('/api/guardar', async (req, res) => {
    try {
        const respuestaGoogle = await fetch(GAS_URL, {
            method: 'POST',
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: JSON.stringify(req.body)
        }).then(r => r.json());

        // Forzamos una actualización inmediata del caché en Node tras un guardado
        actualizarCacheDesdeGoogle();

        res.json(respuestaGoogle);
    } catch (error) {
        res.status(500).json({ success: false, error: "Fallo en la comunicación con la DB" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor Node.js Híbrido corriendo en puerto ${PORT}`);
});
