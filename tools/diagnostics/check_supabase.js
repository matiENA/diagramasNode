require('dotenv').config();
const { query } = require('../utils/db');

async function test() {
  const r1 = await query('SELECT count(*) FROM public.movimientos');
  console.log('Total en public.movimientos:', r1.rows[0].count);

  const r2 = await query('SELECT count(*) FROM public.view_movimientos');
  console.log('Total en public.view_movimientos:', r2.rows[0].count);

  const r3 = await query("SELECT conname, contype, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = 'public.movimientos'::regclass");
  console.log('Constraints en public.movimientos:', r3.rows);

  const r4 = await query("SELECT tgname, pg_get_triggerdef(oid) FROM pg_trigger WHERE tgrelid = 'public.movimientos'::regclass AND NOT tgisinternal");
  console.log('Triggers en public.movimientos:', r4.rows);
}

test().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
