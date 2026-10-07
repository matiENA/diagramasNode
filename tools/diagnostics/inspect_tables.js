const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const db = require('../utils/db');

async function main() {
  try {
    const res = await db.query(`
      SELECT table_name, table_type 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_type, table_name;
    `);

    console.log('--- TABLES & VIEWS IN PUBLIC SCHEMA ---');
    for (const row of res.rows) {
      if (row.table_type === 'BASE TABLE') {
        try {
          const c = await db.query(`SELECT count(*) FROM public."${row.table_name}"`);
          console.log(`[TABLE] ${row.table_name}: ${c.rows[0].count} rows`);
        } catch (err) {
          console.log(`[TABLE] ${row.table_name}: Error (${err.message})`);
        }
      } else {
        console.log(`[VIEW]  ${row.table_name}`);
      }
    }
  } catch (err) {
    console.error('Inspect failed:', err);
  } finally {
    process.exit(0);
  }
}

main();
