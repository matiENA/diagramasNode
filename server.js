const express = require('express');
const path = require('path');
const cors = require('cors');

const app = express();

app.use(cors());

// 👉 LA SOLUCIÓN AL ERROR: Le decimos a Node que lea "text/plain" y lo transforme en JSON
app.use(express.json({ type: ['application/json', 'text/plain'] }));

// 1. Decimos que la carpeta 'public' tiene nuestros archivos estáticos (index.html, css, imágenes)
app.use(express.static(path.join(__dirname, 'public')));

// La URL de tu Google Apps Script
const GAS_URL = "https://script.google.com/macros/s/AKfycbzqk-ag2kmaEsGrScmN4s8SPjpwwEybyuF7Fy_vad8fiGuF_rbDsU5Iw_bZO3WvKrY/exec";

// 1. Modificar la RAM para aceptar la nueva lista
let cacheDatosGlobales = {
    diagramas: null,
    tds: null,
    nombresMesActual: [], // 👉 NUEVA MEMORIA
    ultimaActualizacion: null
};

// 2. Actualizar el Worker
async function actualizarCacheDesdeGoogle() {
    try {
        console.log("Sincronizando con Google Sheets...");
        
        // 👉 AHORA HACEMOS 3 PETICIONES EN PARALELO
        const [resDiag, resTDs, resNombresMes] = await Promise.all([
            fetch(`${GAS_URL}?action=obtenerDiagramasCacheados`).then(r => r.json()),
            fetch(`${GAS_URL}?action=obtenerTDs`).then(r => r.json()),
            fetch(`${GAS_URL}?action=obtenerNombresMesActual`).then(r => r.json()).catch(() => []) // Silenciamos errores si falla
        ]);

        cacheDatosGlobales.diagramas = resDiag;
        cacheDatosGlobales.tds = resTDs;
        cacheDatosGlobales.nombresMesActual = resNombresMes || []; // Guardamos la lista
        cacheDatosGlobales.ultimaActualizacion = new Date().toISOString();
        
        console.log("Caché actualizado con éxito.");
    } catch (error) {
        console.error("Error leyendo de Google:", error);
    }
}

// 3. Reemplazar el endpoint del módulo extractor
app.get('/api/maestro-choferes', (req, res) => {
    if (!cacheDatosGlobales.diagramas) {
        return res.status(503).json({ success: false, error: "Caché de base de datos no disponible aún." });
    }

    try {
        const dataDiag = typeof cacheDatosGlobales.diagramas === 'string' 
            ? JSON.parse(cacheDatosGlobales.diagramas) 
            : cacheDatosGlobales.diagramas;

        const NOMBRES_IGNORADOS = new Set([
            "campo", "abast", "glp", "grales", "grales.", "liviano", 
            "metanol", "pasivo en base", "ypf", "apellido y nombre", 
            "personal activo", "chofer", "choferes", "vacante", "-", "1"
        ]);

        let mapaMaestro = new Map();

        // Extraer de Diagramas
        if (dataDiag.diagramas && Array.isArray(dataDiag.diagramas)) {
            dataDiag.diagramas.forEach(c => {
                if (!c.nom) return;
                let nomNorm = String(c.nom).trim();
                let key = nomNorm.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, ' ');
                if (nomNorm.length > 2 && !NOMBRES_IGNORADOS.has(key)) mapaMaestro.set(key, { nom: nomNorm, dni: "Sin DNI" });
            });
        }

        // Cruzar DNIs
        if (dataDiag.dnis && typeof dataDiag.dnis === 'object') {
            Object.keys(dataDiag.dnis).forEach(key => {
                let rDni = dataDiag.dnis[key];
                let dniVal = rDni ? (rDni.dni || (typeof rDni === 'string' ? rDni : "Sin DNI")) : "Sin DNI";
                if (mapaMaestro.has(key)) {
                    if (dniVal !== "Sin DNI") mapaMaestro.get(key).dni = String(dniVal).trim();
                } else if (!NOMBRES_IGNORADOS.has(key) && key.length > 2) {
                    mapaMaestro.set(key, { nom: key.toUpperCase(), dni: String(dniVal).trim() });
                }
            });
        }

        // Cruzar Teléfonos
        if (dataDiag.telefonos && typeof dataDiag.telefonos === 'object') {
            Object.keys(dataDiag.telefonos).forEach(key => {
                let oTel = dataDiag.telefonos[key];
                if (oTel && oTel.dni && mapaMaestro.has(key)) {
                    if (mapaMaestro.get(key).dni === "Sin DNI") mapaMaestro.get(key).dni = String(oTel.dni).trim();
                }
            });
        }

        const listaConsolidada = Array.from(mapaMaestro.values())
            .filter(c => c.nom && c.dni)
            .sort((a, b) => a.nom.localeCompare(b.nom));

        // 👉 ENVIAMOS AMBAS LISTAS AL FRONTEND
        res.json({
            success: true,
            total: listaConsolidada.length,
            choferes: listaConsolidada,
            nombresPlanillaMes: cacheDatosGlobales.nombresMesActual
        });

    } catch (error) {
        res.status(500).json({ success: false, error: "Error interno procesando identidades." });
    }
});
// Arranca el ciclo del backend
actualizarCacheDesdeGoogle();
setInterval(actualizarCacheDesdeGoogle, 45000);

// ==========================================
// 3. RUTAS DE LA API (Deben ir ANTES del '*')
// ==========================================

// Endpoint para que lea el FrontEnd al instante
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

// 👉 EL PROXY UNIVERSAL: Recibe Todo (Login, Guardar HR, Estados) y se lo pasa a Google
app.post('/api/proxy', async (req, res) => {
    try {
        const respuestaGoogle = await fetch(GAS_URL, {
            method: 'POST',
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: JSON.stringify(req.body)
        }).then(r => r.json());

        // Actualizamos la RAM solo si se modificó algo (no en un login)
        if (req.body && req.body.action !== 'login') {
            actualizarCacheDesdeGoogle();
        }

        res.json(respuestaGoogle);
    } catch (error) {
        console.error("Error en Proxy:", error);
        res.status(500).json({ success: false, error: "Fallo en la comunicación con la DB" });
    }
});


// ====================================================================
// 👉 NUEVO: MÓDULO INDEPENDIENTE DE RECOPILACIÓN (EXTRACTOR)
// Consolida identidades cruzando Diagramas, DNI, Teléfonos y Aptos
// ====================================================================
app.get('/api/maestro-choferes', (req, res) => {
    if (!cacheDatosGlobales.diagramas) {
        return res.status(503).json({ success: false, error: "Caché de base de datos no disponible aún." });
    }

    try {
        const dataDiag = typeof cacheDatosGlobales.diagramas === 'string' 
            ? JSON.parse(cacheDatosGlobales.diagramas) 
            : cacheDatosGlobales.diagramas;

        // Conjunto de nombres prohibidos (Filtro estricto)
        const NOMBRES_IGNORADOS = new Set([
            "campo", "abast", "glp", "grales", "grales.", "liviano", 
            "metanol", "pasivo en base", "ypf", "apellido y nombre", 
            "personal activo", "chofer", "choferes", "vacante", "-", "1"
        ]);

        let mapaMaestro = new Map();

        // FUENTE 1: Lista de Diagramas Principales
        if (dataDiag.diagramas && Array.isArray(dataDiag.diagramas)) {
            dataDiag.diagramas.forEach(c => {
                if (!c.nom) return;
                let nomNormalizado = String(c.nom).trim();
                let key = nomNormalizado.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, ' ');
                
                if (nomNormalizado.length > 2 && !NOMBRES_IGNORADOS.has(key)) {
                    mapaMaestro.set(key, { nom: nomNormalizado, dni: "Sin DNI" });
                }
            });
        }

        // FUENTE 2: Mapeo de DNI (Cruzar y enriquecer)
        if (dataDiag.dnis && typeof dataDiag.dnis === 'object') {
            Object.keys(dataDiag.dnis).forEach(key => {
                let registroDni = dataDiag.dnis[key];
                let dniValor = "Sin DNI";
                if (registroDni) {
                    dniValor = registroDni.dni || (typeof registroDni === 'string' ? registroDni : "Sin DNI");
                }

                if (mapaMaestro.has(key)) {
                    let item = mapaMaestro.get(key);
                    if (dniValor !== "Sin DNI") item.dni = String(dniValor).trim();
                } else if (!NOMBRES_IGNORADOS.has(key) && key.length > 2) {
                    // Si el chofer solo existía en el excel de DNIs, lo agregamos de respaldo
                    let nombreEstetico = key.toUpperCase(); 
                    mapaMaestro.set(key, { nom: nombreEstetico, dni: String(dniValor).trim() });
                }
            });
        }

        // FUENTE 3: Mapeo de Teléfonos/Legajos secundarios
        if (dataDiag.telefonos && typeof dataDiag.telefonos === 'object') {
            Object.keys(dataDiag.telefonos).forEach(key => {
                let objTel = dataDiag.telefonos[key];
                if (objTel && objTel.dni) {
                    if (mapaMaestro.has(key)) {
                        let item = mapaMaestro.get(key);
                        if (item.dni === "Sin DNI") item.dni = String(objTel.dni).trim();
                    }
                }
            });
        }

        // Convertimos el mapa en una lista limpia y ordenada alfabéticamente
        const listaConsolidada = Array.from(mapaMaestro.values())
            .filter(c => c.nom && c.dni)
            .sort((a, b) => a.nom.localeCompare(b.nom));

        res.json({
            success: true,
            total: listaConsolidada.length,
            choferes: listaConsolidada,
            nombresPlanillaMes: cacheDatosGlobales.nombresMesActual 
        });

    } catch (error) {
        console.error("Error consolidando maestro de choferes:", error);
        res.status(500).json({ success: false, error: "Error interno procesando identidades." });
    }
});


// ==========================================
// 4. EL COMODÍN FRONTEND (Debe ir al FINAL)
// ==========================================

// Si alguien entra a cualquier otra ruta de tu dominio, le mandas el index.html
app.get('*', (req, res) => {
    // 👉 NUEVO: Verificamos si pidió el extractor, caso contrario le damos el index normal
    if (req.path === '/extractor') {
        res.sendFile(path.join(__dirname, 'public', 'extractor.html'));
    } else {
        res.sendFile(path.join(__dirname, 'public', 'index.html'));
    }
});

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor Node.js Híbrido corriendo en puerto ${PORT}`);
});
