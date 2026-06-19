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
// 🌟 MÓDULO: GENERADOR DE JSON DESDE SUPABASE
// ==========================================
const mesesAbrev = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];

async function generarJSONParaFrontEnd() {
    try {
        console.log("⚡ Generando diagrama directo desde Supabase (Lectura de Movimientos)...");

        const { data: choferes, error: errC } = await supabase.from('choferes').select('*');
        const { data: unidades, error: errU } = await supabase.from('units').select('*');
        const { data: movimientos, error: errM } = await supabase
            .from('movimientos')
            .select('*')
            .order('fecha_inicio', { ascending: true }); // VITAL: Orden cronológico

        if (errC || errU || errM) {
            console.error("❌ Error consultando Supabase:", errC || errU || errM);
            return [];
        }

        const dictUnidades = {};
        unidades.forEach(u => dictUnidades[u.id] = u);

        const diagramasList = [];

        for (const chofer of choferes) {
            const movsChofer = movimientos.filter(m => m.id_chofer === chofer.id);
            
            let diasFormateados = {};
            let unidadActual = null;
            let contadorOperativo = 1;

            for (const mov of movsChofer) {
                if (mov.id_unidad) unidadActual = dictUnidades[mov.id_unidad];

                const fInicio = new Date(mov.fecha_inicio);
                let fFin = mov.fecha_fin ? new Date(mov.fecha_fin) : new Date(); 
                if (!mov.fecha_fin) fFin.setDate(fFin.getDate() + 30); 

                let current = new Date(fInicio);
                let estadoBase = (mov.estado_diagrama || '').toUpperCase().trim();
                
                if (estadoBase !== 'OPERATIVO' && estadoBase !== 'ABIERTO') {
                    contadorOperativo = 1;
                }

                while (current <= fFin) {
                    const mesIdx = current.getMonth();
                    const anioStr = String(current.getFullYear()).slice(2);
                    const diaIdx = current.getDate() - 1; 
                    const keyMes = `${mesesAbrev[mesIdx]}-${anioStr}`; 

                    if (!diasFormateados[keyMes]) {
                        diasFormateados[keyMes] = Array(31).fill('-');
                    }

                    let textoCelda = estadoBase;
                    if (estadoBase === 'OPERATIVO' || estadoBase === 'ABIERTO') {
                        textoCelda = String(contadorOperativo);
                        contadorOperativo++;
                    }

                    diasFormateados[keyMes][diaIdx] = textoCelda;
                    current.setDate(current.getDate() + 1);
                }
            }

            for (const key in diasFormateados) {
                diasFormateados[key] = diasFormateados[key].join(',');
            }

            diagramasList.push({
                _safeId: "drv_" + chofer.nombre.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "_"),
                nom: chofer.nombre,
                tractor: unidadActual ? unidadActual.tractor : '',
                semi: unidadActual ? unidadActual.semi : '',
                srv: chofer.c_servicio || '', 
                n_ute: unidadActual ? unidadActual.n_ute : '',
                td: '-', 
                hex1: "",
                hex2: "",
                hex_1: "#ffffff",
                hex_2: "#ffffff",
                dias: diasFormateados
            });
        }

        console.log(`✅ Diagrama generado con éxito. ${diagramasList.length} choferes procesados.`);
        return diagramasList;

    } catch (error) {
        console.error("❌ Error fatal generando JSON desde Supabase:", error);
        return [];
    }
}

// ==========================================
// 2. EL WORKER DE NODE (Sincronización Híbrida)
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

        // 👉 AQUÍ ESTÁ EL CAMBIO MAESTRO: La estructura general viene de Supabase, el resto de GAS
        const [diagramasDesdeSupabase, resNombresMes, resViajesDirecto, resTDs] = await Promise.all([
            generarJSONParaFrontEnd(), // 🐘 Lectura desde Supabase PostgreSQL
            fetchSeguro(`${GAS_URL}?action=obtenerNombresMesActual`, 'Mes Actual'),
            fetchSeguro(`${GAS_URL}?action=obtenerViajesYHRDirecto`, 'Lectura HR'),
            fetchSeguro(`${GAS_URL}?action=obtenerTDs`, 'TDs Legacy')
        ]);

        // Envolvemos el array en el objeto que el FrontEnd espera
        let resDiag = { diagramas: diagramasDesdeSupabase || [] };

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

// 👉 EL INTERCEPTOR
app.post('/api/proxy', async (req, res) => {
    try {
        const body = req.body;

        // 🌟 MÓDULO MIGRADO: DOCUMENTOS Y VENCIMIENTOS
        if (body && body.action === 'guardarDocumentos') {
            console.log(`Interceptando guardado de documentos para: ${body.nombre}`);
            const { nombre, exVen, licVen, certVen } = body;
            
            const { data: choferData, error: errChofer } = await supabase
                .from('choferes')
                .select('id')
                .ilike('nombre', nombre)
                .single();

            if (errChofer || !choferData) {
                console.error(`⚠️ Chofer '${nombre}' no encontrado en Supabase. Se guardará solo en Sheets.`);
            } else {
                const choferId = choferData.id;

                const { error: dbError } = await supabase
                    .from('documentos_choferes')
                    .upsert({ 
                        chofer_id: choferId, 
                        venc_periodico: exVen || null, 
                        venc_licencia: licVen || null, 
                        venc_cert_mp: certVen || null,
                        actualizado_en: new Date()
                    }, { onConflict: 'chofer_id' });
                
                if (dbError) console.error("❌ Error escribiendo en Supabase:", dbError.message);
                else console.log(`✅ Supabase actualizado para ID: ${choferId}`);
            }

            fetch(GAS_URL, {
                method: 'POST',
                headers: { "Content-Type": "text/plain;charset=utf-8" },
                body: JSON.stringify(body)
            }).then(r => r.json()).catch(e => console.error("Error Sheets:", e));

            const nLimpio = String(nombre).trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, ' ');
            
            if (cacheDatosGlobales.diagramas) {
                if (!cacheDatosGlobales.diagramas.documentos) cacheDatosGlobales.diagramas.documentos = {};
                if (!cacheDatosGlobales.diagramas.habilitaciones) cacheDatosGlobales.diagramas.habilitaciones = {};
                if (!cacheDatosGlobales.diagramas.certificados) cacheDatosGlobales.diagramas.certificados = {};

                cacheDatosGlobales.diagramas.documentos[nLimpio] = { ven: exVen };
                cacheDatosGlobales.diagramas.habilitaciones[nLimpio] = { ven: licVen };
                cacheDatosGlobales.diagramas.certificados[nLimpio] = { ven: certVen };
                
                io.emit('datos_actualizados', cacheDatosGlobales);
            }

            return res.json({ success: true, message: "Sincronizado correctamente." });
        }

        // =========================================================
        // FLUJO LEGACY NORMAL (Ej: guardar estados UI, hojas de ruta)
        // Todo lo demás sigue fluyendo hacia GAS sin problemas.
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