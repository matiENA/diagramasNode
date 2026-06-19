const express = require('express');
const path = require('path');
const cors = require('cors');
const http = require('http'); 
const { Server } = require('socket.io');

// Librerías para conexión directa a Sheets y Supabase
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { createClient } = require('@supabase/supabase-js');

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

// Configuración Supabase
const supabaseUrl = process.env.SUPABASE_URL || 'https://tu-proyecto.supabase.co';
const supabaseKey = process.env.SUPABASE_KEY || 'tu-anon-key';
const supabase = createClient(supabaseUrl, supabaseKey);

// Configuración Google Sheets
const serviceAccountAuth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') : '',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const ID_PLANILLA = process.env.SPREADSHEET_ID || 'T1eQ9Y5diL5fwxYTxvseNgZJFbX-lSUQ13axbp3cLiqPc'; 
const doc = new GoogleSpreadsheet(ID_PLANILLA, serviceAccountAuth);

let cacheDatosGlobales = { diagramas: null, tds: null, nombresMesActual: [], ultimaActualizacion: null };

// ==========================================
// 2. EL WORKER DE NODE (Sincronización Híbrida - Fase 0)
// ==========================================
async function actualizarCacheDesdeGoogle() {
    try {
        console.log("Sincronizando DB...");
        
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

        const [resDiag, resNombresMes, resViajesDirecto, resTDs] = await Promise.all([
            fetchSeguro(`${GAS_URL}?action=obtenerDiagramasCacheados`, 'Diagramas'),
            fetchSeguro(`${GAS_URL}?action=obtenerNombresMesActual`, 'Mes Actual'),
            fetchSeguro(`${GAS_URL}?action=obtenerViajesYHRDirecto`, 'Lectura HR'),
            fetchSeguro(`${GAS_URL}?action=obtenerTDs`, 'TDs Legacy')
        ]);

        if (resDiag) {
            if (resViajesDirecto) {
                resDiag.nuevaSeccionViajes = resViajesDirecto; 
            } else {
                resDiag.nuevaSeccionViajes = {}; 
            }
            cacheDatosGlobales.diagramas = resDiag;
        }

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

// Polling General cada 45 segundos
const TIEMPO_POLLING = 45000; 
setInterval(() => {
    actualizarCacheDesdeGoogle();
}, TIEMPO_POLLING); 

// ==========================================
// 3. RUTAS DE LA API
// ==========================================
app.get('/api/datos', (req, res) => {
    if (!cacheDatosGlobales.diagramas) return res.status(503).json({ error: "Cargando DB..." });
    res.json({ success: true, diagramas: cacheDatosGlobales.diagramas, tds: cacheDatosGlobales.tds, timestamp: cacheDatosGlobales.ultimaActualizacion });
});

// 👉 EL INTERCEPTOR: Aquí atrapamos las peticiones antes de que vayan a GAS
app.post('/api/proxy', async (req, res) => {
    try {
        const body = req.body;

        // 🌟 MÓDULO MIGRADO: DOCUMENTOS Y VENCIMIENTOS
        if (body && body.action === 'guardarDocumentos') {
            console.log(`Interceptando guardado de documentos para: ${body.nombre}`);
            const { nombre, exVen, licVen, certVen } = body;
            
            // 1. TRADUCCIÓN: Buscar ID del chofer en Supabase
            const { data: choferData, error: errChofer } = await supabase
                .from('choferes')
                .select('id')
                .ilike('nombre', nombre) // ilike hace una búsqueda case-insensitive
                .single();

            if (errChofer || !choferData) {
                console.error(`⚠️ Chofer '${nombre}' no encontrado en Supabase. Se guardará solo en Sheets.`);
            } else {
                const choferId = choferData.id;

                // 2. ESCRITURA EN SUPABASE (Modo Relacional)
                const { error: dbError } = await supabase
                    .from('documentos_choferes')
                    .upsert({ 
                        chofer_id: choferId, 
                        venc_periodico: exVen || null, 
                        venc_licencia: licVen || null, 
                        venc_cert_mp: certVen || null,
                        actualizado_en: new Date()
                    }, { onConflict: 'chofer_id' }); // IMPORTANTE: Define el conflicto para que actualice y no duplique
                
                if (dbError) console.error("❌ Error escribiendo en Supabase:", dbError.message);
                else console.log(`✅ Supabase actualizado para ID: ${choferId}`);
            }

            // 3. MANDAR A GAS DE FONDO (Para que el Sheet se mantenga actualizado)
            fetch(GAS_URL, {
                method: 'POST',
                headers: { "Content-Type": "text/plain;charset=utf-8" },
                body: JSON.stringify(body)
            }).then(r => r.json()).catch(e => console.error("Error Sheets:", e));

            // 4. ACTUALIZAR LA RAM DE NODE.JS AL INSTANTE
            const nLimpio = String(nombre).trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, ' ');
            
            if (cacheDatosGlobales.diagramas) {
                if (!cacheDatosGlobales.diagramas.documentos) cacheDatosGlobales.diagramas.documentos = {};
                if (!cacheDatosGlobales.diagramas.habilitaciones) cacheDatosGlobales.diagramas.habilitaciones = {};
                if (!cacheDatosGlobales.diagramas.certificados) cacheDatosGlobales.diagramas.certificados = {};

                cacheDatosGlobales.diagramas.documentos[nLimpio] = { ven: exVen };
                cacheDatosGlobales.diagramas.habilitaciones[nLimpio] = { ven: licVen };
                cacheDatosGlobales.diagramas.certificados[nLimpio] = { ven: certVen };
                
                // 5. AVISAR A TODAS LAS PANTALLAS (Cero latencia para el usuario)
                io.emit('datos_actualizados', cacheDatosGlobales);
            }

            // Respondemos rápido al usuario, sin esperar a que GAS termine
            return res.json({ success: true, message: "Sincronizado correctamente." });
        }

        // =========================================================
        // FLUJO LEGACY NORMAL (Si no es 'guardarDocumentos', va a GAS normal)
        // =========================================================
        const respuestaGoogle = await fetch(GAS_URL, {
            method: 'POST',
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body: JSON.stringify(body)
        }).then(r => r.json());

        if (body && body.action !== 'login') {
            actualizarCacheDesdeGoogle();
        }
        res.json(respuestaGoogle);

    } catch (error) {
        console.error("Fallo general en Proxy:", error);
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