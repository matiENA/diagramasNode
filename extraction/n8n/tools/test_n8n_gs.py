import psycopg2, json, os
from urllib.parse import urlparse

# Read actual Google Sheet data for Oct-26 from local_loader
import urllib.request
from datetime import datetime

# Read service account credentials from .env
env_vars = {}
with open(r'C:\Users\Matias Rodriguez\Documents\storage_ram_db\local_loader\.env', 'r', encoding='utf-8') as f:
    for line in f:
        if '=' in line and not line.startswith('#'):
            k, v = line.strip().split('=', 1)
            env_vars[k] = v.strip('"\'')

# Let's run a node script to fetch and run prepareSheetData simulation
node_test = '''
require('dotenv').config({ path: 'C:/Users/Matias Rodriguez/Documents/storage_ram_db/local_loader/.env' });
const { JWT } = require('google-auth-library');

async function run() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = process.env.GOOGLE_PRIVATE_KEY.replace(/\\\\n/g, '\\n');
  const auth = new JWT({ email, key, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });

  const url = 'https://sheets.googleapis.com/v4/spreadsheets/1mhfXpFCF6upMlnRnZjDdBVS_wqTx5q8v0qQArNCnNAU/values/' + encodeURIComponent('Oct-26!A1:AN350');
  const res = await auth.request({ url });
  const allRows = res.data.values || [];
  console.log('Total sheet rows:', allRows.length);

  // Row 5 is index 4 (header), Row 6 is index 5 (data)
  const headerRow = allRows[4];
  console.log('Header Row columns:', headerRow.length);

  // Map into objects as n8n prepareSheetData does
  const items = [];
  for (let r = 5; r < allRows.length; r++) {
    const row = allRows[r];
    const obj = {};
    for (let c = 0; c < headerRow.length; c++) {
      const colName = headerRow[c] || ('col_' + (c + 1));
      obj[colName] = row[c] !== undefined ? row[c] : '';
    }
    items.push(obj);
  }

  console.log('Total driver rows:', items.length);
  const sampleDriver = items[0];
  console.log('Sample Driver row keys:', Object.keys(sampleDriver).slice(0, 15));
  console.log('Sample Driver LEGAJO:', sampleDriver['LEGAJO'], 'NOMBRE:', sampleDriver['APELLIDO Y NOMBRE'], 'DIAGRAMA:', sampleDriver['DIAGRAMA']);

  // Extract day columns
  const dayCols = {};
  for (const k of Object.keys(sampleDriver)) {
    const m = k.trim().match(/^(\\\\d+)[\\\\/\\\\-](\\\\d+)$/);
    if (m) {
      dayCols[k] = { day: parseInt(m[1], 10), val: sampleDriver[k] };
    }
  }
  console.log('Day columns found for driver 0:', Object.keys(dayCols).length, dayCols);
}
run().catch(console.error);
'''

with open(r'c:\Users\Matias Rodriguez\Documents\server_local\test_n8n_gs.js', 'w', encoding='utf-8') as f:
    f.write(node_test)
