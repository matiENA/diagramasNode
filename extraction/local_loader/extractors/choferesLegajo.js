const { fetchRange, normalizar } = require('../utils/sheets');
const {
    ID_SPREADSHEET_MASTER,
    ID_SHEET_DOCUMENTOS,
    ID_SHEET_HABILITACIONES,
    ID_SHEET_APTOS_MEDICOS,
    ID_SHEET_OBSERVACIONES
} = require('../utils/shared');

/**
 * Limpia y normaliza DNI o CUIL extrayendo solo dígitos del DNI (7 u 8 dígitos).
 */
function cleanDni(val) {
    if (!val) return '';
    const digits = String(val).replace(/\D/g, '');
    if (digits.length === 11) return digits.substring(2, 10);
    if (digits.length >= 7 && digits.length <= 8) return digits;
    return digits;
}

/**
 * Normaliza CUIL conservando los 11 dígitos.
 */
function cleanCuil(val) {
    if (!val) return '';
    const digits = String(val).replace(/\D/g, '');
    if (digits.length === 11) {
        return `${digits.substring(0, 2)}-${digits.substring(2, 10)}-${digits.substring(10)}`;
    }
    return String(val).trim();
}

/**
 * Parsea fechas en formatos variados:
 * - DD/MM/YYYY, DD-MM-YYYY, DD/MM/YY
 * - "27 sep 2023", "3 Dec 2024", "1 Jun 2026", "4 sep 2022"
 * - YYYY-MM-DD (ISO)
 */
function parseFechaFlexible(str) {
    if (!str) return null;
    const s = String(str).trim();
    if (!s || s === '-' || s.toLowerCase() === 'ok' || s.startsWith('#')) return null;

    // 1. dd/mm/yyyy o dd-mm-yyyy o dd/mm/yy
    const slashParts = s.split(/[\/\-]/);
    if (slashParts.length === 3 && !isNaN(slashParts[0]) && !isNaN(slashParts[1])) {
        let d = parseInt(slashParts[0], 10);
        let m = parseInt(slashParts[1], 10);
        let y = parseInt(slashParts[2], 10);
        if (y < 100) y += 2000;
        if (d > 0 && d <= 31 && m > 0 && m <= 12 && y > 1900 && y < 2100) {
            return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        }
    }

    // 2. Formato textual: '4 sep 2022', '3 Dec 2024', '1 Jun 2026'
    const textParts = s.split(/\s+/);
    if (textParts.length === 3) {
        const d = parseInt(textParts[0], 10);
        const mStr = textParts[1].toLowerCase().slice(0, 3);
        let y = parseInt(textParts[2], 10);
        if (y < 100) y += 2000;

        const monthMap = {
            ene: 1, jan: 1,
            feb: 2,
            mar: 3,
            abr: 4, apr: 4,
            may: 5,
            jun: 6,
            jul: 7,
            ago: 8, aug: 8,
            sep: 9, set: 9,
            oct: 10,
            nov: 11,
            dic: 12, dec: 12
        };

        const m = monthMap[mStr];
        if (d > 0 && d <= 31 && m && y > 1900 && y < 2100) {
            return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        }
    }

    // 3. Ya en formato ISO YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

    return null;
}

/**
 * Extractor Integral de Legajos, Vencimientos, Estudios Médicos, Aptitud y Observaciones.
 * Integra:
 * 1. Planilla Master tab 'LEGAJOS' (Ficha personal y laboral completa)
 * 2. Planilla Master tab 'DB_CHOFERES' (Índice canónico de emparejamiento fuzzy drv_xxxx)
 * 3. Planilla Control Periódicos (Pestañas 'PERIODICOS' y 'ESTUDIOS')
 * 4. Planilla Vencimientos Conductores (Pestaña 'VENCIMIENTOS')
 * 5. Planilla Estado Actual Choferes SRC (Pestaña 'Seguimiento Avalados Mensual')
 * 6. Planilla Observaciones Choferes Drive (Pestaña 'Movimientos')
 */
async function extractChoferesLegajo(supabaseClient = null) {
    console.log("   • Iniciando extracción unificada de Legajos, Vencimientos y Observaciones...");

    // 1. Descarga paralela de todas las fuentes
    const [
        legajosRows,
        dbChoferesRows,
        periodicosRows,
        estudiosRows,
        vencRows,
        avaladosRows,
        obsRows
    ] = await Promise.all([
        fetchRange(ID_SPREADSHEET_MASTER, "'LEGAJOS'!A2:P").catch(err => {
            console.warn("⚠️ Error leyendo LEGAJOS:", err.message);
            return [];
        }),
        fetchRange(ID_SPREADSHEET_MASTER, "'DB_CHOFERES'!A2:H").catch(err => {
            console.warn("⚠️ Error leyendo DB_CHOFERES:", err.message);
            return [];
        }),
        fetchRange(ID_SHEET_DOCUMENTOS, "'PERIODICOS'!A5:L").catch(err => {
            console.warn("⚠️ Error leyendo PERIODICOS:", err.message);
            return [];
        }),
        fetchRange(ID_SHEET_DOCUMENTOS, "'ESTUDIOS'!A2:N").catch(err => {
            console.warn("⚠️ Error leyendo ESTUDIOS:", err.message);
            return [];
        }),
        fetchRange(ID_SHEET_HABILITACIONES, "'VENCIMIENTOS'!A5:G").catch(err => {
            console.warn("⚠️ Error leyendo VENCIMIENTOS:", err.message);
            return [];
        }),
        fetchRange(ID_SHEET_APTOS_MEDICOS, "'Seguimiento Avalados Mensual'!A2:N").catch(err => {
            console.warn("⚠️ Error leyendo AVALADOS:", err.message);
            return [];
        }),
        fetchRange(ID_SHEET_OBSERVACIONES, "'Movimientos'!A7:N").catch(err => {
            console.warn("⚠️ Error leyendo OBSERVACIONES:", err.message);
            return [];
        })
    ]);

    console.log(`   📊 Datos crudos: ${legajosRows.length} Legajos | ${dbChoferesRows.length} DB_CHOFERES | ${vencRows.length} Vencimientos | ${periodicosRows.length} Periódicos | ${estudiosRows.length} Estudios | ${avaladosRows.length} Avalados | ${obsRows.length} Observaciones`);

    // 2. Obtener choferes de Supabase si cliente disponible
    let supaChoferes = [];
    if (supabaseClient) {
        const { data, error } = await supabaseClient.from('choferes').select('id, nombre, legajo, dni');
        if (!error && data) supaChoferes = data;
    }

    const supaByName = new Map();
    const supaByDni = new Map();
    supaChoferes.forEach(c => {
        supaByName.set(normalizar(c.nombre), c);
        const d = cleanDni(c.dni);
        if (d) supaByDni.set(d, c);
    });

    // 3. Construir índice de emparejamiento desde DB_CHOFERES
    const aliasToDrv = new Map();
    const drvToSupa = new Map();
    const drvMap = new Map();

    dbChoferesRows.forEach(r => {
        const drvId = String(r[0] || '').trim();
        if (!drvId) return;

        const nomVenc = normalizar(r[1]);
        const dniVenc = cleanDni(r[2]);
        const nomPer = normalizar(r[3]);
        const cuilPer = cleanDni(r[4]);
        const nomOtro = normalizar(r[5]);
        const dniCleanVal = cleanDni(r[6]);

        let matchedSupa = supaByName.get(nomVenc) || supaByName.get(nomPer) || supaByName.get(nomOtro);
        if (!matchedSupa && dniCleanVal) matchedSupa = supaByDni.get(dniCleanVal);
        if (!matchedSupa && dniVenc) matchedSupa = supaByDni.get(dniVenc);
        if (!matchedSupa && cuilPer) matchedSupa = supaByDni.get(cuilPer);

        if (matchedSupa) {
            drvToSupa.set(drvId, matchedSupa);
        }

        if (nomVenc) aliasToDrv.set(nomVenc, drvId);
        if (nomPer) aliasToDrv.set(nomPer, drvId);
        if (nomOtro) aliasToDrv.set(nomOtro, drvId);
        if (dniVenc) aliasToDrv.set(`dni_${dniVenc}`, drvId);
        if (cuilPer) aliasToDrv.set(`dni_${cuilPer}`, drvId);
        if (dniCleanVal) aliasToDrv.set(`dni_${dniCleanVal}`, drvId);

        drvMap.set(drvId, {
            drvId,
            nombreRef: r[1] || r[3] || r[5] || '',
            dniRef: dniCleanVal || dniVenc || cuilPer || ''
        });
    });

    // Función universal para resolver chofer en Supabase
    function resolverChofer(nombre, dniOrCuil) {
        const n = normalizar(nombre);
        const d = cleanDni(dniOrCuil);

        if (d && supaByDni.has(d)) return supaByDni.get(d);
        if (n && supaByName.has(n)) return supaByName.get(n);

        const drvId = aliasToDrv.get(n) || (d ? aliasToDrv.get(`dni_${d}`) : null);
        if (drvId && drvToSupa.has(drvId)) return drvToSupa.get(drvId);

        return null;
    }

    // Función para obtener drv_id
    function resolverDrvId(nombre, dniOrCuil) {
        const n = normalizar(nombre);
        const d = cleanDni(dniOrCuil);
        return aliasToDrv.get(n) || (d ? aliasToDrv.get(`dni_${d}`) : null) || null;
    }

    // 4. Consolidar tabla 1:1 chofer_documentacion
    // Estructura indexada por chofer_id (si match en Supabase) o drvId / dni
    const docMap = new Map();

    function getOrCreateDocRecord(supaCh, drvId, nombreFallback, dniFallback) {
        const key = supaCh ? supaCh.id : (drvId || `dni_${cleanDni(dniFallback)}` || normalizar(nombreFallback));
        if (!docMap.has(key)) {
            docMap.set(key, {
                chofer_id: supaCh ? supaCh.id : null,
                drv_codigo: drvId || null,
                nombre: supaCh ? supaCh.nombre : (nombreFallback || '').trim().toUpperCase(),
                dni: supaCh && supaCh.dni ? cleanDni(supaCh.dni) : (cleanDni(dniFallback) || null),
                cuil: null,
                telefono: null,
                email: null,
                empresa: null,
                area: null,
                domicilio: null,
                localidad: null,
                telefono_emergencia: null,
                fecha_alta: null,
                estudios_nivel: null,
                experiencia_anios: null,
                fecha_nacimiento: null,
                edad: null,
                venc_licencia_nacional: null,
                venc_psicofisico: null,
                venc_cargas_peligrosas: null,
                venc_periodico: null,
                venc_curso_shell: null,
                venc_manejo_def: null,
                curso_pae: null,
                apto_medico_venc: null,
                apto_medico_estado: null,
                avalado_contratos: null,
                vacuna_antitetanica: null,
                metabolitos_7: null,
                vacuna_covid: null,
                dosis_covid: null,
                obs_documentacion: null,
                actualizado_el: new Date().toISOString()
            });
        }
        return docMap.get(key);
    }

    // A. Incorporar LEGAJOS
    legajosRows.forEach(r => {
        const nom = String(r[1] || '').trim();
        const dniRaw = String(r[2] || '').trim();
        if (!nom && !dniRaw) return;

        const supaCh = resolverChofer(nom, dniRaw);
        const drvId = resolverDrvId(nom, dniRaw);
        const doc = getOrCreateDocRecord(supaCh, drvId, nom, dniRaw);

        if (r[2]) doc.dni = cleanDni(r[2]) || doc.dni;
        if (r[3]) doc.telefono = String(r[3]).trim();
        if (r[4]) doc.email = String(r[4]).trim();
        if (r[5]) doc.empresa = String(r[5]).trim();
        if (r[6]) doc.area = String(r[6]).trim();
        if (r[7]) doc.domicilio = String(r[7]).trim();
        if (r[8]) doc.localidad = String(r[8]).trim();
        if (r[9]) doc.telefono_emergencia = String(r[9]).trim();
        if (r[10]) doc.fecha_alta = parseFechaFlexible(r[10]);
        if (r[11]) doc.estudios_nivel = String(r[11]).trim();
        if (r[12]) doc.experiencia_anios = String(r[12]).trim();
        if (r[13]) doc.venc_periodico = parseFechaFlexible(r[13]) || doc.venc_periodico;
        if (r[14]) doc.fecha_nacimiento = parseFechaFlexible(r[14]);
        if (r[15]) {
            const parsedAge = parseFloat(String(r[15]).trim().replace(',', '.'));
            if (!isNaN(parsedAge)) doc.edad = parsedAge;
        }
    });

    // B. Incorporar VENCIMIENTOS
    vencRows.forEach(r => {
        const nom = String(r[1] || '').trim();
        const dniRaw = String(r[2] || '').trim();
        if (!nom && !dniRaw) return;

        const supaCh = resolverChofer(nom, dniRaw);
        const drvId = resolverDrvId(nom, dniRaw);
        const doc = getOrCreateDocRecord(supaCh, drvId, nom, dniRaw);

        if (r[3]) doc.venc_cargas_peligrosas = parseFechaFlexible(r[3]) || doc.venc_cargas_peligrosas;
        if (r[4]) doc.venc_licencia_nacional = parseFechaFlexible(r[4]) || doc.venc_licencia_nacional;
        if (r[5]) doc.venc_psicofisico = parseFechaFlexible(r[5]) || doc.venc_psicofisico;
        if (r[6]) {
            const obs = String(r[6]).trim();
            if (obs && obs !== '-') {
                doc.obs_documentacion = doc.obs_documentacion ? `${doc.obs_documentacion} | ${obs}` : obs;
            }
        }
    });

    // C. Incorporar PERIODICOS
    periodicosRows.forEach(r => {
        const nom = String(r[1] || '').trim();
        const cuilRaw = String(r[4] || '').trim();
        if (!nom && !cuilRaw) return;

        const supaCh = resolverChofer(nom, cuilRaw);
        const drvId = resolverDrvId(nom, cuilRaw);
        const doc = getOrCreateDocRecord(supaCh, drvId, nom, cuilRaw);

        if (cuilRaw) doc.cuil = cleanCuil(cuilRaw);
        if (r[8]) doc.venc_periodico = parseFechaFlexible(r[8]) || doc.venc_periodico;
        if (r[9]) {
            const obsTurno = String(r[9]).trim();
            if (obsTurno && obsTurno !== '-') {
                doc.obs_documentacion = doc.obs_documentacion ? `${doc.obs_documentacion} | Turno: ${obsTurno}` : `Turno: ${obsTurno}`;
            }
        }
    });

    // D. Incorporar ESTUDIOS
    estudiosRows.forEach(r => {
        const nom = String(r[1] || '').trim();
        const cuilRaw = String(r[2] || '').trim();
        if (!nom && !cuilRaw) return;

        const supaCh = resolverChofer(nom, cuilRaw);
        const drvId = resolverDrvId(nom, cuilRaw);
        const doc = getOrCreateDocRecord(supaCh, drvId, nom, cuilRaw);

        if (cuilRaw && !doc.cuil) doc.cuil = cleanCuil(cuilRaw);
        if (r[5]) doc.vacuna_antitetanica = String(r[5]).trim();
        if (r[6]) doc.metabolitos_7 = String(r[6]).trim();
        if (r[7]) doc.vacuna_covid = String(r[7]).trim();
        if (r[8]) doc.dosis_covid = String(r[8]).trim();
        if (r[9]) doc.curso_pae = String(r[9]).trim();
        if (r[10]) doc.venc_curso_shell = parseFechaFlexible(r[10]) || doc.venc_curso_shell;
        if (r[11]) doc.venc_manejo_def = parseFechaFlexible(r[11]) || doc.venc_manejo_def;
        if (r[13]) doc.venc_psicofisico = parseFechaFlexible(r[13]) || doc.venc_psicofisico;
    });

    // E. Incorporar AVALADOS
    avaladosRows.forEach(r => {
        const nomRaw = String(r[0] || '').replace(',', ' ').trim();
        const cuilRaw = String(r[1] || '').trim();
        if (!nomRaw && !cuilRaw) return;

        const supaCh = resolverChofer(nomRaw, cuilRaw);
        const drvId = resolverDrvId(nomRaw, cuilRaw);
        const doc = getOrCreateDocRecord(supaCh, drvId, nomRaw, cuilRaw);

        if (cuilRaw && !doc.cuil) doc.cuil = cleanCuil(cuilRaw);
        if (r[2]) doc.apto_medico_estado = String(r[2]).trim();
        if (r[3]) doc.avalado_contratos = String(r[3]).trim();
        if (r[6]) doc.apto_medico_venc = parseFechaFlexible(r[6]) || doc.apto_medico_venc;

        const obsSalud = String(r[11] || '').trim();
        if (obsSalud && obsSalud !== '-') {
            doc.obs_documentacion = doc.obs_documentacion ? `${doc.obs_documentacion} | Salud: ${obsSalud}` : `Salud: ${obsSalud}`;
        }
    });

    // 5. Consolidar tabla 1:N chofer_observaciones
    const observacionesList = [];

    obsRows.forEach(r => {
        const nom = String(r[1] || '').trim();
        const fechaRaw = String(r[2] || '').trim();
        const unidad = String(r[3] || '').trim();
        const evento = String(r[4] || '').trim();
        const obsEvento = String(r[5] || '').trim();
        const estado = String(r[6] || '').trim();
        const obsEstado = String(r[7] || '').trim();
        const adminCarga = String(r[0] || '').trim();

        if (!nom && !evento && !obsEvento) return;

        const supaCh = resolverChofer(nom, null);

        observacionesList.push({
            chofer_id: supaCh ? supaCh.id : null,
            chofer_nombre: nom,
            fecha: parseFechaFlexible(fechaRaw),
            unidad_dominio: unidad || null,
            evento: evento || null,
            obs_evento: obsEvento || null,
            estado: estado || null,
            obs_estado: obsEstado || null,
            admin_carga: adminCarga || null,
            creado_el: new Date().toISOString()
        });
    });

    const docList = Array.from(docMap.values());
    console.log(`   ✅ Extracción completada: ${docList.length} registros de documentación consolidados, ${observacionesList.length} observaciones procesadas.`);

    return {
        documentacion: docList,
        observaciones: observacionesList,
        stats: {
            totalDocumentacion: docList.length,
            conChoferIdSupabase: docList.filter(d => d.chofer_id).length,
            totalObservaciones: observacionesList.length,
            observacionesConChoferId: observacionesList.filter(o => o.chofer_id).length
        }
    };
}

/**
 * Sincroniza la documentación y observaciones directamente hacia Supabase.
 */
async function syncChoferesLegajoSupabase(supabaseClient) {
    if (!supabaseClient) {
        throw new Error("Se requiere instancia de supabaseClient para sincronizar.");
    }

    const { documentacion, observaciones, stats } = await extractChoferesLegajo(supabaseClient);

    console.log("\n🚀 Sincronizando chofer_documentacion a Supabase...");
    // Filtrar los que tienen chofer_id para respetar la FK
    const docsConId = documentacion.filter(d => d.chofer_id);
    const docsSinId = documentacion.filter(d => !d.chofer_id);

    if (docsSinId.length > 0) {
        console.warn(`   ⚠️ ${docsSinId.length} registros de documentación no se vincularon a un chofer activo de Supabase (posibles bajas o históricos).`);
    }

    // Upsert por lotes de 50 en chofer_documentacion
    let upsertedDocs = 0;
    const batchSize = 50;

    for (let i = 0; i < docsConId.length; i += batchSize) {
        const batch = docsConId.slice(i, i + batchSize).map(d => {
            const { nombre, ...rest } = d; // Quitar nombre si no es columna en chofer_documentacion
            return rest;
        });

        const { error } = await supabaseClient
            .from('chofer_documentacion')
            .upsert(batch, { onConflict: 'chofer_id' });

        if (error) {
            console.error(`   ❌ Error al upsertar lote ${i}:`, error.message);
        } else {
            upsertedDocs += batch.length;
        }
    }
    console.log(`   ✅ Sincronizados ${upsertedDocs}/${docsConId.length} legajos en 'chofer_documentacion'.`);

    // Sincronizar observaciones
    console.log("\n🚀 Sincronizando chofer_observaciones a Supabase...");
    const obsConId = observaciones.filter(o => o.chofer_id);

    // Para evitar duplicación en re-sincronizaciones, vaciamos e insertamos o filtramos
    // Usamos batch insert
    let insertedObs = 0;
    // Eliminamos observaciones existentes vinculadas
    await supabaseClient.from('chofer_observaciones').delete().neq('id', '00000000-0000-0000-0000-000000000000');

    for (let i = 0; i < obsConId.length; i += 100) {
        const batch = obsConId.slice(i, i + 100).map(o => {
            const { chofer_nombre, ...rest } = o;
            return rest;
        });

        const { error } = await supabaseClient
            .from('chofer_observaciones')
            .insert(batch);

        if (error) {
            console.error(`   ❌ Error al insertar observaciones lote ${i}:`, error.message);
        } else {
            insertedObs += batch.length;
        }
    }
    console.log(`   ✅ Insertadas ${insertedObs}/${obsConId.length} observaciones en 'chofer_observaciones'.`);

    return {
        success: true,
        upsertedDocs,
        insertedObs,
        stats
    };
}

module.exports = {
    extractChoferesLegajo,
    syncChoferesLegajoSupabase,
    cleanDni,
    cleanCuil,
    parseFechaFlexible
};
