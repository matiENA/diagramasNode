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
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization', 'Accept'] }));
app.options('*', cors());
app.use(express.json({ type: ['application/json', 'text/plain'] }));

// ==========================================
// 1. CONFIGURACIÓN E INSTANCIAS
// ==========================================
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey); 

const serviceAccountAuth = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY ? process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n') : '',
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const ID_SPREADSHEET_MASTER = process.env.SPREADSHEET_ID || '1eQ9Y5diL5fwxYTxvseNgZJFbX-lSUQ13axbp3cLiqPc';
const ID_SHEET_LEGAJOS_MAESTRO = '19_UPtQYtu7l9zeZPK_glqonxD5jnxXyD8msyy_1lydg';
const ID_SHEET_OBSERVACIONES = '1VwCNK89ecaac7IDlMWWCLHRqZoch9HB6vop5AfQEaA0';
const ID_SHEET_APTOS_MEDICOS = '1oJmN8hurfHfNnGBYUFcBdlrIj2VUzeIyq0ZTWxTpYNI';
const ID_SHEET_MOVIMIENTOS = '1hhJKwp9xOOHL_zZSJMbrJh5fwfsIPre155UTWhKWI44'; 
const ID_SHEET_KILOMETROS = '1Wr-_P4mDvldif_cAx08sp7yT8uTUrajI2HQAJF6tnGM';
const mesesAbrev = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];

let cacheDatosGlobales = { diagramas: null, tds: null, nombresMesActual: [], ultimaActualizacion: null };

async function fetchRango(spreadsheetId, rango, reintentos = 3) {
    for (let i = 0; i < reintentos; i++) {
        try {
            const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(rango)}`;
            const res = await serviceAccountAuth.request({ url });
            return res.data.values || [];
        } catch (e) {
            if (e.response && e.response.status === 429) {
                await new Promise(resolve => setTimeout(resolve, (i + 1) * 1500));
            } else { return []; }
        }
    }
    return []; 
}

let ejecutandoGlobal = false;
let pendienteGlobal = false;
let necesitaArranqueProfundo = true; 

async function flujoEncoladoGlobal(esArranque = false) {
    if (esArranque) necesitaArranqueProfundo = true;
    if (ejecutandoGlobal) { pendienteGlobal = true; return; }
    ejecutandoGlobal = true;
    try { 
        let hacerArranque = necesitaArranqueProfundo || cacheDatosGlobales.diagramas === null;
        necesitaArranqueProfundo = false; 
        await actualizarCacheDesdeGoogle(hacerArranque); 
    } finally {
        ejecutandoGlobal = false;
        if (pendienteGlobal) { pendienteGlobal = false; flujoEncoladoGlobal(necesitaArranqueProfundo); }
    }
}

setTimeout(() => { flujoEncoladoGlobal(true); }, 3000); 

async function actualizarCacheDesdeGoogle(esArranque = false) {
    try {
        const normalizar = (n) => String(n || '').trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, ' ');
        let resDiagGAS = { documentos: {}, habilitaciones: {}, dnis: {}, certificados: {}, telefonos: {}, flota: {}, observaciones: {}, aptosMedicos: {} };

        // 1. Carga de estructura maestra H1
        const rowsH1 = await fetchRango(ID_SPREADSHEET_MASTER, "'choferes y unidades'!H1");
        if (rowsH1.length > 0 && rowsH1[0][0]) {
            JSON.parse(rowsH1[0][0]).forEach(c => {
                let norm = normalizar(String(c.nombre));
                resDiagGAS.flota[norm] = { tractor: c.tractor || '', semi: c.semi || '', servicio: c.servicio || '', n_ute: c.n_ute || '', td: c.td || '-', hex1: c.hex1 || '', hex2: c.hex2 || '' };
            });
        }

        // 2. RASTREO MAESTRO: LEGAJOS Y CONTACTOS (Desde planilla 19_UPtQ...)
        let telefonosMap = {}; let dnisMap = {};
        try {
            const rowsLegajos = await fetchRango(ID_SHEET_LEGAJOS_MAESTRO, "'Hoja 1'!A8:P300");
            rowsLegajos.forEach(row => {
                let nomNorm = normalizar(row[1]);
                if (nomNorm) {
                    telefonosMap[nomNorm] = { legajo: row[0] || "", telefono: row[3] || "", email: row[4] || "", fechaAlta: row[10] || "" };
                    let dni = String(row[2] || "").replace(/\D/g, '');
                    if (dni) { dnisMap[nomNorm] = { dni: dni }; telefonosMap[dni] = telefonosMap[nomNorm]; }
                }
            });
            // Refuerzo desde pestaña 'dni' del Maestro
            const rowsDniTab = await fetchRango(ID_SPREADSHEET_MASTER, "'dni'!A1:I300");
            rowsDniTab.forEach(row => {
                let n = normalizar(row[0]); let d = String(row[1]||'').replace(/\D/g,'');
                if (n && d) { dnisMap[n] = { dni: d }; }
            });
            resDiagGAS.telefonos = telefonosMap; resDiagGAS.dnis = dnisMap;
        } catch(e) { console.error("Error cargando Legajos:", e); }

        // ... [Resto de lógica de Aptos, Observaciones, Viajes...]
        // (Mantiene el código anterior de carga de diagramas)
        
        cacheDatosGlobales.diagramas = { ...resDiagGAS, ultimaActualizacion: new Date().toISOString() };
        io.emit('datos_actualizados', cacheDatosGlobales);
    } catch (error) { console.error("❌ Error en construcción:", error); }
}

app.post('/api/proxy', async (req, res) => {
    // ... [Código de Proxy consolidado en el paso anterior]
});

server.listen(process.env.PORT || 3000, () => console.log(`🚀 Servidor Activo`));