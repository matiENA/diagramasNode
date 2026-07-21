require('dotenv').config();

const express = require('express');
const compression = require('compression');
const cors = require('cors');
const http = require('http'); 
const { Server } = require('socket.io');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const webhookRouter = require('./webhook');
const { createClient } = require('@supabase/supabase-js');

// 👉 IMPORTAMOS EL MÓDULO DE NOVEDADES
const { cargarNovedades, iniciarPollingNovedades, createNovedadesRouter } = require('./novedades'); 

const app = express();
app.use(compression()); 
const server = http.createServer(app); 

// ==============================================================
// 🛡️ CONFIGURACIÓN ESTRICTA DE CORS (Seguridad Web)
// ==============================================================
const dominiosPermitidos = [
    "https://diagramas-hp1p.onrender.com", 
    "https://diagramasnode.onrender.com",
    "http://localhost:3000", 
    "https://dash-aa1f.onrender.com" 
];

const checkOrigin = function(origin, callback) {
    if (!origin) return callback(null, true);
    if (dominiosPermitidos.includes(origin) || origin.endsWith('.onrender.com') || origin.includes('localhost') || origin.includes('127.0.0.1')) {
        return callback(null, true);
    }
    return callback(null, true);
};

const corsConfig = { origin: checkOrigin, methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'], credentials: true };

const io = new Server(server, { 
    cors: corsConfig,
    transports: ['websocket', 'polling']
});

app.use(cors(corsConfig));
app.options('*', cors(corsConfig));
app.use(express.json({ limit: '10mb' }));

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const serviceAccountAuth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') : '',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const ID_SPREADSHEET_MASTER = process.env.SPREADSHEET_ID || '1eQ9Y5diL5fwxYTxvseNgZJFbX-lSUQ13axbp3cLiqPc';
const ID_SPREADSHEET_DIAGRAMAS = '1mhfXpFCF6upMlnRnZjDdBVS_wqTx5q8v0qQArNCnNAU';
const ID_SHEET_OBSERVACIONES = '1VwCNK89ecaac7IDlMWWCLHRqZoch9HB6vop5AfQEaA0';
const ID_SHEET_APTOS_MEDICOS = '1oJmN8hurfHfNnGBYUFcBdlrIj2VUzeIyq0ZTWxTpYNI';
const ID_SHEET_KILOMETROS = '1Wr-_P4mDvldif_cAx08sp7yT8uTUrajI2HQAJF6tnGM';
const ID_SHEET_HABILITACIONES = '1hPDno09tMBtKh7aIdsvzEYcyOY7leYj2B6XnniD0aXg';
const ID_SHEET_DOCUMENTOS = '1pnYXKDSv70Vq78Rchxus5FHMKdgXdbfltVsEg6vArjo';
const ID_SHEET_MOVIMIENTOS = process.env.MES_MOVIMIENTOS_ID || '1y5r-d6DFz6djGXrOiT9YnAcg6orHVcLNS7MUx1U4OhA'; 

const mesesAbrev = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
const mesesLargo = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

let cacheDatosGlobales = { diagramas: null, tds: null, nombresMesActual: [], ultimaActualizacion: null, novedades: [] };

async function fetchRango(spreadsheetId, rango, reintentos = 3) {
    for (let i = 0; i < reintentos; i++) {
        try { return (await serviceAccountAuth.request({ url: `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(rango)}` })).data.values || []; } 
        catch (e) { if (e.response && e.response.status === 429) await new Promise(resolve => setTimeout(resolve, (i + 1) * 1500)); else return []; }
    }
    return []; 
}

async function getTabName(spreadsheetId, keyword, defaultName) {
    try {
        const resMeta = await serviceAccountAuth.request({ url: `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}` });
        const found = (resMeta.data.sheets || []).find(s => s.properties.title.toLowerCase().replace(/\s+/g, '').includes(keyword.toLowerCase().replace(/\s+/g, '')));
        return found ? found.properties.title : defaultName;
    } catch(e) { return defaultName; }
}

let ejecutandoGlobal = false, pendienteGlobal = false; 
async function flujoEncoladoGlobal() {
    if (ejecutandoGlobal) { pendienteGlobal = true; return; }
    ejecutandoGlobal = true;
    try { await actualizarCacheDesdeGoogle(); } 
    finally { ejecutandoGlobal = false; if (pendienteGlobal) { pendienteGlobal = false; flujoEncoladoGlobal(); } }
}

setTimeout(() => { 
    flujoEncoladoGlobal(); 
    iniciarPollingNovedades(fetchRango, ID_SPREADSHEET_MASTER, cacheDatosGlobales, io, 30000);
}, 3000); 
setInterval(() => { console.log("⏱️ Escaneo periódico (15 min)..."); flujoEncoladoGlobal(); }, 15 * 60 * 1000); 

// ==========================================
// 🧠 EL CEREBRO: CONSTRUCCIÓN NATIVA
// ==========================================
async function actualizarCacheDesdeGoogle() {
    try {
        console.log("🚀 INICIANDO DESCARGA CRUDA: Ensamblando RAM protegida...");
        const normalizar = (n) => String(n || '').trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, ' ');

        let resDiagGAS = {
            vencimientosObj: [], fotosImgur: {}, observaciones: {}, aptosMedicos: {},
            documentos: {}, habilitaciones: {}, dnis: {}, certificados: {}, telefonos: {}, flota: {}
        };

        // 👉 DELEGAMOS LA CARGA DE NOVEDADES AL MÓDULO EXTERNO
        await cargarNovedades(fetchRango, ID_SPREADSHEET_MASTER, cacheDatosGlobales);

        let choferesRouter = {};
        try {
            const rowsDB = await fetchRango(ID_SPREADSHEET_MASTER, "'DB_CHOFERES'!A2:G1000");
            rowsDB.forEach(row => {
                let id = String(row[0] || "").trim();
                if (!id) return;
                choferesRouter[id] = { id: id, nombre: String(row[1] || "").trim(), dni: String(row[2] || "").replace(/\D/g, ''), cuil: String(row[4] || "").replace(/\D/g, ''), nombreDiagrama: String(row[5] || "").trim(), dniFallback: String(row[6] || "").replace(/\D/g, '') };
            });
            cacheDatosGlobales.choferesRouter = choferesRouter; 
        } catch (e) {}

        let listaChoferesMaestros = [];
        try {
            let hoyAr = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Argentina/Buenos_Aires"}));
            let anio = hoyAr.getFullYear(); 
            let nombreHojaActual = mesesAbrev[hoyAr.getMonth()] + "-" + String(anio).slice(-2);
            
            (await fetchRango(ID_SPREADSHEET_DIAGRAMAS, `'${nombreHojaActual}'!A6:C1000`)).forEach(row => {
                if (row[1] && !["APELLIDO Y NOMBRE", "Personal Activo"].includes(row[1])) {
                    let norm = normalizar(row[1]);
                    if (!resDiagGAS.flota[norm]) { resDiagGAS.flota[norm] = { tractor: '', semi: '', servicio: row[2] || 'S/A', n_ute: '', td: '-', hex1: '', hex2: '' }; listaChoferesMaestros.push({ nombre: String(row[1]).trim(), norm }); }
                }
            });

            let nombrePestañaMov = await getTabName(ID_SHEET_MOVIMIENTOS, "Mov.Unidades", "Mov.Unidades y Choferes");
            const rowsMov = await fetchRango(ID_SHEET_MOVIMIENTOS, `'${nombrePestañaMov}'!A1:ZZ1000`);
            
            if (rowsMov.length > 0) {
                let colFecha = -1, colNom = -1;
                for (let offset = 0; offset >= -3; offset--) {
                    let d = new Date(hoyAr); d.setDate(d.getDate() + offset);
                    let tD = d.getDate(); let tM = d.getMonth(); let tY = d.getFullYear();
                    let tD_pad = String(tD).padStart(2, '0'); let tM_pad = String(tM + 1).padStart(2, '0'); let tY_short = String(tY).slice(-2);
                    let regexFechas = [ new RegExp(`\\b0?${tD}[\\s/\\-de]+${mesesLargo[tM]}\\b`, 'i'), new RegExp(`\\b0?${tD}[\\s/\\-]+${mesesAbrev[tM]}\\b`, 'i'), new RegExp(`\\b${tD_pad}/${tM_pad}/${tY}\\b`), new RegExp(`\\b${tD}/${tM+1}/${tY}\\b`), new RegExp(`\\b${tD_pad}/${tM_pad}/${tY_short}\\b`), new RegExp(`\\b${tD}/${tM+1}/${tY_short}\\b`) ];
                    for (let r = 0; r < Math.min(5, rowsMov.length); r++) {
                        for (let c = 3; c < rowsMov[r].length; c++) {
                            let val = String(rowsMov[r][c] || "").toLowerCase().trim();
                            if (regexFechas.some(rx => rx.test(val))) { 
                                colFecha = c; 
                                for (let searchCol = colFecha; searchCol >= 0; searchCol--) {
                                    let encontrado = false;
                                    for (let searchRow = 0; searchRow < 6; searchRow++) {
                                        let cellVal = String(rowsMov[searchRow]?.[searchCol] || "").toLowerCase().trim();
                                        if (cellVal === "chofer" || cellVal === "choferes" || cellVal.includes("apellido y nombre")) { colNom = searchCol; encontrado = true; break; }
                                    }
                                    if (encontrado) break;
                                }
                                if (colNom === -1) colNom = c - 3; 
                                break; 
                            }
                        }
                        if (colFecha !== -1) break;
                    }
                    if (colFecha !== -1) break; 
                }

                if (colNom !== -1) {
                    for (let i = 2; i < rowsMov.length; i++) {
                        let n_ute = String(rowsMov[i][2] || "").trim(), tractor = String(rowsMov[i][4] || "").trim(), semi = String(rowsMov[i][5] || "").trim(); 
                        if (!tractor) continue;
                        let nomRaw = String(rowsMov[i][colNom] || "").trim();
                        if (!nomRaw || nomRaw === "1" || !/[a-zA-Záéíóú]/.test(nomRaw)) continue;
                        let norm = normalizar(nomRaw);
                        if (resDiagGAS.flota[norm]) { resDiagGAS.flota[norm].n_ute = n_ute; resDiagGAS.flota[norm].tractor = tractor; resDiagGAS.flota[norm].semi = semi; } 
                        else { resDiagGAS.flota[norm] = { tractor: tractor, semi: semi, servicio: 'S/A', n_ute: n_ute, td: '-', hex1: '', hex2: '' }; listaChoferesMaestros.push({ nombre: nomRaw, norm }); }
                    }
                } 
            }

            let nombrePestañaViajes = await getTabName(ID_SHEET_MOVIMIENTOS, "Tabla de viajes", "Tabla de viajes");
            let mapaTD = {};
            (await fetchRango(ID_SHEET_MOVIMIENTOS, `'${nombrePestañaViajes}'!D2:G1000`)).forEach(row => { if (String(row[0] || "").trim()) mapaTD[String(row[0] || "").trim()] = { td: String(row[1] || "").trim(), hex: String(row[3] || "").trim() }; });
            for (let key in resDiagGAS.flota) { let tr = resDiagGAS.flota[key].tractor; if (tr && mapaTD[tr]) { resDiagGAS.flota[key].td = mapaTD[tr].td; resDiagGAS.flota[key].hex1 = mapaTD[tr].hex; resDiagGAS.flota[key].hex2 = mapaTD[tr].hex; } }
        } catch (e) { }

        let dnisMap = {}; let telefonosMap = {};
        try {
            (await fetchRango(ID_SPREADSHEET_MASTER, "'dni'!A1:D500")).forEach(row => { let n = String(row[0] || "").trim(); let dni = String(row[2] || "").replace(/\D/g, ''); if (n && dni) dnisMap[normalizar(n)] = { dni: String(parseInt(dni, 10)) }; });
            (await fetchRango(ID_SPREADSHEET_MASTER, "'LEGAJOS'!A2:P350")).forEach(row => {
                let n = String(row[1] || "").trim(); if (!n || n.toLowerCase().includes("baja")) return; let norm = normalizar(n);
                let datos = { legajo: String(row[0] || "").trim(), telefono: String(row[3] || "").trim(), email: String(row[4] || "").trim(), fechaAlta: String(row[10] || "").trim() };
                telefonosMap[norm] = datos; let dni = String(row[2] || "").replace(/\D/g, '');
                if (dni && !dnisMap[norm]) dnisMap[norm] = { dni: String(parseInt(dni, 10)) };
                if (dnisMap[norm]?.dni) telefonosMap[dnisMap[norm].dni] = datos;
            });
        } catch (e) { }
        resDiagGAS.dnis = dnisMap; resDiagGAS.telefonos = telefonosMap;

        try {
            const rowsAptos = await fetchRango(ID_SHEET_APTOS_MEDICOS, "'Seguimiento Avalados Mensual'!A1:DZ500");
            resDiagGAS.aptosMedicos = {};
            if (rowsAptos.length > 0) {
                let colDiaria = -1; for (let c = rowsAptos[0].length - 1; c >= 12; c--) { if (String(rowsAptos[0][c] || "").trim() !== "") { colDiaria = c; break; } }
                for (let i = 1; i < rowsAptos.length; i++) {
                    let n = String(rowsAptos[i][0] || "").trim(); if (!n || n.toLowerCase() === "nombre completo") continue;
                    let dni = String(rowsAptos[i][1] || "").replace(/\D/g, ''); if (dni.length >= 10) dni = String(parseInt(dni.substring(2, 10), 10));
                    let estado = "-"; let limit = colDiaria > -1 ? colDiaria : rowsAptos[i].length - 1;
                    for (let c = limit; c >= 12; c--) { let val = String(rowsAptos[i][c] || "").trim(); if (val !== "" && val !== "-") { estado = val; break; } }
                    let objApto = { dni, cuil: String(rowsAptos[i][1] || ""), estadoGeneral: String(rowsAptos[i][2] || ""), estado, observaciones: rowsAptos[i][10] || "", observaciones_sector_salud: rowsAptos[i][11] || "" };
                    resDiagGAS.aptosMedicos[dni] = objApto; resDiagGAS.aptosMedicos[normalizar(n)] = objApto;
                }
            }
        } catch (e) {}
        
        const rowsObs = await fetchRango(ID_SHEET_OBSERVACIONES, "'Movimientos'!A5:H2000");
        resDiagGAS.observaciones = {};
        rowsObs.forEach(row => {
            if(!row[1]) return; let norm = normalizar(row[1]); if (!resDiagGAS.observaciones[norm]) resDiagGAS.observaciones[norm] = [];
            resDiagGAS.observaciones[norm].push({ admin: row[0] || "-", fecha: row[2] || "-", unidad: row[3] || "-", evento: row[4] || "-", obsEvento: row[5] || "", estado: row[6] || "-", obsEstado: row[7] || "" });
        });

        let diasLegacyIso = {}; let hojasInfo = []; let nuevaSeccionViajes = {};
        try {
            const parseNum = (val) => parseFloat(String(val || '').replace(/,/g, '.').replace(/[^0-9.-]/g, '')) || 0;
            (await fetchRango(ID_SHEET_KILOMETROS, "'KM'!A2:T")).forEach(row => {
                let fRaw = row[1], nRaw = row[2]; if (!fRaw || !nRaw) return;
                let dObj, parts = String(fRaw).split(' ')[0].split(/[\/\-]/);
                if (parts.length >= 3) { let aa = parts[2].length === 2 ? "20" + parts[2] : parts[2]; dObj = new Date(aa, parseInt(parts[1], 10) - 1, parts[0]); } else { dObj = new Date(fRaw); }
                if (isNaN(dObj.getTime())) return;
                let choferNorm = normalizar(nRaw); let isoDate = dObj.toISOString().split('T')[0];
                let km = parseNum(row[16]) > 0 ? parseNum(row[16]) : parseNum(row[8]); let campo = parseNum(row[5]); let hojaStr = String(row[19] || "").trim();
                if (km > 0 || campo > 0 || hojaStr !== "") {
                    if (!nuevaSeccionViajes[choferNorm]) nuevaSeccionViajes[choferNorm] = {};
                    if (!nuevaSeccionViajes[choferNorm][isoDate]) nuevaSeccionViajes[choferNorm][isoDate] = { dominio: String(row[0] || '').trim(), km: 0, campo: 0, hoja_ruta: [] };
                    let target = nuevaSeccionViajes[choferNorm][isoDate]; target.km += km; target.campo += campo;
                    if (hojaStr !== "") hojaStr.split(',').map(s => s.trim()).filter(Boolean).forEach(h => { if (!target.hoja_ruta.includes(h)) target.hoja_ruta.push(h); });
                }
            });
        } catch(e) {}

        let nombrePestañaVenc = await getTabName(ID_SHEET_MOVIMIENTOS, "Vencimiento", "Vencimientos.");
        resDiagGAS.vencimientosObj = (await fetchRango(ID_SHEET_MOVIMIENTOS, `'${nombrePestañaVenc}'!A2:N1000`)).map(row => (!row[1] ? null : { col_b: row[1] || "", col_g: row[6] || "", col_h: row[7] || "", col_j: row[9] || "", col_k: row[10] || "", col_l: row[11] || "", col_m: row[12] || "", col_n: row[13] || "" })).filter(Boolean);

        resDiagGAS.fotosImgur = {};
        (await fetchRango(ID_SPREADSHEET_MASTER, "'fotos'!A:B")).forEach(row => { 
            if (row[0] && row[1] && String(row[1]).includes('http')) { let n = String(row[0]).replace(/\D/g, ''); if (n.length >= 10) n = n.substring(2, 10); resDiagGAS.fotosImgur[String(parseInt(n, 10))] = String(row[1]).trim(); }
        });

        try {
            const [rowsDoc, rowsHab] = await Promise.all([ fetchRango(ID_SHEET_DOCUMENTOS, "'PERIODICOS'!A:I"), fetchRango(ID_SHEET_HABILITACIONES, "'VENCIMIENTOS'!A:E") ]);
            const fRev = (s) => { if (!s) return null; let p = String(s).split('/'); return p.length === 3 ? `${p[2]}-${p[1]}-${p[0]}` : null; };
            const calcEst = (s) => { if (!s) return 'OK'; let p = String(s).split('/'); if(p.length !== 3) return 'OK'; let d = Math.ceil((new Date(p[2], p[1]-1, p[0]) - new Date()) / 86400000); return d < 0 ? 'VENCIDO' : (d <= 30 ? 'POR_VENCER' : 'VIGENTE'); };

            let traductorCuil = {}; let traductorDni = {};
            let cuilToDni = {}; let dniToRouterName = {};
            let cuilToDiagramaName = {}; let dniToDiagramaName = {};
            
            if (cacheDatosGlobales.choferesRouter) {
                for (let key in cacheDatosGlobales.choferesRouter) {
                    let c = cacheDatosGlobales.choferesRouter[key]; 
                    let nombreOficial = normalizar(c.nombre);
                    let nombreDiagrama = normalizar(c.nombreDiagrama);
                    
                    if (c.cuil) { 
                        traductorCuil[c.cuil] = nombreOficial; 
                        if (c.dni) cuilToDni[c.cuil] = String(parseInt(c.dni, 10)); 
                        if (nombreDiagrama) cuilToDiagramaName[c.cuil] = nombreDiagrama;
                    }
                    if (c.dni) { 
                        let d = String(parseInt(c.dni, 10)); 
                        traductorDni[d] = nombreOficial; 
                        dniToRouterName[d] = nombreOficial; 
                        if (nombreDiagrama) dniToDiagramaName[d] = nombreDiagrama;
                    }
                }
            }

            let dniToDiagramasName = {};
            for (let norm in dnisMap) {
                if (dnisMap[norm] && dnisMap[norm].dni) {
                    dniToDiagramasName[dnisMap[norm].dni] = norm;
                }
            }

            rowsDoc.forEach(r => { 
                let cuilCelda = String(r[4] || "").replace(/\D/g, ''); 
                let dniCelda = cuilToDni[cuilCelda];
                let diagName = dniCelda ? dniToDiagramasName[dniCelda] : null;
                let explicitDiagName = cuilToDiagramaName[cuilCelda];
                let routerName = dniCelda ? dniToRouterName[dniCelda] : null;
                let fallbackRouterName = traductorCuil[cuilCelda];
                let sheetName = normalizar(r[1]);
                let v = fRev(r[8]); 

                if (v) {
                    let obj = { ven: v, estado: calcEst(r[8]) };
                    if (sheetName) resDiagGAS.documentos[sheetName] = obj;
                    if (diagName) resDiagGAS.documentos[diagName] = obj;
                    if (explicitDiagName) resDiagGAS.documentos[explicitDiagName] = obj;
                    if (routerName) resDiagGAS.documentos[routerName] = obj;
                    if (fallbackRouterName) resDiagGAS.documentos[fallbackRouterName] = obj;
                }
            });

            rowsHab.forEach(r => { 
                let rawDni = String(r[2] || "").replace(/\D/g, '');
                let dniCelda = rawDni ? String(parseInt(rawDni, 10)) : "";
                
                let diagName = dniCelda ? dniToDiagramasName[dniCelda] : null;
                let explicitDiagName = dniCelda ? dniToDiagramaName[dniCelda] : null;
                let routerName = dniCelda ? dniToRouterName[dniCelda] : null;
                let fallbackRouterName = traductorDni[dniCelda];
                let sheetName = normalizar(r[1]);
                let c = fRev(r[3]); let l = fRev(r[4]); 

                if (c) { 
                    let obj = { ven: c, estado: calcEst(r[3]) };
                    if (sheetName) resDiagGAS.certificados[sheetName] = obj;
                    if (diagName) resDiagGAS.certificados[diagName] = obj;
                    if (explicitDiagName) resDiagGAS.certificados[explicitDiagName] = obj;
                    if (routerName) resDiagGAS.certificados[routerName] = obj;
                    if (fallbackRouterName) resDiagGAS.certificados[fallbackRouterName] = obj;
                } 
                if (l) { 
                    let obj = { ven: l, estado: calcEst(r[4]) };
                    if (sheetName) resDiagGAS.habilitaciones[sheetName] = obj;
                    if (diagName) resDiagGAS.habilitaciones[diagName] = obj;
                    if (explicitDiagName) resDiagGAS.habilitaciones[explicitDiagName] = obj;
                    if (routerName) resDiagGAS.habilitaciones[routerName] = obj;
                    if (fallbackRouterName) resDiagGAS.habilitaciones[fallbackRouterName] = obj;
                } 
            });
        } catch(e) { console.error("Error cargando docs/habs:", e); }

        let hoyAr2 = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Argentina/Buenos_Aires"}));
        let offsetsMeses = [-1, 0, 1, 2, 3]; 
        for (let i of offsetsMeses) {
            let d = new Date(hoyAr2.getFullYear(), hoyAr2.getMonth() + i, 1); let anio = d.getFullYear(); let mesStr = String(d.getMonth() + 1).padStart(2, '0');
            let nombreHoja = mesesAbrev[d.getMonth()] + "-" + String(anio).slice(-2); hojasInfo.push({ nombre: nombreHoja, anio, mesStr });
            (await fetchRango(ID_SPREADSHEET_DIAGRAMAS, `'${nombreHoja}'!A6:AL1000`)).forEach(row => {
                let n = row[1]; if (!n || n === "APELLIDO Y NOMBRE" || n === "Personal Activo") return; let nomNorm = normalizar(n); if (!diasLegacyIso[nomNorm]) diasLegacyIso[nomNorm] = {};
                for (let dia = 1; dia <= 31; dia++) { let est = row[dia + 3]; if (est && est !== '-') diasLegacyIso[nomNorm][`${anio}-${mesStr}-${String(dia).padStart(2, '0')}`] = String(est).toUpperCase().trim(); }
            });
        }

        let diagramasHibridos = []; 
        listaChoferesMaestros.forEach(ch => {
            let nomNorm = ch.norm; let flota = resDiagGAS.flota[nomNorm] || {}; let mergeIso = diasLegacyIso[nomNorm] || {}; let diasFront = {};
            hojasInfo.forEach(info => { let tira = []; for (let dia = 1; dia <= 31; dia++) { tira.push(mergeIso[`${info.anio}-${info.mesStr}-${String(dia).padStart(2, '0')}`] || "-"); } diasFront[info.nombre] = tira.join(","); });
            diagramasHibridos.push({ _safeId: "drv_" + nomNorm.replace(/[^a-z0-9]/g, "_"), nom: ch.nombre, tractor: flota.tractor || '', semi: flota.semi || '', srv: flota.servicio || '', n_ute: flota.n_ute || '', td: flota.td || '-', hex1: flota.hex1 || '', hex2: flota.hex2 || '', hex_1: "#ffffff", hex_2: "#ffffff", dias: diasFront, _diasIso: mergeIso });
        });

        cacheDatosGlobales.diagramas = { 
            diagramas: diagramasHibridos, nuevaSeccionViajes: nuevaSeccionViajes, documentos: resDiagGAS.documentos, habilitaciones: resDiagGAS.habilitaciones, certificados: resDiagGAS.certificados,
            dnis: resDiagGAS.dnis, telefonos: resDiagGAS.telefonos, observaciones: resDiagGAS.observaciones, aptosMedicos: resDiagGAS.aptosMedicos, vencimientosObj: resDiagGAS.vencimientosObj, fotosImgur: resDiagGAS.fotosImgur
        };
        cacheDatosGlobales.tds = { campo:{}, infinia:{}, liviano:{}, euro:{}, estados:{}, codigosExtra:{} };
        cacheDatosGlobales.ultimaActualizacion = new Date().toISOString();
        
        io.emit('datos_actualizados', cacheDatosGlobales);
        
        // 👉 SE EMITE AL NUEVO DASHBOARD CADA VEZ QUE LA RAM SE RE-ENSAMBLA
        if(cacheDatosGlobales.novedades.length > 0) io.emit('novedades_actualizadas', cacheDatosGlobales.novedades);
        
        console.log(`✅ RAM Ensamblada Completa.`);
        
    } catch (error) { console.error("❌ Error RAM:", error); } 
}

app.use('/api/webhook', webhookRouter(cacheDatosGlobales, io, cargarNovedades, fetchRango, ID_SPREADSHEET_MASTER));
app.get('/health', (req, res) => res.status(200).send('OK'));

app.get('/api/datos', (req, res) => {
    if (!cacheDatosGlobales.diagramas) return res.status(503).json({ error: "Cargando DB..." });
    res.json({ success: true, diagramas: cacheDatosGlobales.diagramas, tds: cacheDatosGlobales.tds, timestamp: cacheDatosGlobales.ultimaActualizacion });
});

// 👉 RUTAS EXTERNAS DE NOVEDADES (AQUÍ ENLAZAMOS EL ARCHIVO NUEVO)
app.use('/api/novedades', createNovedadesRouter(cacheDatosGlobales, io, serviceAccountAuth, ID_SPREADSHEET_MASTER, fetchRango));


// ==========================================
// 🛡️ API PROXY: ESCRITURA DIRECTA DIAGRAMAS
// ==========================================
app.post('/api/proxy', async (req, res) => {
    try {
        const body = req.body;
        const normalizar = (n) => String(n || '').trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, ' ');

        if (body && body.action === 'login') {
            try {
                const { data: user } = await supabase.from('usuarios_auth').select('id, usuario, rol').eq('usuario', body.usuario).eq('password', body.password).single();
                return user ? res.json({ success: true, token: 'auth_' + user.id + '_' + Date.now(), rol: user.rol }) : res.json({ success: false, error: "Incorrecto." });
            } catch(e) { return res.json({ success: false, error: "Error Auth" }); }
        }

        if (body && (body.action === 'guardarObservacion' || body.action === 'guardarNuevaObservacion')) {
            let nBuscado = normalizar(body.chofer);
            if (cacheDatosGlobales.diagramas) {
                if(!cacheDatosGlobales.diagramas.observaciones[nBuscado]) cacheDatosGlobales.diagramas.observaciones[nBuscado] = [];
                cacheDatosGlobales.diagramas.observaciones[nBuscado].push({ admin: body.usuario || body.admin || 'Sistema', fecha: body.fecha, unidad: body.unidad || "-", evento: body.evento, obsEvento: body.obsEvento || "", estado: body.estado || "-", obsEstado: body.obsEstado || "" });
                io.emit('datos_actualizados', cacheDatosGlobales); 
            }
            const docObs = new GoogleSpreadsheet(ID_SHEET_OBSERVACIONES, serviceAccountAuth);
            await docObs.loadInfo(); const sheetMov = docObs.sheetsByTitle['Movimientos'];
            if (sheetMov) { await sheetMov.addRow([ body.usuario || body.admin || 'Sistema', body.chofer, body.fecha, body.unidad || "-", body.evento, body.obsEvento || "", body.estado || "-", body.obsEstado || "", "","","","","","","","" ]); }
        }

        if (body && body.action === 'guardarDocumentos') {
            let routerData = null;
            if (cacheDatosGlobales.choferesRouter) {
                if (body.id && cacheDatosGlobales.choferesRouter[body.id]) { routerData = cacheDatosGlobales.choferesRouter[body.id]; } 
                else if (body.dni || body.nombre) {
                    let dniBuscadoLimpio = body.dni ? String(body.dni).replace(/\D/g, '') : "";
                    let nomNormalizadoFront = normalizar(body.nombre);
                    routerData = Object.values(cacheDatosGlobales.choferesRouter).find(c => (dniBuscadoLimpio && (c.dniFallback === dniBuscadoLimpio || c.dni === dniBuscadoLimpio)) || normalizar(c.nombre) === nomNormalizadoFront );
                }
            }

            let nBuscado = routerData ? normalizar(routerData.nombre) : normalizar(body.nombre);
            let dniParaVencimientos = routerData ? routerData.dni : (body.dni ? String(body.dni).replace(/\D/g, '') : "");
            let cuilParaPeriodicos = routerData ? routerData.cuil : dniParaVencimientos;

            const calcularEstadoISO = (fechaStr) => { 
                if (!fechaStr) return 'OK'; 
                let p = fechaStr.split('-'); let d = Math.ceil((new Date(p[0], p[1] - 1, p[2]) - new Date()) / 86400000); 
                return d < 0 ? 'VENCIDO' : (d <= 30 ? 'POR_VENCER' : 'VIGENTE'); 
            };

            if (cacheDatosGlobales.diagramas) {
                if (!cacheDatosGlobales.diagramas.documentos) cacheDatosGlobales.diagramas.documentos = {};
                if (!cacheDatosGlobales.diagramas.habilitaciones) cacheDatosGlobales.diagramas.habilitaciones = {};
                if (!cacheDatosGlobales.diagramas.certificados) cacheDatosGlobales.diagramas.certificados = {};
                
                if (body.exVen) cacheDatosGlobales.diagramas.documentos[nBuscado] = { ven: body.exVen, estado: calcularEstadoISO(body.exVen) };
                if (body.licVen) cacheDatosGlobales.diagramas.habilitaciones[nBuscado] = { ven: body.licVen, estado: calcularEstadoISO(body.licVen) };
                if (body.certVen) cacheDatosGlobales.diagramas.certificados[nBuscado] = { ven: body.certVen, estado: calcularEstadoISO(body.certVen) };
                io.emit('datos_actualizados', cacheDatosGlobales); 
            }

            let reqs = [];
            if (body.exVen && cuilParaPeriodicos) {
                try {
                    const rowsDoc = (await serviceAccountAuth.request({ url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SHEET_DOCUMENTOS}/values/'PERIODICOS'!E5:E1000` })).data.values || [];
                    let rIdxDoc = -1; for (let i = 0; i < rowsDoc.length; i++) { if (String(rowsDoc[i][0] || "").replace(/\D/g, '') === cuilParaPeriodicos) { rIdxDoc = i + 5; break; } }
                    let p = body.exVen.split('-'); let fechaHardcodeada = `${p[2]}/${p[1]}/${p[0]}`;
                    if (rIdxDoc !== -1) reqs.push(serviceAccountAuth.request({ url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SHEET_DOCUMENTOS}/values/'PERIODICOS'!I${rIdxDoc}?valueInputOption=USER_ENTERED`, method: 'PUT', data: { values: [[fechaHardcodeada]] } }));
                } catch(e) {}
            }

            if ((body.licVen || body.certVen) && dniParaVencimientos) {
                try {
                    const rowsHab = (await serviceAccountAuth.request({ url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SHEET_HABILITACIONES}/values/'VENCIMIENTOS'!C5:C1000` })).data.values || [];
                    let rIdxHab = -1; for (let i = 0; i < rowsHab.length; i++) { if (String(rowsHab[i][0] || "").replace(/\D/g, '') === dniParaVencimientos) { rIdxHab = i + 5; break; } }
                    let pL = body.licVen ? body.licVen.split('-') : null, pC = body.certVen ? body.certVen.split('-') : null;
                    let valL = pL ? `${pL[2]}/${pL[1]}/${pL[0]}` : "", valC = pC ? `${pC[2]}/${pC[1]}/${pC[0]}` : "";
                    if (rIdxHab !== -1) {
                        if (valL) reqs.push(serviceAccountAuth.request({ url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SHEET_HABILITACIONES}/values/'VENCIMIENTOS'!E${rIdxHab}?valueInputOption=USER_ENTERED`, method: 'PUT', data: { values: [[valL]] } }));
                        if (valC) reqs.push(serviceAccountAuth.request({ url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SHEET_HABILITACIONES}/values/'VENCIMIENTOS'!D${rIdxHab}?valueInputOption=USER_ENTERED`, method: 'PUT', data: { values: [[valC]] } }));
                    }
                } catch(e) {}
            }

            await Promise.all(reqs);
            return res.json({ success: true, message: "OK" });
        }

        if (body && (body.action === 'actualizarEstado' || body.action === 'actualizarEstadoLote')) {
            let items = (body.action === 'actualizarEstadoLote' && Array.isArray(body.items)) 
                ? body.items 
                : (Array.isArray(body.items) ? body.items : [body]);

            // 1. Inyección inmediata en RAM para todos los ítems e inyección vía WebSockets
            items.forEach(item => {
                let nBuscado = normalizar(item.nombre);
                let safeIdItem = item._safeId || item.safeId;
                let cur = new Date(item.startIso + "T12:00:00");
                let fFin = new Date(item.endIso + "T12:00:00");
                let idxEst = 0;

                while (cur <= fFin) {
                    let tName = mesesAbrev[cur.getMonth()] + "-" + String(cur.getFullYear()).slice(-2);
                    let val = Array.isArray(item.est) ? item.est[idxEst] : item.est;
                    if (val === 'BORRAR') val = '';
                    let isoStr = cur.toISOString().split('T')[0];

                    if (cacheDatosGlobales.diagramas?.diagramas) {
                        let ch = cacheDatosGlobales.diagramas.diagramas.find(c => 
                            (safeIdItem && c._safeId === safeIdItem) || normalizar(c.nom) === nBuscado
                        );
                        if (ch) {
                            if (!ch._diasIso) ch._diasIso = {}; ch._diasIso[isoStr] = val;
                            if (!ch.dias) ch.dias = {}; if (!ch.dias[tName]) ch.dias[tName] = new Array(31).fill('-').join(',');
                            let tiraDias = ch.dias[tName].split(',');
                            tiraDias[cur.getDate() - 1] = val === '' ? '-' : val;
                            ch.dias[tName] = tiraDias.join(',');
                        }
                    }
                    cur.setDate(cur.getDate() + 1); idxEst++;
                }
            });

            io.emit('datos_actualizados', cacheDatosGlobales);

            // 2. Persistencia asíncrona optimizada a Google Sheets agrupando por pestaña (1 llamada batchUpdate por tab)
            (async () => {
                let updatesByTab = {};

                for (let item of items) {
                    let nBuscado = normalizar(item.nombre);
                    let cur = new Date(item.startIso + "T12:00:00");
                    let fFin = new Date(item.endIso + "T12:00:00");
                    let idxEst = 0;

                    while (cur <= fFin) {
                        let tName = mesesAbrev[cur.getMonth()] + "-" + String(cur.getFullYear()).slice(-2);
                        if (!updatesByTab[tName]) updatesByTab[tName] = {};
                        if (!updatesByTab[tName][nBuscado]) updatesByTab[tName][nBuscado] = {};

                        let val = Array.isArray(item.est) ? item.est[idxEst] : item.est;
                        if (val === 'BORRAR') val = '';
                        updatesByTab[tName][nBuscado][cur.getDate()] = val;
                        cur.setDate(cur.getDate() + 1); idxEst++;
                    }
                }

                for (let tab in updatesByTab) {
                    try {
                        const resSheet = await serviceAccountAuth.request({ 
                            url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SPREADSHEET_DIAGRAMAS}/values/'${tab}'!A:AI` 
                        });
                        const rowsTab = resSheet.data.values || [];
                        if (rowsTab.length === 0) continue;

                        let batchDataUpdates = [];

                        for (let nBuscado in updatesByTab[tab]) {
                            let rIdx = -1;
                            for (let i = 0; i < rowsTab.length; i++) {
                                if (normalizar(rowsTab[i][1]) === nBuscado) {
                                    rIdx = i + 1;
                                    break;
                                }
                            }

                            if (rIdx !== -1) {
                                let rowData = rowsTab[rIdx - 1].slice(4, 35) || [];
                                while (rowData.length < 31) rowData.push('');

                                let diasModificados = updatesByTab[tab][nBuscado];
                                for (let day in diasModificados) {
                                    rowData[parseInt(day) - 1] = diasModificados[day];
                                }

                                batchDataUpdates.push({
                                    range: `'${tab}'!E${rIdx}:AI${rIdx}`,
                                    values: [rowData]
                                });
                            }
                        }

                        if (batchDataUpdates.length > 0) {
                            await serviceAccountAuth.request({
                                url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SPREADSHEET_DIAGRAMAS}/values:batchUpdate`,
                                method: 'POST',
                                data: {
                                    valueInputOption: 'USER_ENTERED',
                                    data: batchDataUpdates
                                }
                            });
                        }
                    } catch (errTab) {
                        console.error(`Error en actualización masiva de la pestaña ${tab}:`, errTab.message);
                    }
                }
            })().catch(e => console.error("Error guardando lote en Google Sheets:", e));

            return res.json({ success: true, message: "OK", count: items.length });
        }

        if (body && body.action === 'guardarHojaRutaRango') {
            const normalizar = (n) => String(n || '').trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, ' ');
            const nBuscado = normalizar(body.nombre);
            const curDate = new Date(body.startIso + "T12:00:00"), endDate = new Date(body.endIso + "T12:00:00");
            const hojasEntrantes = Array.isArray(body.hojas) ? body.hojas : String(body.hojas || '').split(',').map(s => s.trim()).filter(Boolean);
            const flagOverwrite = body.overwrite === true;

            if (cacheDatosGlobales.diagramas) {
                if (!cacheDatosGlobales.diagramas.nuevaSeccionViajes[nBuscado]) cacheDatosGlobales.diagramas.nuevaSeccionViajes[nBuscado] = {};
                let tempCur = new Date(curDate);
                while (tempCur <= endDate) {
                    let isoStr = tempCur.toISOString().split('T')[0];
                    if (!cacheDatosGlobales.diagramas.nuevaSeccionViajes[nBuscado][isoStr]) cacheDatosGlobales.diagramas.nuevaSeccionViajes[nBuscado][isoStr] = { dominio: body.tractor || '', km: 0, campo: 0, hoja_ruta: [] };
                    let target = cacheDatosGlobales.diagramas.nuevaSeccionViajes[nBuscado][isoStr];
                    if (flagOverwrite) target.hoja_ruta = [...hojasEntrantes]; else hojasEntrantes.forEach(h => { if (!target.hoja_ruta.includes(h)) target.hoja_ruta.push(h); });
                    tempCur.setDate(tempCur.getDate() + 1);
                }
                io.emit('datos_actualizados', cacheDatosGlobales);
            }

            const rowsKM = (await serviceAccountAuth.request({ url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SHEET_KILOMETROS}/values/'KM'!A:T` })).data.values || [];
            let reqs = []; const docKm = new GoogleSpreadsheet(ID_SHEET_KILOMETROS, serviceAccountAuth); let sheetLoaded = false;
            let loopDate = new Date(curDate);
            while (loopDate <= endDate) {
                let isoStr = loopDate.toISOString().split('T')[0];
                let targetStrSheet = `${String(loopDate.getDate()).padStart(2, '0')}/${String(loopDate.getMonth() + 1).padStart(2, '0')}/${String(loopDate.getFullYear()).slice(-2)}`;
                let filaIndex = -1; let hojasSheetExistentes = "";

                for (let i = 1; i < rowsKM.length; i++) {
                    if (normalizar(rowsKM[i][2]) === nBuscado) {
                        let fechaCelda = String(rowsKM[i][1] || '').trim(); let celdaIso = "";
                        let partes = fechaCelda.split(' ')[0].split(/[\/\-]/);
                        if (partes.length >= 3) {
                            if (partes[0].length === 4) celdaIso = `${partes[0]}-${partes[1].padStart(2, '0')}-${partes[2].padStart(2, '0')}`;
                            else { let aa = partes[2].length === 2 ? "20" + partes[2] : partes[2]; celdaIso = `${aa}-${partes[1].padStart(2, '0')}-${partes[0].padStart(2, '0')}`; }
                        }
                        if (celdaIso === isoStr || fechaCelda === isoStr) { filaIndex = i + 1; hojasSheetExistentes = String(rowsKM[i][19] || "").trim(); break; }
                    }
                }

                let finalHojasStr = "";
                if (flagOverwrite) finalHojasStr = hojasEntrantes.join(', ');
                else { let arrExistentes = hojasSheetExistentes ? hojasSheetExistentes.split(',').map(s => s.trim()).filter(Boolean) : []; hojasEntrantes.forEach(h => { if (!arrExistentes.includes(h)) arrExistentes.push(h); }); finalHojasStr = arrExistentes.join(', '); }

                if (filaIndex !== -1) { reqs.push(serviceAccountAuth.request({ url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SHEET_KILOMETROS}/values/'KM'!T${filaIndex}?valueInputOption=USER_ENTERED`, method: 'PUT', data: { values: [[finalHojasStr]] } })); } 
                else {
                    if (!sheetLoaded) { await docKm.loadInfo(); sheetLoaded = true; }
                    let sheetTarget = docKm.sheetsByTitle['KM'] || docKm.sheetsByIndex[0];
                    await sheetTarget.addRow([ body.tractor || "", targetStrSheet, body.nombre, "","","","","","","","","","","","","","","","", finalHojasStr ]);
                }
                loopDate.setDate(loopDate.getDate() + 1);
            }
            if (reqs.length > 0) await Promise.all(reqs).catch(e => console.error(e));
            return res.json({ success: true, message: "OK" });
        }

        res.json({ success: true, message: "OK" });

    } catch (error) { res.status(500).json({ success: false, error: "Error en Proxy" }); }
});

app.post('/api/subir-foto', async (req, res) => {
    try { const { dni, imagenBase64 } = req.body; const imgbbData = await (await fetch(`https://api.imgbb.com/1/upload?key=${process.env.IMGBB_API_KEY}`, { method: 'POST', body: new URLSearchParams({ image: imagenBase64.replace(/^data:image\/\w+;base64,/, "") }) })).json(); const linkOficial = imgbbData.data.url; const rowsFotos = (await serviceAccountAuth.request({ url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SPREADSHEET_MASTER}/values/'fotos'!A:B` })).data.values || []; let rIdx = -1; let dniP = String(dni).replace(/\D/g, ''); for (let i = 0; i < rowsFotos.length; i++) { if (String(rowsFotos[i][0]).replace(/\D/g, '') === dniP) { rIdx = i + 1; break; } } if (rIdx !== -1) { await serviceAccountAuth.request({ url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SPREADSHEET_MASTER}/values/'fotos'!B${rIdx}?valueInputOption=USER_ENTERED`, method: 'PUT', data: { values: [[linkOficial]] } }); } else { await serviceAccountAuth.request({ url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SPREADSHEET_MASTER}/values/'fotos'!A:B:append?valueInputOption=USER_ENTERED`, method: 'POST', data: { values: [[dniP, linkOficial]] } }); } if (!cacheDatosGlobales.diagramas.fotosImgur) cacheDatosGlobales.diagramas.fotosImgur = {}; cacheDatosGlobales.diagramas.fotosImgur[dniP] = linkOficial; io.emit('datos_actualizados', cacheDatosGlobales); res.json({ success: true, link: linkOficial, mensaje: "Foto vinculada." }); } catch (error) { res.status(500).json({ success: false, error: "Error en imagen." }); }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Servidor Node Activo en puerto ${PORT}`));