const express = require('express');
const { serviceAccountAuth, ID_SPREADSHEET_MASTER } = require('../utils/shared');

module.exports = function createFotosRouter(cacheDatosGlobales, io) {
    const router = express.Router();

    router.post('/', async (req, res) => {
        try {
            const { dni, imagenBase64 } = req.body;

            // 1. Subir a imgbb API
            const formData = new URLSearchParams({ 
                image: imagenBase64.replace(/^data:image\/\w+;base64,/, "") 
            });
            const response = await fetch(`https://api.imgbb.com/1/upload?key=${process.env.IMGBB_API_KEY}`, { 
                method: 'POST', 
                body: formData 
            });
            const imgbbData = await response.json();
            const linkOficial = imgbbData.data.url;

            // 2. Buscar fila existente en hoja 'fotos'
            const responseSheets = await serviceAccountAuth.request({ 
                url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SPREADSHEET_MASTER}/values/'fotos'!A:B` 
            });
            const rowsFotos = responseSheets.data.values || [];
            let rIdx = -1;
            let dniP = String(dni).replace(/\D/g, '');

            for (let i = 0; i < rowsFotos.length; i++) {
                if (String(rowsFotos[i][0]).replace(/\D/g, '') === dniP) {
                    rIdx = i + 1;
                    break;
                }
            }

            // 3. Actualizar fila existente o agregar nueva
            if (rIdx !== -1) {
                await serviceAccountAuth.request({ 
                    url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SPREADSHEET_MASTER}/values/'fotos'!B${rIdx}?valueInputOption=USER_ENTERED`, 
                    method: 'PUT', 
                    data: { values: [[linkOficial]] } 
                });
            } else {
                await serviceAccountAuth.request({ 
                    url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SPREADSHEET_MASTER}/values/'fotos'!A:B:append?valueInputOption=USER_ENTERED`, 
                    method: 'POST', 
                    data: { values: [[dniP, linkOficial]] } 
                });
            }

            // 4. Actualizar cache y emitir evento
            if (!cacheDatosGlobales.diagramas.fotosImgur) {
                cacheDatosGlobales.diagramas.fotosImgur = {};
            }
            cacheDatosGlobales.diagramas.fotosImgur[dniP] = linkOficial;
            
            io.emit('datos_actualizados', cacheDatosGlobales);
            
            res.json({ success: true, link: linkOficial, mensaje: "Foto vinculada." });
        } catch (error) {
            console.error("Error en imagen:", error);
            res.status(500).json({ success: false, error: "Error en imagen." });
        }
    });

    return router;
};
