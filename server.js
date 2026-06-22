const express = require('express');
const path = require('path');
const cors = require('cors');
const http = require('http'); 
const { Server } = require('socket.io');

// Librerías para conexión
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { createClient } = require('@supabase/supabase-js');

// 👉 Importamos los dos workers (Flota y Viajes)
const { sincronizarTractoresContinuo } = require('./sincronizadorFlota'); 
const { sincronizarViajesASupabase } = require('./sincronizadorViajes'); 

const app = express();
const server = http.createServer(app); 
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json({ type: ['application/json', 'text/plain'] }));
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// 1. CONFIGURACIÓN DE CONEXIONES 
// ==========================================
const GAS_URL = process.env.GAS_URL;

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const serviceAccountAuth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') : '',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const ID_PLANILLA = process.env.SPREADSHEET_ID; 
const doc = new GoogleSpreadsheet(ID_PLANILLA, serviceAccountAuth);

let cacheDatosGlobales = { diagramas: null, tds: null, nombresMesActual: [], ultimaActualizacion: null };

const fetchSeguro = async (url, nombre) => {
    try {
        const r = await fetch(url);
        const text = await r.text();
        if (text.trim().startsWith('<')) {
            console.error(`❌ Alerta en [${nombre}]: GAS devolvió HTML.`);
            return null;
        }
        return JSON.parse(text);
    } catch (err) {
        console.error(`❌ Error parseando JSON en [${nombre}]:`, err.message);
        return null;
    }
};

// ==========================================
// 🚀 WORKERS PERMANENTES (Cada 5 minutos)
// ==========================================
const TIEMPO_SYNC = 5 * 60 * 1000; 

// Ejecutar la primera vez al arrancar el servidor
setTimeout(() => {
    sincronizarTractoresContinuo();
    sincronizarViajesASupabase();
}, 10000); 

// Dejarlo en bucle por tiempo indeterminado
setInterval(() => {
    sincronizarTractoresContinuo();
    sincronizarViajesASupabase();
}, TIEMPO_SYNC);


// ==========================================
// 2. EL WORKER DE NODE (MERGE HÍBRIDO + SQL)
// ==========================================
async function actualizarCacheDesdeGoogle() {
    try {
        console.log("🔄 Sincronizando COMPLETO: Supabase (Flota + Viajes) + GAS (Diagramas)...");
        
        // 1. Descargamos de GAS solo lo que sigue allí (Diagramas, Mes y TDs)
        const [resDiagGAS, resNombresMes, resTDs] = await Promise.all([
            fetchSeguro(`${GAS_URL}?action=obtenerDiagramasCacheados`, 'Diagramas Legacy'),
            fetchSeguro(`${GAS_URL}?action=obtenerNombresMesActual`, 'Mes Actual'),
            fetchSeguro(`${GAS_URL}?action=obtenerTDs`, 'TDs Legacy')
        ]);

        // 2. Consultamos Supabase (Padrón de Choferes)
        const { data: choferes, error: errSupabase } = await supabase
            .from('choferes')
            .select('nombre, c_servicio, units(n_ute, tractor, semi)');

        if (errSupabase) console.error("⚠️ Error leyendo Supabase:", errSupabase.message);

        // 🌟 3. LEER LOS VIAJES DIRECTAMENTE DESDE SUPABASE SQL
        const fechaLimite = new Date();
        fechaLimite.setDate(fechaLimite.getDate() - 60); // Traemos los últimos 60 días
        const fechaLimiteStr = fechaLimite.toISOString().split('T')[0];

        const { data: registrosViajesSQL, error: errV } = await supabase
            .from('registros_viajes_km')
            .select('*, choferes(nombre)')
            .gte('fecha', fechaLimiteStr);

        let nuevaSeccionViajes = {};
        const normalizar = (n) => String(n || '').trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, ' ');

        if (!errV && registrosViajesSQL) {
            registrosViajesSQL.forEach(row => {
                if (!row.choferes) return;
                const choferNorm = normalizar(row.choferes.nombre);
                
                if (!nuevaSeccionViajes[choferNorm]) nuevaSeccionViajes[choferNorm] = {};
                
                // Armamos el objeto exacto que el Frontend ya sabe leer
                nuevaSeccionViajes[choferNorm][row.fecha] = {
                    dominio: row.dominio || '',
                    liviano: Number(row.liviano || 0),
                    euro: Number(row.euro || 0),
                    campo: Number(row.campo || 0),
                    infiniaD: Number(row.infinia_d || 0),
                    hoja_ruta: row.hoja_ruta || []
                };
            });
        }

        // 4. EL GRAN MERGE
        let diagramasHibridos = [];
        
        if (choferes) {
            const dictDiasGAS = {};
            if (resDiagGAS && resDiagGAS.diagramas) {
                resDiagGAS.diagramas.forEach(d => {
                    dictDiasGAS[d.nom.trim().toLowerCase()] = d.dias;
                });
            }

            diagramasHibridos = choferes.map(chofer => {
                const nomNorm = chofer.nombre.trim().toLowerCase();
                const calendario = dictDiasGAS[nomNorm] || {}; 

                return {
                    _safeId: "drv_" + nomNorm.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "_"),
                    nom: chofer.nombre,
                    tractor: chofer.units ? (chofer.units.tractor || '') : '',
                    semi: chofer.units ? (chofer.units.semi || '') : '',
                    srv: chofer.c_servicio || '',
                    n_ute: chofer.units ? (chofer.units.n_ute || '') : '',
                    td: '-', 
                    hex1: "", hex2: "", hex_1: "#ffffff", hex_2: "#ffffff",
                    dias: calendario 
                };
            });
        }

        // 5. Empaquetar y enviar a la memoria RAM
        let resDiag = { diagramas: diagramasHibridos };
        
        if (resDiagGAS && resDiagGAS.documentos) resDiag.documentos = resDiagGAS.documentos;
        if (resDiagGAS && resDiagGAS.habilitaciones) resDiag.habilitaciones = resDiagGAS.habilitaciones;
        if (resDiagGAS && resDiagGAS.certificados) resDiag.certificados = resDiagGAS.certificados;
        
        // 🌟 Inyectamos los viajes extraídos de SQL
        resDiag.nuevaSeccionViajes = nuevaSeccionViajes; 

        cacheDatosGlobales.diagramas = resDiag;
        cacheDatosGlobales.tds = resTDs || { campo: {}, infinia: {}, liviano: {}, euro: {}, estados: {}, codigosExtra: {} };
        cacheDatosGlobales.nombresMesActual = resNombresMes || [];
        cacheDatosGlobales.ultimaActualizacion = new Date().toISOString();
        
        console.log("✅ Caché global Híbrido actualizado con éxito.");
        io.emit('datos_actualizados', cacheDatosGlobales);

    } catch (error) {
        console.error("Error crítico general:", error);
    }
}

// Arranca el ciclo del backend
actualizarCacheDesdeGoogle();

// ==========================================
// 🔔 3. RECEPTOR DE WEBHOOKS
// ==========================================
app.post('/api/webhook/google', async (req, res) => {
    // Liberamos a Google de inmediato
    res.json({ success: true, message: "Recibido" }); 

    const evento = req.body.evento || 'TODO';
    console.log(`🔔 Webhook disparado por cambio en: ${evento}`);

    try {
        if (evento === 'KM') {
            console.log("🚚 Nuevo KM detectado. Procesando hacia Supabase SQL...");
            // Extraemos de la Planilla y lo metemos a SQL primero
            await sincronizarViajesASupabase();
            // Luego actualizamos el servidor completo (que ahora lee de SQL)
            await actualizarCacheDesdeGoogle(); 
            console.log(`✅ Socket emitido tras webhook de KM (Vía Supabase)`);
        } 
        else if (evento === 'TD') {
            const nuevosTDs = await fetchSeguro(`${GAS_URL}?action=obtenerTDs`, 'TDs');
            cacheDatosGlobales.tds = nuevosTDs || cacheDatosGlobales.tds;
            cacheDatosGlobales.ultimaActualizacion = new Date().toISOString();
            io.emit('datos_actualizados', cacheDatosGlobales);
            console.log(`✅ Socket emitido tras webhook de TD`);
        } 
        else {
            // Eventos mayores (DIAGRAMA)
            await actualizarCacheDesdeGoogle();
        }
    } catch (error) {
        console.error("❌ Error procesando el webhook:", error);
    }
});

// ==========================================
// 🐘 4. RECEPTOR DE WEBHOOKS (Desde Supabase)
// ==========================================
app.post('/api/webhook/supabase', async (req, res) => {
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${process.env.SUPABASE_WEBHOOK_SECRET || 'Mayo2026'}`) {
        return res.status(403).json({ error: "No autorizado" });
    }

    res.json({ success: true, message: "Recibido por Node" }); 

    const payload = req.body;
    console.log(`🐘 Webhook Supabase: Cambio en tabla [${payload.table}] | Acción: ${payload.type}`);

    try {
        // 👉 AÑADIDA la tabla 'registros_viajes_km'
        const tablasMonitoreadas = ['choferes', 'units', 'documentos_choferes', 'movimientos', 'estados_diarios', 'registros_viajes_km'];
        
        if (tablasMonitoreadas.includes(payload.table)) {
            console.log("🔄 Recargando datos desde Supabase...");
            await actualizarCacheDesdeGoogle();
        }

    } catch (error) {
        console.error("❌ Error procesando webhook de Supabase:", error);
    }
});


// ==========================================
// 5. RUTAS DE LA API (Endpoints del Front-End)
// ==========================================
app.get('/api/datos', (req, res) => {
    if (!cacheDatosGlobales.diagramas) return res.status(503).json({ error: "Cargando DB..." });
    res.json({ success: true, diagramas: cacheDatosGlobales.diagramas, tds: cacheDatosGlobales.tds, timestamp: cacheDatosGlobales.ultimaActualizacion });
});

// 👉 EL INTERCEPTOR
app.post('/api/proxy', async (req, res) => {
    try {
        const body = req.body;

        if (body && body.action === 'guardarDocumentos') {
            const { nombre, exVen, licVen, certVen } = body;
            
            const { data: choferData, error: errChofer } = await supabase
                .from('choferes')
                .select('id')
                .ilike('nombre', nombre)
                .single();

            if (!errChofer && choferData) {
                const choferId = choferData.id;
                await supabase
                    .from('documentos_choferes')
                    .upsert({ 
                        chofer_id: choferId, 
                        venc_periodico: exVen || null, 
                        venc_licencia: licVen || null, 
                        venc_cert_mp: certVen || null,
                        actualizado_en: new Date()
                    }, { onConflict: 'chofer_id' });
            }

            fetch(GAS_URL, {
                method: 'POST',
                headers: { "Content-Type": "text/plain;charset=utf-8" },
                body: JSON.stringify(body)
            }).catch(e => console.error("Error Sheets:", e));

            return res.json({ success: true, message: "Documentos sincronizados." });
        }

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

// Maestro Legacy 
app.get('/api/maestro-choferes', (req, res) => {
    if (!cacheDatosGlobales.diagramas || !cacheDatosGlobales.diagramas.diagramas) {
        return res.status(503).send("Cargando DB...");
    }
    const html = `<!DOCTYPE html><html><body><pre>${JSON.stringify(cacheDatosGlobales.diagramas.diagramas, null, 2)}</pre></body></html>`;
    res.send(html);
});

// SPA Fallback
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor Híbrido (Fast Webhooks) corriendo en puerto ${PORT}`));