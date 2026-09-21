// ==============================================================
// 🧪 DIAGNÓSTICO Y MEDICIÓN DE IMPACTO EN RAM: CLIENTE PG
// ==============================================================

require('dotenv').config();

function formatMB(bytes) {
    return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

function getMemorySnapshot() {
    const mem = process.memoryUsage();
    return {
        rss: mem.rss,
        heapTotal: mem.heapTotal,
        heapUsed: mem.heapUsed,
        external: mem.external,
        rssFormatted: formatMB(mem.rss),
        heapTotalFormatted: formatMB(mem.heapTotal),
        heapUsedFormatted: formatMB(mem.heapUsed)
    };
}

async function runTest() {
    console.log('\n===============================================================');
    console.log('🐘 TEST DE RENDIMIENTO, PARÁMETROS Y HUELLA DE RAM (PG CLIENT)');
    console.log('===============================================================\n');

    // 1. Huella Base de Node.js antes de cargar el módulo PG
    const memBaseline = getMemorySnapshot();
    console.log('📊 1. HUELLA DE MEMORIA BASE (Runtime Node.js sin PG):');
    console.log(`   • Heap Usado:  ${memBaseline.heapUsedFormatted}`);
    console.log(`   • Heap Total:  ${memBaseline.heapTotalFormatted}`);
    console.log(`   • RSS (Total): ${memBaseline.rssFormatted}\n`);

    // 2. Cargar módulo utils/db
    const startLoad = Date.now();
    const db = require('../utils/db');
    const loadTimeMs = Date.now() - startLoad;
    const memAfterLoad = getMemorySnapshot();

    const heapDelta = memAfterLoad.heapUsed - memBaseline.heapUsed;
    const rssDelta = memAfterLoad.rss - memBaseline.rss;

    console.log('⚡ 2. HUELLA TRAS INICIALIZAR PG CLIENT & POOL:');
    console.log(`   • Tiempo de carga del driver: ${loadTimeMs} ms`);
    console.log(`   • Heap Usado actual:  ${memAfterLoad.heapUsedFormatted} (Delta: +${formatMB(heapDelta)})`);
    console.log(`   • RSS actual:         ${memAfterLoad.rssFormatted} (Delta: +${formatMB(rssDelta)})`);
    console.log(`   💡 Impacto de RAM mínimo: ~${formatMB(heapDelta)} (vs >100 MB de Prisma o TypeORM)\n`);

    // 3. Parámetros del Pool
    const metrics = db.getPoolMetrics();
    console.log('⚙️ 3. PARÁMETROS DEL POOL (Optimizados para baja RAM / 512 MB):');
    console.log(`   • Max Conexiones Simultáneas:    ${metrics.poolConfig.max}`);
    console.log(`   • Idle Timeout (Cierre inactivo): ${metrics.poolConfig.idleTimeoutMillis} ms (10s)`);
    console.log(`   • Connection Timeout:             ${metrics.poolConfig.connectionTimeoutMillis} ms (5s)`);
    console.log(`   • Max Uses por Conexión:          ${metrics.poolConfig.maxUses} consultas`);
    console.log(`   • SSL Configurado:                ${metrics.poolConfig.ssl ? 'SÍ (rejectUnauthorized: false)' : 'NO'}`);
    console.log(`   • DATABASE_URL configurada:       ${metrics.isConfigured ? 'SÍ ✅' : 'NO ⚠️ (Modo Fallback)'}\n`);

    // 4. Prueba de Conexión en Vivo
    if (metrics.isConfigured) {
        console.log('🔌 4. PROBANDO CONEXIÓN A POSTGRESQL...');
        const health = await db.checkHealth();
        if (health.ok) {
            console.log(`   ✅ Conexión Exitosa:`);
            console.log(`      • Base de datos:  ${health.database}`);
            console.log(`      • Hora servidor:  ${health.serverTime}`);
            console.log(`      • Latencia:       ${health.latencyMs} ms`);

            // Probar query ligera y medir memoria
            const qRes = await db.query('SELECT 1 as test_val, current_setting(\'server_version\') as version');
            console.log(`      • Query test:     OK (Versión Postgres: ${qRes.rows[0]?.version})`);
        } else {
            console.log(`   ❌ Error de conexión: ${health.error}`);
        }
    } else {
        console.log('ℹ️ 4. CONEXIÓN EN ESPERA:');
        console.log('   Para conectar a PostgreSQL / Supabase vía pg client, añade en tu .env:');
        console.log('   DATABASE_URL="postgres://postgres:[PASSWORD]@[HOST]:6543/postgres?pgbouncer=true"');
        console.log('   (Usa el Transaction Pooler en puerto 6543 para no saturar conexiones en Supabase)\n');
    }

    const memFinal = getMemorySnapshot();
    console.log('===============================================================');
    console.log('📋 RESUMEN DE PARÁMETROS Y MÉTRICAS DEVUELTAS:');
    console.log('===============================================================');
    const salidaJSON = {
        driver: "pg (node-postgres)",
        parametros_pool: metrics.poolConfig,
        memoria_base: {
            heapUsedMB: +(memBaseline.heapUsed / 1024 / 1024).toFixed(2),
            rssMB: +(memBaseline.rss / 1024 / 1024).toFixed(2)
        },
        memoria_con_pg: {
            heapUsedMB: +(memFinal.heapUsed / 1024 / 1024).toFixed(2),
            rssMB: +(memFinal.rss / 1024 / 1024).toFixed(2),
            deltaHeapMB: +(heapDelta / 1024 / 1024).toFixed(2)
        },
        status_pool: metrics.poolStatus
    };
    console.log(JSON.stringify(salidaJSON, null, 2));
    console.log('===============================================================\n');

    // Cerrar pool para terminar el script limpiamente
    if (db.pool) {
        await db.pool.end();
    }
}

runTest().catch(err => {
    console.error('Error ejecutando diagnóstico:', err);
    process.exit(1);
});
