#!/usr/bin/env node
/**
 * tools/diagnostics/db-perf-audit.js
 *
 * Auditoría de rendimiento / consumo de la base (Supabase Postgres) + escaneo estático del código.
 * 100% SOLO LECTURA: toda la sesión corre dentro de `BEGIN READ ONLY ... ROLLBACK`
 * con statement_timeout, así que no puede escribir ni dejar locks.
 *
 * Uso (desde la raíz de eor_v1):
 *   node tools/diagnostics/db-perf-audit.js                 # DB + código, salida markdown a stdout
 *   node tools/diagnostics/db-perf-audit.js --only=db       # solo métricas de Postgres
 *   node tools/diagnostics/db-perf-audit.js --only=code     # solo escaneo estático (no requiere DB)
 *   node tools/diagnostics/db-perf-audit.js --json          # salida JSON
 *   node tools/diagnostics/db-perf-audit.js --out=reporte.md
 *
 * Requiere DATABASE_URL (o SUPABASE_DB_URL) en el .env de la raíz.
 * Usa `pg` y `dotenv` de apps/backend/node_modules (no agrega dependencias).
 */

const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');
const backendRequire = (m) => require(require.resolve(m, { paths: [path.join(ROOT, 'apps', 'backend')] }));

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v === undefined ? true : v];
}));
const ONLY = args.only || 'all';
const AS_JSON = Boolean(args.json);

try { backendRequire('dotenv').config({ path: path.join(ROOT, '.env'), quiet: true }); } catch { /* opcional */ }

// ------------------------------------------------------------------
// 1. Consultas de diagnóstico (todas de catálogo / estadísticas)
// ------------------------------------------------------------------
const DB_QUERIES = [
    {
        id: 'db_size',
        title: 'Tamaño de la base',
        sql: `SELECT current_database() AS db, pg_size_pretty(pg_database_size(current_database())) AS size,
                     version() AS version`
    },
    {
        id: 'settings',
        title: 'Parámetros relevantes (logs, timeouts, aislamiento)',
        sql: `SELECT name, setting, unit FROM pg_settings
              WHERE name IN ('max_connections','shared_buffers','work_mem','statement_timeout',
                             'idle_in_transaction_session_timeout','default_transaction_isolation',
                             'log_min_duration_statement','log_statement','log_connections',
                             'log_disconnections','track_io_timing','synchronous_commit')
              ORDER BY name`
    },
    {
        id: 'tables',
        title: 'Top 25 relaciones por tamaño (todas las schemas, incluye auth/realtime/storage)',
        sql: `SELECT n.nspname AS schema, c.relname AS tabla, c.reltuples::bigint AS filas_est,
                     pg_size_pretty(pg_total_relation_size(c.oid)) AS total,
                     pg_size_pretty(pg_indexes_size(c.oid)) AS indices,
                     s.seq_scan, s.idx_scan, s.n_tup_ins AS ins, s.n_tup_upd AS upd, s.n_tup_del AS del,
                     s.n_dead_tup AS dead, s.last_autovacuum::date::text AS ult_autovacuum
              FROM pg_class c
              JOIN pg_namespace n ON n.oid = c.relnamespace
              LEFT JOIN pg_stat_all_tables s ON s.relid = c.oid
              WHERE c.relkind IN ('r','p','m')
                AND n.nspname NOT IN ('pg_catalog','information_schema')
                AND n.nspname NOT LIKE 'pg_toast%'
              ORDER BY pg_total_relation_size(c.oid) DESC
              LIMIT 25`
    },
    { id: 'pgss_info', title: 'Ventana de pg_stat_statements', pgss: true,
      sql: (s) => `SELECT stats_reset::text AS desde, dealloc FROM ${s}.pg_stat_statements_info` },
    {
        id: 'top_total_time', title: 'Top 20 sentencias por tiempo total', pgss: true,
        sql: (s) => `SELECT calls, round(total_exec_time::numeric,1) AS total_ms, round(mean_exec_time::numeric,2) AS mean_ms,
                            rows, round(rows::numeric/NULLIF(calls,0),1) AS filas_x_call, r.rolname AS rol,
                            left(regexp_replace(query,'\\s+',' ','g'),200) AS query
                     FROM ${s}.pg_stat_statements p LEFT JOIN pg_roles r ON r.oid = p.userid
                     ORDER BY total_exec_time DESC LIMIT 20`
    },
    {
        id: 'top_calls', title: 'Top 20 sentencias por frecuencia (detecta polling / N+1)', pgss: true,
        sql: (s) => `SELECT calls, round(mean_exec_time::numeric,2) AS mean_ms, rows,
                            round(rows::numeric/NULLIF(calls,0),1) AS filas_x_call, r.rolname AS rol,
                            left(regexp_replace(query,'\\s+',' ','g'),200) AS query
                     FROM ${s}.pg_stat_statements p LEFT JOIN pg_roles r ON r.oid = p.userid
                     ORDER BY calls DESC LIMIT 20`
    },
    {
        id: 'top_rows', title: 'Top 15 sentencias por filas devueltas (proxy de egress)', pgss: true,
        sql: (s) => `SELECT rows, calls, round(rows::numeric/NULLIF(calls,0),1) AS filas_x_call, r.rolname AS rol,
                            left(regexp_replace(query,'\\s+',' ','g'),200) AS query
                     FROM ${s}.pg_stat_statements p LEFT JOIN pg_roles r ON r.oid = p.userid
                     ORDER BY rows DESC LIMIT 15`
    },
    {
        id: 'cache_hit', title: 'Cache hit ratio (objetivo > 99%)',
        sql: `SELECT (SELECT round(100.0*sum(heap_blks_hit)/NULLIF(sum(heap_blks_hit)+sum(heap_blks_read),0),2) FROM pg_statio_user_tables) AS tablas_pct,
                     (SELECT round(100.0*sum(idx_blks_hit)/NULLIF(sum(idx_blks_hit)+sum(idx_blks_read),0),2) FROM pg_statio_user_indexes) AS indices_pct`
    },
    {
        id: 'seq_scan_heavy', title: 'Tablas public con más seq scans que index scans (>500 filas)',
        sql: `SELECT relname AS tabla, seq_scan, COALESCE(idx_scan,0) AS idx_scan, seq_tup_read, n_live_tup,
                     round(seq_tup_read::numeric/NULLIF(seq_scan,0)) AS filas_x_seq
              FROM pg_stat_user_tables
              WHERE schemaname='public' AND seq_scan > COALESCE(idx_scan,0) AND n_live_tup > 500
              ORDER BY seq_tup_read DESC LIMIT 15`
    },
    {
        id: 'unused_indexes', title: 'Índices public nunca usados (no PK / no UNIQUE)',
        sql: `SELECT s.relname AS tabla, s.indexrelname AS indice, s.idx_scan,
                     pg_size_pretty(pg_relation_size(s.indexrelid)) AS tam
              FROM pg_stat_user_indexes s JOIN pg_index i ON i.indexrelid = s.indexrelid
              WHERE s.schemaname='public' AND s.idx_scan = 0 AND NOT i.indisprimary AND NOT i.indisunique
              ORDER BY pg_relation_size(s.indexrelid) DESC`
    },
    {
        id: 'fk_without_index', title: 'FKs sin índice en la columna origen (JOIN/DELETE lentos, locks)',
        sql: `SELECT c.conrelid::regclass::text AS tabla, c.conname AS fk, pg_get_constraintdef(c.oid) AS definicion
              FROM pg_constraint c
              WHERE c.contype='f' AND c.connamespace='public'::regnamespace
                AND NOT EXISTS (
                  SELECT 1 FROM pg_index i
                  WHERE i.indrelid = c.conrelid
                    AND (string_to_array(i.indkey::text,' ')::int2[])[1:array_length(c.conkey,1)] = c.conkey)
              ORDER BY 1`
    },
    {
        id: 'constraints', title: 'Integridad por tabla public (PK/FK/UNIQUE/CHECK, RLS, replica identity)',
        sql: `SELECT c.relname AS tabla,
                     count(k.oid) FILTER (WHERE k.contype='p') AS pk,
                     count(k.oid) FILTER (WHERE k.contype='f') AS fk,
                     count(k.oid) FILTER (WHERE k.contype='u') AS uq,
                     count(k.oid) FILTER (WHERE k.contype='c') AS ck,
                     c.relrowsecurity AS rls,
                     CASE c.relreplident WHEN 'd' THEN 'default' WHEN 'f' THEN 'full' WHEN 'n' THEN 'nothing' ELSE 'index' END AS replica_identity
              FROM pg_class c LEFT JOIN pg_constraint k ON k.conrelid = c.oid
              WHERE c.relkind='r' AND c.relnamespace='public'::regnamespace
              GROUP BY c.relname, c.relrowsecurity, c.relreplident
              ORDER BY (count(k.oid) FILTER (WHERE k.contype='p')) ASC, c.relname`
    },
    {
        id: 'realtime_publication', title: 'Tablas publicadas en supabase_realtime',
        sql: `SELECT schemaname, tablename FROM pg_publication_tables WHERE pubname='supabase_realtime' ORDER BY 1,2`
    },
    {
        id: 'triggers', title: 'Triggers en public (costo por escritura / atomicidad)',
        sql: `SELECT event_object_table AS tabla, trigger_name, action_timing AS momento,
                     string_agg(event_manipulation, ',') AS eventos, left(action_statement,90) AS accion
              FROM information_schema.triggers WHERE trigger_schema='public'
              GROUP BY 1,2,3,5 ORDER BY 1,2`
    },
    {
        id: 'views', title: 'Vistas y vistas materializadas en public',
        sql: `SELECT c.relname AS vista, CASE c.relkind WHEN 'v' THEN 'view' ELSE 'materialized' END AS tipo,
                     length(pg_get_viewdef(c.oid)) AS largo_def
              FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('v','m') ORDER BY 2,1`
    },
    {
        id: 'connections', title: 'Conexiones activas por aplicación/estado',
        sql: `SELECT COALESCE(NULLIF(application_name,''),'(sin nombre)') AS app, usename AS usuario, state AS estado,
                     count(*) AS n, max(now()-state_change)::text AS max_en_estado
              FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()
              GROUP BY 1,2,3 ORDER BY n DESC`
    },
    {
        id: 'long_tx', title: 'Transacciones abiertas > 30 s (riesgo de locks / bloat)',
        sql: `SELECT pid, usename, application_name, state, (now()-xact_start)::text AS edad_tx,
                     left(regexp_replace(query,'\\s+',' ','g'),150) AS query
              FROM pg_stat_activity
              WHERE xact_start IS NOT NULL AND now()-xact_start > interval '30 seconds' AND pid <> pg_backend_pid()
              ORDER BY xact_start`
    }
];

async function runDbAudit() {
    const url = process.env.DATABASE_URL || process.env.SUPABASE_DB_URL;
    if (!url) return { error: 'DATABASE_URL / SUPABASE_DB_URL no configurada en .env' };

    const { Client } = backendRequire('pg');
    const local = /localhost|127\.0\.0\.1/.test(url);
    const client = new Client({
        connectionString: url,
        ssl: local ? false : { rejectUnauthorized: false },
        application_name: 'eor-db-perf-audit',
        connectionTimeoutMillis: 8000
    });

    const out = {};
    await client.connect();
    try {
        await client.query('BEGIN READ ONLY');
        await client.query(`SET LOCAL statement_timeout = '15s'`);

        const ext = await client.query(
            `SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
             WHERE e.extname = 'pg_stat_statements'`);
        const pgssSchema = ext.rows[0]?.nspname || null;

        for (const q of DB_QUERIES) {
            if (q.pgss && !pgssSchema) {
                out[q.id] = { title: q.title, error: 'pg_stat_statements no instalado' };
                continue;
            }
            const sql = typeof q.sql === 'function' ? q.sql(pgssSchema) : q.sql;
            await client.query('SAVEPOINT q');
            try {
                const r = await client.query(sql);
                out[q.id] = { title: q.title, rows: r.rows };
                await client.query('RELEASE SAVEPOINT q');
            } catch (e) {
                await client.query('ROLLBACK TO SAVEPOINT q');
                out[q.id] = { title: q.title, error: e.message };
            }
        }
    } finally {
        await client.query('ROLLBACK').catch(() => {});
        await client.end().catch(() => {});
    }
    return out;
}

// ------------------------------------------------------------------
// 2. Escaneo estático del código (patrones de consumo)
// ------------------------------------------------------------------
const SCAN_DIRS = [
    { layer: 'frontend', dir: 'apps/frontend/src' },
    { layer: 'backend', dir: 'apps/backend' },
    { layer: 'extraction', dir: 'extraction/local_loader' }
];
const SKIP = /node_modules|[\\/]dist[\\/]|[\\/]build[\\/]|\.min\.js$/;
const EXT = /\.(js|jsx|ts|tsx|mjs|cjs)$/;

const PATTERNS = [
    { id: 'select_star', desc: 'SELECT * / .select("*") (columnas de más = egress y RAM)',
      re: /SELECT\s+\*\s+FROM|\.select\(\s*(['"`])\*\1\s*\)/i },
    { id: 'polling', desc: 'Polling (refetchInterval / setInterval)', re: /refetchInterval\s*:|setInterval\s*\(/ },
    { id: 'realtime', desc: 'Suscripciones Realtime', re: /\.channel\s*\(|postgres_changes/ },
    { id: 'cache_ttl', desc: 'Parámetros de cache (staleTime/gcTime/TTL)', re: /staleTime\s*:|gcTime\s*:|cacheTime\s*:|\bTTL\b/i },
    { id: 'transactions', desc: 'Transacciones explícitas (BEGIN/COMMIT/ROLLBACK, getClient)',
      re: /['"`]\s*(BEGIN|COMMIT|ROLLBACK)\b|getClient\s*\(/ },
    { id: 'parallel_async', desc: 'map(async)/forEach(async) (posible N+1 o ráfaga de queries)',
      re: /\.(map|forEach)\s*\(\s*async/ },
    { id: 'rpc_upsert', desc: 'RPC / upsert (escrituras compuestas)', re: /\.rpc\s*\(|\.upsert\s*\(/ },
    { id: 'hot_ram', desc: 'Accesos a hotRamManager', re: /hotRamManager\.\w+/ }
];
const FROM_RE = /\.from\s*\(\s*['"`]([\w.]+)['"`]\s*\)/g;
const SQL_TABLE_RE = /\b(?:FROM|JOIN|UPDATE|INTO)\s+(?:public\.)?((?:view_)?[a-z_][a-z0-9_]{2,})\b/gi;
const SQL_NOISE = new Set(['the', 'pg_stat_activity', 'pg_class', 'pg_namespace', 'information_schema', 'select', 'where']);

function walk(dir, files = []) {
    if (!fs.existsSync(dir)) return files;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (SKIP.test(p)) continue;
        if (e.isDirectory()) walk(p, files);
        else if (EXT.test(e.name)) files.push(p);
    }
    return files;
}

function runCodeScan() {
    const hits = Object.fromEntries(PATTERNS.map((p) => [p.id, { desc: p.desc, count: 0, refs: [] }]));
    const tables = {}; // tabla -> { frontend, backend, extraction }

    for (const { layer, dir } of SCAN_DIRS) {
        for (const file of walk(path.join(ROOT, dir))) {
            const rel = path.relative(ROOT, file).replace(/\\/g, '/');
            const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
            lines.forEach((line, i) => {
                for (const p of PATTERNS) {
                    if (p.re.test(line)) {
                        const h = hits[p.id];
                        h.count++;
                        if (h.refs.length < 40) h.refs.push(`${rel}:${i + 1}  ${line.trim().slice(0, 110)}`);
                    }
                }
                const bump = (t) => {
                    if (SQL_NOISE.has(t.toLowerCase())) return;
                    tables[t] ??= { frontend: 0, backend: 0, extraction: 0 };
                    tables[t][layer]++;
                };
                for (const m of line.matchAll(FROM_RE)) bump(m[1].replace(/^public\./, ''));
                if (/['"`]|SELECT|UPDATE|INSERT/i.test(line)) {
                    for (const m of line.matchAll(SQL_TABLE_RE)) {
                        if (/^(view_|choferes|unidades|diagramas|movimientos|tractores|semis|servicios_|chofer_|usuarios_|eor_)/i.test(m[1])) bump(m[1].toLowerCase());
                    }
                }
            });
        }
    }
    const tableRows = Object.entries(tables)
        .map(([tabla, c]) => ({ tabla, ...c, total: c.frontend + c.backend + c.extraction }))
        .sort((a, b) => b.total - a.total);
    return { patterns: hits, tables: tableRows };
}

// ------------------------------------------------------------------
// 3. Render
// ------------------------------------------------------------------
const cell = (v) => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').slice(0, 140);
};
function mdTable(rows) {
    if (!rows || rows.length === 0) return '_(sin filas)_\n';
    const cols = Object.keys(rows[0]);
    return [
        `| ${cols.join(' | ')} |`,
        `| ${cols.map(() => '---').join(' | ')} |`,
        ...rows.map((r) => `| ${cols.map((c) => cell(r[c])).join(' | ')} |`)
    ].join('\n') + '\n';
}

function renderMarkdown(report) {
    const md = [`# Auditoría DB/consumo EOR — ${report.generatedAt}\n`];
    if (report.db) {
        md.push('## A. Postgres (solo lectura)\n');
        if (report.db.error) md.push(`> ❌ ${report.db.error}\n`);
        else for (const sec of Object.values(report.db)) {
            md.push(`### ${sec.title}\n`);
            md.push(sec.error ? `> ⚠️ ${sec.error}\n` : mdTable(sec.rows));
        }
    }
    if (report.code) {
        md.push('## B. Escaneo estático del código\n');
        md.push('### Tablas/vistas referenciadas por capa\n');
        md.push(mdTable(report.code.tables));
        for (const h of Object.values(report.code.patterns)) {
            md.push(`### ${h.desc} — ${h.count} ocurrencias\n`);
            if (h.refs.length) md.push('```text\n' + h.refs.join('\n') + '\n```\n');
        }
    }
    return md.join('\n');
}

(async () => {
    const report = { generatedAt: new Date().toISOString() };
    if (ONLY === 'all' || ONLY === 'db') {
        try { report.db = await runDbAudit(); } catch (e) { report.db = { error: e.message }; }
    }
    if (ONLY === 'all' || ONLY === 'code') report.code = runCodeScan();

    const text = AS_JSON ? JSON.stringify(report, null, 2) : renderMarkdown(report);
    if (args.out) {
        fs.writeFileSync(path.resolve(process.cwd(), args.out), text, 'utf8');
        console.log(`✅ Reporte escrito en ${args.out}`);
    } else {
        process.stdout.write(text + '\n');
    }
})();
