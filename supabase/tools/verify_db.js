require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function check() {
    console.log('🔍 Verificando estado relacional de Supabase...\n');

    const { count: suCount } = await supabase.from('servicios_unidades').select('*', { count: 'exact', head: true });
    const { count: scCount } = await supabase.from('servicios_choferes').select('*', { count: 'exact', head: true });
    const { count: trCount } = await supabase.from('tractores').select('*', { count: 'exact', head: true });
    const { count: seCount } = await supabase.from('semis').select('*', { count: 'exact', head: true });
    const { count: uCount } = await supabase.from('unidades').select('*', { count: 'exact', head: true });
    const { count: cCount } = await supabase.from('choferes').select('*', { count: 'exact', head: true });
    const { count: mCount } = await supabase.from('movimientos').select('*', { count: 'exact', head: true });

    console.log(`📊 Conteos Canónicos:`);
    console.log(`   • Servicios Unidades:  ${suCount}`);
    console.log(`   • Servicios Choferes:  ${scCount}`);
    console.log(`   • Tractores:           ${trCount}`);
    console.log(`   • Semis:               ${seCount}`);
    console.log(`   • Unidades:            ${uCount}`);
    console.log(`   • Choferes:            ${cCount}`);
    console.log(`   • Movimientos:         ${mCount}`);

    // Test de relación anidada para Unidades
    const { data: sampleUnidad, error: errU } = await supabase
        .from('unidades')
        .select('id, n_ute, estado, tractores(patente, marca, vtv), semis(patente, marca, cisternado), servicios_unidades(denominacion)')
        .not('tractor_id', 'is', null)
        .not('semi_id', 'is', null)
        .limit(1);

    if (errU) console.error('❌ Error en query de unidades:', errU.message);
    else console.log('\n🚛 Muestra de Unidad con Acople y Servicio Relacional:\n', JSON.stringify(sampleUnidad[0], null, 2));

    // Test de relación anidada para Choferes
    const { data: sampleChofer, error: errC } = await supabase
        .from('choferes')
        .select('id, nombre, legajo, estado, servicios_choferes(denominacion, servicios_unidades(denominacion))')
        .limit(1);

    if (errC) console.error('❌ Error en query de choferes:', errC.message);
    else console.log('\n👤 Muestra de Chofer con Servicio Propio y Mapeo a Flota:\n', JSON.stringify(sampleChofer[0], null, 2));
}

check().catch(console.error);
