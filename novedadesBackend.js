// ====================
// ESTADO GLOBAL (Front-End)
// ====================
let novedadesMemoria = [];
let choferesDelimitados = []; 
let tipoNovedadActiva = 'baja';

// ====================
// SOCKET.IO LISTENERS
// ====================
if (typeof socket !== 'undefined') {
    socket.on('novedades:sync', (payload) => {
        novedadesMemoria = payload;
        actualizarVistasNovedades();
    });

    socket.on('datos_actualizados', (payload) => {
        if (payload.diagramas && payload.diagramas.diagramas) {
            choferesDelimitados = payload.diagramas.diagramas.map(d => ({
                nom: d.nom,
                tractor: d.tractor || 'S/A',
                ute: d.n_ute || 'S/A',
                semi: d.semi || '',
                srv: d.srv || ''
            }));
            // Si el modal está abierto, actualizamos el selector silenciosamente
            const modal = document.getElementById('modal-novedades-mobile');
            if (modal && !modal.classList.contains('translate-y-full')) actualizarVistasNovedades();
        }
    });
}

// ====================
// MUTACIONES Y ENVÍO (Optimistic UI)
// ====================
function toggleEstadoNovedad(id) {
    const index = novedadesMemoria.findIndex(n => n.id === id);
    if (index === -1) return;

    // 1. Mutación local inmediata (Blink-free)
    const nuevoEstado = novedadesMemoria[index].estado === 'live' ? 'resuelto' : 'live';
    novedadesMemoria[index].estado = nuevoEstado;
    actualizarVistasNovedades();

    // 2. Envío al Servidor
    socket.emit('novedad:estado:update', { id, estado: nuevoEstado });
}

function procesarNuevaNovedad(e) {
    e.preventDefault();
    
    const choferRaw = document.getElementById('form-nov-objetivo').value;
    if(!choferRaw) return;
    
    const chofer = JSON.parse(choferRaw);
    const fechaInput = document.getElementById('form-nov-fecha');
    const detalleInput = document.getElementById('form-nov-detalle');

    const nuevaNovedad = {
        id: `nov_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`,
        tipo: tipoNovedadActiva,
        jerarquia: {
            nom: chofer.nom,
            tractor: chofer.tractor,
            semi: [chofer.semi].filter(Boolean),
            srv: [chofer.srv].filter(Boolean),
            n_ute: chofer.ute,
            dias: fechaInput ? fechaInput.value : new Date().toISOString().split('T')[0]
        },
        detalle: detalleInput ? detalleInput.value : `Operación generada por despachante`,
        estado: 'live',
        timestamp: new Date().toISOString()
    };

    // 1. Mutación Local Inmediata
    novedadesMemoria.unshift(nuevaNovedad);
    actualizarVistasNovedades();
    toggleModalNovedadesMobile();

    // 2. Emitir a Node.js
    socket.emit('novedad:crear', nuevaNovedad);
}

function cambiarTipoNovedad(tipo) {
    tipoNovedadActiva = tipo;
    actualizarVistasNovedades();
}

function toggleModalNovedadesMobile() {
    const modal = document.getElementById('modal-novedades-mobile');
    if (modal) modal.classList.toggle('translate-y-full');
}

// ====================
// RENDERIZADO (Morphdom)
// ====================
function actualizarVistasNovedades() {
    const dashboard = document.getElementById('view-dashboard-novedades');
    if (dashboard) morphdom(dashboard, renderDashboardNovedades());
    
    const modal = document.getElementById('modal-novedades-mobile');
    if (modal && !modal.classList.contains('translate-y-full')) {
        morphdom(modal, renderModuloCargaMobile(), { childrenOnly: true });
    }
}

// (Pega aquí debajo las funciones renderDashboardNovedades, renderCardNovedad y renderModuloCargaMobile que te entregué en el paso anterior)