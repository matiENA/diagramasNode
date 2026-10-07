const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const db = require('../utils/db');

async function testPipeline() {
  console.log('==============================================================================');
  console.log('🧪 VERIFICACIÓN INTEGRAL DE ARQUITECTURA KM EN SUPABASE');
  console.log('==============================================================================\n');

  try {
    // 1. Confirmar ausencia de movimientos_km
    console.log('1️⃣ Comprobando que movimientos_km ya no existe...');
    const tCheck = await db.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' AND table_name = 'movimientos_km';
    `);
    if (tCheck.rows.length === 0) {
      console.log('   ✅ movimientos_km fue eliminada con éxito (0 tablas residuales).');
    } else {
      throw new Error('movimientos_km todavía existe!');
    }

    // 2. Comprobar choferes_km_mensual
    console.log('\n2️⃣ Verificando tabla principal public.choferes_km_mensual...');
    const rChoferesKm = await db.query(`
      SELECT 
        COUNT(*)::int as total_buckets,
        COUNT(DISTINCT chofer_id)::int as total_choferes,
        ROUND(SUM(km_mes_total))::float as total_km_acumulados,
        SUM(cant_viajes)::int as total_viajes
      FROM public.choferes_km_mensual;
    `);
    console.log('   ✅ Métricas en choferes_km_mensual:', rChoferesKm.rows[0]);

    // 3. Comprobar vista view_calendario_diagrama_km
    console.log('\n3️⃣ Verificando vista public.view_calendario_diagrama_km...');
    const t0 = Date.now();
    const rDiagKm = await db.query(`
      SELECT diagrama_id, chofer_id, mes_tab, km_mes_total, cant_viajes_mes
      FROM public.view_calendario_diagrama_km
      WHERE km_mes_total > 0
      LIMIT 5;
    `);
    console.log(`   ✅ Query ejecutada en ${Date.now() - t0}ms.`);
    console.log('   Sample:', rDiagKm.rows);

    // 4. Comprobar vista virtual view_calendario_km
    console.log('\n4️⃣ Verificando vista virtual public.view_calendario_km...');
    const t1 = Date.now();
    const rCalKm = await db.query(`
      SELECT fecha, chofer_nombre, legajo, dominio, km, cant_viajes, hoja_ruta
      FROM public.view_calendario_km
      WHERE km > 0
      LIMIT 5;
    `);
    console.log(`   ✅ Query ejecutada en ${Date.now() - t1}ms.`);
    console.log('   Sample:', rCalKm.rows);

    // 5. Comprobar vista view_individual_chofer
    console.log('\n5️⃣ Verificando vista public.view_individual_chofer (total_km)...');
    const t2 = Date.now();
    const rInd = await db.query(`
      SELECT chofer_id, nombre, legajo, total_km
      FROM public.view_individual_chofer
      WHERE total_km > 0
      LIMIT 5;
    `);
    console.log(`   ✅ Query ejecutada en ${Date.now() - t2}ms.`);
    console.log('   Sample:', rInd.rows);

    // 6. Probar sincronización de una muestra de viajes hacia cisternas_km
    console.log('\n6️⃣ Probando inyección y upsert hacia public.cisternas_km...');
    const { extractKilometros, upsertCisternasKm } = require('../../storage_ram_db/extractors/kilometros');
    
    // Obtenemos tractores y unidades existentes
    const uRes = await db.query(`
      SELECT u.id as id_unidad, u.tractor_id, t.patente AS tractor, u.semi_id, s.patente AS semi, u.n_ute
      FROM public.unidades u
      LEFT JOIN public.tractores t ON u.tractor_id = t.id
      LEFT JOIN public.semis s ON u.semi_id = s.id
      WHERE u.tractor_id IS NOT NULL AND u.semi_id IS NOT NULL
      LIMIT 10;
    `);

    const formacionMap = new Map();
    uRes.rows.forEach(u => {
      const item = {
        id_unidad: u.id_unidad,
        tractor_id: u.tractor_id,
        tractor_patente: u.tractor,
        semi_id: u.semi_id,
        cisterna_patente: u.semi,
        n_ute: u.n_ute
      };
      if (u.tractor) formacionMap.set(u.tractor.trim().toUpperCase().replace(/[^A-Z0-9]/g, ''), item);
      if (u.id_unidad) formacionMap.set(u.id_unidad, item);
    });

    const sampleTrips = uRes.rows.map((u, i) => ({
      fecha: '2026-10-0' + ((i % 5) + 1),
      dominio: u.tractor,
      id_unidad: u.id_unidad,
      id_chofer: null,
      km_totales: 250.0 + (i * 10),
      hoja_ruta: 'HR-AUTO-' + (1000 + i)
    }));

    await upsertCisternasKm(db, sampleTrips, { formacionMap });
    const cCount = await db.query(`SELECT count(*)::int as total FROM public.cisternas_km;`);
    console.log(`   ✅ Filas en cisternas_km tras upsert: ${cCount.rows[0].total}`);

    const cSample = await db.query(`
      SELECT fecha, tractor_patente, cisterna_patente, km_totales, hoja_ruta, estado_asignacion
      FROM public.cisternas_km
      LIMIT 3;
    `);
    console.log('   Sample en cisternas_km:', cSample.rows);

    console.log('\n==============================================================================');
    console.log('🎉 TODAS LAS VERIFICACIONES COMPLETADAS CON ÉXITO');
    console.log('==============================================================================');
  } catch (err) {
    console.error('❌ Error en test pipeline:', err);
    process.exit(1);
  } finally {
    process.exit(0);
  }
}

testPipeline();
