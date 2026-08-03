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

                if (nombreDiagrama) mapaNombreDiagramaAId[normalizar(nombreDiagrama)] = id;
                if (nombre && !mapaNombreDiagramaAId[normalizar(nombre)]) mapaNombreDiagramaAId[normalizar(nombre)] = id;
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
        try {
            let hoyAr = getFechaArgentina();
            let anio = hoyAr.getFullYear(); 
            let nombreHojaActual = mesesAbrev[hoyAr.getMonth()] + "-" + String(anio).slice(-2);
            
            (await fetchRango(ID_SPREADSHEET_DIAGRAMAS, `'${nombreHojaActual}'!A6:C1000`)).forEach(row => {
                if (row[1] && !["APELLIDO Y NOMBRE", "Personal Activo"].includes(row[1])) {
                    let norm = normalizar(row[1]);
                    if (!resDiagGAS.flota[norm]) { resDiagGAS.flota[norm] = { tractor: '', semi: '', servicio: row[2] || 'S/A', n_ute: '' }; listaChoferesMaestros.push({ nombre: String(row[1]).trim(), norm }); }
                }
            });

            let nombrePestañaMov = await getTabName(ID_SHEET_MOVIMIENTOS, "Mov.Unidades", "Mov.Unidades y Choferes");
            const rowsMov = await fetchRango(ID_SHEET_MOVIMIENTOS, `'${nombrePestañaMov}'!A1:ZZ1000`);
            
            if (rowsMov.length > 0) {
                let colFecha = -1, colNom = -1;
                for (let offset = 0; offset >= -10; offset--) {
                    let d = new Date(hoyAr); d.setDate(d.getDate() + offset);
                    let tD = d.getDate(); let tM = d.getMonth(); let tY = d.getFullYear();
                    let tD_pad = String(tD).padStart(2, '0'); let tM_pad = String(tM + 1).padStart(2, '0'); let tY_short = String(tY).slice(-2);
                    let regexFechas = [ new RegExp(`\\b0?${tD}[\\s/\\-de]+${mesesLargo[tM]}\\b`, 'i'), new RegExp(`\\b0?${tD}[\\s/\\-]+${mesesAbrev[tM]}\\b`, 'i'), new RegExp(`\\b${tD_pad}/${tM_pad}/${tY}\\b`), new RegExp(`\\b${tD}/${tM+1}/${tY}\\b`), new RegExp(`\\b${tD_pad}/${tM_pad}/${tY_short}\\b`), new RegExp(`\\b${tD}/${tM+1}/${tY_short}\\b`) ];
                    for (let r = 0; r < Math.min(5, rowsMov.length); r++) {
                        for (let c = 3; c < rowsMov[r].length; c++) {
                            let val = String(rowsMov[r][c] || "").toLowerCase().replace(/\s+/g, ' ').trim();
                            if (regexFechas.some(rx => rx.test(val))) { 
                                colFecha = c; 
                                for (let searchCol = colFecha; searchCol >= 0; searchCol--) {
                                    let encontrado = false;
                                    for (let searchRow = 0; searchRow < 6; searchRow++) {
                                        let cellVal = String(rowsMov[searchRow]?.[searchCol] || "").toLowerCase().trim();
                                        if (cellVal === "chofer" || cellVal === "choferes" || cellVal.includes("apellido y nombre")) { colNom = searchCol; encontrado = true; break; }
                                    }
                                    if (encontrado) break;
                                }
                                if (colNom === -1) colNom = c - 3; 
                                break; 
                            }
                        }
                        if (colFecha !== -1) break;
                    }
                    if (colFecha !== -1) break; 
                }

                if (colFecha === -1) {
                    const regexAnyDate = /\b\d{1,2}[\s/\-de]+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)\b/i;
                    for (let r = 0; r < Math.min(5, rowsMov.length); r++) {
                        for (let c = rowsMov[r].length - 1; c >= 3; c--) {
                            let val = String(rowsMov[r][c] || "").toLowerCase().replace(/\s+/g, ' ').trim();
                            if (regexAnyDate.test(val)) {
                                colFecha = c;
                                for (let searchCol = colFecha; searchCol >= 0; searchCol--) {
                                    let encontrado = false;
                                    for (let searchRow = 0; searchRow < 6; searchRow++) {
                                        let cellVal = String(rowsMov[searchRow]?.[searchCol] || "").toLowerCase().trim();
                                        if (cellVal === "chofer" || cellVal === "choferes" || cellVal.includes("apellido y nombre")) { colNom = searchCol; encontrado = true; break; }
                                    }
                                    if (encontrado) break;
                                }
                                if (colNom === -1) colNom = c - 3;
                                break;
                            }
                        }
                        if (colFecha !== -1) break;
                    }
                }

                if (colNom !== -1) {
                    for (let i = 2; i < rowsMov.length; i++) {
                        let n_ute = String(rowsMov[i][2] || "").trim(), tractor = String(rowsMov[i][4] || "").trim(), semi = String(rowsMov[i][5] || "").trim(); 
                        if (!tractor) continue;
                        let nomRaw = String(rowsMov[i][colNom] || "").trim();
                        if (!nomRaw || nomRaw === "1" || !/[a-zA-Záéíóú]/.test(nomRaw)) continue;
                        let norm = normalizar(nomRaw);
                        
                        let targetKey = norm;
                        if (!resDiagGAS.flota[targetKey] && mapaNombreDiagramaAId) {
                            let choferId = mapaNombreDiagramaAId[norm];
                            if (choferId && choferesRouter[choferId]) {
                                let diagName = normalizar(choferesRouter[choferId].nombreDiagrama || choferesRouter[choferId].nombre);
                                if (resDiagGAS.flota[diagName]) targetKey = diagName;
                            }
                        }
                        if (!resDiagGAS.flota[targetKey]) {
                            let keys = Object.keys(resDiagGAS.flota);
                            let foundKey = keys.find(k => k === norm || k.includes(norm) || norm.includes(k));
                            if (foundKey) targetKey = foundKey;
                        }

                        if (resDiagGAS.flota[targetKey]) { resDiagGAS.flota[targetKey].n_ute = n_ute; resDiagGAS.flota[targetKey].tractor = tractor; resDiagGAS.flota[targetKey].semi = semi; } 
                        else { resDiagGAS.flota[norm] = { tractor: tractor, semi: semi, servicio: 'S/A', n_ute: n_ute }; listaChoferesMaestros.push({ nombre: nomRaw, norm }); }
                    }
                } 
            }

        } catch (e) { }

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
                    if (sheetName) resDiagGAS.documentos[sheetName] = obj;
                    if (diagName) resDiagGAS.documentos[diagName] = obj;
                    if (explicitDiagName) resDiagGAS.documentos[explicitDiagName] = obj;
                    if (routerName) resDiagGAS.documentos[routerName] = obj;
                    if (fallbackRouterName) resDiagGAS.documentos[fallbackRouterName] = obj;
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
                    if (sheetName) resDiagGAS.certificados[sheetName] = obj;
                    if (diagName) resDiagGAS.certificados[diagName] = obj;
                    if (explicitDiagName) resDiagGAS.certificados[explicitDiagName] = obj;
                    if (routerName) resDiagGAS.certificados[routerName] = obj;
                    if (fallbackRouterName) resDiagGAS.certificados[fallbackRouterName] = obj;
                } 
                if (l) { 
                    let obj = { ven: l, estado: calcEst(r[4]) };
                    if (sheetName) resDiagGAS.habilitaciones[sheetName] = obj;
                    if (diagName) resDiagGAS.habilitaciones[diagName] = obj;
                    if (explicitDiagName) resDiagGAS.habilitaciones[explicitDiagName] = obj;
                    if (routerName) resDiagGAS.habilitaciones[routerName] = obj;
                    if (fallbackRouterName) resDiagGAS.habilitaciones[fallbackRouterName] = obj;
                } 
            });
        } catch(e) { console.error("Error cargando docs/habs:", e); }

        let hoyAr2 = getFechaArgentina();
        let offsetsMeses = [-1, 0, 1, 2, 3]; 
        for (let i of offsetsMeses) {
            let d = new Date(hoyAr2.getFullYear(), hoyAr2.getMonth() + i, 1); 
            let anio = d.getFullYear(); 
            let mesStr = String(d.getMonth() + 1).padStart(2, '0');
            let nombreHoja = mesesAbrev[d.getMonth()] + "-" + String(anio).slice(-2); 
            hojasInfo.push({ nombre: nombreHoja, anio, mesStr });

            const rowsSheet = await fetchRango(ID_SPREADSHEET_DIAGRAMAS, `'${nombreHoja}'!A1:AL1000`);
            if (rowsSheet.length === 0) continue;

            let dayColMap = {};
            for (let r = 0; r < Math.min(10, rowsSheet.length); r++) {
                let tempMap = {};
                let matchesCount = 0;
                if (!rowsSheet[r]) continue;

                for (let c = 0; c < rowsSheet[r].length; c++) {
                    let cellVal = String(rowsSheet[r][c] || "").trim();
                    let m = cellVal.match(/^0*([1-9]|[12][0-9]|3[01])[\/\-]\d{1,2}$/);
                    if (m) {
                        let dayNum = parseInt(m[1], 10);
                        tempMap[dayNum] = c;
                        matchesCount++;
                    }
                }

                if (matchesCount >= 15) {
                    dayColMap = tempMap;
                    break;
                }
            }

            if (Object.keys(dayColMap).length === 0) {
                for (let dia = 1; dia <= 31; dia++) dayColMap[dia] = dia + 3;
            }

            rowsSheet.forEach(row => {
                let n = row[1]; 
                if (!n || ["APELLIDO Y NOMBRE", "Personal Activo", "LEGAJO"].includes(String(n).trim())) return; 
                let nomNorm = normalizar(n); 
                if (!diasLegacyIso[nomNorm]) diasLegacyIso[nomNorm] = {};

                for (let dia = 1; dia <= 31; dia++) { 
                    let colIdx = dayColMap[dia];
                    let est = colIdx !== undefined ? row[colIdx] : undefined; 
                    if (est && est !== '-') {
                        diasLegacyIso[nomNorm][`${anio}-${mesStr}-${String(dia).padStart(2, '0')}`] = String(est).toUpperCase().trim(); 
                    }
                }
            });
        }

        let diagramasHibridos = []; 
        listaChoferesMaestros.forEach(ch => {
            let nomNorm = ch.norm; let flota = resDiagGAS.flota[nomNorm] || {}; let mergeIso = diasLegacyIso[nomNorm] || {}; let diasFront = {};
            hojasInfo.forEach(info => { let tira = []; for (let dia = 1; dia <= 31; dia++) { tira.push(mergeIso[`${info.anio}-${info.mesStr}-${String(dia).padStart(2, '0')}`] || "-"); } diasFront[info.nombre] = tira.join(","); });
            diagramasHibridos.push({ _safeId: "drv_" + nomNorm.replace(/[^a-z0-9]/g, "_"), nom: ch.nombre, tractor: flota.tractor || '', semi: flota.semi || '', srv: flota.servicio || '', n_ute: flota.n_ute || '', dias: diasFront, _diasIso: mergeIso });
        });

        cacheDatosGlobales.diagramas = { 
            diagramas: diagramasHibridos, flota: resDiagGAS.flota, nuevaSeccionViajes: nuevaSeccionViajes, documentos: resDiagGAS.documentos, habilitaciones: resDiagGAS.habilitaciones, certificados: resDiagGAS.certificados,
            dnis: resDiagGAS.dnis, telefonos: resDiagGAS.telefonos, observaciones: resDiagGAS.observaciones, aptosMedicos: resDiagGAS.aptosMedicos, vencimientosObj: resDiagGAS.vencimientosObj, fotosImgur: resDiagGAS.fotosImgur
        };
        cacheDatosGlobales.tds = { campo:{}, infinia:{}, liviano:{}, euro:{}, estados:{}, codigosExtra:{} };
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

function iniciarCachePolling(cacheDatosGlobales, io, ioDash) {
    setTimeout(() => { 
        flujoEncoladoGlobal(cacheDatosGlobales, io, ioDash); 
        iniciarPollingNovedades(fetchRango, ID_SPREADSHEET_MASTER, cacheDatosGlobales, io, ioDash, 30000);
    }, 3000); 
    setInterval(() => { console.log("⏱️ Escaneo periódico (15 min)..."); flujoEncoladoGlobal(cacheDatosGlobales, io, ioDash); }, 15 * 60 * 1000);
}

module.exports = { iniciarCachePolling };
