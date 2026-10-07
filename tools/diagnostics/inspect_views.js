const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const db = require('../utils/db');

async function main() {
  try {
    const res = await db.query(`
      SELECT table_name, view_definition
      FROM information_schema.views
      WHERE table_schema = 'public' AND table_name IN ('view_calendario_km', 'view_individual_chofer');
    `);

    for (const row of res.rows) {
      console.log(`\n======================================================`);
      console.log(`VIEW: ${row.table_name}`);
      console.log(`======================================================`);
      console.log(row.view_definition);
    }
  } catch (err) {
    console.error('Error:', err);
  } finally {
    process.exit(0);
  }
}

main();
