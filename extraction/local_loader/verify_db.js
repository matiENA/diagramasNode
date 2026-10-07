require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function check() {
    const { data: c } = await supabase.from('choferes').select('id, nombre, legajo, c_servicio, estado').not('legajo', 'is', null).limit(5);
    console.log('Sample choferes con legajo:');
    console.log(JSON.stringify(c, null, 2));
    
    const { data: m } = await supabase.from('movimientos').select('*').limit(3);
    console.log('\nSample movimientos:');
    console.log(JSON.stringify(m, null, 2));

    const { count: uCount } = await supabase.from('unidades').select('*', { count: 'exact', head: true });
    const { count: cCount } = await supabase.from('choferes').select('*', { count: 'exact', head: true });
    const { count: mCount } = await supabase.from('movimientos').select('*', { count: 'exact', head: true });
    console.log(`\nConteos en Supabase: Unidades=${uCount}, Choferes=${cCount}, Movimientos=${mCount}`);
}

check().catch(console.error);
