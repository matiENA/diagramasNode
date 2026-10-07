// Smoke test SOLO LECTURA (GET). Compara eor_v1 backend (4005) contra:
//   - backend original (3005) y front/proxy original (3000, que sirve /api/views y /api/movimientos)
const NEW = 'http://localhost:4005';
const OLD_BACK = 'http://localhost:3005';
const OLD_FRONT = 'http://localhost:3000';

async function get(base, p) {
  const t = Date.now();
  try {
    const r = await fetch(base + p, { signal: AbortSignal.timeout(45000) });
    const txt = await r.text();
    let j = null; try { j = JSON.parse(txt); } catch (_) {}
    return { status: r.status, ms: Date.now() - t, bytes: txt.length, j, txt };
  } catch (e) { return { status: 'ERR:' + (e.cause?.code || e.message), ms: Date.now() - t, bytes: 0, j: null, txt: '' }; }
}
function shape(j, depth = 0) {
  if (j === null || j === undefined) return 'null';
  if (Array.isArray(j)) return `[${j.length}]` + (j.length && depth < 2 ? shape(j[0], depth + 1) : '');
  if (typeof j === 'object') { const ks = Object.keys(j).sort(); return depth < 2 ? '{' + ks.map(k => k + ':' + shape(j[k], depth + 1)).join(',') + '}' : `{${ks.length}k}`; }
  return typeof j;
}
function keysOnly(j) {
  if (Array.isArray(j)) return 'arr' + (j.length ? ':' + Object.keys(j[0] || {}).sort().join(',') : ':empty');
  if (j && typeof j === 'object') return Object.keys(j).sort().join(',');
  return typeof j;
}

(async () => {
  const rows = [];
  const check = async (label, p, oldBase, notes = '') => {
    const n = await get(NEW, p);
    const o = oldBase ? await get(oldBase, p) : null;
    const sameStatus = o ? String(o.status) === String(n.status) : '-';
    const sameKeys = o && n.j && o.j ? keysOnly(o.j) === keysOnly(n.j) : '-';
    rows.push({ label, path: p, new: n.status, newMs: n.ms, kb: (n.bytes / 1024).toFixed(1), old: o ? o.status : '-', sameStatus, sameKeys });
    return n;
  };

  await check('health', '/health', OLD_BACK);
  await check('db status', '/api/db/status', OLD_BACK);
  await check('datos (RAM)', '/api/datos', OLD_BACK);
  await check('servicios', '/api/servicios', OLD_BACK);
  // rutas portadas -> las sirve el front original (3000)
  const views = ['diaria', 'cards', 'flota', 'diagrama', 'inducciones', 'retorno', 'catalogo-choferes', 'movimientos'];
  let cat = null;
  for (const v of views) { const n = await check('views/' + v, '/api/views/' + v, OLD_FRONT); if (v === 'catalogo-choferes') cat = n; }
  let chId = null;
  const arr = cat?.j?.data || cat?.j?.choferes || (Array.isArray(cat?.j) ? cat.j : null);
  if (arr && arr.length) chId = arr[0].id || arr[0].chofer_id;
  if (chId) {
    await check('views/individual', `/api/views/individual/${chId}`, OLD_FRONT);
    await check('views/calendario', `/api/views/calendario/${chId}?zoom=3`, OLD_FRONT);
  } else rows.push({ label: 'individual/calendario', path: '(sin chofer id en catalogo)', new: 'SKIP' });
  await check('movimientos/recorte-diario', '/api/movimientos/recorte-diario', OLD_FRONT);
  await check('diagramas (GET base)', '/api/diagramas', OLD_BACK);
  await check('dash flota', '/api/dash/flota', OLD_BACK);
  console.table(rows);
  const bad = rows.filter(r => !String(r.new).startsWith('2'));
  console.log(bad.length ? 'NO-2xx en eor_v1:' : 'Todos 2xx en eor_v1', bad.map(b => `${b.path}=${b.new}`).join(' | '));
})();
