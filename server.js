const express = require('express');
const path = require('path');
const cors = require('cors');

const app = express();

app.use(cors());
app.use(express.json());

// 1. Decimos que la carpeta 'public' tiene nuestros archivos estáticos (index.html, css, imágenes)
app.use(express.static(path.join(__dirname, 'public')));

// La URL de tu Google Apps Script
const GAS_URL = "https://script.google.com/macros/s/AKfycbzqk-ag2kmaEsGrScmN4s8SPjpwwEybyuF7Fy_vad8fiGuF_rbDsU5Iw_bZO3WvKrY/exec";

// Memoria RAM del servidor (Caché)
let cacheDatosGlobales = {
    diagramas: null,
    tds: null,
    ultimaActualizacion: null
};

// 2. EL WORKER DE NODE (El único que hace Polling a Google)
async function actualizarCacheDesdeGoogle() {
    try {
        console.log("Sincronizando con Google Sheets...");
        
        const [resDiag, resTDs] = await Promise.all([
            fetch(`${GAS_URL}?action=obtenerDiagramasCacheados`).then(r => r.json()),
            fetch(`${GAS_URL}?action=obtenerTDs`).then(r => r.json())
        ]);

        cacheDatosGlobales.diagramas = resDiag;
        cacheDatosGlobales.tds = resTDs;
        cacheDatosGlobales.ultimaActualizacion = new Date().toISOString();
        
        console.log("Caché actualizado con éxito.");
    } catch (error) {
        console.error("Error leyendo de Google:", error);
    }
}

// Arranca el ciclo del backend
actualizarCacheDesdeGoogle();
setInterval(actualizarCacheDesdeGoogle, 45000);


// ==========================================
// 3. RUTAS DE LA API (Deben ir ANTES del '*')
// ==========================================

// Endpoint para que lea el FrontEnd
app.get('/api/datos', (req, res) => {
    if (!cacheDatosGlobales.diagramas) {
        return res.status(503).json({ error: "El servidor aún está cargando la base de datos." });
    }
    
    res.json({
        success: true,
        diagramas: cacheDatosGlobales.diagramas,
        tds: cacheDatosGlobales.tds,
        timestamp: cacheDatosGlobales.ultimaActualizacion
    });
});

// 3. PASARELA UNIVERSAL (Frontend -> Node -> Google)
// Intercepta logins, guardado de Hojas de Ruta, Estados, Docs, etc.
app.post('/api/proxy', async (req, res) => {
    try {
        const respuestaGoogle = await fetch(GAS_URL, {
            method: 'POST',
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: JSON.stringify(req.body)
        }).then(r => r.json());

        // Forzamos actualización del caché en Node SOLO si fue una acción de guardar/modificar
        if (req.body && req.body.action !== 'login') {
            actualizarCacheDesdeGoogle();
        }

        res.json(respuestaGoogle);
    } catch (error) {
        console.error("Error en Proxy:", error);
        res.status(500).json({ success: false, error: "Fallo en la comunicación con la DB" });
    }
});


// ==========================================
// 4. EL COMODÍN FRONTEND (Debe ir al FINAL)
// ==========================================

// Si alguien entra a cualquier otra ruta de tu dominio, le mandas el index.html
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor Node.js Híbrido corriendo en puerto ${PORT}`);
});
