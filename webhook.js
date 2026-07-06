const express = require('express');

module.exports = function(cacheDatosGlobales, io) {
    const router = express.Router();

    // Ruta completa: POST /api/webhook/google
    router.post('/google', (req, res) => {
        try {
            const body = req.body;
            
            // 1. Verificamos si es un evento de actualización de kilómetros/hojas de ruta
            if (body && body.action === 'webhook_update_viaje') {
                const { chofer, fecha, datos } = body;
                
                // Aseguramos que la RAM ya esté ensamblada y tengamos los datos base
                if (chofer && fecha && cacheDatosGlobales.diagramas) {
                    console.log(`⚡ [Webhook] Recibido desde Sheets -> Chofer: ${chofer} | Fecha: ${fecha}`);
                    
                    // Verificamos que la estructura del diccionario exista en RAM
                    if (!cacheDatosGlobales.diagramas.nuevaSeccionViajes) {
                        cacheDatosGlobales.diagramas.nuevaSeccionViajes = {};
                    }
                    if (!cacheDatosGlobales.diagramas.nuevaSeccionViajes[chofer]) {
                        cacheDatosGlobales.diagramas.nuevaSeccionViajes[chofer] = {};
                    }
                    
                    // Inyectamos el dato. Usamos spread (...) por si en un futuro hay más campos, no pisarlos.
                    cacheDatosGlobales.diagramas.nuevaSeccionViajes[chofer][fecha] = {
                        ...(cacheDatosGlobales.diagramas.nuevaSeccionViajes[chofer][fecha] || {}),
                        ...datos
                    };
                    
                    // 🚀 Emitimos al instante a todas las pantallas
                    io.emit('datos_actualizados', cacheDatosGlobales);
                }
                
                return res.status(200).json({ success: true, message: "Inyectado en RAM exitosamente" });
            }

            // Si llega algún otro tipo de evento no reconocido
            return res.status(200).json({ success: true, message: "Ping ignorado/desconocido" });

        } catch (error) {
            console.error("❌ Error crítico en Webhook:", error);
            return res.status(500).json({ success: false, error: "Error procesando el webhook" });
        }
    });

    return router;
};