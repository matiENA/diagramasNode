// ==============================================================
// 🧪 DIAGNÓSTICO Y PRUEBA DE RAM EN PUERTOS LOCALES
// Verifica los puertos 3000 (Backend Principal) y 3001 (Microservicio KM)
// ==============================================================

const http = require('http');

const KM_PORT = process.env.KM_PORT || 3001;
const MAIN_PORT = process.env.MAIN_PORT || (process.env.PORT && process.env.PORT !== '3001' ? process.env.PORT : 3000);

function fetchJson(url, timeoutMs = 4000) {
    return new Promise((resolve) => {
        const start = Date.now();
        const req = http.get(url, { timeout: timeoutMs }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                const latency = Date.now() - start;
                try {
                    const json = JSON.parse(data);
                    resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: json, latency });
                } catch (e) {
                    resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, raw: data.trim(), latency });
                }
            });
        });
        req.on('error', (err) => resolve({ ok: false, error: err.code || err.message || 'Desconectado', latency: Date.now() - start }));
        req.on('timeout', () => {
            req.destroy();
            resolve({ ok: false, error: 'TIMEOUT (> ' + timeoutMs + 'ms)', latency: Date.now() - start });
        });
    });
}

async function runDiagnostic() {
    console.log('\n===============================================================');
    console.log('🧪 DIAGNÓSTICO DE RAM Y CONEXIÓN EN PUERTOS LOCALES');
    console.log('===============================================================\n');

    // 1. Diagnóstico del Microservicio KM (Puerto 3001)
    console.log(`🔍 1. Comprobando Microservicio de Kilómetros en PUERTO ${KM_PORT}:`);
    const kmHealth = await fetchJson(`http://localhost:${KM_PORT}/health`);
    if (!kmHealth.ok) {
        console.log('   ❌ Microservicio en puerto 3001: OFFLINE o no responde');
        console.log(`      Error: ${kmHealth.error || kmHealth.status}`);
        console.log('      👉 Para iniciarlo ejecuta: npm run start:km\n');
    } else {
        console.log(`   ✅ Microservicio en puerto 3001: ONLINE (${kmHealth.latency}ms)`);
        const stats = kmHealth.data && kmHealth.data.stats ? kmHealth.data.stats : {};
        const mem = kmHealth.data && kmHealth.data.memoria_actual ? kmHealth.data.memoria_actual : {};
        console.log(`      • Servicio: ${kmHealth.data.servicio || 'km-extractor-service'}`);
        console.log(`      • Uptime: ${kmHealth.data.uptime_segundos || 0} segundos`);
        console.log(`      • Planilla: ${kmHealth.data.planilla_objetivo || 'N/A'}`);
        console.log(`      • Filas procesadas de la hoja 'KM': ${stats.totalRows || 'Extrayendo...'}`);
        console.log(`      • Choferes indexados en RAM: ${stats.choferesCount || 0}`);
        console.log(`      • Viajes activos (12 meses): ${stats.totalViajesHot || 0}`);
        console.log(`      • Memoria RAM Usada: Heap ${mem.heapUsedMB || 0} MB | Total ${mem.heapTotalMB || 0} MB`);

        // Test de latencia de entrega de partición de viajes
        process.stdout.write('   ⏱️  Midiendo tiempo de descarga de RAM (/api/km/viajes)... ');
        const kmViajes = await fetchJson(`http://localhost:${KM_PORT}/api/km/viajes`, 10000);
        if (kmViajes.ok) {
            console.log(`¡EXITOSO! Recibido en ${kmViajes.latency}ms.`);
        } else {
            console.log(`Pendiente (${kmViajes.data && kmViajes.data.message ? kmViajes.data.message : 'Sincronizando...'})`);
        }
        console.log('');
    }

    // 2. Diagnóstico del Backend Principal
    console.log(`🔍 2. Comprobando Backend Principal (Diagramas) en PUERTO ${MAIN_PORT}:`);
    const mainHealth = await fetchJson(`http://localhost:${MAIN_PORT}/health`);
    if (!mainHealth.ok || mainHealth.raw !== 'OK') {
        if (mainHealth.status === 404 || (mainHealth.ok && mainHealth.raw !== 'OK')) {
            console.log(`   ⚠️ ATENCIÓN: El puerto ${MAIN_PORT} responde pero NO es el Backend Principal.`);
            console.log('      (Hay otra aplicación o script de Node corriendo en este puerto)');
            console.log(`      👉 Detén la otra aplicación en el puerto ${MAIN_PORT} o usa otro puerto con PORT=3002.`);
        } else {
            console.log(`   ❌ Backend Principal en puerto ${MAIN_PORT}: OFFLINE`);
            console.log(`      Error: ${mainHealth.error || ('Status HTTP ' + mainHealth.status)}`);
            console.log(`      👉 Para iniciarlo conectado al puerto local ${KM_PORT} ejecuta: npm run start:main:local`);
        }
        console.log('');
    } else {
        console.log(`   ✅ Backend Principal en puerto ${MAIN_PORT}: ONLINE (${mainHealth.latency}ms)`);
        const mainKmStatus = await fetchJson(`http://localhost:${MAIN_PORT}/api/km/status`);
        if (mainKmStatus.ok && mainKmStatus.data) {
            const cfg = mainKmStatus.data;
            console.log(`      • Microservicio configurado: ${cfg.microservicio_configurado ? 'SÍ' : 'NO'}`);
            console.log(`      • URL de conexión KM: ${cfg.url || 'No configurada (Usa fallback local)'}`);
            if (cfg.url && cfg.url.includes(String(KM_PORT))) {
                console.log(`      ⚡ ¡CONEXIÓN ÓPTIMA! El Backend Principal está consumiendo la RAM del puerto ${KM_PORT}.`);
            } else if (cfg.url && cfg.url.includes('render.com')) {
                console.log('      🌐 El Backend Principal está conectado al microservicio en la nube (Render).');
            }
        }
        console.log('');
    }

    // 3. Resumen de comandos
    console.log('===============================================================');
    console.log('📋 COMANDOS PARA PROBAR EN PUERTOS LOCALES:');
    console.log('===============================================================');
    console.log(`1. Iniciar Microservicio KM (Puerto ${KM_PORT}):`);
    console.log('   npm run start:km\n');
    console.log(`2. Iniciar Backend Principal conectado a la RAM local de ${KM_PORT} (Puerto ${MAIN_PORT}):`);
    console.log('   npm run start:main:local\n');
    console.log('3. Iniciar Backend Principal conectado a la nube de Render:');
    console.log('   npm run start:main\n');
    console.log('4. Ejecutar este diagnóstico de RAM en cualquier momento:');
    console.log('   npm run test:ram\n');
    console.log('5. URLs para abrir directamente en el navegador o curl:');
    console.log(`   • Microservicio Health:   http://localhost:${KM_PORT}/health`);
    console.log(`   • Microservicio Viajes:   http://localhost:${KM_PORT}/api/km/viajes`);
    console.log(`   • Backend Conexión KM:    http://localhost:${MAIN_PORT}/api/km/status`);
    console.log(`   • Backend RAM Completa:   http://localhost:${MAIN_PORT}/api/datos`);
    console.log('===============================================================\n');
}

runDiagnostic();
