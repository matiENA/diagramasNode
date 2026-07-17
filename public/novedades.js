// ====================
// 1. ESTADO GLOBAL (RAM CLIENTE)
// ====================
let novedadesMemoria = [];
let choferesDelimitados = []; 
let tipoNovedadActiva = 'baja';

// ====================
// 2. SINCRONIZACIÓN REAL-TIME (Socket.io)
// ====================
// A. Sincronización del Tablero de Novedades
socket.on('novedades:sync', (payload) => {
    novedadesMemoria = payload; 
    actualizarVistas();
});

// B. Extracción de Delimitadores desde la Matriz Global
socket.on('datos_actualizados', (payload) => {
    if (payload && payload.diagramas && payload.diagramas.diagramas) {
        choferesDelimitados = payload.diagramas.diagramas.map(d => ({
            id: d._safeId,
            nom: d.nom,
            tractor: d.tractor || 'S/A',
            ute: d.n_ute || 'S/A',
            semi: d.semi || '',
            srv: d.srv || ''
        }));
        // Actualizamos las vistas por si el modal está abierto y necesita los nuevos choferes
        actualizarVistas();
    }
});

// ====================
// 3. RENDER: DASHBOARD DE NOVEDADES
// ====================
function renderDashboardNovedades() {
    const activas = novedadesMemoria.filter(n => n.estado === 'live');
    const resueltas = novedadesMemoria.filter(n => n.estado === 'resuelto');

    return `
    <div id="view-dashboard-novedades" class="flex flex-col lg:flex-row gap-5 h-full p-4 bg-gray-50">
        
        <!-- Tablero Live -->
        <section class="flex-1 flex flex-col bg-white rounded-2xl shadow-sm border border-gray-200">
            <header class="p-4 border-b border-gray-100 flex justify-between items-center bg-gray-50/50 rounded-t-2xl">
                <div class="flex items-center gap-2">
                    <span class="h-2.5 w-2.5 rounded-full bg-blue-500 animate-pulse"></span>
                    <h2 class="text-xs font-black text-gray-700 uppercase tracking-wider">Tablero Live</h2>
                </div>
                <span class="text-xs font-bold text-blue-700 bg-blue-50 px-2.5 py-1 rounded-md">${activas.length} Activas</span>
            </header>
            <div class="flex-1 overflow-y-auto snap-y snap-mandatory p-4 space-y-3">
                ${activas.map(renderCard).join('') || renderEmptyState('Sin novedades activas')}
            </div>
        </section>

        <!-- Tablero Resueltos -->
        <section class="flex-1 flex flex-col bg-gray-50 rounded-2xl border border-gray-200 opacity-80 hover:opacity-100 transition-opacity">
            <header class="p-4 border-b border-gray-200 flex justify-between items-center bg-gray-100/50 rounded-t-2xl">
                <h2 class="text-xs font-black text-gray-500 uppercase tracking-wider">Historial Resueltos</h2>
                <span class="text-xs font-bold text-gray-600 bg-gray-200 px-2.5 py-1 rounded-md">${resueltas.length}</span>
            </header>
            <div class="flex-1 overflow-y-auto p-4 space-y-3">
                ${resueltas.map(renderCard).join('') || renderEmptyState('Historial vacío')}
            </div>
        </section>

        <!-- FAB Mobile -->
        <button onclick="abrirModalMobile()" class="lg:hidden fixed bottom-6 right-6 h-14 w-14 bg-gray-900 text-white rounded-full shadow-2xl flex items-center justify-center text-2xl z-40 active:scale-95 transition-transform">
            +
        </button>
    </div>
    `;
}

// ====================
// 4. RENDER: CARD INDIVIDUAL
// ====================
function renderCard(data) {
    const isResuelto = data.estado === 'resuelto';
    const bgClass = isResuelto ? 'bg-gray-100/50 border-gray-200' : 'bg-white border-gray-300 shadow-sm';
    const textClass = isResuelto ? 'text-gray-400 line-through' : 'text-gray-900';

    return `
    <article class="snap-start p-4 rounded-xl border ${bgClass} transition-colors">
        <div class="flex items-start gap-3">
            <input type="checkbox" ${isResuelto ? 'checked' : ''} onchange="toggleEstadoNovedad('${data.id}')" 
                   class="mt-1 w-5 h-5 text-gray-900 border-gray-300 rounded focus:ring-gray-900 cursor-pointer">
            <div class="flex-1 min-w-0">
                <div class="flex justify-between items-center mb-1.5 gap-2">
                    <h3 class="text-sm font-bold truncate ${textClass}">${data.jerarquia.nom}</h3>
                    <span class="text-[10px] font-bold px-2 py-0.5 bg-gray-200 text-gray-700 rounded uppercase shrink-0">${data.tipo}</span>
                </div>
                <div class="grid grid-cols-2 gap-x-2 gap-y-1 text-xs text-gray-500">
                    <p class="truncate">TRC: <span class="font-medium text-gray-700">${data.jerarquia.tractor}</span></p>
                    <p class="truncate">UTE: <span class="font-medium text-gray-700">${data.jerarquia.ute}</span></p>
                </div>
                <div class="mt-3 pt-2 border-t border-gray-100 flex justify-between items-center text-xs">
                    <span class="truncate pr-2 text-gray-600 italic">"${data.detalle}"</span>
                    <span class="font-mono font-bold text-gray-400 bg-gray-100 px-1.5 rounded shrink-0">${data.jerarquia.dias}</span>
                </div>
            </div>
        </div>
    </article>
    `;
}

// ====================
// 5. RENDER: MÓDULO MÓVIL DE CARGA
// ====================
function renderModuloMobile() {
    const reqFecha = ['baja', 'certificacion', 'examen'].includes(tipoNovedadActiva);
    const reqDetalle = tipoNovedadActiva === 'reparacion';

    return `
    <div id="modal-novedades" class="fixed inset-x-0 bottom-0 z-50 transform translate-y-full transition-transform duration-300 bg-white rounded-t-3xl shadow-[0_-10px_40px_rgba(0,0,0,0.15)] pb-safe md:max-w-md md:mx-auto">
        <div class="p-6 space-y-5">
            <div class="w-12 h-1 bg-gray-200 rounded-full mx-auto mb-2" onclick="cerrarModalMobile()"></div>

            <div class="flex justify-between items-center">
                <h3 class="text-xl font-black text-gray-900 tracking-tight">Registrar Novedad</h3>
                <button type="button" onclick="cerrarModalMobile()" class="text-gray-400 font-bold p-2">✕</button>
            </div>

            <form onsubmit="procesarCarga(event)" class="space-y-4">
                <div class="space-y-1.5">
                    <label class="block text-[11px] font-bold text-gray-500 uppercase tracking-wider">Chofer y Unidad</label>
                    <select id="form-objetivo" required class="w-full h-12 px-4 bg-gray-50 border border-gray-200 rounded-xl text-sm font-medium focus:ring-2 focus:ring-gray-900 outline-none truncate">
                        <option value="" disabled selected>Seleccionar del diagrama...</option>
                        ${choferesDelimitados.map(c => `<option value='${JSON.stringify(c)}'>${c.nom} (TRC: ${c.tractor})</option>`).join('')}
                    </select>
                </div>

                <div class="space-y-1.5">
                    <label class="block text-[11px] font-bold text-gray-500 uppercase tracking-wider">Clasificación</label>
                    <div class="grid grid-cols-2 gap-2">
                        ${renderBtnTipo('baja', 'Baja / Término')}
                        ${renderBtnTipo('certificacion', 'Certificación')}
                        ${renderBtnTipo('examen', 'Examen Médico')}
                        ${renderBtnTipo('reparacion', 'Reparación')}
                    </div>
                </div>

                <div class="min-h-[70px] space-y-3">
                    ${reqFecha ? `
                        <div class="space-y-1.5">
                            <label class="block text-[11px] font-bold text-gray-500 uppercase tracking-wider">Fecha Render</label>
                            <input type="date" id="form-fecha" required class="w-full h-12 px-4 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-gray-900 outline-none">
                        </div>` : ''}
                    
                    ${reqDetalle ? `
                        <div class="space-y-1.5">
                            <label class="block text-[11px] font-bold text-gray-500 uppercase tracking-wider">Detalle Técnico</label>
                            <textarea id="form-detalle" required rows="2" placeholder="Especificar requerimiento..." class="w-full p-3 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-gray-900 outline-none resize-none"></textarea>
                        </div>` : ''}
                </div>

                <button type="submit" class="w-full h-14 bg-gray-900 text-white font-bold rounded-xl shadow-lg active:scale-[0.98] transition-transform">
                    Confirmar Novedad
                </button>
            </form>
        </div>
    </div>
    `;
}

function renderBtnTipo(tipo, label) {
    const activo = tipoNovedadActiva === tipo;
    const clase = activo ? 'bg-gray-900 text-white border-gray-900 shadow-sm' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50';
    return `<button type="button" onclick="cambiarTipo('${tipo}')" class="h-10 text-xs font-bold rounded-lg border transition-colors ${clase}">${label}</button>`;
}

function renderEmptyState(msg) {
    return `<div class="py-12 flex flex-col items-center justify-center text-gray-400"><svg class="w-8 h-8 mb-2 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"></path></svg><span class="text-xs font-bold uppercase tracking-wider">${msg}</span></div>`;
}

// ====================
// 6. CONTROLADORES Y MUTACIONES
// ====================
function actualizarVistas() {
    const dashboard = document.getElementById('view-dashboard-novedades');
    if (dashboard) morphdom(dashboard, renderDashboardNovedades());
    
    const modal = document.getElementById('modal-novedades');
    if (modal && !modal.classList.contains('translate-y-full')) {
        morphdom(modal, renderModuloMobile(), { childrenOnly: true });
    }
}

function cambiarTipo(tipo) {
    tipoNovedadActiva = tipo;
    actualizarVistas(); // El morphdom mantiene el formulario intacto y solo cambia los inputs
}

function toggleEstadoNovedad(id) {
    const index = novedadesMemoria.findIndex(n => n.id === id);
    if (index === -1) return;

    // Mutación optimista en RAM
    novedadesMemoria[index].estado = novedadesMemoria[index].estado === 'live' ? 'resuelto' : 'live';
    actualizarVistas();

    // Sincronizar con Server para actualizar la Hoja de Cálculo
    socket.emit('novedad:estado:update', { id: id, estado: novedadesMemoria[index].estado });
}

function procesarCarga(e) {
    e.preventDefault();
    
    const chofer = JSON.parse(document.getElementById('form-objetivo').value);
    const fecha = document.getElementById('form-fecha')?.value || new Date().toISOString().split('T')[0];
    const detalle = document.getElementById('form-detalle')?.value || `Operación de ${tipoNovedadActiva}`;

    const nuevaNovedad = {
        id: `nov_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
        tipo: tipoNovedadActiva,
        jerarquia: {
            nom: chofer.nom,
            tractor: chofer.tractor,
            ute: chofer.ute,
            semi: [chofer.semi].filter(Boolean),
            srv: [chofer.srv].filter(Boolean),
            dias: fecha
        },
        detalle: detalle,
        estado: 'live',
        timestamp: new Date().toISOString()
    };

    // 1. Guardar en RAM local e inyectar visualmente sin latencia
    novedadesMemoria.unshift(nuevaNovedad);
    actualizarVistas();
    cerrarModalMobile();

    // 2. Emitir a Node.js para consolidación persistente
    socket.emit('novedad:crear', nuevaNovedad);
}

function abrirModalMobile() { document.getElementById('modal-novedades').classList.remove('translate-y-full'); }
function cerrarModalMobile() { document.getElementById('modal-novedades').classList.add('translate-y-full'); }