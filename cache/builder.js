const { 
    normalizar, 
    getFechaArgentina, 
    mesesAbrev, 
    mesesLargo, 
    fetchRango, 
    getTabName, 
    serviceAccountAuth, 
    ID_SPREADSHEET_MASTER,
    ID_SPREADSHEET_DIAGRAMAS,
    ID_SHEET_OBSERVACIONES,
    ID_SHEET_APTOS_MEDICOS,
    ID_SHEET_KILOMETROS,
    ID_SHEET_HABILITACIONES,
    ID_SHEET_DOCUMENTOS,
    ID_SHEET_MOVIMIENTOS
} = require('../utils/shared');
const { cargarNovedades, enriquecerNovedadesConFlota, iniciarPollingNovedades } = require('../novedades');

let ejecutandoGlobal = false, pendienteGlobal = false; 

async function flujoEncoladoGlobal(cacheDatosGlobales, io, ioDash) {
    if (ejecutandoGlobal) { pendienteGlobal = true; return; }
    ejecutandoGlobal = true;
    try { await actualizarCacheDesdeGoogle(cacheDatosGlobales, io, ioDash); } 
    finally { ejecutandoGlobal = false; if (pendienteGlobal) { pendienteGlobal = false; flujoEncoladoGlobal(cacheDatosGlobales, io, ioDash); } }
}

async function actualizarCacheDesdeGoogle(cacheDatosGlobales, io, ioDash) {
    try {
        console.log("🚀 INICIANDO DESCARGA CRUDA: Ensamblando RAM protegida...");

        let resDiagGAS = {
            vencimientosObj: [], fotosImgur: {}, observaciones: {}, aptosMedicos: {},
            documentos: {}, habilitaciones: {}, dnis: {}, certificados: {}, telefonos: {}, flota: {}
        };

        let choferesRouter = {};
        let mapaNombreDiagramaAId = {};
        try {
            const rowsDB = await fetchRango(ID_SPREADSHEET_MASTER, "'DB_CHOFERES'!A2:G1000");
            rowsDB.forEach(row => {
                let id = String(row[0] || "").trim();
                if (!id) return;
                let nombre = String(row[1] || "").trim();
                let nombreDiagrama = String(row[5] || "").trim();
                choferesRouter[id] = { id: id, nombre: nombre, dni: String(row[2] || "").replace(/\D/g, ''), cuil: String(row[4] || "").replace(/\D/g, ''), nombreDiagrama: nombreDiagrama, dniFallback: String(row[6] || "").replace(/\D/g, '') };

                if (nombreDiagrama) {
                    let nd = normalizar(nombreDiagrama);
                    mapaNombreDiagramaAId[nd] = id;
                    if (nd.includes('ñ')) mapaNombreDiagramaAId[nd.replace(/ñ/g, 'n')] = id;
                }
                if (nombre) {
                    let nm = normalizar(nombre);
                    if (!mapaNombreDiagramaAId[nm]) mapaNombreDiagramaAId[nm] = id;
                    if (nm.includes('ñ') && !mapaNombreDiagramaAId[nm.replace(/ñ/g, 'n')]) mapaNombreDiagramaAId[nm.replace(/ñ/g, 'n')] = id;
                }
            });
            cacheDatosGlobales.choferesRouter = choferesRouter; 
            cacheDatosGlobales.mapaNombreDiagramaAId = mapaNombreDiagramaAId;
        } catch (e) {}

        // 👉 DELEGAMOS LA CARGA DE NOVEDADES AL MÓDULO EXTERNO (PASANDO EL MAPA DE CHOFERES)
        await cargarNovedades(fetchRango, ID_SPREADSHEET_MASTER, cacheDatosGlobales, mapaNombreDiagramaAId);

        // Poda: mantener solo novedades activas + resueltas de los últimos 7 días
        const LIMITE_RESUELTAS_MS = 7 * 24 * 60 * 60 * 1000;
        const ahora = Date.now();
        cacheDatosGlobales.novedades = (cacheDatosGlobales.novedades || []).filter(n => 
            !n.resuelto || !n.fecha_resolucion || (ahora - new Date(n.fecha_resolucion).getTime()) < LIMITE_RESUELTAS_MS
        );

        let listaChoferesMaestros = [];
        let catalogoUnidades = [];
        let mapaChoferAUt = {};
        let marcasTractores = {};
        let marcasSemis = {};
        let vencimientosPorPatente = {};
        try {
            let hoyAr = getFechaArgentina();
            let anio = hoyAr.getFullYear(); 
            let nombreHojaActual = mesesAbrev[hoyAr.getMonth()] + "-" + String(anio).slice(-2);
            
            (await fetchRango(ID_SPREADSHEET_DIAGRAMAS, `'${nombreHojaActual}'!A6:C1000`)).forEach(row => {
                if (row[1] && !["APELLIDO Y NOMBRE", "Personal Activo"].includes(row[1])) {
                    let norm = normalizar(row[1]);
                    if (!resDiagGAS.flota[norm]) { 
                        let objFlota = { tractor: '', semi: '', servicio: row[2] || 'S/A', n_ute: '', cisternado: '' };
                        resDiagGAS.flota[norm] = objFlota; 
                        if (norm.includes('ñ')) resDiagGAS.flota[norm.replace(/ñ/g, 'n')] = objFlota;
                        listaChoferesMaestros.push({ nombre: String(row[1]).trim(), norm }); 
                    }
                }
            });

            // 1. Cargar marcas de tractores y semis, y vencimientos de patentes (Uni QM)
            try {
                const [rowsTractores, rowsSemis, rowsUniQM] = await Promise.all([
                    fetchRango(ID_SPREADSHEET_MASTER, "'TRACTORES'!C2:D300").catch(() => []),
                    fetchRango(ID_SPREADSHEET_MASTER, "'SEMIS'!C2:D300").catch(() => []),
                    fetchRango(ID_SHEET_MOVIMIENTOS, "'base datos Uni QM'!A3:F1500").catch(() => [])
                ]);

                rowsTractores.forEach(r => {
                    let pat = String(r[0] || '').trim().toUpperCase().replace(/\s+/g, '');
                    let marca = String(r[1] || '').trim();
                    if (pat && marca && pat !== 'DOMINIO') marcasTractores[pat] = marca;
                });

                rowsSemis.forEach(r => {
                    let pat = String(r[0] || '').trim().toUpperCase().replace(/\s+/g, '');
                    let marca = String(r[1] || '').trim();
                    if (pat && marca && pat !== 'DOMINIO') marcasSemis[pat] = marca;
                });

                resDiagGAS.vencimientosObj = rowsUniQM.map(row => {
                    let patente = String(row[0] || '').trim().toUpperCase().replace(/\s+/g, '');
                    if (!patente || patente === 'PATENTE') return null;
                    let objV = {
                        patente: patente,
                        mas: String(row[1] || '').trim(),
                        vtv: String(row[2] || '').trim(),
                        esp_es: String(row[3] || '').trim(),
                        vi: String(row[4] || '').trim(),
                        ve: String(row[5] || '').trim()
                    };
                    vencimientosPorPatente[patente] = objV;
                    return objV;
                }).filter(Boolean);
                console.log(`🚚 Vencimientos de unidades cargados desde 'base datos Uni QM': ${resDiagGAS.vencimientosObj.length} unidades.`);
            } catch (eUni) {
                console.error("Error cargando marcas / vencimientos de unidades:", eUni);
            }

            // 2. Parseo estructurado de la planilla mensual de Movimientos
            let nombrePestañaMov = await getTabName(ID_SHEET_MOVIMIENTOS, "Mov.Unidades", "Mov.Unidades y Choferes");
            const rowsMov = await fetchRango(ID_SHEET_MOVIMIENTOS, `'${nombrePestañaMov}'!A1:ZZ1000`);
            
            if (rowsMov.length > 0) {
                let dateMap = [];
                const row0 = rowsMov[0] || [];

                function parseHeaderDate(str) {
                    if (!str) return null;
                    let clean = String(str).toLowerCase().replace(/\s+/g, ' ').trim();
                    let matchWord = clean.match(/(\d{1,2})[\s/\-de]+([a-z]+)[\s/\-de]+(\d{2,4})/);
                    if (matchWord) {
                        let day = parseInt(matchWord[1], 10);
                        let mStr = matchWord[2].substring(0, 3);
                        let monthIdx = mesesAbrev.map(m => m.toLowerCase()).indexOf(mStr);
                        if (monthIdx === -1) monthIdx = mesesLargo.map(m => m.toLowerCase()).indexOf(matchWord[2]);
                        let year = parseInt(matchWord[3], 10);
                        if (year < 100) year += 2000;
                        if (monthIdx !== -1 && day >= 1 && day <= 31) return new Date(year, monthIdx, day);
                    }
                    let matchSlash = clean.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
                    if (matchSlash) {
                        let day = parseInt(matchSlash[1], 10);
                        let monthIdx = parseInt(matchSlash[2], 10) - 1;
                        let year = parseInt(matchSlash[3], 10);
                        if (year < 100) year += 2000;
                        return new Date(year, monthIdx, day);
                    }
                    return null;
                }

                row0.forEach((cell, cIdx) => {
                    let parsedDate = parseHeaderDate(cell);
                    if (parsedDate) {
                        let choferCol = Math.max(0, cIdx - 3);
                        dateMap.push({ colFecha: cIdx, colNom: choferCol, dateObj: parsedDate });
                    }
                });

                let todayStr = hoyAr.toISOString().split('T')[0];
                let selectedDateCol = dateMap.find(d => d.dateObj.toISOString().split('T')[0] === todayStr);

                if (!selectedDateCol) {
                    let validPast = dateMap.filter(d => d.dateObj <= hoyAr).sort((a,b) => b.dateObj - a.dateObj);
                    if (validPast.length > 0) selectedDateCol = validPast[0];
                }
                if (!selectedDateCol && dateMap.length > 0) {
                    selectedDateCol = dateMap[dateMap.length - 1];
                }

                const ESTADOS_ICONOS = ['⚪', '🟢', '🔴', '🟡', '🔵', '⚫', '🟣'];
                let currentSrvUt = 'S/A';

                for (let i = 1; i < rowsMov.length; i++) {
                    let row = rowsMov[i];
                    if (!row || row.length === 0) continue;

                    let col0 = String(row[0] || '').trim();
                    let col2 = String(row[2] || '').trim();
                    let col4 = String(row[4] || '').trim();
                    let col5 = String(row[5] || '').trim();

                    // Detectar cabecera de sección de servicio (ej: LIVIANO, METANOL, CAMPO, SOCIO, etc.)
                    if (col0 && !ESTADOS_ICONOS.includes(col0) && !col2 && !col4 && !col5) {
                        currentSrvUt = col0.toUpperCase();
                        continue;
                    }

                    let n_ute = col2;
                    let cistVal = String(row[3] || '').trim();
                    let tractorPat = col4.toUpperCase().replace(/\s+/g, '');
                    let semiPat = col5.toUpperCase().replace(/\s+/g, '');

                    if (!tractorPat && !semiPat && !n_ute) continue;
                    if (cistVal.toLowerCase() === 'cisternado') continue;



                    let objTractor = tractorPat ? {
                        patente: tractorPat,
                        marca: marcasTractores[tractorPat] || '',
                        vencimientos: vencimientosPorPatente[tractorPat] || null
                    } : null;

                    let objSemi = semiPat ? {
                        patente: semiPat,
                        marca: marcasSemis[semiPat] || '',
                        cisternado: cistVal || '',
                        vencimientos: vencimientosPorPatente[semiPat] || null
                    } : null;

                    let choferAsignado = null;
                    if (selectedDateCol) {
                        let nomRaw = String(row[selectedDateCol.colNom] || '').trim();
                        if (nomRaw && nomRaw !== '1' && nomRaw.length >= 3) {
                            let norm = normalizar(nomRaw);
                            let safeId = "drv_" + norm.replace(/ñ/g, 'n').replace(/[^a-z0-9]/g, "_");
                            choferAsignado = { nom: nomRaw, _safeId: safeId };
                        }
                    }

                    let objUt = {
                        n_ute: n_ute || '',
                        srv_ut: currentSrvUt,
                        tractor: objTractor,
                        semi: objSemi,
                        chofer_asignado: choferAsignado
                    };

                    catalogoUnidades.push(objUt);

                    // Si hay chofer asignado en la fecha seleccionada, vincular en mapa
                    if (choferAsignado) {
                        let nomRaw = choferAsignado.nom;
                        let norm = normalizar(nomRaw);
                        let targetKey = norm;
                        if (mapaNombreDiagramaAId) {
                            let choferId = mapaNombreDiagramaAId[norm] || (norm.includes('ñ') ? mapaNombreDiagramaAId[norm.replace(/ñ/g, 'n')] : null);
                            if (choferId && choferesRouter[choferId]) {
                                let diagName = normalizar(choferesRouter[choferId].nombreDiagrama || choferesRouter[choferId].nombre);
                                if (resDiagGAS.flota[diagName]) targetKey = diagName;
                                else if (diagName.includes('ñ') && resDiagGAS.flota[diagName.replace(/ñ/g, 'n')]) targetKey = diagName.replace(/ñ/g, 'n');
                            }
                        }
                        if (!resDiagGAS.flota[targetKey]) {
                            let keys = Object.keys(resDiagGAS.flota);
                            let foundKey = keys.find(k => k === norm || (norm.includes('ñ') && k === norm.replace(/ñ/g, 'n')));
                            if (foundKey) targetKey = foundKey;
                        }

                        mapaChoferAUt[targetKey] = objUt;
                        mapaChoferAUt[norm] = objUt;
                        if (targetKey.includes('ñ')) mapaChoferAUt[targetKey.replace(/ñ/g, 'n')] = objUt;
                        if (norm.includes('ñ')) mapaChoferAUt[norm.replace(/ñ/g, 'n')] = objUt;

                        if (resDiagGAS.flota[targetKey]) {
                            if (n_ute) resDiagGAS.flota[targetKey].n_ute = n_ute;
                            if (tractorPat) resDiagGAS.flota[targetKey].tractor = tractorPat;
                            if (semiPat) resDiagGAS.flota[targetKey].semi = semiPat;
                            if (cistVal) resDiagGAS.flota[targetKey].cisternado = cistVal;
                            resDiagGAS.flota[targetKey].srv_ut = currentSrvUt;
                        }
                    }
                }
            }
        } catch (e) { console.error("Error en lectura de Movimientos / Unidades:", e); }

        let dnisMap = {}; let telefonosMap = {};
        try {
            (await fetchRango(ID_SPREADSHEET_MASTER, "'dni'!A1:D500")).forEach(row => { 
                let n = String(row[0] || "").trim(); 
                let dni = String(row[2] || "").replace(/\D/g, ''); 
                if (n && dni) {
                    let norm = normalizar(n);
                    let valDni = { dni: String(parseInt(dni, 10)) };
                    dnisMap[norm] = valDni;
                    if (norm.includes('ñ')) dnisMap[norm.replace(/ñ/g, 'n')] = valDni;
                }
            });
            (await fetchRango(ID_SPREADSHEET_MASTER, "'LEGAJOS'!A2:P350")).forEach(row => {
                let n = String(row[1] || "").trim(); if (!n || n.toLowerCase().includes("baja")) return; let norm = normalizar(n);
                let datos = { legajo: String(row[0] || "").trim(), telefono: String(row[3] || "").trim(), email: String(row[4] || "").trim(), fechaAlta: String(row[10] || "").trim() };
                telefonosMap[norm] = datos; 
                if (norm.includes('ñ')) telefonosMap[norm.replace(/ñ/g, 'n')] = datos;
                let dni = String(row[2] || "").replace(/\D/g, '');
                if (dni && !dnisMap[norm]) {
                    let valDni = { dni: String(parseInt(dni, 10)) };
                    dnisMap[norm] = valDni;
                    if (norm.includes('ñ')) dnisMap[norm.replace(/ñ/g, 'n')] = valDni;
                }
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
                    let norm = normalizar(n);
                    resDiagGAS.aptosMedicos[dni] = objApto; 
                    resDiagGAS.aptosMedicos[norm] = objApto;
                    if (norm.includes('ñ')) resDiagGAS.aptosMedicos[norm.replace(/ñ/g, 'n')] = objApto;
                }
            }
        } catch (e) {}
        
        const rowsObs = await fetchRango(ID_SHEET_OBSERVACIONES, "'Movimientos'!A5:H2000");
        resDiagGAS.observaciones = {};
        rowsObs.forEach(row => {
            if(!row[1]) return; 
            let norm = normalizar(row[1]); 
            if (!resDiagGAS.observaciones[norm]) resDiagGAS.observaciones[norm] = [];
            let obsItem = { admin: row[0] || "-", fecha: row[2] || "-", unidad: row[3] || "-", evento: row[4] || "-", obsEvento: row[5] || "", estado: row[6] || "-", obsEstado: row[7] || "" };
            resDiagGAS.observaciones[norm].push(obsItem);
            if (norm.includes('ñ')) {
                let sinEnie = norm.replace(/ñ/g, 'n');
                if (!resDiagGAS.observaciones[sinEnie]) resDiagGAS.observaciones[sinEnie] = resDiagGAS.observaciones[norm];
            }
        });

        let diasLegacyIso = {}; let hojasInfo = []; let nuevaSeccionViajes = {};
        try {
            const hoyArKm = (typeof getFechaArgentina === 'function') ? getFechaArgentina() : new Date();
            // Ventana de 12 meses (365 días hacia atrás) para mantener en RAM el registro visualizable del Kiosko
            const limite12MesesMs = hoyArKm.getTime() - (365 * 24 * 3600 * 1000);
            const parseNum = (val) => parseFloat(String(val || '').replace(/,/g, '.').replace(/[^0-9.-]/g, '')) || 0;

            (await fetchRango(ID_SHEET_KILOMETROS, "'KM'!A2:T")).forEach(row => {
                let fRaw = row[1], nRaw = row[2]; if (!fRaw || !nRaw) return;
                let dObj, parts = String(fRaw).split(' ')[0].split(/[\/\-]/);
                if (parts.length >= 3) { let aa = parts[2].length === 2 ? "20" + parts[2] : parts[2]; dObj = new Date(aa, parseInt(parts[1], 10) - 1, parts[0]); } else { dObj = new Date(fRaw); }
                if (isNaN(dObj.getTime())) return;
                
                // Descartar registros históricos mayores a 12 meses (Cold Storage)
                if (dObj.getTime() < limite12MesesMs) return;

                let choferNorm = normalizar(nRaw); let isoDate = dObj.toISOString().split('T')[0];
                let km = parseNum(row[16]) > 0 ? parseNum(row[16]) : parseNum(row[8]); let campo = parseNum(row[5]); let hojaStr = String(row[19] || "").trim();
                if (km > 0 || campo > 0 || hojaStr !== "") {
                    if (!nuevaSeccionViajes[choferNorm]) nuevaSeccionViajes[choferNorm] = {};
                    if (!nuevaSeccionViajes[choferNorm][isoDate]) nuevaSeccionViajes[choferNorm][isoDate] = { dominio: String(row[0] || '').trim(), km: 0, campo: 0, hoja_ruta: [] };
                    let target = nuevaSeccionViajes[choferNorm][isoDate]; target.km += km; target.campo += campo;
                    if (hojaStr !== "") hojaStr.split(',').map(s => s.trim()).filter(Boolean).forEach(h => { if (!target.hoja_ruta.includes(h)) target.hoja_ruta.push(h); });
                    if (choferNorm.includes('ñ')) {
                        let sinEnie = choferNorm.replace(/ñ/g, 'n');
                        nuevaSeccionViajes[sinEnie] = nuevaSeccionViajes[choferNorm];
                    }
                }
            });
        } catch(e) {}



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
                    const regDoc = (k) => {
                        if (!k) return;
                        resDiagGAS.documentos[k] = obj;
                        if (k.includes('ñ')) resDiagGAS.documentos[k.replace(/ñ/g, 'n')] = obj;
                    };
                    regDoc(sheetName);
                    regDoc(diagName);
                    regDoc(explicitDiagName);
                    regDoc(routerName);
                    regDoc(fallbackRouterName);
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
                    const regCert = (k) => {
                        if (!k) return;
                        resDiagGAS.certificados[k] = obj;
                        if (k.includes('ñ')) resDiagGAS.certificados[k.replace(/ñ/g, 'n')] = obj;
                    };
                    regCert(sheetName);
                    regCert(diagName);
                    regCert(explicitDiagName);
                    regCert(routerName);
                    regCert(fallbackRouterName);
                } 
                if (l) { 
                    let obj = { ven: l, estado: calcEst(r[4]) };
                    const regHab = (k) => {
                        if (!k) return;
                        resDiagGAS.habilitaciones[k] = obj;
                        if (k.includes('ñ')) resDiagGAS.habilitaciones[k.replace(/ñ/g, 'n')] = obj;
                    };
                    regHab(sheetName);
                    regHab(diagName);
                    regHab(explicitDiagName);
                    regHab(routerName);
                    regHab(fallbackRouterName);
                } 
            });
        } catch(e) { console.error("Error cargando docs/habs:", e); }

        // 1. Cargar cache histórico de diagramas desde Master (CACHE_DIAGRAMAS tab)
        diasLegacyIso = {};
        try {
            const rowsMasterCache = await fetchRango(ID_SPREADSHEET_MASTER, "'CACHE_DIAGRAMAS'!A2:C1000");
            rowsMasterCache.forEach(r => {
                let norm = normalizar(r[0]);
                if (norm && r[1]) {
                    try {
                        diasLegacyIso[norm] = JSON.parse(r[1]);
                    } catch(eJson) {}
                }
            });
            console.log(`📦 Cache de diagramas cargado desde Master: ${Object.keys(diasLegacyIso).length} choferes.`);
        } catch(eMasterCache) {
            console.error("Error leyendo CACHE_DIAGRAMAS de Master:", eMasterCache);
        }

        let hoyAr2 = getFechaArgentina();
        let offsetsMeses = [-1, 0, 1, 2]; 
        for (let i of offsetsMeses) {
            let d = new Date(hoyAr2.getFullYear(), hoyAr2.getMonth() + i, 1); 
            let anio = d.getFullYear(); 
            let targetMonthNum = d.getMonth() + 1;
            let mesStr = String(targetMonthNum).padStart(2, '0');
            let nombreHoja = mesesAbrev[d.getMonth()] + "-" + String(anio).slice(-2); 

            const rowsSheet = await fetchRango(ID_SPREADSHEET_DIAGRAMAS, `'${nombreHoja}'!A1:AL1000`);
            if (rowsSheet.length === 0) continue;

            let dayColMap = {};
            for (let r = 0; r < Math.min(10, rowsSheet.length); r++) {
                let tempMap = {};
                let matchesCount = 0;
                if (!rowsSheet[r]) continue;

                for (let c = 0; c < rowsSheet[r].length; c++) {
                    let cellVal = String(rowsSheet[r][c] || "").trim();
                    let m = cellVal.match(/^0*([1-9]|[12][0-9]|3[01])[\/\-](0*([1-9]|1[0-2]))$/);
                    if (m) {
                        let dayNum = parseInt(m[1], 10);
                        let monthNum = parseInt(m[2], 10);
                        if (monthNum === targetMonthNum) {
                            if (tempMap[dayNum] === undefined) {
                                tempMap[dayNum] = c;
                                matchesCount++;
                            }
                        }
                    }
                }

                if (matchesCount >= 15) {
                    dayColMap = tempMap;
                    break;
                }
            }

            const maxDaysInMonth = new Date(anio, targetMonthNum, 0).getDate();

            if (Object.keys(dayColMap).length === 0) {
                let offsetDia1 = 4;
                const patronDia1 = new RegExp(`^0*1[\\\/\\-]${targetMonthNum}$`);
                outer: for (let r = 0; r < Math.min(12, rowsSheet.length); r++) {
                    if (!rowsSheet[r]) continue;
                    for (let c = 0; c < rowsSheet[r].length; c++) {
                        let cellVal = String(rowsSheet[r][c] || '').trim();
                        if (patronDia1.test(cellVal)) {
                            offsetDia1 = c;
                            break outer;
                        }
                    }
                }
                for (let dia = 1; dia <= maxDaysInMonth; dia++) dayColMap[dia] = offsetDia1 + (dia - 1);
            }

            rowsSheet.forEach(row => {
                let n = row[1]; 
                if (!n || ["APELLIDO Y NOMBRE", "Personal Activo", "LEGAJO"].includes(String(n).trim())) return; 
                let nomNorm = normalizar(n); 
                if (!diasLegacyIso[nomNorm]) diasLegacyIso[nomNorm] = {};

                for (let dia = 1; dia <= maxDaysInMonth; dia++) { 
                    let colIdx = dayColMap[dia];
                    let est = colIdx !== undefined ? row[colIdx] : undefined; 
                    if (est && est !== '-') {
                        diasLegacyIso[nomNorm][`${anio}-${mesStr}-${String(dia).padStart(2, '0')}`] = String(est).toUpperCase().trim(); 
                    }
                }
            });
        }

        // Construir hojasInfo para TODOS los meses del año (para que el front tenga la tira completa de cada mes)
        let baseYear = hoyAr2.getFullYear();
        hojasInfo = [];
        let mesesTotal = [
            { anio: baseYear - 1, mes: 11 }, { anio: baseYear - 1, mes: 12 },
            { anio: baseYear, mes: 1 }, { anio: baseYear, mes: 2 }, { anio: baseYear, mes: 3 }, { anio: baseYear, mes: 4 },
            { anio: baseYear, mes: 5 }, { anio: baseYear, mes: 6 }, { anio: baseYear, mes: 7 }, { anio: baseYear, mes: 8 },
            { anio: baseYear, mes: 9 }, { anio: baseYear, mes: 10 }, { anio: baseYear, mes: 11 }, { anio: baseYear, mes: 12 },
            { anio: baseYear + 1, mes: 1 }, { anio: baseYear + 1, mes: 2 }
        ];
        mesesTotal.forEach(m => {
            let mesStr = String(m.mes).padStart(2, '0');
            let nombreHoja = mesesAbrev[m.mes - 1] + "-" + String(m.anio).slice(-2);
            hojasInfo.push({ nombre: nombreHoja, anio: m.anio, mesStr });
        });

        let diagramasHibridos = []; 
        listaChoferesMaestros.forEach(ch => {
            let nomNorm = ch.norm;
            let nomNormSinEnie = nomNorm.includes('ñ') ? nomNorm.replace(/ñ/g, 'n') : null;
            let flota = resDiagGAS.flota[nomNorm] || {};
            let mergeIso = diasLegacyIso[nomNorm] || {};
            let diasFront = {};
            hojasInfo.forEach(info => {
                let tira = [];
                for (let dia = 1; dia <= 31; dia++) {
                    tira.push(mergeIso[`${info.anio}-${info.mesStr}-${String(dia).padStart(2, '0')}`] || "-");
                }
                diasFront[info.nombre] = tira.join(",");
            });

            let safeId = "drv_" + nomNorm.replace(/ñ/g, 'n').replace(/[^a-z0-9]/g, "_");
            let utChofer = mapaChoferAUt[nomNorm] || (nomNormSinEnie ? mapaChoferAUt[nomNormSinEnie] : null) || null;
            if (utChofer) {
                utChofer.chofer_asignado = { nom: ch.nombre, _safeId: safeId };
            }

            // Datos centralizados de identidad, contacto, fotos y documentos
            let dniVal = (resDiagGAS.dnis[nomNorm]?.dni || (nomNormSinEnie ? resDiagGAS.dnis[nomNormSinEnie]?.dni : null)) || '';
            let fotoUrl = (dniVal && resDiagGAS.fotosImgur[dniVal]) ? resDiagGAS.fotosImgur[dniVal] : '';
            let contactoObj = resDiagGAS.telefonos[nomNorm] || (nomNormSinEnie ? resDiagGAS.telefonos[nomNormSinEnie] : null) || (dniVal ? resDiagGAS.telefonos[dniVal] : null) || null;
            let aptoMed = (dniVal ? resDiagGAS.aptosMedicos[dniVal] : null) || resDiagGAS.aptosMedicos[nomNorm] || (nomNormSinEnie ? resDiagGAS.aptosMedicos[nomNormSinEnie] : null) || null;
            let docMed = resDiagGAS.documentos[nomNorm] || (nomNormSinEnie ? resDiagGAS.documentos[nomNormSinEnie] : null) || null;
            let docLic = resDiagGAS.habilitaciones[nomNorm] || (nomNormSinEnie ? resDiagGAS.habilitaciones[nomNormSinEnie] : null) || null;
            let docCert = resDiagGAS.certificados[nomNorm] || (nomNormSinEnie ? resDiagGAS.certificados[nomNormSinEnie] : null) || null;
            let obsList = resDiagGAS.observaciones[nomNorm] || (nomNormSinEnie ? resDiagGAS.observaciones[nomNormSinEnie] : null) || [];
            let viajesChofer = nuevaSeccionViajes[nomNorm] || (nomNormSinEnie ? nuevaSeccionViajes[nomNormSinEnie] : null) || {};

            diagramasHibridos.push({
                _safeId: safeId,
                nom: ch.nombre,
                srv_chofer: flota.servicio || 'S/A',
                dni: dniVal,
                foto: fotoUrl,
                contacto: contactoObj ? {
                    telefono: contactoObj.telefono || '',
                    email: contactoObj.email || '',
                    legajo: contactoObj.legajo || '',
                    fechaAlta: contactoObj.fechaAlta || ''
                } : null,
                documentos: {
                    medico: docMed,
                    licencia: docLic,
                    certificados: docCert,
                    apto_medico: aptoMed
                },
                dias: diasFront,
                ut: utChofer,
                observaciones: obsList,
                viajes: viajesChofer
            });
        });

        // Enriquecer catálogo completo de unidades y vencimientos para Control de Flota
        const patentesRegistradas = new Set();
        let listaVencimientosCompleta = [];

        (resDiagGAS.vencimientosObj || []).forEach(v => {
            if (!v || !v.patente) return;
            const pat = String(v.patente).trim().toUpperCase();
            patentesRegistradas.add(pat);

            const esSemi = !!marcasSemis[pat] || (!marcasTractores[pat] && !v.esp_es && !v.vi && !v.ve);
            const marca = marcasTractores[pat] || marcasSemis[pat] || '';

            const item = {
                ...v,
                patente: pat,
                marca: marca,
                esSemi: esSemi,
                tipo: esSemi ? 'SEMI' : 'TRACTOR',
                // Compatibilidad retroactiva
                col_b: pat,
                col_g: !esSemi ? (v.mas || '') : '',
                col_h: !esSemi ? (v.vtv || '') : '',
                col_j: esSemi ? (v.mas || '') : '',
                col_k: esSemi ? (v.vtv || '') : '',
                col_l: v.esp_es || '',
                col_m: v.vi || '',
                col_n: v.ve || ''
            };
            listaVencimientosCompleta.push(item);
        });

        // Asegurar que tractores y semis de catalogoUnidades que no estén en Uni QM se agreguen
        catalogoUnidades.forEach(ut => {
            if (ut.tractor?.patente) {
                const patTr = String(ut.tractor.patente).trim().toUpperCase();
                if (!patentesRegistradas.has(patTr)) {
                    patentesRegistradas.add(patTr);
                    const vTr = ut.tractor.vencimientos || {};
                    listaVencimientosCompleta.push({
                        patente: patTr,
                        marca: ut.tractor.marca || marcasTractores[patTr] || '',
                        esSemi: false,
                        tipo: 'TRACTOR',
                        mas: vTr.mas || '',
                        vtv: vTr.vtv || '',
                        esp_es: vTr.esp_es || '',
                        vi: vTr.vi || '',
                        ve: vTr.ve || '',
                        col_b: patTr,
                        col_g: vTr.mas || '',
                        col_h: vTr.vtv || '',
                        col_j: '',
                        col_k: '',
                        col_l: vTr.esp_es || '',
                        col_m: vTr.vi || '',
                        col_n: vTr.ve || ''
                    });
                }
            }
            if (ut.semi?.patente) {
                const patSe = String(ut.semi.patente).trim().toUpperCase();
                if (!patentesRegistradas.has(patSe)) {
                    patentesRegistradas.add(patSe);
                    const vSe = ut.semi.vencimientos || {};
                    listaVencimientosCompleta.push({
                        patente: patSe,
                        marca: ut.semi.marca || marcasSemis[patSe] || '',
                        esSemi: true,
                        tipo: 'SEMI',
                        cisternado: ut.semi.cisternado || '',
                        mas: vSe.mas || '',
                        vtv: vSe.vtv || '',
                        esp_es: vSe.esp_es || '',
                        vi: vSe.vi || '',
                        ve: vSe.ve || '',
                        col_b: patSe,
                        col_g: '',
                        col_h: '',
                        col_j: vSe.mas || '',
                        col_k: vSe.vtv || '',
                        col_l: vSe.esp_es || '',
                        col_m: vSe.vi || '',
                        col_n: vSe.ve || ''
                    });
                }
            }
        });

        resDiagGAS.vencimientosObj = listaVencimientosCompleta;

        // Mapa indexado de UTs por N° UTE para búsqueda inmediata O(1)
        const mapaUtPorNumero = {};
        catalogoUnidades.forEach(u => {
            if (u.n_ute) mapaUtPorNumero[u.n_ute] = u;
        });

        cacheDatosGlobales.diagramas = { 
            diagramas: diagramasHibridos,
            ut: catalogoUnidades,             // Grupo completo de objetos UT en RAM (incluso inactivos/no asignados)
            unidades: catalogoUnidades,       // Alias de compatibilidad
            utMap: mapaUtPorNumero,           // Diccionario indexado por n_ute
            flota: resDiagGAS.flota,
            vencimientosObj: resDiagGAS.vencimientosObj,
            marcasTractores: marcasTractores,
            marcasSemis: marcasSemis,
            nuevaSeccionViajes: nuevaSeccionViajes
        };
        cacheDatosGlobales.ut = catalogoUnidades; // Acceso directo en raíz de RAM
        cacheDatosGlobales.vencimientosObj = resDiagGAS.vencimientosObj;
        cacheDatosGlobales.marcasTractores = marcasTractores;
        cacheDatosGlobales.marcasSemis = marcasSemis;
        cacheDatosGlobales.ultimaActualizacion = new Date().toISOString();
        
        // Load users for mentions autocomplete
        try {
            const rowsUsuarios = await fetchRango(ID_SPREADSHEET_MASTER, "'DB_Usuarios'!A:C");
            cacheDatosGlobales.usuarios = rowsUsuarios
                .filter(row => row[0] && String(row[0]).trim().toLowerCase() !== 'usuario')
                .map(row => String(row[0]).trim().toUpperCase());
            console.log(`👥 Usuarios cargados para menciones: ${cacheDatosGlobales.usuarios.length}`);
        } catch (eUsers) {
            console.error('Error cargando usuarios:', eUsers);
            if (!cacheDatosGlobales.usuarios) cacheDatosGlobales.usuarios = [];
        }
        
        // 👉 Auto-enriquecer novedades con los tractores / n_ute de la flota recién ensamblada y persistir en Sheets
        try {
            await enriquecerNovedadesConFlota(cacheDatosGlobales, serviceAccountAuth, ID_SPREADSHEET_MASTER, fetchRango);
        } catch (eEnrich) {
            console.error("Error al enriquecer novedades con la flota:", eEnrich);
        }

        io.emit('datos_actualizados', cacheDatosGlobales);
        
        // 👉 SE EMITE AL NUEVO DASHBOARD CADA VEZ QUE LA RAM SE RE-ENSAMBLA
        if(cacheDatosGlobales.novedades && cacheDatosGlobales.novedades.length > 0) ioDash.emit('novedades_actualizadas', cacheDatosGlobales.novedades);
        
        console.log(`✅ RAM Ensamblada Completa.`);
        
    } catch (error) { console.error("❌ Error RAM:", error); } 
}

async function syncAllDiagramasToMaster(cacheDatosGlobales = null, io = null) {
    try {
        console.log("🔄 INICIANDO SINCRONIZACIÓN COMPLETA DE DIAGRAMAS -> MASTER (1eQ9Y5diL5fwxYTxvseNgZJFbX-lSUQ13axbp3cLiqPc)...");
        const resMeta = await serviceAccountAuth.request({ url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SPREADSHEET_DIAGRAMAS}` });
        const allSheets = (resMeta.data.sheets || []).map(s => s.properties.title);

        const monthTabs = allSheets.filter(s => {
            let low = s.toLowerCase();
            return mesesAbrev.some(m => low.includes(m.toLowerCase())) && /\d{2}/.test(s);
        });

        let diasLegacyIso = {};

        for (let nombreHoja of monthTabs) {
            let parts = nombreHoja.split('-');
            if (parts.length < 2) continue;
            let mIdx = mesesAbrev.findIndex(m => m.toLowerCase() === parts[0].toLowerCase());
            if (mIdx === -1) continue;
            let anioStr = "20" + parts[1].replace(/\D/g, '');
            let targetMonthNum = mIdx + 1;
            let mesStr = String(targetMonthNum).padStart(2, '0');
            let anio = parseInt(anioStr, 10);

            const rowsSheet = await fetchRango(ID_SPREADSHEET_DIAGRAMAS, `'${nombreHoja}'!A1:AL1000`);
            if (rowsSheet.length === 0) continue;

            let dayColMap = {};
            for (let r = 0; r < Math.min(10, rowsSheet.length); r++) {
                let tempMap = {};
                let matchesCount = 0;
                if (!rowsSheet[r]) continue;

                for (let c = 0; c < rowsSheet[r].length; c++) {
                    let cellVal = String(rowsSheet[r][c] || "").trim();
                    let m = cellVal.match(/^0*([1-9]|[12][0-9]|3[01])[\/\-](0*([1-9]|1[0-2]))$/);
                    if (m) {
                        let dayNum = parseInt(m[1], 10);
                        let monthNum = parseInt(m[2], 10);
                        if (monthNum === targetMonthNum) {
                            if (tempMap[dayNum] === undefined) {
                                tempMap[dayNum] = c;
                                matchesCount++;
                            }
                        }
                    }
                }

                if (matchesCount >= 15) {
                    dayColMap = tempMap;
                    break;
                }
            }

            const maxDaysInMonth = new Date(anio, targetMonthNum, 0).getDate();

            if (Object.keys(dayColMap).length === 0) {
                let offsetDia1 = 4;
                const patronDia1 = new RegExp(`^0*1[\\\/\\-]${targetMonthNum}$`);
                outer: for (let r = 0; r < Math.min(12, rowsSheet.length); r++) {
                    if (!rowsSheet[r]) continue;
                    for (let c = 0; c < rowsSheet[r].length; c++) {
                        let cellVal = String(rowsSheet[r][c] || '').trim();
                        if (patronDia1.test(cellVal)) {
                            offsetDia1 = c;
                            break outer;
                        }
                    }
                }
                for (let dia = 1; dia <= maxDaysInMonth; dia++) dayColMap[dia] = offsetDia1 + (dia - 1);
            }

            rowsSheet.forEach(row => {
                let n = row[1]; 
                if (!n || ["APELLIDO Y NOMBRE", "Personal Activo", "LEGAJO"].includes(String(n).trim())) return; 
                let nomNorm = normalizar(n); 
                if (!diasLegacyIso[nomNorm]) diasLegacyIso[nomNorm] = {};

                for (let dia = 1; dia <= maxDaysInMonth; dia++) { 
                    let colIdx = dayColMap[dia];
                    let est = colIdx !== undefined ? row[colIdx] : undefined; 
                    if (est && est !== '-') {
                        diasLegacyIso[nomNorm][`${anio}-${mesStr}-${String(dia).padStart(2, '0')}`] = String(est).toUpperCase().trim(); 
                    }
                }
            });
        }

        const nowIso = new Date().toISOString();
        const rowsToWrite = [["CHOFER_NORM", "DIAGRAMAS_JSON", "ULTIMA_ACTUALIZACION"]];
        for (let normKey in diasLegacyIso) {
            rowsToWrite.push([normKey, JSON.stringify(diasLegacyIso[normKey]), nowIso]);
        }

        try {
            const resMasterMeta = await serviceAccountAuth.request({ url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SPREADSHEET_MASTER}` });
            const masterSheets = (resMasterMeta.data.sheets || []).map(s => s.properties.title);
            if (!masterSheets.includes("CACHE_DIAGRAMAS")) {
                await serviceAccountAuth.request({
                    url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SPREADSHEET_MASTER}:batchUpdate`,
                    method: 'POST',
                    data: { requests: [{ addSheet: { properties: { title: "CACHE_DIAGRAMAS" } } }] }
                });
            }
        } catch(eTab) {}

        await serviceAccountAuth.request({
            url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SPREADSHEET_MASTER}/values/'CACHE_DIAGRAMAS'!A1:Z:clear`,
            method: 'POST'
        });

        await serviceAccountAuth.request({
            url: `https://sheets.googleapis.com/v4/spreadsheets/${ID_SPREADSHEET_MASTER}/values/'CACHE_DIAGRAMAS'!A1?valueInputOption=USER_ENTERED`,
            method: 'PUT',
            data: { values: rowsToWrite }
        });

        console.log(`✅ Sincronización guardada en 'CACHE_DIAGRAMAS' en Master (${rowsToWrite.length - 1} choferes).`);

        if (cacheDatosGlobales && io) {
            await actualizarCacheDesdeGoogle(cacheDatosGlobales, io);
        }
        return true;
    } catch(e) {
        console.error("❌ Error en syncAllDiagramasToMaster:", e);
        return false;
    }
}

function iniciarCachePolling(cacheDatosGlobales, io, ioDash) {
    setTimeout(() => { 
        flujoEncoladoGlobal(cacheDatosGlobales, io, ioDash); 
        iniciarPollingNovedades(fetchRango, ID_SPREADSHEET_MASTER, cacheDatosGlobales, io, ioDash, 30000);
    }, 3000); 
    setInterval(() => { console.log("⏱️ Escaneo periódico (15 min)..."); flujoEncoladoGlobal(cacheDatosGlobales, io, ioDash); }, 15 * 60 * 1000);
}

module.exports = { iniciarCachePolling, syncAllDiagramasToMaster, actualizarCacheDesdeGoogle };
