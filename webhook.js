const express = require('express');

module.exports = function(cacheDatosGlobales, io) {
    const router = express.Router();

    router.post('/google', (req, res) => {
        try {
            const body = req.body;
            
            // ==============================================================
            // 1. WEBHOOK: ALGUIEN EDITÓ UN KILÓMETRO EN LA PLANILLA 'KM'
            // ==============================================================
            if (body && body.action === 'webhook_update_viaje') {
                const { chofer, fecha, datos } = body;
                
                if (chofer && fecha && cacheDatosGlobales.diagramas) {
                    if (!cacheDatosGlobales.diagramas.nuevaSeccionViajes) cacheDatosGlobales.diagramas.nuevaSeccionViajes = {};
                    if (!cacheDatosGlobales.diagramas.nuevaSeccionViajes[chofer]) cacheDatosGlobales.diagramas.nuevaSeccionViajes[chofer] = {};
                    
                    cacheDatosGlobales.diagramas.nuevaSeccionViajes[chofer][fecha] = {
                        ...(cacheDatosGlobales.diagramas.nuevaSeccionViajes[chofer][fecha] || {}),
                        ...datos
                    };
                    
                    io.emit('datos_actualizados', cacheDatosGlobales);
                }
                return res.status(200).json({ success: true, message: "Viaje inyectado en RAM" });
            }

            // ==============================================================
            // 2. WEBHOOK: ALGUIEN EDITÓ UN ESTADO EN LA PLANILLA 'DIAGRAMAS'
            // ==============================================================
            if (body && body.action === 'webhook_update_estado') {
                const { chofer, fechaIso, estado, sheetTab } = body;
                
                if (chofer && fechaIso && cacheDatosGlobales.diagramas && cacheDatosGlobales.diagramas.diagramas) {
                    const normalizar = (n) => String(n || '').trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, ' ');
                    const nBuscado = normalizar(chofer);
                    
                    // Buscar al chofer en la RAM
                    const choferObj = cacheDatosGlobales.diagramas.diagramas.find(c => normalizar(c.nom) === nBuscado);
                    
                    if (choferObj) {
                        const estadoLimpio = estado === "" ? "-" : estado;

                        // A. Actualizamos el diccionario ISO absoluto
                        if (!choferObj._diasIso) choferObj._diasIso = {};
                        choferObj._diasIso[fechaIso] = estadoLimpio;

                        // B. Actualizamos la tira separada por comas que lee el frontend
                        if (sheetTab && choferObj.dias && choferObj.dias[sheetTab]) {
                            let tiraDias = choferObj.dias[sheetTab].split(',');
                            let diaNum = parseInt(fechaIso.split('-')[2], 10);
                            
                            if (diaNum >= 1 && diaNum <= 31) {
                                tiraDias[diaNum - 1] = estadoLimpio;
                                choferObj.dias[sheetTab] = tiraDias.join(',');
                            }
                        }
                        
                        console.log(`⚡ [Webhook] Estado de ${chofer} actualizado a "${estadoLimpio}" el ${fechaIso}`);
                        io.emit('datos_actualizados', cacheDatosGlobales);
                    }
                }
                return res.status(200).json({ success: true, message: "Estado inyectado en RAM" });
            }

            return res.status(200).json({ success: true, message: "Ping ignorado/desconocido" });

        } catch (error) {
            console.error("❌ Error crítico en Webhook:", error);
            return res.status(500).json({ success: false, error: "Error procesando el webhook" });
        }
    });

    return router;
};