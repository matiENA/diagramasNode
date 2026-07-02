const express = require('express');
const compression = require('compression');
const cors = require('cors');
const http = require('http'); 
const { Server } = require('socket.io');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(compression()); 
const server = http.createServer(app); 

const io = new Server(server, { 
    cors: { origin: ["https://diagramas-hp1p.onrender.com", "http://localhost:3000", "*"], methods: ["GET", "POST"], credentials: true },
    transports: ['websocket', 'polling']
});

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'] }));
app.options('*', cors());
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
const ID_SHEET_MOVIMIENTOS = process.env.MES_MOVIMIENTOS_ID || '1hhJKwp9xOOHL_zZSJMbrJh5fwfsIPre155UTWhKWI44'; 

const mesesAbrev = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
let cacheDatosGlobales = { diagramas: null, tds: null, nombresMesActual: [], ultimaActualizacion: null };

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
        const found = (resMeta.data.sheets || []).find(s => s.properties.title.toLowerCase().includes(keyword.toLowerCase()));
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

setTimeout(() => { flujoEncoladoGlobal(); }, 3000); 

setInterval(() => { 
    console.log("⏱️ Escaneo periódico (15 min): Comprobando cambios externos en Google Sheets...");
    flujoEncoladoGlobal(); 
}, 15 * 60 * 1000); 

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

        let listaChoferesMaestros = [];
        try {
            // 👉 SOLUCIÓN 1: Forzar Zona Horaria Argentina (UTC-3)
            let hoy = new Date(new Date().toLocaleString("en-US", {timeZone: "America/Argentina/Buenos_Aires"}));
            let anio = hoy.getFullYear(); 
            let nombreHojaActual = mesesAbrev[hoy.getMonth()] + "-" + String(anio).slice(-2);
            
            (await fetchRango(ID_SPREADSHEET_DIAGRAMAS, `'${nombreHojaActual}'!A6:C1000`)).forEach(row => {
                if (row[1] && !["APELLIDO Y NOMBRE", "Personal Activo"].includes(row[1])) {
                    let norm = normalizar(row[1]);
                    if (!resDiagGAS.flota[norm]) { resDiagGAS.flota[norm] = { tractor: '', semi: '', servicio: row[2] || 'S/A', n_ute: '', td: '-', hex1: '', hex2: '' }; listaChoferesMaestros.push({ nombre: String(row[1]).trim(), norm }); }
                }
            });

            let nombrePestañaMov = await getTabName(ID_SHEET_MOVIMIENTOS, "Mov.Unidades", "Mov.Unidades y Choferes");
            const rowsMov = await fetchRango(ID_SHEET_MOVIMIENTOS, `'${nombrePestañaMov}'!A1:ZZ1000`);
            
            if (rowsMov.length > 0) {
                let headers = rowsMov[0];
                let targetD = hoy.getDate(), targetM = hoy.getMonth(), targetY = hoy.getFullYear();
                let targetD_pad = String(targetD).padStart(2, '0');
                let targetM_pad = String(targetM + 1).padStart(2, '0');
                let targetY_short = String(targetY).slice(-2);
                
                // 👉 SOLUCIÓN 2: Multi-Formatos de Fecha
                let regexFechas = [
                    new RegExp(`\\b0?${targetD}[\\s/\\-de]+${["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"][targetM]}\\b`, 'i'),
                    new RegExp(`\\b0?${targetD}[\\s/\\-]+${mesesAbrev[targetM]}\\b`, 'i'),
                    new RegExp(`\\b${targetD_pad}/${targetM_pad}/${targetY}\\b`),
                    new RegExp(`\\b${targetD}/${targetM+1}/${targetY}\\b`),
                    new RegExp(`\\b${targetD_pad}/${targetM_pad}/${targetY_short}\\b`),
                    new RegExp(`\\b${targetD}/${targetM+1}/${targetY_short}\\b`),
                    new RegExp(`\\b${targetD_pad}/${targetM_pad}\\b`),
                    new RegExp(`\\b${targetD}/${targetM+1}\\b`)
                ];

                let colFecha = -1, colNom = -1;
                
                // Búsqueda de la Fecha (Hacia atrás, para agarrar el día actual que suele estar más a la derecha)
                for (let c = headers.length - 1; c >= 3; c--) { 
                    let val = String(headers[c] || "").toLowerCase().trim(); 
                    if (regexFechas.some(rx => rx.test(val))) { colFecha = c; break; } 
                }

                if (colFecha !== -1 && colFecha >= 3) { 
                    colNom = colFecha - 3; 
                } else { 
                    // Fallback 1: Buscar la palabra "chofer" en los títulos
                    for (let c = headers.length - 1; c >= 3; c--) { 
                        if (String(headers[c] || "").toLowerCase().trim().includes("chofer")) { colNom = c; break; } 
                    } 
                }

                // 👉 SOLUCIÓN 3: Auto-Calibración de Columnas (Si fallan los títulos, lee los datos)
                if (colNom === -1 && listaChoferesMaestros.length > 0) {
                    let knownNames = listaChoferesMaestros.slice(0, 8).map(c => c.norm);
                    for (let c = headers.length - 1; c >= 3; c--) {
                        let found = false;
                        for (let i = 2; i < Math.min(20, rowsMov.length); i++) {
                            if (knownNames.includes(normalizar(rowsMov[i][c]))) {
                                colNom = c; found = true; break;
                            }
                        }
                        if (found) break;
                    }
                }

                // Ahora sí, extraemos los vehículos sin fallar
                if (colNom !== -1) {
                    for (let i = 2; i < rowsMov.length; i++) {
                        let nomRaw = String(rowsMov[i][colNom] || "").trim();
                        if (!nomRaw || nomRaw === "1" || !/[a-zA-Záéíóú]/.test(nomRaw)) continue;
                        let norm = normalizar(nomRaw);
                        if (resDiagGAS.flota[norm]) { 
                            resDiagGAS.flota[norm].n_ute = String(rowsMov[i][2] || "").trim(); 
                            resDiagGAS.flota[norm].tractor = String(rowsMov[i][4] || "").trim(); 
                            resDiagGAS.flota[norm].semi = String(rowsMov[i][5] || "").trim(); 
                        } else { 
                            resDiagGAS.flota[norm] = { tractor: String(rowsMov[i][4] || "").trim(), semi: String(rowsMov[i][5] || "").trim(), servicio: 'S/A', n_ute: String(rowsMov[i][2] || "").trim(), td: '-', hex1: '', hex2: '' }; 
                            listaChoferesMaestros.push({ nombre: nomRaw, norm }); 
                        }
                    }
                }
            }

            let nombrePestañaViajes = await getTabName(ID_SHEET_MOVIMIENTOS, "Tabla de viajes", "Tabla de viajes");
            let mapaTD = {};
            (await fetchRango(ID_SHEET_MOVIMIENTOS, `'${nombrePestañaViajes}'!D2:G1000`)).forEach(row => { if (String(row[0] || "").trim()) mapaTD[String(row[0] || "").trim()] = { td: String(row[1] || "").trim(), hex: String(row[3] || "").trim() }; });
            
            for (let key in resDiagGAS.flota) { let tr = resDiagGAS.flota[key].tractor; if (tr && mapaTD[tr]) { resDiagGAS.flota[key].td = mapaTD[tr].td; resDiagGAS.flota[key].hex1 = mapaTD[tr].hex; resDiagGAS.flota[key].hex2 = mapaTD[tr].hex; } }
        } catch (e) {}

        // 👉 RESTAURADO EL BLOQUE BORRADO (DNIs y Teléfonos)
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
        } catch (e) {}
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

            rowsDoc.forEach(r => { let n = normalizar(r[1]); let v = fRev(r[8]); if (n && v) resDiagGAS.documentos[n] = { ven: v, estado: calcEst(r[8]) }; });
            rowsHab.forEach(r => { let n = normalizar(r[1]); let c = fRev(r[3]); let l = fRev(r[4]); if (n) { if (c) resDiagGAS.certificados[n] = { ven: c, estado: calcEst(r[3]) }; if (l) resDiagGAS.habilitaciones[n] = { ven: l, estado: calcEst(r[4]) }; } });
        } catch(e) { console.error("Error Lectura Docs:", e); }

        let hoy = new Date(); let offsetsMeses = [-1, 0, 1, 2, 3]; 
        for (let i of offsetsMeses) {
            let d = new Date(hoy.getFullYear(), hoy.getMonth() + i, 1); let anio = d.getFullYear(); let mesStr = String(d.getMonth() + 1).padStart(2, '0');
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
        console.log(`✅ RAM Ensamblada Completa.`);
        
    } catch (error) { console.error("❌ Error RAM:", error); } 
}

app.get('/health', (req, res) => res.status(200).send('OK'));
app.get('/api/datos', (req, res) => {
    if (!cacheDatosGlobales.diagramas) return res.status(503).json({ error: "Cargando DB..." });
    res.json({ success: true, diagramas: cacheDatosGlobales.diagramas, tds: cacheDatosGlobales.tds, timestamp: cacheDatosGlobales.ultimaActualizacion });
});

// ==========================================
// 🛡️ API PROXY: ESCRITURA DIRECTA
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
            let nBuscado = normalizar(body.nombre);
            let dniBuscado = cacheDatosGlobales.diagramas?.dnis?.[nBuscado]?.dni || "";
            const calcularEstadoISO = (fechaStr) => { if (!fechaStr) return 'OK'; let p = fechaStr.split('-'); let d = Math.ceil((new Date(p[0], p[1] - 1, p[2]) - new Date()) / 86400000); return d < 0 ? 'VENCIDO' : (d <= 30 ? 'POR_VENCER' : 'VIGENTE'); };

            if (cacheDatosGlobales.diagramas) {
                if (!cacheDatosGlobales.diagramas.documentos) cacheDatosGlobales.diagramas.documentos = {};
                if (!cacheDatosGlobales.diagramas.habilitaciones) cacheDatosGlobales.diagramas.habilitaciones = {};
                if (!cacheDatosGlobales.diagramas.certificados) cacheDatosGlobales.diagramas.certificados = {};
                if (body.exVen) cacheDatosGlobales.diagramas.documentos[nBuscado] = { ven: body.exVen, estado: calcularEstadoISO(body.exVen) };
                if (body.licVen) cacheDatosGlobales.diagramas.habilitaciones[nBuscado] = { ven: body.licVen, estado: calcularEstadoISO(body.licVen) };
                if (body.certVen) cacheDatosGlobales.diagramas.certificados[nBuscado] = { ven: body.certVen, estado: calcularEstadoISO(body.certVen) };
                io.emit('datos_actualizados', cacheDatosGlobales); 
            }

            if (body.licVen || body.certVen) {
                try {
                    const rowsHab = (await serviceAccountAuth.request({ url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SHEET_HABILITACIONES}/values/'VENCIMIENTOS'!A:C` })).data.values || [];
                    let rIdx = -1; for (let i = 0; i < rowsHab.length; i++) { if ((dniBuscado && String(rowsHab[i][2] || "").replace(/\D/g, '') === dniBuscado) || normalizar(rowsHab[i][1]) === nBuscado) { rIdx = i + 1; break; } }
                    if (rIdx !== -1) {
                        let reqs = [];
                        if (body.licVen) { let p = body.licVen.split('-'); reqs.push(serviceAccountAuth.request({ url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SHEET_HABILITACIONES}/values/'VENCIMIENTOS'!E${rIdx}?valueInputOption=USER_ENTERED`, method: 'PUT', data: { values: [[`${p[2]}/${p[1]}/${p[0]}`]] } })); }
                        if (body.certVen) { let p = body.certVen.split('-'); reqs.push(serviceAccountAuth.request({ url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SHEET_HABILITACIONES}/values/'VENCIMIENTOS'!D${rIdx}?valueInputOption=USER_ENTERED`, method: 'PUT', data: { values: [[`${p[2]}/${p[1]}/${p[0]}`]] } })); }
                        await Promise.all(reqs); 
                    } else {
                        let pL = body.licVen ? body.licVen.split('-') : null, pC = body.certVen ? body.certVen.split('-') : null;
                        await serviceAccountAuth.request({ url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SHEET_HABILITACIONES}/values/'VENCIMIENTOS'!A:E:append?valueInputOption=USER_ENTERED`, method: 'POST', data: { values: [["", body.nombre, dniBuscado, pC ? `${pC[2]}/${pC[1]}/${pC[0]}` : "", pL ? `${pL[2]}/${pL[1]}/${pL[0]}` : ""]] } });
                    }
                } catch(e) {}
            }
            if (body.exVen) {
                try {
                    const rowsDoc = (await serviceAccountAuth.request({ url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SHEET_DOCUMENTOS}/values/'PERIODICOS'!A:E` })).data.values || [];
                    let rIdx = -1; for (let i = 0; i < rowsDoc.length; i++) { let d = String(rowsDoc[i][4] || "").replace(/\D/g, ''); d = d.length===11 ? String(parseInt(d.substring(2,10),10)) : d; if ((dniBuscado && d === dniBuscado) || normalizar(rowsDoc[i][1]) === nBuscado) { rIdx = i + 1; break; } }
                    if (rIdx !== -1) { let p = body.exVen.split('-'); await serviceAccountAuth.request({ url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SHEET_DOCUMENTOS}/values/'PERIODICOS'!I${rIdx}?valueInputOption=USER_ENTERED`, method: 'PUT', data: { values: [[`${p[2]}/${p[1]}/${p[0]}`]] } }); } 
                    else { let p = body.exVen.split('-'); await serviceAccountAuth.request({ url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SHEET_DOCUMENTOS}/values/'PERIODICOS'!A:I:append?valueInputOption=USER_ENTERED`, method: 'POST', data: { values: [["", body.nombre, "", "", dniBuscado, "", "", "", `${p[2]}/${p[1]}/${p[0]}`]] } }); }
                } catch(e) {}
            }
        }

        if (body && body.action === 'actualizarEstado') {
            let nBuscado = normalizar(body.nombre); let cur = new Date(body.startIso + "T12:00:00"); let fFin = new Date(body.endIso + "T12:00:00");
            let idxEst = 0; let updatesBySheet = {};
            
            while(cur <= fFin) {
                let tName = mesesAbrev[cur.getMonth()] + "-" + String(cur.getFullYear()).slice(-2);
                if (!updatesBySheet[tName]) updatesBySheet[tName] = {};
                let val = Array.isArray(body.est) ? body.est[idxEst] : body.est; if (val === 'BORRAR') val = '-';
                updatesBySheet[tName][cur.getDate()] = val;
                
                let isoStr = cur.toISOString().split('T')[0];
                if (cacheDatosGlobales.diagramas?.diagramas) { let ch = cacheDatosGlobales.diagramas.diagramas.find(c => normalizar(c.nom) === nBuscado); if (ch) { if (!ch._diasIso) ch._diasIso = {}; ch._diasIso[isoStr] = val; } }
                cur.setDate(cur.getDate() + 1); idxEst++;
            }
            io.emit('datos_actualizados', cacheDatosGlobales);

            for (let tab in updatesBySheet) {
                try {
                    const rowsTab = (await serviceAccountAuth.request({ url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SPREADSHEET_DIAGRAMAS}/values/'${tab}'!A:C` })).data.values || [];
                    let rIdx = -1; for(let i=0; i<rowsTab.length; i++) { if(normalizar(rowsTab[i][1]) === nBuscado) { rIdx = i + 1; break; } }
                    if (rIdx !== -1) {
                        let rowData = (await serviceAccountAuth.request({ url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SPREADSHEET_DIAGRAMAS}/values/'${tab}'!D${rIdx}:AH${rIdx}` })).data.values?.[0] || new Array(31).fill('-');
                        while(rowData.length < 31) rowData.push('-');
                        for (let day in updatesBySheet[tab]) rowData[parseInt(day)-1] = updatesBySheet[tab][day];
                        await serviceAccountAuth.request({ url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SPREADSHEET_DIAGRAMAS}/values/'${tab}'!D${rIdx}:AH${rIdx}?valueInputOption=USER_ENTERED`, method: 'PUT', data: { values: [rowData] } });
                    }
                } catch(e) {}
            }
        }

        if (body && body.action === 'guardarHojaRutaPlanilla') {
            let nBuscado = normalizar(body.nombre); let targetStr = `${String(new Date(body.fecha + "T12:00:00").getDate()).padStart(2,'0')}/${String(new Date(body.fecha + "T12:00:00").getMonth()+1).padStart(2,'0')}/${String(new Date(body.fecha + "T12:00:00").getFullYear()).slice(-2)}`;
            let strHojas = (body.hojas || []).join(', ');

            if (cacheDatosGlobales.diagramas) {
                if(!cacheDatosGlobales.diagramas.nuevaSeccionViajes[nBuscado]) cacheDatosGlobales.diagramas.nuevaSeccionViajes[nBuscado] = {};
                if(!cacheDatosGlobales.diagramas.nuevaSeccionViajes[nBuscado][body.fecha]) cacheDatosGlobales.diagramas.nuevaSeccionViajes[nBuscado][body.fecha] = { dominio: body.tractor || '', km: 0, campo: 0, hoja_ruta: [] };
                let target = cacheDatosGlobales.diagramas.nuevaSeccionViajes[nBuscado][body.fecha];
                (body.hojas || []).filter(Boolean).forEach(h => { if (!target.hoja_ruta.includes(h)) target.hoja_ruta.push(h); });
                io.emit('datos_actualizados', cacheDatosGlobales);
            }

            const rowsBC = (await serviceAccountAuth.request({ url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SHEET_KILOMETROS}/values/'KM'!B:C` })).data.values || [];
            let rIdx = -1;
            for (let i = 1; i < rowsBC.length; i++) {
                if (normalizar(rowsBC[i][1]) === nBuscado) {
                    let p = String(rowsBC[i][0] || '').trim().split(' ')[0].split(/[\/\-]/);
                    if (p.length >= 3 && `${String(parseInt(p[p[0].length===4?2:0], 10)).padStart(2,'0')}/${String(parseInt(p[1], 10)).padStart(2,'0')}/${p[p[0].length===4?0:2].slice(-2)}` === targetStr) { rIdx = i + 1; break; }
                    else if (String(rowsBC[i][0]).includes(targetStr) || String(rowsBC[i][0]).startsWith(body.fecha)) { rIdx = i + 1; break; }
                }
            }

            if (rIdx !== -1) { await serviceAccountAuth.request({ url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SHEET_KILOMETROS}/values/'KM'!T${rIdx}?valueInputOption=USER_ENTERED`, method: 'PUT', data: { values: [[strHojas]] } }); } 
            else { const docKm = new GoogleSpreadsheet(ID_SHEET_KILOMETROS, serviceAccountAuth); await docKm.loadInfo(); await (docKm.sheetsByTitle['KM'] || docKm.sheetsByIndex[0]).addRow([body.tractor || "", targetStr, body.nombre, "","","","","","","","","","","","","","","","", strHojas]); }
        }

        res.json({ success: true, message: "OK" });

    } catch (error) { res.status(500).json({ success: false, error: "Error en Proxy" }); }
});

app.post('/api/subir-foto', async (req, res) => {
    try { const { dni, imagenBase64 } = req.body; const imgbbData = await (await fetch(`https://api.imgbb.com/1/upload?key=${process.env.IMGBB_API_KEY}`, { method: 'POST', body: new URLSearchParams({ image: imagenBase64.replace(/^data:image\/\w+;base64,/, "") }) })).json(); const linkOficial = imgbbData.data.url; const rowsFotos = (await serviceAccountAuth.request({ url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SPREADSHEET_MASTER}/values/'fotos'!A:B` })).data.values || []; let rIdx = -1; let dniP = String(dni).replace(/\D/g, ''); for (let i = 0; i < rowsFotos.length; i++) { if (String(rowsFotos[i][0]).replace(/\D/g, '') === dniP) { rIdx = i + 1; break; } } if (rIdx !== -1) { await serviceAccountAuth.request({ url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SPREADSHEET_MASTER}/values/'fotos'!B${rIdx}?valueInputOption=USER_ENTERED`, method: 'PUT', data: { values: [[linkOficial]] } }); } else { await serviceAccountAuth.request({ url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SPREADSHEET_MASTER}/values/'fotos'!A:B:append?valueInputOption=USER_ENTERED`, method: 'POST', data: { values: [[dniP, linkOficial]] } }); } if (!cacheDatosGlobales.diagramas.fotosImgur) cacheDatosGlobales.diagramas.fotosImgur = {}; cacheDatosGlobales.diagramas.fotosImgur[dniP] = linkOficial; io.emit('datos_actualizados', cacheDatosGlobales); res.json({ success: true, link: linkOficial, mensaje: "Foto vinculada." }); } catch (error) { res.status(500).json({ success: false, error: "Error en imagen." }); }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Servidor Node Activo en puerto ${PORT}`));