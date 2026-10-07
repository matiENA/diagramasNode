// ==============================================================
// 🧪 PRUEBA INTEGRAL LOCAL: ENDPOINT /api/db/status Y MEDICIÓN DE RAM
// ==============================================================

const http = require('http');

async function testEndpoint() {
    console.log('🚀 Iniciando prueba local de endpoint /api/db/status...');
    
    // Configurar puerto de prueba temporal para no chocar
    process.env.PORT = '3099';
    
    // Iniciar servidor
    const app = require('../server.js');
    
    // Esperar 1.5s a que inicialice
    await new Promise(r => setTimeout(r, 1500));
    
    const options = {
        hostname: 'localhost',
        port: 3099,
        path: '/api/db/status',
        method: 'GET'
    };

    const req = http.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
            console.log('\n===============================================================');
            console.log(`✅ RESPUESTA RECIBIDA DE /api/db/status (HTTP ${res.statusCode}):`);
            console.log('===============================================================');
            try {
                const parsed = JSON.parse(data);
                console.log(JSON.stringify(parsed, null, 2));
            } catch (e) {
                console.log(data);
            }
            console.log('===============================================================\n');
            process.exit(0);
        });
    });

    req.on('error', (err) => {
        console.error('❌ Error conectando a localhost:3099:', err.message);
        process.exit(1);
    });

    req.end();
}

testEndpoint();
