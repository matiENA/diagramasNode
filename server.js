const express = require('express');
const path = require('path');
const cors = require('cors');
const http = require('http'); 
const { Server } = require('socket.io');

const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { createClient } = require('@supabase/supabase-js');

const { sincronizarTractoresContinuo } = require('./sincronizadorFlota'); 
const { sincronizarViajesASupabase } = require('./sincronizadorViajes'); 

const app = express();
const server = http.createServer(app); 
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json({ type: ['application/json', 'text/plain'] }));
app.use(express.static(path.join(__dirname, 'public')));

// ==========================================
// 1. CONFIGURACIÓN 
// ==========================================
const GAS_URL = process.env.GAS_URL;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// =========================================================
// 📡 NUEVO: ESCUCHADOR EN TIEMPO REAL (REEMPLAZA WEBHOOKS)
// =========================================================
const tablasMonitoreadas = ['choferes', 'units', 'documentos_choferes', 'movimientos', 'estados_diarios'];

tablasMonitoreadas.forEach(tabla => {
    supabase.channel(`escuchar-${tabla}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: tabla }, payload => {
            console.log(`🔔 [Realtime] Cambio detectado en tabla: ${tabla}`);
            flujoEncoladoGlobal(); // Dispara la actualización de RAM igual que antes
        })
        .subscribe((status) => {
            if (status === 'SUBSCRIBED') {
                console.log(`📡 Render suscrito exitosamente a la tabla: ${tabla}`);
            }
        });
});
// =========================================================

const serviceAccountAuth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') : '',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const ID_PLANILLA = process.env.SPREADSHEET_ID; 

let cacheDatosGlobales = { diagramas: null, tds: null, nombresMesActual: [], ultimaActualizacion: null };

const fetchSeguro = async (url) => {
    try {
        const r = await fetch(url);
        const text = await r.text();
        if (text.trim().startsWith('<')) return null;
        return JSON.parse(text);
    } catch (err) { return null; }
};

// ==========================================
// 🛡️ SISTEMA DE COLAS (CANDADOS)
// ==========================================
let ejecutandoGlobal = false;
let pendienteGlobal = false;

async function flujoEncoladoGlobal() {
    if (ejecutandoGlobal) { pendienteGlobal = true; return; }
    ejecutandoGlobal = true;
    try { await actualizarCacheDesdeGoogle(); } 
    finally {
        ejecutandoGlobal = false;
        if (pendienteGlobal) { pendienteGlobal = false; flujoEncoladoGlobal(); }
    }
}

// 👉 NUEVA COLA: Solo se activa con el Webhook de Google
let ejecutandoKM = false;
let pendienteKM = false;

async function flujoEncoladoKM() {
    if (ejecutandoKM) { pendienteKM = true; return; }
    ejecutandoKM = true;
    try {
        // Le pasamos '2' para que solo lea 48hs hacia atrás de la planilla de Google
        await sincronizarViajesASupabase(2);
        // Luego recarga la RAM desde Supabase para el Frontend
        await actualizarCacheDesdeGoogle();
        console.log(`✅ Front-End actualizado con la edición desde Excel.`);
    } finally {
        ejecutandoKM = false;
        if (pendienteKM) { pendienteKM = false; flujoEncoladoKM(); }
    }
}

// ==========================================
// 🚀 WORKERS PERMANENTES 
// ==========================================
setTimeout(() => {
    sincronizarTractoresContinuo();
    flujoEncoladoGlobal(); 
}, 5000); 

setInterval(() => {
    sincronizarTractoresContinuo();
}, 5 * 60 * 1000); // ❌ El worker de viajes masivos YA NO está aquí. Todo funciona por Realtime/Eventos.

// ==========================================
// 2. EL WORKER DE NODE (Lectura Híbrida)
// ==========================================
async function actualizarCacheDesdeGoogle() {
    try {
        console.log("🔄 Sincronizando Memoria RAM (Supabase + Google)...");
        
        const [resDiagGAS, resNombresMes, resTDs] = await Promise.all([
            fetchSeguro(`${GAS_URL}?action=obtenerDiagramasCacheados`),
            fetchSeguro(`${GAS_URL}?action=obtenerNombresMesActual`),
            fetchSeguro(`${GAS_URL}?action=obtenerTDs`)
        ]);

        const { data: choferes } = await supabase.from('choferes').select('id, nombre, c_servicio, units(n_ute, tractor, semi)');
        const normalizar = (n) => String(n || '').trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, ' ');
        const mapaNombresId = {};
        if (choferes) choferes.forEach(c => { mapaNombresId[c.id] = normalizar(c.nombre); });

        const fechaLimite = new Date();
        fechaLimite.setDate(fechaLimite.getDate() - 365); 
        const fechaLimiteStr = fechaLimite.toISOString().split('T')[0];

        let registrosViajesSQL = [];
        let hayMasDatos = true;
        let pagina = 0;

        while (hayMasDatos) {
            const { data: chunk } = await supabase.from('registros_viajes_km').select('*')
                .gte('fecha', fechaLimiteStr).range(pagina * 1000, (pagina + 1) * 1000 - 1);
            if (chunk && chunk.length > 0) {
                registrosViajesSQL.push(...chunk);
                pagina++;
                if (chunk.length < 1000) hayMasDatos = false;
            } else { hayMasDatos = false; }
        }

        let nuevaSeccionViajes = {};
        if (registrosViajesSQL.length > 0) {
            registrosViajesSQL.forEach(row => {
                const choferNorm = mapaNombresId[row.chofer_id];
                if (!choferNorm) return; 
                if (!nuevaSeccionViajes[choferNorm]) nuevaSeccionViajes[choferNorm] = {};
                const fechaLimpia = String(row.fecha).split('T')[0];
                nuevaSeccionViajes[choferNorm][fechaLimpia] = {
                    dominio: row.dominio || '', km: Number(row.km || 0), 
                    liviano: Number(row.liviano || 0), euro: Number(row.euro || 0),
                    campo: Number(row.campo || 0), infiniaD: Number(row.infinia_d || 0), 
                    hoja_ruta: row.hoja_ruta || []
                };
            });
        }

        let diagramasHibridos = [];
        if (choferes) {
            const dictDiasGAS = {};
            if (resDiagGAS && resDiagGAS.diagramas) resDiagGAS.diagramas.forEach(d => { dictDiasGAS[d.nom.trim().toLowerCase()] = d.dias; });
            diagramasHibridos = choferes.map(chofer => {
                const nomNorm = normalizar(chofer.nombre);
                return {
                    _safeId: "drv_" + nomNorm.replace(/[^a-z0-9]/g, "_"), nom: chofer.nombre, 
                    tractor: chofer.units ? (chofer.units.tractor || '') : '', semi: chofer.units ? (chofer.units.semi || '') : '', 
                    srv: chofer.c_servicio || '', n_ute: chofer.units ? (chofer.units.n_ute || '') : '', td: '-', 
                    hex1: "", hex2: "", hex_1: "#ffffff", hex_2: "#ffffff", dias: dictDiasGAS[nomNorm] || {} 
                };
            });
        }

        let resDiag = { diagramas: diagramasHibridos, nuevaSeccionViajes };
        if (resDiagGAS && resDiagGAS.documentos) resDiag.documentos = resDiagGAS.documentos;
        if (resDiagGAS && resDiagGAS.habilitaciones) resDiag.habilitaciones = resDiagGAS.habilitaciones;
        if (resDiagGAS && resDiagGAS.certificados) resDiag.certificados = resDiagGAS.certificados;

        cacheDatosGlobales.diagramas = resDiag;
        cacheDatosGlobales.tds = resTDs || cacheDatosGlobales.tds || {};
        cacheDatosGlobales.nombresMesActual = resNombresMes || [];
        cacheDatosGlobales.ultimaActualizacion = new Date().toISOString();
        
        io.emit('datos_actualizados', cacheDatosGlobales);
    } catch (error) { console.error("Error crítico general:", error); }
}

// ==========================================
// 🔔 3. RECEPTORES DE WEBHOOKS
// ==========================================
app.post('/api/webhook/google', async (req, res) => {
    res.json({ success: true, message: "Recibido" }); 
    const evento = req.body.evento || 'TODO';
    
    if (evento === 'KM') {
        // 👉 SI ALGUIEN TOCA EL EXCEL DE KMs, DISPARA LA MICRO-SINCRONIZACIÓN
        flujoEncoladoKM();
    } else if (evento === 'TD') {
        const nuevosTDs = await fetchSeguro(`${GAS_URL}?action=obtenerTDs`);
        cacheDatosGlobales.tds = nuevosTDs || cacheDatosGlobales.tds;
        cacheDatosGlobales.ultimaActualizacion = new Date().toISOString();
        io.emit('datos_actualizados', cacheDatosGlobales);
    } else { 
        flujoEncoladoGlobal(); 
    }
});

// ==========================================
// 🌟 4. RUTAS DE LA API Y PROXY
// ==========================================
app.get('/api/datos', (req, res) => {
    if (!cacheDatosGlobales.diagramas) return res.status(503).json({ error: "Cargando DB..." });
    res.json({ success: true, diagramas: cacheDatosGlobales.diagramas, tds: cacheDatosGlobales.tds, timestamp: cacheDatosGlobales.ultimaActualizacion });
});

app.post('/api/proxy', async (req, res) => {
    try {
        const body = req.body;

        if (body && body.action === 'guardarDocumentos') {
            const { data: choferData } = await supabase.from('choferes').select('id').ilike('nombre', body.nombre).single();
            if (choferData) {
                await supabase.from('documentos_choferes').upsert({ 
                    chofer_id: choferData.id, venc_periodico: body.exVen, venc_licencia: body.licVen, venc_cert_mp: body.certVen 
                }, { onConflict: 'chofer_id' });
            }
            fetch(GAS_URL, { method: 'POST', body: JSON.stringify(body) }).catch(() => {});
            return res.json({ success: true, message: "Documentos sincronizados." });
        }

        if (body && (body.action === 'guardarHojasRuta' || body.action === 'guardarViaje' || body.action === 'actualizarViaje' || body.hoja_ruta !== undefined || body.km !== undefined)) {
            const nomChofer = body.nombre || body.nom || body.chofer;
            const fechaViaje = body.fecha || body.isoDate;

            if (nomChofer && fechaViaje) {
                const { data: choferData } = await supabase.from('choferes').select('id').ilike('nombre', nomChofer).single();
                if (choferData) {
                    const { data: viajeExistente } = await supabase.from('registros_viajes_km').select('*').eq('chofer_id', choferData.id).eq('fecha', fechaViaje).single();

                    const viajeAInsertar = {
                        chofer_id: choferData.id, fecha: fechaViaje,
                        dominio: body.dominio !== undefined ? body.dominio : (viajeExistente?.dominio || null),
                        km: body.km !== undefined ? body.km : (viajeExistente?.km || 0),
                        liviano: body.liviano !== undefined ? body.liviano : (viajeExistente?.liviano || 0),
                        euro: body.euro !== undefined ? body.euro : (viajeExistente?.euro || 0),
                        campo: body.campo !== undefined ? body.campo : (viajeExistente?.campo || 0),
                        infinia_d: body.infinia_d !== undefined ? body.infinia_d : (viajeExistente?.infinia_d || 0),
                        hoja_ruta: body.hoja_ruta !== undefined ? body.hoja_ruta : (viajeExistente?.hoja_ruta || []),
                        actualizado_en: new Date()
                    };
                    await supabase.from('registros_viajes_km').upsert(viajeAInsertar, { onConflict: 'chofer_id,fecha' });
                }
            }
        }

        const respuestaGoogle = await fetch(GAS_URL, { method: 'POST', body: JSON.stringify(body) }).then(r => r.json());
        if (body && body.action !== 'login') flujoEncoladoGlobal(); 
        res.json(respuestaGoogle);

    } catch (error) { res.status(500).json({ success: false, error: "Fallo en Proxy" }); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Servidor SQL Activo en puerto ${PORT}`));