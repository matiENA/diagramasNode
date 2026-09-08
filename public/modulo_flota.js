// ==========================================
// 🚛 MÓDULO CONTROL DE FLOTA (LÓGICA y UX/UI)
// ==========================================

window.filtroFlotaActual = 'todos'; 

window.setFiltroFlota = function(tipoFiltro) {
    window.filtroFlotaActual = tipoFiltro;
    
    if (typeof window.filtrarTabla === 'function') {
        window.filtrarTabla();
    } else {
        const container = document.getElementById('contenedor-unidades') || document.getElementById('dashboard');
        if (container) {
            window.renderizarVistaUnidades(container, window.datosGlobales || []);
        }
    }
};

window.renderizarVistaUnidades = function(container, choferesFiltrados = null) {
    if (!container) return;

    // 1. Obtener catálogo crudo de unidades y vencimientos desde la RAM
    let cache = window.vencimientosCacheGlobal;
    if (typeof cache === 'string') {
        try { cache = JSON.parse(cache); } catch(e) { cache = []; }
    }
    if (!Array.isArray(cache)) cache = [];

    // Si vencimientosCacheGlobal está vacío, construir a partir del catálogo de UTs en RAM
    const catalogoUTs = window.catalogoUnidadesGlobal || [];
    if (cache.length === 0 && catalogoUTs.length > 0) {
        cache = catalogoUTs.flatMap(ut => [
            ut.tractor ? { patente: ut.tractor.patente, marca: ut.tractor.marca, esSemi: false, ...(ut.tractor.vencimientos || {}) } : null,
            ut.semi ? { patente: ut.semi.patente, marca: ut.semi.marca, esSemi: true, cisternado: ut.semi.cisternado || '', ...(ut.semi.vencimientos || {}) } : null
        ]).filter(Boolean);
    }

    // 2. Indexar UTs y choferes por patente para O(1) matching
    const mapaUtPorPatente = {};
    catalogoUTs.forEach(ut => {
        if (ut.tractor?.patente) mapaUtPorPatente[ut.tractor.patente.toUpperCase().trim()] = ut;
        if (ut.semi?.patente) mapaUtPorPatente[ut.semi.patente.toUpperCase().trim()] = ut;
    });

    const mapaChoferPorPatente = {};
    const choferesBase = window.datosGlobales || [];
    choferesBase.forEach(c => {
        if (c.tractor) {
            let p = String(c.tractor).toUpperCase().trim();
            if (p && !mapaChoferPorPatente[p]) mapaChoferPorPatente[p] = c;
        }
        if (c.semi) {
            let p = String(c.semi).toUpperCase().trim();
            if (p && !mapaChoferPorPatente[p]) mapaChoferPorPatente[p] = c;
        }
    });

    const marcasTr = window.marcasTractoresGlobal || {};
    const marcasSe = window.marcasSemisGlobal || {};

    // 3. Normalizar y deduplicar lista completa de unidades
    const patentesProcesadas = new Set();
    const listaCombinada = [...cache];

    // Asegurar que si una UT tiene tractor o semi no presente en cache, se agregue
    catalogoUTs.forEach(ut => {
        if (ut.tractor?.patente) {
            let p = ut.tractor.patente.toUpperCase().trim();
            if (!listaCombinada.some(item => String(item.patente || item.col_b || '').toUpperCase().trim() === p)) {
                listaCombinada.push({ patente: p, marca: ut.tractor.marca, esSemi: false, ...(ut.tractor.vencimientos || {}) });
            }
        }
        if (ut.semi?.patente) {
            let p = ut.semi.patente.toUpperCase().trim();
            if (!listaCombinada.some(item => String(item.patente || item.col_b || '').toUpperCase().trim() === p)) {
                listaCombinada.push({ patente: p, marca: ut.semi.marca, esSemi: true, cisternado: ut.semi.cisternado || '', ...(ut.semi.vencimientos || {}) });
            }
        }
    });

    const fBaseObj = (typeof fechaGlobalContexto !== 'undefined' && fechaGlobalContexto) 
        ? new Date(fechaGlobalContexto + "T12:00:00") 
        : new Date();
        
    const textoBusqueda = (document.getElementById('buscador-nombre') ? document.getElementById('buscador-nombre').value.toLowerCase().trim() : '');

    let listaUnidades = [];

    listaCombinada.forEach((u, index) => {
        let patente = String(u.patente || u.col_b || '').trim().toUpperCase();
        if (!patente || patentesProcesadas.has(patente)) return;
        patentesProcesadas.add(patente);

        const utAsoc = mapaUtPorPatente[patente] || null;

        // Determinar si es semirremolque
        let esSemi = false;
        if (u.esSemi !== undefined) {
            esSemi = Boolean(u.esSemi);
        } else if (u.tipo) {
            esSemi = String(u.tipo).toUpperCase() === 'SEMI';
        } else if (marcasSe[patente]) {
            esSemi = true;
        } else if (marcasTr[patente]) {
            esSemi = false;
        } else if (utAsoc && utAsoc.semi?.patente?.toUpperCase() === patente) {
            esSemi = true;
        } else {
            esSemi = Boolean(!u.col_g && !u.col_h && (u.col_j || u.col_k));
        }

        const marca = u.marca || (esSemi ? (utAsoc?.semi?.marca || marcasSe[patente]) : (utAsoc?.tractor?.marca || marcasTr[patente])) || '';
        const nUte = (utAsoc && utAsoc.n_ute) || '';
        const srv = (utAsoc && utAsoc.srv_ut) || '';

        // Buscar chofer asignado (primero en UT, luego en choferes globales)
        let choferAsignado = null;
        if (utAsoc && utAsoc.chofer_asignado && utAsoc.chofer_asignado.nom) {
            choferAsignado = {
                nom: utAsoc.chofer_asignado.nom,
                _safeId: utAsoc.chofer_asignado._safeId || ("drv_" + utAsoc.chofer_asignado.nom.toLowerCase().replace(/[^a-z0-9]/g, '_')),
                srv: srv || 'S/A',
                n_ute: nUte
            };
        } else if (mapaChoferPorPatente[patente]) {
            const ch = mapaChoferPorPatente[patente];
            choferAsignado = {
                nom: ch.nom,
                _safeId: ch._safeId || ("drv_" + (ch.nom || '').toLowerCase().replace(/[^a-z0-9]/g, '_')),
                srv: ch.srv || srv || 'S/A',
                tractor: ch.tractor || '',
                semi: ch.semi || '',
                n_ute: ch.n_ute || nUte
            };
        }

        // Buscar equipo compañero (semi si es tractor, tractor si es semi)
        let patTractor = esSemi ? (utAsoc?.tractor?.patente || choferAsignado?.tractor || 'S/D') : patente;
        let patSemi = esSemi ? patente : (utAsoc?.semi?.patente || choferAsignado?.semi || 'Desenganchado');

        // Hidratar vencimientos del compañero para visualización de conjunto
        let partnerVenc = null;
        let partnerPat = esSemi ? (patTractor !== 'S/D' ? patTractor : null) : (patSemi !== 'Desenganchado' && patSemi !== 'S/D' ? patSemi : null);
        if (partnerPat) {
            if (esSemi && utAsoc?.tractor?.vencimientos) {
                partnerVenc = utAsoc.tractor.vencimientos;
            } else if (!esSemi && utAsoc?.semi?.vencimientos) {
                partnerVenc = utAsoc.semi.vencimientos;
            } else {
                partnerVenc = cache.find(item => String(item.patente || item.col_b || '').trim().toUpperCase() === partnerPat);
            }
        }

        // Datos para renderizado de badges (incluye compañero si está enganchado)
        let unidadData = {
            mass_tr: !esSemi ? (u.mas || u.mass_tr || u.col_g || '') : (partnerVenc?.mas || partnerVenc?.mass_tr || partnerVenc?.col_g || ''),
            vtv_tr: !esSemi ? (u.vtv || u.vtv_tr || u.col_h || '') : (partnerVenc?.vtv || partnerVenc?.vtv_tr || partnerVenc?.col_h || ''),
            mass_semi: esSemi ? (u.mas || u.mass_semi || u.col_j || '') : (partnerVenc?.mas || partnerVenc?.mass_semi || partnerVenc?.col_j || ''),
            vtv_semi: esSemi ? (u.vtv || u.vtv_semi || u.col_k || '') : (partnerVenc?.vtv || partnerVenc?.vtv_semi || partnerVenc?.col_k || ''),
            esp_es: u.esp_es || u.col_l || '',
            vi: u.vi || u.col_m || '',
            ve: u.ve || u.col_n || ''
        };

        // Alerta específica del activo propio
        let ownData = {
            mass_tr: !esSemi ? (u.mas || u.mass_tr || u.col_g || '') : '',
            vtv_tr: !esSemi ? (u.vtv || u.vtv_tr || u.col_h || '') : '',
            mass_semi: esSemi ? (u.mas || u.mass_semi || u.col_j || '') : '',
            vtv_semi: esSemi ? (u.vtv || u.vtv_semi || u.col_k || '') : '',
            esp_es: u.esp_es || u.col_l || '',
            vi: u.vi || u.col_m || '',
            ve: u.ve || u.col_n || ''
        };

        let estadoGlobal = 'OK';
        if (typeof window.evaluarAlertasUnidad === 'function') {
            estadoGlobal = window.evaluarAlertasUnidad(ownData, fBaseObj);
        } else {
            const docs = [ownData.mass_tr, ownData.vtv_tr, ownData.mass_semi, ownData.vtv_semi, ownData.esp_es, ownData.vi, ownData.ve];
            let tieneVencido = false;
            let tienePorVencer = false;
            docs.forEach(d => {
                if (!d || d === '-' || String(d).trim() === '') return;
                let est = typeof window.evaluarEstadoDoc === 'function' ? window.evaluarEstadoDoc(String(d).trim(), fBaseObj) : 'OK';
                if (est === 'VENCIDO') tieneVencido = true;
                if (est === 'POR_VENCER') tienePorVencer = true;
            });
            if (tieneVencido) estadoGlobal = 'VENCIDO';
            else if (tienePorVencer) estadoGlobal = 'POR_VENCER';
        }

        listaUnidades.push({
            ...u,
            patente,
            esSemi,
            marca,
            nUte,
            srv,
            patTractor,
            patSemi,
            unidadData,
            estadoGlobal,
            choferAsignado,
            safeId: "unit_" + patente.replace(/[^a-zA-Z0-9]/g, "_") + "_" + index
        });
    });

    // 4. Filtrado (Estado + Tipo + Buscador multi-criterio)
    let unidadesFiltradas = listaUnidades.filter(u => {
        // A. Filtro por Estado de vencimiento o tipo de equipo
        if (window.filtroFlotaActual === 'vencido' && u.estadoGlobal !== 'VENCIDO') return false;
        if (window.filtroFlotaActual === 'por_vencer' && u.estadoGlobal !== 'POR_VENCER') return false;
        if (window.filtroFlotaActual === 'al_dia' && u.estadoGlobal !== 'OK') return false;
        if (window.filtroFlotaActual === 'tractores' && u.esSemi) return false;
        if (window.filtroFlotaActual === 'semis' && !u.esSemi) return false;
        
        // B. Filtro de Búsqueda por Texto
        if (textoBusqueda !== '') {
            const coincidePatente = u.patente.toLowerCase().includes(textoBusqueda);
            const coincideChofer = u.choferAsignado && u.choferAsignado.nom && u.choferAsignado.nom.toLowerCase().includes(textoBusqueda);
            const coincideMarca = u.marca && u.marca.toLowerCase().includes(textoBusqueda);
            const coincideUte = u.nUte && String(u.nUte).toLowerCase().includes(textoBusqueda);
            const coincideSrv = u.srv && u.srv.toLowerCase().includes(textoBusqueda);
            const coincideEnganche = (u.patTractor && u.patTractor.toLowerCase().includes(textoBusqueda)) ||
                                     (u.patSemi && u.patSemi.toLowerCase().includes(textoBusqueda));

            if (!coincidePatente && !coincideChofer && !coincideMarca && !coincideUte && !coincideSrv && !coincideEnganche) {
                return false;
            }
        }

        return true;
    });

    // 5. Ordenamiento inteligente Gestalt (Vencidos primero, Por Vencer segundo, Alfabético secundario)
    const pesoEstado = { 'VENCIDO': 1, 'POR_VENCER': 2, 'OK': 3 };
    unidadesFiltradas.sort((a, b) => {
        if (pesoEstado[a.estadoGlobal] !== pesoEstado[b.estadoGlobal]) {
            return pesoEstado[a.estadoGlobal] - pesoEstado[b.estadoGlobal];
        }
        return a.patente.localeCompare(b.patente);
    });

    // 6. Construcción de Interfaz UX/UI
    let html = `
    <div class="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden animate-[fadeIn_0.3s_ease-out] mb-8">
        <div class="bg-gradient-to-r from-gray-800 to-gray-600 p-5 flex flex-col md:flex-row justify-between md:items-center text-white gap-4">
            <div>
                <h2 class="text-xl font-bold flex items-center gap-2">
                    <span>Control de Flota</span>
                    <span class="text-xs bg-gray-700/80 text-gray-200 px-2 py-0.5 rounded-full font-mono font-normal border border-gray-600">RAM Activa</span>
                </h2>
                <p class="text-xs text-gray-200 mt-1">Gestión integral de vencimientos, inspecciones y asignación de unidades</p>
            </div>
            
            <div class="flex items-center gap-3">
                <div class="flex flex-wrap gap-1 bg-gray-900/40 p-1.5 rounded-lg border border-gray-600/50 shadow-inner">
                    <button onclick="setFiltroFlota('todos')" class="px-3 py-1.5 rounded-md text-xs font-bold transition-all ${window.filtroFlotaActual === 'todos' ? 'bg-white text-gray-900 shadow' : 'text-gray-300 hover:text-white hover:bg-gray-700/50'}">Todos</button>
                    <button onclick="setFiltroFlota('por_vencer')" class="px-3 py-1.5 rounded-md text-xs font-bold transition-all ${window.filtroFlotaActual === 'por_vencer' ? 'bg-yellow-400 text-yellow-900 shadow' : 'text-gray-300 hover:text-yellow-400 hover:bg-gray-700/50'}">Por Vencer</button>
                    <button onclick="setFiltroFlota('vencido')" class="px-3 py-1.5 rounded-md text-xs font-bold transition-all ${window.filtroFlotaActual === 'vencido' ? 'bg-red-500 text-white shadow' : 'text-gray-300 hover:text-red-400 hover:bg-gray-700/50'}">Vencidos</button>
                    <button onclick="setFiltroFlota('tractores')" class="px-3 py-1.5 rounded-md text-xs font-bold transition-all ${window.filtroFlotaActual === 'tractores' ? 'bg-blue-600 text-white shadow' : 'text-gray-300 hover:text-blue-300 hover:bg-gray-700/50'}">🚚 Tractores</button>
                    <button onclick="setFiltroFlota('semis')" class="px-3 py-1.5 rounded-md text-xs font-bold transition-all ${window.filtroFlotaActual === 'semis' ? 'bg-indigo-600 text-white shadow' : 'text-gray-300 hover:text-indigo-300 hover:bg-gray-700/50'}">🔗 Semis</button>
                </div>
                <span class="hidden lg:block px-3 py-1.5 bg-white/20 rounded-lg text-sm font-black border border-white/30 backdrop-blur-sm shadow-sm">${unidadesFiltradas.length} Unidades</span>
            </div>
        </div>
        
        <div class="p-4 sm:p-6 bg-gray-50/50">
            <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 w-full">
    `;

    if (unidadesFiltradas.length === 0) {
        html += `<div class="col-span-1 lg:col-span-2 text-center p-10 bg-white rounded-xl shadow-sm border border-dashed border-gray-300 font-bold text-gray-500">No hay unidades que coincidan con los filtros aplicados.</div>`;
    }

    // 7. Iteración de Nodos Visuales
    unidadesFiltradas.forEach((u) => {
        let bgBarra = u.estadoGlobal === 'VENCIDO' ? 'bg-red-50 hover:bg-red-100 border-red-200' : 
                      u.estadoGlobal === 'POR_VENCER' ? 'bg-yellow-50 hover:bg-yellow-100 border-yellow-200' : 
                      'bg-white hover:bg-gray-50 border-gray-200';
                      
        let textBarra = u.estadoGlobal === 'VENCIDO' ? 'text-red-700' : u.estadoGlobal === 'POR_VENCER' ? 'text-yellow-800' : 'text-gray-700';
        let alertIcon = u.estadoGlobal === 'VENCIDO' ? '🔴' : u.estadoGlobal === 'POR_VENCER' ? '🟡' : '✅';

        let subtituloTipo = `${u.marca ? u.marca + ' • ' : ''}${u.esSemi ? 'Semirremolque' : 'Tractor'}`;
        if (u.nUte) subtituloTipo += ` (UTE ${u.nUte})`;

        let asignacionHtml = '';

        if (u.choferAsignado) {
            let esEsteElTractor = !u.esSemi;
            
            let engancheBadge = esEsteElTractor 
                ? (u.patSemi && u.patSemi !== 'Desenganchado' && u.patSemi !== 'S/D'
                    ? `<span class="bg-indigo-50 text-indigo-700 border border-indigo-200 px-2 py-0.5 rounded text-[10px] font-black tracking-wide shadow-sm flex items-center gap-1">🔗 SEMI: ${u.patSemi}</span>` 
                    : `<span class="bg-red-50 text-red-600 border border-red-200 px-2 py-0.5 rounded text-[10px] font-black tracking-wide shadow-sm italic">Desenganchado</span>`)
                : (u.patTractor && u.patTractor !== 'S/D'
                    ? `<span class="bg-blue-50 text-blue-700 border border-blue-200 px-2 py-0.5 rounded text-[10px] font-black tracking-wide shadow-sm flex items-center gap-1">🚚 TRAC: ${u.patTractor}</span>` 
                    : `<span class="bg-gray-100 text-gray-500 border border-gray-200 px-2 py-0.5 rounded text-[10px] font-black tracking-wide shadow-sm italic">S/D</span>`);

            let uteBadge = u.nUte ? `<span class="text-[9px] font-black bg-blue-50 text-blue-700 px-2 py-0.5 rounded border border-blue-200 uppercase tracking-wider shadow-sm">UTE ${u.nUte}</span>` : '';
            let srvBadge = `<span class="text-[9px] font-black bg-gray-100 text-gray-600 px-2 py-0.5 rounded border border-gray-200 uppercase tracking-wider shadow-sm">${u.choferAsignado.srv || u.srv || 'S/A'}</span>`;

            asignacionHtml = `
            <div class="flex flex-col md:flex-row justify-between items-start md:items-center bg-white p-3 rounded-xl border border-indigo-100 shadow-sm mb-3 gap-3 hover:shadow-md transition-shadow">
                <div class="flex items-center gap-3">
                    <div class="w-8 h-8 rounded-full bg-indigo-50 border border-indigo-100 text-indigo-500 flex items-center justify-center shadow-inner text-sm">👤</div>
                    <div class="flex flex-col">
                        <span class="text-[9px] font-black text-gray-400 uppercase tracking-widest leading-none mb-0.5">Asignación Diagrama</span>
                        <span class="text-xs font-bold text-gray-800 cursor-pointer hover:text-blue-600 transition-colors" onclick="irAVistaIndividual('${u.choferAsignado._safeId}')">${u.choferAsignado.nom}</span>
                    </div>
                </div>
                <div class="flex items-center gap-2 flex-wrap">
                    ${uteBadge}
                    ${srvBadge}
                    ${engancheBadge}
                </div>
            </div>`;
        } else {
            let uteBadge = u.nUte ? `<span class="text-[9px] font-black bg-gray-100 text-gray-600 px-2 py-0.5 rounded border border-gray-200 uppercase tracking-wider">UTE ${u.nUte}</span>` : '';
            asignacionHtml = `
            <div class="bg-gray-50 p-3 rounded-xl border border-dashed border-gray-200 flex items-center justify-between mb-3">
                <span class="text-[10px] font-bold text-gray-400 uppercase tracking-widest flex items-center gap-2">
                    <span class="w-2 h-2 rounded-full bg-gray-300"></span> Unidad en Base / Sin Chofer asignado
                </span>
                ${uteBadge}
            </div>`;
        }

        html += `
        <div class="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden flex flex-col justify-between">
            <button onclick="toggleUnidadDetalle('${u.safeId}')" class="w-full p-4 flex justify-between items-center ${bgBarra} transition-colors focus:outline-none cursor-pointer border-b border-transparent hover:border-gray-200">
                <div class="flex items-center gap-4">
                    <div class="w-10 h-10 rounded-lg ${u.esSemi ? 'bg-indigo-100 text-indigo-600' : 'bg-blue-100 text-blue-600'} flex items-center justify-center text-lg shadow-inner">
                        ${u.esSemi ? '🔗' : '🚚'}
                    </div>
                    <div class="flex flex-col text-left">
                        <span class="font-black ${textBarra} text-lg tracking-wide">${u.patente}</span>
                        <span class="text-[10px] font-bold text-gray-400 uppercase tracking-widest">${subtituloTipo}</span>
                    </div>
                </div>
                <div class="flex items-center gap-3">
                    <span class="hidden sm:block text-[10px] font-black uppercase tracking-widest ${textBarra}">${alertIcon} ${u.estadoGlobal.replace('_', ' ')}</span>
                    <svg id="icon-unit-${u.safeId}" class="w-5 h-5 ${textBarra} transition-transform duration-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>
                </div>
            </button>
            
            <div id="panel-unit-${u.safeId}" class="hidden bg-slate-50 p-4 border-t border-gray-100 flex-1">
                ${asignacionHtml}
                <div class="grid grid-cols-1 xl:grid-cols-2 gap-3">
                    <div class="flex flex-col gap-2 bg-white p-3 rounded-xl border border-gray-200 shadow-sm">
                        <span class="text-[9px] font-black text-indigo-400 uppercase tracking-widest mb-1 border-b border-gray-100 pb-1.5 text-center flex justify-center items-center gap-1">🛡️ MASS</span>
                        ${typeof window.renderBadgeUnidad === 'function' ? window.renderBadgeUnidad(u.unidadData.mass_tr, 'MASS', 'TR', fBaseObj) : ''}
                        ${typeof window.renderBadgeUnidad === 'function' ? window.renderBadgeUnidad(u.unidadData.mass_semi, 'MASS', 'SE', fBaseObj) : ''}
                    </div>
                    <div class="flex flex-col gap-2 bg-white p-3 rounded-xl border border-gray-200 shadow-sm">
                        <span class="text-[9px] font-black text-blue-400 uppercase tracking-widest mb-1 border-b border-gray-100 pb-1.5 text-center flex justify-center items-center gap-1">⚙️ VTV / RTO</span>
                        ${typeof window.renderBadgeUnidad === 'function' ? window.renderBadgeUnidad(u.unidadData.vtv_tr, 'VTV', 'TR', fBaseObj) : ''}
                        ${typeof window.renderBadgeUnidad === 'function' ? window.renderBadgeUnidad(u.unidadData.vtv_semi, 'VTV', 'SE', fBaseObj) : ''}
                    </div>
                </div>
                ${!u.esSemi ? `
                <div class="mt-3 flex flex-col gap-2 bg-white p-3 rounded-xl border border-gray-200 shadow-sm">
                    <span class="text-[9px] font-black text-purple-400 uppercase tracking-widest mb-1 border-b border-gray-100 pb-1.5 text-center flex justify-center items-center gap-1">📜 CERTIFICADOS EXTRA</span>
                    <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
                        ${typeof window.renderBadgeUnidad === 'function' ? window.renderBadgeUnidad(u.unidadData.esp_es, 'ESP-ES', 'TR', fBaseObj) : ''}
                        ${typeof window.renderBadgeUnidad === 'function' ? window.renderBadgeUnidad(u.unidadData.vi, 'VI', 'TR', fBaseObj) : ''}
                        ${typeof window.renderBadgeUnidad === 'function' ? window.renderBadgeUnidad(u.unidadData.ve, 'VE', 'TR', fBaseObj) : ''}
                    </div>
                </div>` : ''}
            </div>
        </div>`;
    });

    html += `</div></div></div>`;
    
    // Inyectar en el DOM usando actualizarSinBlink o asignación directa
    if (typeof window.actualizarSinBlink === 'function') {
        window.actualizarSinBlink(container.id || 'contenedor-unidades', html);
    } else {
        container.innerHTML = html;
    }
};

window.toggleUnidadDetalle = function(id) {
    const panel = document.getElementById(`panel-unit-${id}`);
    const icon = document.getElementById(`icon-unit-${id}`);
    if (!panel || !icon) return;
    
    if (panel.classList.contains('hidden')) {
        panel.classList.remove('hidden');
        panel.classList.add('expand-anim');
        icon.style.transform = 'rotate(180deg)';
    } else {
        panel.classList.add('hidden');
        panel.classList.remove('expand-anim');
        icon.style.transform = 'rotate(0deg)';
    }
};