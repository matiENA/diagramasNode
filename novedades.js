// ==========================================
// 🧠 MÓDULO BACKEND: NOVEDADES (novedades.js)
// ==========================================

const ID_SPREADSHEET_MASTER = '1eQ9Y5diL5fwxYTxvseNgZJFbX-lSUQ13axbp3cLiqPc';
const TAB_NOVEDADES = 'novedades';

module.exports = function (io, serviceAccountAuth, cacheDatosGlobales) {
    
    // 1. Inicializar estructura en la RAM protegida
    if (!cacheDatosGlobales.novedades) cacheDatosGlobales.novedades = [];

    // ==========================================
    // 📥 DESCARGA CRUDA: Sincronización Inicial
    // ==========================================
    async function cargarNovedadesRAM() {
        try {
            console.log("📥 [NOVEDADES] Sincronizando con Google Sheets...");
            const response = await serviceAccountAuth.request({ 
                url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SPREADSHEET_MASTER}/values/'${TAB_NOVEDADES}'!A:F` 
            });
            const rows = response.data.values || [];
            
            // Omitimos la cabecera (fila 0) y estructuramos
            if (rows.length > 1) {
                cacheDatosGlobales.novedades = rows.slice(1).map(r => ({
                    id: r[0] || '',
                    tipo: r[1] || '',
                    jerarquia: r[2] ? JSON.parse(r[2]) : {},
                    detalle: r[3] || '',
                    estado: r[4] || 'live',
                    timestamp: r[5] || ''
                })).reverse(); // Ordenamos: Más recientes primero
            }
            console.log(`✅ [NOVEDADES] RAM Ensamblada: ${cacheDatosGlobales.novedades.length} activas/resueltas.`);
        } catch (e) { 
            console.error("❌ [NOVEDADES] Error crítico de lectura:", e.response ? e.response.statusText : e); 
        }
    }

    cargarNovedadesRAM();

    // ==========================================
    // ⚡ SOCKET.IO: Eventos Bidireccionales
    // ==========================================
    io.on('connection', (socket) => {
        
        // Sincronización inicial al conectar cliente
        socket.emit('novedades:sync', cacheDatosGlobales.novedades);

        // A. CREACIÓN DE NOVEDAD
        socket.on('novedad:crear', async (novedad) => {
            // Optimistic UI en el Backend: Actualiza RAM y emite a todos instantáneamente
            cacheDatosGlobales.novedades.unshift(novedad);
            io.emit('novedades:sync', cacheDatosGlobales.novedades);

            try {
                const rowData = [
                    novedad.id, 
                    novedad.tipo, 
                    JSON.stringify(novedad.jerarquia), 
                    novedad.detalle, 
                    novedad.estado, 
                    novedad.timestamp
                ];

                await serviceAccountAuth.request({
                    url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SPREADSHEET_MASTER}/values/'${TAB_NOVEDADES}'!A:F:append?valueInputOption=USER_ENTERED`,
                    method: 'POST',
                    data: { values: [rowData] }
                });
            } catch (e) { console.error("❌ [NOVEDADES] Error escritura append:", e); }
        });

        // B. ACTUALIZACIÓN DE ESTADO (Live <-> Resuelto)
        socket.on('novedad:estado:update', async ({ id, estado }) => {
            // Actualiza RAM local
            const index = cacheDatosGlobales.novedades.findIndex(n => n.id === id);
            if (index !== -1) {
                cacheDatosGlobales.novedades[index].estado = estado;
                io.emit('novedades:sync', cacheDatosGlobales.novedades);
            }

            // Persistencia: Buscar fila por ID y actualizar solo esa celda (Columna E)
            try {
                const response = await serviceAccountAuth.request({ 
                    url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SPREADSHEET_MASTER}/values/'${TAB_NOVEDADES}'!A:A` 
                });
                const rows = response.data.values || [];
                
                let rIdx = -1;
                for (let i = 0; i < rows.length; i++) {
                    if (rows[i][0] === id) { rIdx = i + 1; break; }
                }

                if (rIdx !== -1) {
                    await serviceAccountAuth.request({
                        url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SPREADSHEET_MASTER}/values/'${TAB_NOVEDADES}'!E${rIdx}?valueInputOption=USER_ENTERED`,
                        method: 'PUT',
                        data: { values: [[estado]] }
                    });
                }
            } catch (e) { console.error("❌ [NOVEDADES] Error actualización estado:", e); }
        });
    });
};