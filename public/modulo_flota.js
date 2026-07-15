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
        // 👉 CORRECCIÓN 1: Leer datosGlobales directo (sin window.)
        window.renderizarVistaUnidades(container, datosGlobales); 
    }
};

window.renderizarVistaUnidades = function(container, choferesFiltrados = null) {
    let cache = window.vencimientosCacheGlobal;
    if (typeof cache === 'string') { try { cache = JSON.parse(cache); } catch(e) { cache = []; } }
    if (!Array.isArray(cache)) cache = [];

    // 👉 CORRECCIÓN 2: Leer fechaGlobalContexto directo (sin window.)
    let fBaseObj = new Date(fechaGlobalContexto + "T12:00:00");
    const textoBusqueda = (document.getElementById('buscador-nombre') ? document.getElementById('buscador-nombre').value.toLowerCase().trim() : '');
    
    let listaUnidades = cache.map((u, index) => {
        let patente = String(u.col_b || '').trim().toUpperCase();
        let esSemi = (!u.col_g && !u.col_h && (u.col_j || u.col_k)); 
        
        let unidadData = {
            mass_tr: u.col_g, vtv_tr: u.col_h,
            mass_semi: u.col_j, vtv_semi: u.col_k,
            esp_es: u.col_l, vi: u.col_m, ve: u.col_n
        };
        
        let estadoGlobal = window.evaluarAlertasUnidad(unidadData, fBaseObj);
        
        // 👉 CORRECCIÓN 3: Leer datosGlobales directo (sin window.)
        let choferAsignado = datosGlobales.find(c =>
            (c.tractor || '').toUpperCase().trim() === patente ||
            (c.semi || '').toUpperCase().trim() === patente
        );

        return {
            ...u, patente, esSemi, unidadData, estadoGlobal, choferAsignado, safeId: "unit_" + patente.replace(/[^a-zA-Z0-9]/g, "_") + "_" + index
        };
    }).filter(u => u.patente !== '');

    // 3. Sistema Dual de Filtrado (Botones de Estado + Buscador de Texto)
    let unidadesFiltradas = listaUnidades.filter(u => {
        // A. Filtro por Estado (Gestalt: Filtrado por categoría)
        if (window.filtroFlotaActual === 'vencido' && u.estadoGlobal !== 'VENCIDO') return false;
        if (window.filtroFlotaActual === 'por_vencer' && u.estadoGlobal !== 'POR_VENCER') return false;
        
        // B. Filtro por Texto (Buscador Global)
        if (textoBusqueda !== '') {
            const coincidePatente = u.patente.toLowerCase().includes(textoBusqueda);
            // Validamos si el chofer asignado a esta unidad superó el filtro global
            const coincideChofer = choferesFiltrados && u.choferAsignado && choferesFiltrados.some(c => c._safeId === u.choferAsignado._safeId);
            
            if (!coincidePatente && !coincideChofer) return false;
        }

        return true;
    });

    // 4. SMART SORTING (Principio Gestalt de Prägnanz - Jerarquía Visual de Alerta)
    // Forzamos al ojo a ver primero los problemas (Vencidos), luego advertencias (Por Vencer).
    const pesoEstado = { 'VENCIDO': 1, 'POR_VENCER': 2, 'OK': 3 };
    unidadesFiltradas.sort((a, b) => {
        if (pesoEstado[a.estadoGlobal] !== pesoEstado[b.estadoGlobal]) {
            return pesoEstado[a.estadoGlobal] - pesoEstado[b.estadoGlobal]; // Alertas arriba
        }
        return a.patente.localeCompare(b.patente); // Alfabético secundario
    });

    // 5. Construcción de Interfaz (UI)
    let html = `
    <div class="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden animate-[fadeIn_0.3s_ease-out] mb-8">
        <div class="bg-gradient-to-r from-gray-800 to-gray-600 p-5 flex flex-col md:flex-row justify-between md:items-center text-white gap-4">
            <div>
                <h2 class="text-xl font-bold">Control de Flota</h2>
                <p class="text-xs text-gray-200 mt-1">Gestión integral de vencimientos y asignación de unidades</p>
            </div>
            
            <div class="flex items-center gap-3">
                <div class="flex gap-1 bg-gray-900/40 p-1.5 rounded-lg border border-gray-600/50 shadow-inner">
                    <button onclick="setFiltroFlota('todos')" class="px-3 py-1.5 rounded-md text-xs font-bold transition-all ${window.filtroFlotaActual === 'todos' ? 'bg-white text-gray-900 shadow' : 'text-gray-300 hover:text-white hover:bg-gray-700/50'}">Todos</button>
                    <button onclick="setFiltroFlota('por_vencer')" class="px-3 py-1.5 rounded-md text-xs font-bold transition-all ${window.filtroFlotaActual === 'por_vencer' ? 'bg-yellow-400 text-yellow-900 shadow' : 'text-gray-300 hover:text-yellow-400 hover:bg-gray-700/50'}">Por Vencer</button>
                    <button onclick="setFiltroFlota('vencido')" class="px-3 py-1.5 rounded-md text-xs font-bold transition-all ${window.filtroFlotaActual === 'vencido' ? 'bg-red-500 text-white shadow' : 'text-gray-300 hover:text-red-400 hover:bg-gray-700/50'}">Vencidos</button>
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

    // 6. Iteración de Nodos Visuales
    unidadesFiltradas.forEach((u) => {
        let bgBarra = u.estadoGlobal === 'VENCIDO' ? 'bg-red-50 hover:bg-red-100 border-red-200' : 
                      u.estadoGlobal === 'POR_VENCER' ? 'bg-yellow-50 hover:bg-yellow-100 border-yellow-200' : 
                      'bg-white hover:bg-gray-50 border-gray-200';
                      
        let textBarra = u.estadoGlobal === 'VENCIDO' ? 'text-red-700' : u.estadoGlobal === 'POR_VENCER' ? 'text-yellow-800' : 'text-gray-700';
        let alertIcon = u.estadoGlobal === 'VENCIDO' ? '🔴' : u.estadoGlobal === 'POR_VENCER' ? '🟡' : '✅';

        let asignacionHtml = '';
        let patTractor = u.esSemi ? 'S/D' : u.patente;
        let patSemi = u.esSemi ? u.patente : 'S/D';

        if (u.choferAsignado) {
            let esEsteElTractor = (u.choferAsignado.tractor || '').toUpperCase().trim() === u.patente;
            patTractor = u.choferAsignado.tractor || 'S/D';
            patSemi = u.choferAsignado.semi || 'Desenganchado';
            
            let engancheBadge = esEsteElTractor 
                ? (u.choferAsignado.semi ? `<span class="bg-indigo-50 text-indigo-700 border border-indigo-200 px-2 py-0.5 rounded text-[10px] font-black tracking-wide shadow-sm flex items-center gap-1">🔗 SEMI: ${u.choferAsignado.semi}</span>` : `<span class="bg-red-50 text-red-600 border border-red-200 px-2 py-0.5 rounded text-[10px] font-black tracking-wide shadow-sm italic">Desenganchado</span>`)
                : (u.choferAsignado.tractor ? `<span class="bg-blue-50 text-blue-700 border border-blue-200 px-2 py-0.5 rounded text-[10px] font-black tracking-wide shadow-sm flex items-center gap-1">🚚 TRAC: ${u.choferAsignado.tractor}</span>` : `<span class="bg-gray-100 text-gray-500 border border-gray-200 px-2 py-0.5 rounded text-[10px] font-black tracking-wide shadow-sm italic">S/D</span>`);

            asignacionHtml = `
            <div class="flex flex-col md:flex-row justify-between items-start md:items-center bg-white p-3 rounded-xl border border-indigo-100 shadow-sm mb-3 gap-3 hover:shadow-md transition-shadow">
                <div class="flex items-center gap-3">
                    <div class="w-8 h-8 rounded-full bg-indigo-50 border border-indigo-100 text-indigo-500 flex items-center justify-center shadow-inner text-sm">👤</div>
                    <div class="flex flex-col">
                        <span class="text-[9px] font-black text-gray-400 uppercase tracking-widest leading-none mb-0.5">Asignación Diagrama</span>
                        <span class="text-xs font-bold text-gray-800 cursor-pointer hover:text-blue-600 transition-colors" onclick="irAVistaIndividual('${u.choferAsignado._safeId}')">${u.choferAsignado.nom}</span>
                    </div>
                </div>
                <div class="flex items-center gap-2">
                    <span class="text-[9px] font-black bg-gray-100 text-gray-600 px-2 py-0.5 rounded border border-gray-200 uppercase tracking-wider shadow-sm">${u.choferAsignado.srv || 'S/A'}</span>
                    ${engancheBadge}
                </div>
            </div>`;
        } else {
            asignacionHtml = `
            <div class="bg-gray-50 p-3 rounded-xl border border-dashed border-gray-200 flex items-center justify-center mb-3">
                <span class="text-[10px] font-bold text-gray-400 uppercase tracking-widest flex items-center gap-2"><span class="w-2 h-2 rounded-full bg-gray-300"></span> Unidad en Base / Sin Chofer asignado</span>
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
                        <span class="text-[10px] font-bold text-gray-400 uppercase tracking-widest">${u.esSemi ? 'Semirremolque' : 'Tractor'}</span>
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
    
    // Inyectar en el DOM usando la técnica anti-blink que ya tienes implementada
    if (typeof window.actualizarSinBlink === 'function') {
        window.actualizarSinBlink(container.id || 'dashboard', html);
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