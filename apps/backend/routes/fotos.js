const express = require('express');
const sharp = require('sharp');
const { Pool } = require('pg');
const { supabase, serviceAccountAuth, ID_SPREADSHEET_MASTER } = require('../utils/shared');
const { emitirDatosSiCambiaron } = require('../cache/builder');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://rsvajuxihvmpmrmlcbul.supabase.co';

module.exports = function createFotosRouter(cacheDatosGlobales, io) {
    const router = express.Router();

    router.post('/', async (req, res) => {
        try {
            const { dni, imagenBase64, chofer_id, fotoUrl } = req.body;
            if (!dni && !chofer_id) {
                return res.status(400).json({ success: false, error: "Identificador de chofer (DNI o ID) no proporcionado." });
            }
            if (!imagenBase64 && !fotoUrl) {
                return res.status(400).json({ success: false, error: "Imagen o URL de foto no proporcionada." });
            }

            const dniP = dni ? String(dni).replace(/\D/g, '') : '';
            let linkOficial = fotoUrl || null;

            if (imagenBase64) {
                const rawBase64 = imagenBase64.replace(/^data:image\/\w+;base64,/, "");
                const inputBuffer = Buffer.from(rawBase64, 'base64');

                // 1. Optimizar y convertir a WebP (384x512 max, calidad 82%)
                const webpBuffer = await sharp(inputBuffer)
                    .resize(384, 512, { fit: 'cover', position: 'center' })
                    .webp({ quality: 82, effort: 4 })
                    .toBuffer();

                // 2. Subir directamente a Supabase Storage (Bucket: choferes-fotos)
                const fileName = dniP ? `${dniP}.webp` : `${chofer_id}.webp`;
                const { error: uploadError } = await supabase.storage
                    .from('choferes-fotos')
                    .upload(fileName, webpBuffer, {
                        contentType: 'image/webp',
                        upsert: true
                    });

                if (uploadError) {
                    console.error("❌ Error subiendo a Supabase Storage:", uploadError.message);
                    return res.status(500).json({ success: false, error: "Error al almacenar foto en Supabase Storage." });
                }

                // URL pública canónica en Supabase CDN
                linkOficial = `${SUPABASE_URL}/storage/v1/object/public/choferes-fotos/${fileName}?t=${Date.now()}`;
            }

            // 3. Persistir en PostgreSQL (public.choferes)
            try {
                if (chofer_id) {
                    await pool.query(
                        `UPDATE public.choferes 
                         SET foto = $1, actualizado_el = NOW() 
                         WHERE id = $2`,
                        [linkOficial, chofer_id]
                    );
                } else if (dniP) {
                    await pool.query(
                        `UPDATE public.choferes 
                         SET foto = $1, actualizado_el = NOW() 
                         WHERE id IN (
                             SELECT chofer_id 
                             FROM chofer_documentacion 
                             WHERE REPLACE(REPLACE(dni, '.', ''), ' ', '') = $2
                         )`,
                        [linkOficial, dniP]
                    );
                }
            } catch (dbErr) {
                console.warn("⚠️ Advertencia al actualizar foto en choferes DB:", dbErr.message);
            }

            // 4. Actualizar memoria RAM en tiempo real
            if (cacheDatosGlobales.diagramas && Array.isArray(cacheDatosGlobales.diagramas.diagramas)) {
                const choferObj = cacheDatosGlobales.diagramas.diagramas.find(c => String(c.dni || '').replace(/\D/g, '') === dniP);
                if (choferObj) {
                    choferObj.foto = linkOficial;
                }
            }
            if (cacheDatosGlobales.choferesRouter) {
                const routerObj = Object.values(cacheDatosGlobales.choferesRouter).find(c => String(c.dni || c.dniFallback || '').replace(/\D/g, '') === dniP);
                if (routerObj) {
                    routerObj.foto = linkOficial;
                }
            }
            if (cacheDatosGlobales.diagramas && cacheDatosGlobales.diagramas.fotosImgur) {
                cacheDatosGlobales.diagramas.fotosImgur[dniP] = linkOficial;
            }

            emitirDatosSiCambiaron(io, cacheDatosGlobales);

            // 5. RESPALDO ASÍNCRONO EN GOOGLE SHEETS (Sin bloquear la respuesta)
            (async () => {
                try {
                    const responseSheets = await serviceAccountAuth.request({ 
                        url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SPREADSHEET_MASTER}/values/'fotos'!A:B` 
                    });
                    const rowsFotos = responseSheets.data.values || [];
                    let rIdx = -1;

                    for (let i = 0; i < rowsFotos.length; i++) {
                        if (String(rowsFotos[i][0]).replace(/\D/g, '') === dniP) {
                            rIdx = i + 1;
                            break;
                        }
                    }

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
                } catch (sheetsErr) {
                    console.warn("⚠️ [Respaldo Sheets] No se pudo guardar copia de respaldo en Sheets:", sheetsErr.message);
                }
            })().catch(() => {});

            res.json({ success: true, link: linkOficial, mensaje: "Foto optimizada (.webp) y vinculada en Supabase." });
        } catch (error) {
            console.error("Error en procesamiento de foto:", error);
            res.status(500).json({ success: false, error: "Error en procesamiento de imagen." });
        }
    });

    return router;
};
