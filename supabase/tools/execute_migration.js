const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
require('dotenv').config();

async function runMigration() {
  console.log('🔄 Conectando a Supabase PostgreSQL...');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  console.log('✅ Conexión establecida.');

  const sqlPath = path.join(__dirname, 'supabase_clean_duplicates.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');

  console.log('🚀 Ejecutando script de migración SQL...');
  const start = Date.now();
  try {
    await client.query(sql);
    console.log(`✅ Migración ejecutada con éxito en ${Date.now() - start} ms!`);
  } catch (err) {
    console.error('❌ Error ejecutando migración:', err);
    await client.end();
    process.exit(1);
  }

  // Verificaciones
  console.log('\n📊 VERIFICACIÓN POST-MIGRACIÓN:');

  // 1. Columnas de choferes
  const choferesCols = await client.query(`
    SELECT column_name FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'choferes'
    ORDER BY ordinal_position;
  `);
  console.log('• Columnas actuales en choferes:', choferesCols.rows.map(r => r.column_name).join(', '));

  // 2. Columnas de diagramas
  const diagramasCols = await client.query(`
    SELECT column_name FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'diagramas'
    ORDER BY ordinal_position;
  `);
  console.log('• Columnas actuales en diagramas:', diagramasCols.rows.map(r => r.column_name).join(', '));

  // 3. Columnas de movimientos_km
  const kmCols = await client.query(`
    SELECT column_name FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'movimientos_km'
    ORDER BY ordinal_position;
  `);
  console.log('• Columnas actuales en movimientos_km:', kmCols.rows.map(r => r.column_name).join(', '));

  // 4. Columnas de novedades
  const novCols = await client.query(`
    SELECT column_name FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'novedades'
    ORDER BY ordinal_position;
  `);
  console.log('• Columnas actuales en novedades:', novCols.rows.map(r => r.column_name).join(', '));

  // 5. Columnas de chofer_observaciones
  const obsCols = await client.query(`
    SELECT column_name FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = 'chofer_observaciones'
    ORDER BY ordinal_position;
  `);
  console.log('• Columnas actuales en chofer_observaciones:', obsCols.rows.map(r => r.column_name).join(', '));

  // 6. Test de vista movimientos
  const movView = await client.query(`SELECT count(*) FROM public.movimientos;`);
  console.log('• Conteo en vista movimientos:', movView.rows[0].count);

  // 7. Conteo de filas en tablas principales
  const tables = ['choferes', 'chofer_documentacion', 'chofer_observaciones', 'diagramas', 'movimientos_km', 'novedades', 'tractores', 'semis', 'unidades'];
  console.log('\n📈 Conteo de filas conservadas:');
  for (const t of tables) {
    const c = await client.query(`SELECT count(*) FROM public."${t}";`);
    console.log(`  - ${t.padEnd(22)}: ${c.rows[0].count}`);
  }

  // 8. Test de vista view_calendario_km
  const vCal = await client.query(`SELECT count(*) FROM public.view_calendario_km;`);
  console.log('• Registros en view_calendario_km:', vCal.rows[0].count);

  // 9. Test de vista view_diagrama_mensual
  const vDiag = await client.query(`SELECT count(*) FROM public.view_diagrama_mensual;`);
  console.log('• Registros en view_diagrama_mensual:', vDiag.rows[0].count);

  // 10. Test de vista view_diaria_operativa
  const vDiaria = await client.query(`SELECT count(*) FROM public.view_diaria_operativa;`);
  console.log('• Registros en view_diaria_operativa:', vDiaria.rows[0].count);

  await client.end();
}

runMigration().catch(console.error);
