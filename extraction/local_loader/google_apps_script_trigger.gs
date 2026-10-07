/**
 * ==============================================================================
 * GOOGLE APPS SCRIPT: DISPARADOR / TRIGGER HACIA SUPABASE
 * ==============================================================================
 * Instrucciones de instalación:
 * 1. Abre tu Google Sheets (Diagramas o Movimientos).
 * 2. En el menú superior ve a: Extensiones > Apps Script.
 * 3. Pega este código reemplazando SERVER_URL por la URL de tu backend
 *    (ej: 'http://localhost:3005' o 'https://tu-servicio.onrender.com').
 * 4. Guarda con Ctrl+S (o el ícono de disco).
 * 5. Recarga la hoja de cálculo. Aparecerá un menú superior: "⚡ Supabase".
 * ==============================================================================
 */

// 🌐 Reemplazar con la URL local del loader (puerto 3010) o túnel público (ngrok/cloudflared)
const SERVER_URL = "http://localhost:3010"; 

/**
 * Agrega un menú personalizado en la barra superior al abrir la hoja.
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('⚡ Supabase')
    .addItem('🚛 Disparar Sincronización Ahora', 'dispararSincronizacion')
    .addSeparator()
    .addItem('ℹ️ Consultar Estado (/health)', 'consultarEstadoServidor')
    .addToUi();
}

/**
 * Función que dispara la extracción y actualización en Supabase.
 */
function dispararSincronizacion() {
  const ui = SpreadsheetApp.getUi();
  const endpoint = SERVER_URL + '/sync';
  
  try {
    SpreadsheetApp.getActiveSpreadsheet().toast('Disparando extracción hacia Supabase...', 'Sincronización', 5);
    
    const options = {
      method: 'post',
      contentType: 'application/json',
      muteHttpExceptions: true
    };
    
    const response = UrlFetchApp.fetch(endpoint, options);
    const code = response.getResponseCode();
    const content = response.getContentText();
    
    if (code === 200 || code === 202) {
      SpreadsheetApp.getActiveSpreadsheet().toast('Extracción activada con éxito. Procesando en segundo plano...', '✅ Éxito', 8);
    } else {
      ui.alert('⚠️ El servidor respondió con código ' + code + ':\n' + content);
    }
  } catch (error) {
    ui.alert('❌ Error de conexión:\n' + error.toString() + 
             '\n\nVerifica que el servidor esté activo y accesible en: ' + SERVER_URL);
  }
}

/**
 * Consulta el estado de salud y última sincronización del motor.
 */
function consultarEstadoServidor() {
  const ui = SpreadsheetApp.getUi();
  try {
    const response = UrlFetchApp.fetch(SERVER_URL + '/health', { muteHttpExceptions: true });
    const json = JSON.parse(response.getContentText());
    
    const mensaje = 
      'Estado: ' + json.status + '\n' +
      'Última Sincronización: ' + (json.lastSync || 'Ninguna aún') + '\n' +
      'Unidades en RAM: ' + (json.stats?.totalUnidades || 0) + '\n' +
      'Choferes en RAM: ' + (json.stats?.totalChoferes || 0) + '\n' +
      'Movimientos en RAM: ' + (json.stats?.totalMovimientos || 0);
      
    ui.alert('Diagnóstico del Servidor storage_ram_db', mensaje, ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('❌ No se pudo conectar con el servidor: ' + e.toString());
  }
}

/**
 * OPCIONAL: Disparador automático al editar (con debounce)
 * Para activarlo:
 * 1. Ve a "Activadores" (ícono de reloj en el panel izquierdo de Apps Script).
 * 2. Clic en "Añadir activador".
 * 3. Selecciona la función: "alModificarHoja".
 * 4. Tipo de evento: "Al modificar" (On change) o "Al editar" (On edit).
 */
function alModificarHoja(e) {
  // Evitar disparos repetidos en ráfaga (debounce de 2 minutos)
  const cache = CacheService.getScriptCache();
  const yaDisparado = cache.get('sync_lock');
  
  if (yaDisparado) {
    return; // Ya hay un disparo reciente en cola
  }
  
  cache.put('sync_lock', 'true', 120); // Bloqueo por 120 segundos
  
  try {
    UrlFetchApp.fetch(SERVER_URL + '/sync', {
      method: 'post',
      muteHttpExceptions: true
    });
  } catch (err) {
    console.warn('Error en trigger automático:', err);
  }
}
