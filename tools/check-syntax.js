// Chequeo de sintaxis (node --check) de todos los .js de apps/backend y extraction/local_loader.
// Uso: node tools/check-syntax.js
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const roots = ['apps/backend', 'extraction/local_loader'].map(r => path.resolve(__dirname, '..', r));
const skip = new Set(['node_modules', 'data', 'cache']);
let total = 0, fail = 0;

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) {
      total++;
      const r = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8' });
      if (r.status !== 0) { fail++; console.error('FAIL', path.relative(process.cwd(), p), '\n', r.stderr.split('\n').slice(0, 4).join('\n')); }
    }
  }
}
roots.forEach(r => fs.existsSync(r) && walk(r));
console.log(`node --check: ${total - fail}/${total} OK`);
process.exit(fail ? 1 : 0);
