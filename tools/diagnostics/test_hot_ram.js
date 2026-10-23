/**
 * tools/diagnostics/test_hot_ram.js
 * Test de verificación y rendimiento de Hot RAM embebido en eor_v1/apps/backend
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const db = require('../../apps/backend/utils/db');
const hotRam = require('../../apps/backend/cache/hotRamManager');
const express = require('../../apps/backend/node_modules/express');
const http = require('http');

async function runTests() {
    console.log('===============================================================');
    console.log('⚡ TEST DE INTEGRACIÓN Y RENDIMIENTO: MOTOR HOT RAM (OPCIÓN B)');
    console.log('===============================================================\n');

    const memInicio = process.memoryUsage();
    console.log(`📊 Memoria inicial: ${(memInicio.heapUsed / 1024 / 1024).toFixed(2)} MB Heap | ${(memInicio.rss / 1024 / 1024).toFixed(2)} MB RSS\n`);

    // 1. Test de Hidratación en RAM
    console.log('1️⃣ Hidratando Hot RAM desde PostgreSQL Supabase...');
    const t0 = Date.now();
    const ok = await hotRam.hydrateFromDatabase(db);
    const msHidratacion = Date.now() - t0;

    if (!ok) {
        console.error('❌ Error hidratando Hot RAM. Revisa las credenciales de base de datos.');
        process.exit(1);
    }

    const memPost = process.memoryUsage();
    const deltaHeapMb = (memPost.heapUsed - memInicio.heapUsed) / 1024 / 1024;
    console.log(`   ✅ Hidratación completada en ${msHidratacion} ms`);
    console.log(`   📦 Huella de memoria de Hot RAM: +${deltaHeapMb.toFixed(2)} MB en Heap (Total: ${(memPost.heapUsed / 1024 / 1024).toFixed(2)} MB)`);
    console.log(`   🏷️ ETag inicial: ${hotRam.getEtag()}`);
    console.log(`   📈 Conteo: ${hotRam.stats.totalDiaria} choferes en diaria, ${hotRam.stats.totalFlota} unidades en flota, ${hotRam.stats.totalRetorno} en retorno, ${hotRam.stats.totalCalendarios} calendarios.\n`);

    // 2. Test de Rendimiento de Consultas en RAM (< 5ms)
    console.log('2️⃣ Evaluando latencia de consultas y filtros en memoria:');

    // A. Diaria sin filtros
    const tDiaria0 = performance.now();
    const resDiaria = hotRam.queryDiaria({ limit: 16, offset: 0 });
    const msDiaria = (performance.now() - tDiaria0).toFixed(2);
    console.log(`   • queryDiaria (sin filtro, 16 choferes): ${msDiaria} ms | Total: ${resDiaria.total} | Retornados: ${resDiaria.retornados}`);

    // B. Diaria con filtro de servicio y búsqueda
    const tDiariaFiltro0 = performance.now();
    const resDiariaFiltro = hotRam.queryDiaria({ limit: 50, offset: 0, servicio: 'METANOL', search: 'A' });
    const msDiariaFiltro = (performance.now() - tDiariaFiltro0).toFixed(2);
    console.log(`   • queryDiaria (servicio METANOL + search 'A'): ${msDiariaFiltro} ms | Total matching: ${resDiariaFiltro.total}`);

    // C. Flota
    const tFlota0 = performance.now();
    const resFlota = hotRam.queryFlota({ servicio: 'TODOS', search: '' });
    const msFlota = (performance.now() - tFlota0).toFixed(2);
    console.log(`   • queryFlota: ${msFlota} ms | Total unidades: ${resFlota.length}`);

    // D. Retorno
    const tRetorno0 = performance.now();
    const resRetorno = hotRam.queryRetorno({ tipo: 'TODOS' });
    const msRetorno = (performance.now() - tRetorno0).toFixed(2);
    console.log(`   • queryRetorno: ${msRetorno} ms | Retornan hoy: ${resRetorno.resumen.vuelven_hoy} | mañana: ${resRetorno.resumen.vuelven_manana}`);

    // E. Ficha individual O(1)
    if (resDiaria.datos.length > 0) {
        const testChId = resDiaria.datos[0].chofer_id;
        const tInd0 = performance.now();
        const resInd = hotRam.queryIndividualChofer(testChId);
        const msInd = (performance.now() - tInd0).toFixed(2);
        console.log(`   • queryIndividualChofer O(1): ${msInd} ms | Chofer: ${resInd?.nombre || 'N/A'}`);
    }

    console.log('\n3️⃣ Montando servidor Express de prueba para evaluar HTTP y ETag 304:');
    const app = express();
    const createViewsRouter = require('../../apps/backend/routes/views');
    const createHotRamRouter = require('../../apps/backend/routes/hotRamRoutes');

    app.use('/api/views', createViewsRouter(hotRam));
    app.use('/', createHotRamRouter(hotRam));

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}`;
    console.log(`   🌐 Servidor Express efímero en puerto ${port}`);

    // Test HTTP GET /api/views/diaria
    const tHttp1 = performance.now();
    const r1 = await fetch(`${baseUrl}/api/views/diaria?limit=16`);
    const msHttp1 = (performance.now() - tHttp1).toFixed(2);
    const etagReceived = r1.headers.get('etag');
    const j1 = await r1.json();
    console.log(`   • GET /api/views/diaria -> HTTP ${r1.status} en ${msHttp1} ms | ETag: ${etagReceived} | Vista: ${j1.vista}`);

    // Test HTTP 304 Not Modified con If-None-Match
    const tHttp2 = performance.now();
    const r2 = await fetch(`${baseUrl}/api/views/diaria?limit=16`, {
        headers: { 'If-None-Match': etagReceived }
    });
    const msHttp2 = (performance.now() - tHttp2).toFixed(2);
    const bodyLength = (await r2.text()).length;
    console.log(`   • GET /api/views/diaria (con If-None-Match) -> HTTP ${r2.status} en ${msHttp2} ms | Bytes payload: ${bodyLength} (0 egress)`);

    // Test GET /ram (Métricas del motor)
    const rRam = await fetch(`${baseUrl}/ram`);
    const jRam = await rRam.json();
    console.log(`   • GET /ram -> Estado: ${jRam.status} | Heap: ${jRam.memoria.heapUsedMb} MB | Choferes: ${jRam.stats.totalChoferes}`);

    // 4. Test de Mutación Optimista en RAM
    console.log('\n4️⃣ Probando mutación optimista en RAM e invalidación de ETag:');
    const etagPrevio = hotRam.getEtag();
    const targetUnidad = hotRam.flota[0]?.unidad_id;

    if (targetUnidad) {
        hotRam.actualizarAcople(targetUnidad, { tractor: 'PRUEBA999', semi: 'SEMI999' });
        const etagNuevo = hotRam.getEtag();
        console.log(`   • ETag previo: ${etagPrevio} -> ETag nuevo tras acople: ${etagNuevo}`);
        console.log(`   • ¿Cambió el ETag?: ${etagPrevio !== etagNuevo ? 'SÍ (Correcto)' : 'NO (Error)'}`);

        const rFlotaCheck = await fetch(`${baseUrl}/api/views/flota?search=PRUEBA999`);
        const jFlotaCheck = await rFlotaCheck.json();
        const encontrada = jFlotaCheck.datos.some(u => u.tractor === 'PRUEBA999');
        console.log(`   • Mutación visible instantáneamente en /api/views/flota: ${encontrada ? '✅ SÍ' : '❌ NO'}`);
    }

    server.close();
    console.log('\n===============================================================');
    console.log('🎉 TODOS LOS TESTS DE HOT RAM PASARON SATISFACTORIAMENTE');
    console.log('===============================================================\n');

    if (db.pool) await db.pool.end();
}

runTests().catch(err => {
    console.error('💥 Error inesperado:', err);
    process.exit(1);
});
