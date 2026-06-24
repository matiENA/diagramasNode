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

const serviceAccountAuth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') : '',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

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
// 🛡️ SISTEMA DE COLAS Y WORKERS
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

let ejecutandoKM = false;
let pendienteKM = false;

async function flujoEncoladoKM() {
    if (ejecutandoKM) { pendienteKM = true; return; }
    ejecutandoKM = true;
    try {
        await sincronizarViajesASupabase(2);
        await actualizarCacheDesdeGoogle();
    } finally {
        ejecutandoKM = false;
        if (pendienteKM) { pendienteKM = false; flujoEncoladoKM(); }
    }
}

setTimeout(() => {
    sincronizarTractoresContinuo();
    flujoEncoladoGlobal(); 
}, 5000); 

setInterval(() => {
    sincronizarTractoresContinuo();
}, 5 * 60 * 1000); 

// ==========================================
// 🧠 2. EL CEREBRO: ENSAMBLADOR A PRUEBA DE BALAS
// ==========================================
async function actualizarCacheDesdeGoogle() {
    try {
        console.log("🔄 Reconstruyendo Memoria RAM (SQL + Google)...");
        
        const [resDiagGAS, resNombresMes, resTDs] = await Promise.all([
            fetchSeguro(`${GAS_URL}?action=obtenerDiagramasCacheados`),
            fetchSeguro(`${GAS_URL}?action=obtenerNombresMesActual`),
            fetchSeguro(`${GAS_URL}?action=obtenerTDs`)
        ]);

        const { data: choferes, error: errChoferes } = await supabase.from('choferes')
            .select('*, units(n_ute, tractor, semi)');
            
        if (errChoferes) console.error("⚠️ Error SQL leyendo choferes:", errChoferes.message);
        
        const normalizar = (n) => String(n || '').trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, ' ');
        const mapaNombresId = {};
        
        let docsMap = (resDiagGAS && resDiagGAS.documentos) ? { ...resDiagGAS.documentos } : {};
        let habsMap = (resDiagGAS && resDiagGAS.habilitaciones) ? { ...resDiagGAS.habilitaciones } : {};
        let certsMap = (resDiagGAS && resDiagGAS.certificados) ? { ...resDiagGAS.certificados } : {};
        let dnisMap = (resDiagGAS && resDiagGAS.dnis) ? { ...resDiagGAS.dnis } : {};
        let telefonosMap = (resDiagGAS && resDiagGAS.telefonos) ? { ...resDiagGAS.telefonos } : {};

        let visualesLegacyMap = {};
        let diasLegacyMap = {}; 
        
        if (resDiagGAS && resDiagGAS.diagramas) {
            resDiagGAS.diagramas.forEach(d => {
                let nombreNorm = normalizar(d.nom);
                visualesLegacyMap[nombreNorm] = { td: d.td, hex_1: d.hex_1, hex_2: d.hex_2, hex1: d.hex1, hex2: d.hex2 };
                diasLegacyMap[nombreNorm] = d.dias || {}; 
            });
        }

        if (choferes) {
            choferes.forEach(c => { 
                const nombreReal = String(c.nombre || '').trim();
                const nomNorm = normalizar(nombreReal);
                mapaNombresId[c.id] = nomNorm; 
                
                if (c.dni) dnisMap[nomNorm] = { dni: c.dni };
                
                let datosContacto = telefonosMap[nomNorm] || {};
                if (c.telefono) datosContacto.telefono = c.telefono;
                if (c.legajo) datosContacto.legajo = c.legajo;
                if (c.email) datosContacto.email = c.email;
                
                telefonosMap[nomNorm] = datosContacto;
                if (c.dni) telefonosMap[c.dni] = datosContacto;
            });
        }

        const fechaLimite = new Date();
        fechaLimite.setDate(fechaLimite.getDate() - 365); 
        const fechaLimiteStr = fechaLimite.toISOString().split('T')[0];

        // --- LECTURA A: VIAJES (KMs) ---
        let registrosViajesSQL = [];
        let masViajes = true;
        let pagV = 0;
        while (masViajes) {
            const { data: chunk } = await supabase.from('registros_viajes_km').select('*').gte('fecha', fechaLimiteStr).range(pagV * 1000, (pagV + 1) * 1000 - 1);
            if (chunk && chunk.length > 0) { registrosViajesSQL.push(...chunk); pagV++; if (chunk.length < 1000) masViajes = false; } 
            else { masViajes = false; }
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
                    campo: Number(row.campo || 0), infiniaD: Number(row.infinia_d || 0), hoja_ruta: row.hoja_ruta || []
                };
            });
        }

        // --- LECTURA B: DIAGRAMAS DIARIOS ---
        let diagramasSQL = [];
        let masDiag = true;
        let pagD = 0;
        while (masDiag) {
            const { data: chunkD, error: errDiag } = await supabase.from('diagramas_diarios').select('*').gte('fecha', fechaLimiteStr).range(pagD * 1000, (pagD + 1) * 1000 - 1);
            if (errDiag) console.error("⚠️ Error SQL Diagramas:", errDiag.message);
            if (chunkD && chunkD.length > 0) { diagramasSQL.push(...chunkD); pagD++; if (chunkD.length < 1000) masDiag = false; } 
            else { masDiag = false; }
        }

        const dictDiasSQL = {};
        if (diagramasSQL.length > 0) {
            diagramasSQL.forEach(row => {
                const choferNorm = mapaNombresId[row.chofer_id];
                if (!choferNorm) return;
                if (!dictDiasSQL[choferNorm]) dictDiasSQL[choferNorm] = {};
                const fechaLimpia = String(row.fecha).split('T')[0];
                dictDiasSQL[choferNorm][fechaLimpia] = row.estado;
            });
        }

        // 👉 LECTURA C: DOCUMENTOS DESDE SQL
        const { data: documentosSQL, error: errDocs } = await supabase.from('documentos_choferes').select('*');
        if (documentosSQL) {
            documentosSQL.forEach(doc => {
                const choferNorm = mapaNombresId[doc.chofer_id];
                if (choferNorm) {
                    if (doc.venc_periodico) docsMap[choferNorm] = { ven: String(doc.venc_periodico).split('T')[0], estado: 'OK' };
                    if (doc.venc_licencia) habsMap[choferNorm] = { ven: String(doc.venc_licencia).split('T')[0], estado: 'OK' };
                    if (doc.venc_cert_mp) certsMap[choferNorm] = { ven: String(doc.venc_cert_mp).split('T')[0], estado: 'OK' };
                }
            });
        }

        // --- ENSAMBLADO FINAL ---
        let diagramasHibridos = [];
        let choferesProcesados = new Set(); 

        if (choferes) {
            choferes.forEach(chofer => {
                const nombreReal = String(chofer.nombre || '').trim();
                const nomNorm = normalizar(nombreReal);
                
                if (!nombreReal || choferesProcesados.has(nomNorm)) return;
                choferesProcesados.add(nomNorm);

                let unTractor = '', unSemi = '', unUte = '';
                if (chofer.units) {
                    let u = Array.isArray(chofer.units) ? chofer.units[0] : chofer.units;
                    if (u) { unTractor = u.tractor || ''; unSemi = u.semi || ''; unUte = u.n_ute || ''; }
                }

                let vL = visualesLegacyMap[nomNorm] || {};
                let diasCombinados = { ...(diasLegacyMap[nomNorm] || {}), ...(dictDiasSQL[nomNorm] || {}) };

                diagramasHibridos.push({
                    _safeId: "drv_" + nomNorm.replace(/[^a-z0-9]/g, "_"), 
                    nom: nombreReal, 
                    tractor: unTractor, 
                    semi: unSemi, 
                    srv: chofer.c_servicio || '', 
                    n_ute: unUte, 
                    td: vL.td || '-', 
                    hex1: vL.hex1 || "", hex2: vL.hex2 || "", hex_1: vL.hex_1 || "#ffffff", hex_2: vL.hex_2 || "#ffffff", 
                    dias: diasCombinados 
                });
            });
        }

        let resDiag = { 
            diagramas: diagramasHibridos, nuevaSeccionViajes,
            documentos: docsMap, habilitaciones: habsMap, certificados: certsMap,
            dnis: dnisMap, telefonos: telefonosMap
        };

        if (resDiagGAS && resDiagGAS.observaciones) resDiag.observaciones = resDiagGAS.observaciones;
        if (resDiagGAS && resDiagGAS.aptosMedicos) resDiag.aptosMedicos = resDiagGAS.aptosMedicos;
        if (resDiagGAS && resDiagGAS.vencimientosObj) resDiag.vencimientosObj = resDiagGAS.vencimientosObj;
        if (resDiagGAS && resDiagGAS.fotosImgur) resDiag.fotosImgur = resDiagGAS.fotosImgur;

        cacheDatosGlobales.diagramas = resDiag;
        cacheDatosGlobales.tds = resTDs || cacheDatosGlobales.tds || {};
        cacheDatosGlobales.nombresMesActual = resNombresMes || [];
        cacheDatosGlobales.ultimaActualizacion = new Date().toISOString();
        
        io.emit('datos_actualizados', cacheDatosGlobales);
        console.log(`✅ RAM lista y Sockets emitidos.`);
    } catch (error) { console.error("❌ Error en ensamblador:", error); }
}

// ==========================================
// 🔔 3. RECEPTORES DE WEBHOOKS
// ==========================================
app.post('/api/webhook/google', async (req, res) => {
    res.json({ success: true, message: "Recibido" }); 
    const evento = req.body.evento || 'TODO';
    
    if (evento === 'KM') flujoEncoladoKM();
    else if (evento === 'TD') {
        const nuevosTDs = await fetchSeguro(`${GAS_URL}?action=obtenerTDs`);
        cacheDatosGlobales.tds = nuevosTDs || cacheDatosGlobales.tds;
        cacheDatosGlobales.ultimaActualizacion = new Date().toISOString();
        io.emit('datos_actualizados', cacheDatosGlobales);
    } else flujoEncoladoGlobal(); 
});

// ==========================================
// 🌟 4. RUTAS API Y PROXY (MUTACIÓN INTELIGENTE EN RAM)
// ==========================================
app.get('/api/datos', (req, res) => {
    if (!cacheDatosGlobales.diagramas) return res.status(503).json({ error: "Cargando DB..." });
    res.json({ success: true, diagramas: cacheDatosGlobales.diagramas, tds: cacheDatosGlobales.tds, timestamp: cacheDatosGlobales.ultimaActualizacion });
});

app.post('/api/proxy', async (req, res) => {
    try {
        const body = req.body;
        let huboCambios = false;
        const normalizar = (n) => String(n || '').trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, ' ');

        // A. DOCUMENTOS (Guarda en SQL + Muta la RAM)
        if (body && body.action === 'guardarDocumentos') {
            const { data: choferData } = await supabase.from('choferes').select('id').ilike('nombre', body.nombre).single();
            if (choferData) {
                await supabase.from('documentos_choferes').upsert({ chofer_id: choferData.id, venc_periodico: body.exVen, venc_licencia: body.licVen, venc_cert_mp: body.certVen }, { onConflict: 'chofer_id' });
                
                let choferNorm = normalizar(body.nombre);
                if (!cacheDatosGlobales.diagramas.documentos) cacheDatosGlobales.diagramas.documentos = {};
                if (!cacheDatosGlobales.diagramas.habilitaciones) cacheDatosGlobales.diagramas.habilitaciones = {};
                if (!cacheDatosGlobales.diagramas.certificados) cacheDatosGlobales.diagramas.certificados = {};
                
                if (body.exVen) cacheDatosGlobales.diagramas.documentos[choferNorm] = { ven: body.exVen, estado: 'OK' };
                if (body.licVen) cacheDatosGlobales.diagramas.habilitaciones[choferNorm] = { ven: body.licVen, estado: 'OK' };
                if (body.certVen) cacheDatosGlobales.diagramas.certificados[choferNorm] = { ven: body.certVen, estado: 'OK' };
                
                huboCambios = true;
            }
        }

        // B. VIAJES Y KMs (Guarda en SQL + Muta la RAM)
        if (body && (body.action === 'guardarHojasRuta' || body.action === 'guardarViaje' || body.action === 'actualizarViaje' || body.hoja_ruta !== undefined || body.km !== undefined)) {
            const nomChofer = body.nombre || body.nom || body.chofer;
            const fechaViaje = body.fecha || body.isoDate;

            if (nomChofer && fechaViaje) {
                const { data: choferData } = await supabase.from('choferes').select('id').ilike('nombre', nomChofer).single();
                if (choferData) {
                    const { data: viajeExistente } = await supabase.from('registros_viajes_km').select('*').eq('chofer_id', choferData.id).eq('fecha', fechaViaje).single();
                    await supabase.from('registros_viajes_km').upsert({
                        chofer_id: choferData.id, fecha: fechaViaje,
                        dominio: body.dominio !== undefined ? body.dominio : (viajeExistente?.dominio || null),
                        km: body.km !== undefined ? body.km : (viajeExistente?.km || 0),
                        liviano: body.liviano !== undefined ? body.liviano : (viajeExistente?.liviano || 0),
                        euro: body.euro !== undefined ? body.euro : (viajeExistente?.euro || 0),
                        campo: body.campo !== undefined ? body.campo : (viajeExistente?.campo || 0),
                        infinia_d: body.infinia_d !== undefined ? body.infinia_d : (viajeExistente?.infinia_d || 0),
                        hoja_ruta: body.hoja_ruta !== undefined ? body.hoja_ruta : (viajeExistente?.hoja_ruta || []),
                        actualizado_en: new Date()
                    }, { onConflict: 'chofer_id,fecha' });

                    let choferNorm = normalizar(nomChofer);
                    if (!cacheDatosGlobales.diagramas.nuevaSeccionViajes) cacheDatosGlobales.diagramas.nuevaSeccionViajes = {};
                    if (!cacheDatosGlobales.diagramas.nuevaSeccionViajes[choferNorm]) cacheDatosGlobales.diagramas.nuevaSeccionViajes[choferNorm] = {};
                    
                    let vEx = cacheDatosGlobales.diagramas.nuevaSeccionViajes[choferNorm][fechaViaje] || {};
                    cacheDatosGlobales.diagramas.nuevaSeccionViajes[choferNorm][fechaViaje] = {
                        dominio: body.dominio !== undefined ? body.dominio : (vEx.dominio || ''),
                        km: body.km !== undefined ? Number(body.km) : (vEx.km || 0),
                        liviano: body.liviano !== undefined ? Number(body.liviano) : (vEx.liviano || 0),
                        euro: body.euro !== undefined ? Number(body.euro) : (vEx.euro || 0),
                        campo: body.campo !== undefined ? Number(body.campo) : (vEx.campo || 0),
                        infiniaD: body.infinia_d !== undefined ? Number(body.infinia_d) : (vEx.infiniaD || 0),
                        hoja_ruta: body.hoja_ruta !== undefined ? body.hoja_ruta : (vEx.hoja_ruta || [])
                    };
                    huboCambios = true;
                }
            }
        }

        // C. DIAGRAMAS (Guarda en SQL + Muta la RAM)
        if (body && body.action === 'actualizarEstado') {
            const nomChofer = body.nombre; const startIso = body.startIso; const endIso = body.endIso; const estPayload = body.est;

            if (nomChofer && startIso && endIso) {
                const { data: choferData } = await supabase.from('choferes').select('id').ilike('nombre', nomChofer).single();
                
                if (choferData) {
                    let dStart = new Date(startIso + "T12:00:00"); let dEnd = new Date(endIso + "T12:00:00");
                    let current = new Date(dStart); let dayIndex = 0; let arrayParaUpsert = [];

                    let choferNorm = normalizar(nomChofer);
                    let idxChoferRAM = cacheDatosGlobales.diagramas.diagramas ? cacheDatosGlobales.diagramas.diagramas.findIndex(d => normalizar(d.nom) === choferNorm) : -1;

                    while (current <= dEnd) {
                        let fechaDia = current.toISOString().split('T')[0];
                        let estadoDia = Array.isArray(estPayload) ? (estPayload[dayIndex] || '') : estPayload;

                        if (estadoDia === 'BORRAR' || estadoDia === '' || estadoDia === null || estadoDia === '-') {
                            await supabase.from('diagramas_diarios').delete().match({ chofer_id: choferData.id, fecha: fechaDia });
                            if (idxChoferRAM !== -1 && cacheDatosGlobales.diagramas.diagramas[idxChoferRAM].dias) {
                                delete cacheDatosGlobales.diagramas.diagramas[idxChoferRAM].dias[fechaDia];
                            }
                        } else {
                            arrayParaUpsert.push({ chofer_id: choferData.id, fecha: fechaDia, estado: String(estadoDia).toUpperCase().trim(), actualizado_en: new Date() });
                            if (idxChoferRAM !== -1) {
                                if (!cacheDatosGlobales.diagramas.diagramas[idxChoferRAM].dias) cacheDatosGlobales.diagramas.diagramas[idxChoferRAM].dias = {};
                                cacheDatosGlobales.diagramas.diagramas[idxChoferRAM].dias[fechaDia] = String(estadoDia).toUpperCase().trim();
                            }
                        }
                        current.setDate(current.getDate() + 1); dayIndex++;
                    }
                    if (arrayParaUpsert.length > 0) await supabase.from('diagramas_diarios').upsert(arrayParaUpsert, { onConflict: 'chofer_id,fecha' });
                    huboCambios = true;
                }
            }
        }

        const REPLICAR_EN_GOOGLE = false; 
        let respuestaFrontend = { success: true, message: "Guardado rápido en SQL" };

        if (REPLICAR_EN_GOOGLE) {
            try { respuestaFrontend = await fetch(GAS_URL, { method: 'POST', body: JSON.stringify(body) }).then(r => r.json()); } 
            catch (err) { console.error("⚠️ Fallo en la réplica:", err.message); }
        }

        // 🚀 CERO EGRESS DE SUPABASE: Solo emitimos la RAM mutada
        if (body && body.action !== 'login' && huboCambios) {
            cacheDatosGlobales.ultimaActualizacion = new Date().toISOString();
            io.emit('datos_actualizados', cacheDatosGlobales); 
        }

        res.json(respuestaFrontend);

    } catch (error) { console.error(error); res.status(500).json({ success: false, error: "Fallo general en Proxy" }); }
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Servidor Central SQL Activo en puerto ${PORT}`));