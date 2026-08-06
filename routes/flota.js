const express = require('express');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { normalizar, serviceAccountAuth, getFechaArgentina, mesesLargo, ID_SHEET_MOVIMIENTOS, fetchRango, getTabName } = require('../utils/shared');

/**
 * Enrutador para la gestión de flota (Movimientos y Asignaciones)
 * @param {Object} cacheDatosGlobales - Memoria en RAM con los datos cacheados
 * @param {Object} [io] - Instancia de Socket.io (opcional)
 */
module.exports = function createFlotaRouter(cacheDatosGlobales, io) {
    const router = express.Router();

    /**
     * GET /api/flota/estado
     * Transforma los datos de movimientos crudos en 3 tablas: unidades, choferes y asignaciones.
     */
    router.get('/estado', (req, res) => {
        try {
            if (!cacheDatosGlobales.movimientos) {
                return res.json({ unidades: [], choferes: [], asignaciones: [] });
            }

            const rawUnidades = cacheDatosGlobales.movimientos.unidades || [];
            const choferesRouter = cacheDatosGlobales.choferesRouter || {};
            const mapaNombre = cacheDatosGlobales.mapaNombreDiagramaAId || {};

            let unidades = [];
            let choferesMap = new Map();
            let asignaciones = [];

            // 1. Inicializar mapa de choferes con DB_CHOFERES
            Object.values(choferesRouter).forEach(ch => {
                choferesMap.set(ch.id, {
                    id: ch.id,
                    nombre: ch.nombre,
                    dni: ch.dni || '',
                    servicio: '',
                    empresa: 'TRANSER',
                    unidad_actual: null
                });
            });

            // 2. Recorrer las unidades
            rawUnidades.forEach(u => {
                let unidad = {
                    n_ute: u.n_ute,
                    tractor: u.tractor,
                    semi: u.semi,
                    cisternado: u.cisternado || '',
                    servicio: u.servicio || 'S/A',
                    estado: u.estado || '🟢',
                    novedades: u.novedades || '',
                    asignacion_actual: null
                };

                let currentAsignacion = null;

                // 3. Escanear días del 1 al 31 para construir asignaciones
                for (let day = 1; day <= 31; day++) {
                    const diaData = u.diasMov && u.diasMov[day];
                    if (!diaData) continue;
                    
                    const choferRaw = diaData.chofer;
                    const isDriver = choferRaw && choferRaw !== '1' && /[a-zA-Záéíóú]/.test(choferRaw);
                    
                    if (isDriver) {
                        const choferNombre = String(choferRaw).trim();
                        const norm = normalizar(choferNombre);
                        let choferId = mapaNombre[norm];
                        
                        // Si no lo encontramos en la DB maestra, lo agregamos como nuevo
                        if (!choferId) {
                            choferId = 'gen_' + norm.replace(/[^a-z0-9]/g, '_');
                            if (!choferesMap.has(choferId)) {
                                choferesMap.set(choferId, {
                                    id: choferId,
                                    nombre: choferNombre,
                                    dni: '',
                                    servicio: u.servicio,
                                    empresa: 'TRANSER',
                                    unidad_actual: null
                                });
                            }
                        }
                        
                        const isoDate = diaData.fecha || '';

                        if (!currentAsignacion || currentAsignacion.chofer_nombre !== choferNombre) {
                            // Cierra la asignación previa
                            if (currentAsignacion) {
                                const lastDayNum = currentAsignacion.dias[currentAsignacion.dias.length - 1];
                                const lastDiaData = u.diasMov[lastDayNum];
                                currentAsignacion.fecha_fin = lastDiaData ? lastDiaData.fecha : null;
                                asignaciones.push(currentAsignacion);
                            }
                            // Inicia nueva asignación
                            currentAsignacion = {
                                id: `a_${u.n_ute}_${choferId}_${isoDate.replace(/-/g, '') || day}`,
                                n_ute: u.n_ute,
                                tractor: u.tractor,
                                chofer_nombre: choferNombre,
                                chofer_id: choferId,
                                servicio: u.servicio,
                                fecha_inicio: isoDate,
                                fecha_fin: null,
                                activa: false,
                                dias: [day]
                            };
                        } else {
                            // Continúa el mismo chofer
                            currentAsignacion.dias.push(day);
                        }
                    } else {
                        // Hueco o estado (no hay chofer), se cierra la asignación actual
                        if (currentAsignacion) {
                            const lastDayNum = currentAsignacion.dias[currentAsignacion.dias.length - 1];
                            const lastDiaData = u.diasMov[lastDayNum];
                            currentAsignacion.fecha_fin = lastDiaData ? lastDiaData.fecha : null;
                            asignaciones.push(currentAsignacion);
                            currentAsignacion = null;
                        }
                    }
                }

                // Cierra si quedó abierta al fin de mes
                if (currentAsignacion) {
                    asignaciones.push(currentAsignacion);
                }
                
                // Determina la asignación activa (la última de la unidad si llega al final)
                const asigsUnit = asignaciones.filter(a => a.n_ute === u.n_ute);
                if (asigsUnit.length > 0) {
                    const lastAsig = asigsUnit[asigsUnit.length - 1];
                    lastAsig.activa = true;
                    lastAsig.fecha_fin = null; // Sigue activa
                    
                    unidad.asignacion_actual = {
                        chofer_nombre: lastAsig.chofer_nombre,
                        fecha_inicio: lastAsig.fecha_inicio,
                        fecha_fin: null
                    };

                    // Actualizar unidad_actual del chofer
                    if (choferesMap.has(lastAsig.chofer_id)) {
                        let chObj = choferesMap.get(lastAsig.chofer_id);
                        chObj.unidad_actual = { n_ute: u.n_ute, tractor: u.tractor };
                        if (!chObj.servicio) chObj.servicio = u.servicio;
                    }
                }

                unidades.push(unidad);
            });

            // Convertir el mapa de choferes a array
            const choferes = Array.from(choferesMap.values());

            res.json({
                unidades,
                choferes,
                asignaciones
            });
        } catch (error) {
            console.error("Error GET /api/flota/estado:", error);
            res.status(500).json({ error: error.message });
        }
    });

    /**
     * GET /api/flota/servicios
     * Retorna la lista de servicios disponibles
     */
    router.get('/servicios', (req, res) => {
        try {
            if (!cacheDatosGlobales.movimientos) {
                return res.json({ servicios: ['LIVIANO', 'METANOL', 'ABASTECEDORES', 'GLP', 'C.GENERALES', 'CAMPO'] });
            }
            res.json({ servicios: cacheDatosGlobales.movimientos.servicios || [] });
        } catch (error) {
            console.error("Error GET /api/flota/servicios:", error);
            res.status(500).json({ error: error.message });
        }
    });

    /**
     * POST /api/flota/asignacion
     * Asigna un chofer a una unidad en un rango de días y actualiza Google Sheets.
     */
    router.post('/asignacion', async (req, res) => {
        try {
            const { n_ute, chofer_nombre, dia_inicio, dia_fin } = req.body;
            if (!n_ute || !chofer_nombre || !dia_inicio) {
                return res.status(400).json({ error: "Faltan datos requeridos (n_ute, chofer_nombre, dia_inicio)" });
            }

            const startDay = parseInt(dia_inicio, 10);
            const endDay = dia_fin ? parseInt(dia_fin, 10) : startDay;

            // 1. Actualizar caché en memoria (RAM)
            if (cacheDatosGlobales.movimientos && cacheDatosGlobales.movimientos.unidades) {
                let unidadRAM = cacheDatosGlobales.movimientos.unidades.find(u => String(u.n_ute).trim() === String(n_ute).trim());
                if (unidadRAM && unidadRAM.diasMov) {
                    for (let i = startDay; i <= endDay; i++) {
                        if (unidadRAM.diasMov[i]) {
                            unidadRAM.diasMov[i].chofer = chofer_nombre;
                        } else {
                            unidadRAM.diasMov[i] = { chofer: chofer_nombre };
                        }
                    }
                }
                
                // Emitir por WebSockets si el objeto io está disponible
                if (io) {
                    io.emit('datos_actualizados', cacheDatosGlobales);
                }
            }

            // 2. Actualizar Google Sheets
            const nombrePestañaMov = await getTabName(ID_SHEET_MOVIMIENTOS, "Mov.Unidades", "Mov.Unidades y Choferes");
            const doc = new GoogleSpreadsheet(ID_SHEET_MOVIMIENTOS, serviceAccountAuth);
            await doc.loadInfo();
            const sheet = doc.sheetsByTitle[nombrePestañaMov];
            
            if (!sheet) {
                return res.status(404).json({ error: "No se encontró la pestaña de Movimientos" });
            }

            // Buscar la fila correspondiente al n_ute (Columna C -> Índice 2)
            await sheet.loadCells('C1:C200'); 
            let targetRow = -1;
            for (let r = 0; r < 200; r++) {
                const cell = sheet.getCell(r, 2);
                if (String(cell.value).trim() === String(n_ute).trim()) {
                    targetRow = r;
                    break;
                }
            }

            if (targetRow === -1) {
                return res.status(404).json({ error: "Unidad no encontrada en la planilla de Movimientos" });
            }

            // La estructura CSV tiene metadata hasta la col 27 (índice 27), días empiezan en índice 28.
            // 13 columnas por día, la columna de chofer es la primera del bloque.
            const COLS_POR_DIA = 13;
            const COL_INICIO = 28; 

            const colStartIdx = COL_INICIO + ((startDay - 1) * COLS_POR_DIA);
            const colEndIdx = COL_INICIO + ((endDay - 1) * COLS_POR_DIA) + COLS_POR_DIA; 
            
            await sheet.loadCells({
                startRowIndex: targetRow,
                endRowIndex: targetRow + 1,
                startColumnIndex: colStartIdx,
                endColumnIndex: colEndIdx
            });

            for (let day = startDay; day <= endDay; day++) {
                const colIdx = COL_INICIO + ((day - 1) * COLS_POR_DIA);
                const cell = sheet.getCell(targetRow, colIdx);
                cell.value = chofer_nombre;
            }

            await sheet.saveUpdatedCells();

            return res.json({ success: true, message: "Asignación actualizada correctamente en Sheet y RAM" });
        } catch (error) {
            console.error("Error POST /api/flota/asignacion:", error);
            res.status(500).json({ error: error.message });
        }
    });

    return router;
};
