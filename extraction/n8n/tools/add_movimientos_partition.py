import json
import sqlite3
import uuid
import sys
from datetime import datetime

sys.stdout.reconfigure(encoding='utf-8')

db_path = r'C:\Users\Matias Rodriguez\.n8n\database.sqlite'
wf_file = r'c:\Users\Matias Rodriguez\Documents\server_local\n8n\workflows\bases_organizacion_tractores.json'

print("📖 Leyendo workflow actual desde:", wf_file)
with open(wf_file, 'r', encoding='utf-8') as f:
    wf = json.load(f)

nodes = wf.get('nodes', [])
connections = wf.get('connections', {})

# Remover nodos previos de movimientos si ya existían para idempotencia
nodes = [n for n in nodes if not n.get('name', '').startswith(('Nota: Movimientos', '▶️ Disparar: Movimientos', '⚡ Webhook: Movimientos', '⚙️ Configuración: Movimientos', '1. Leer Movimientos (Google Sheets)', '2. Filtrar y Normalizar Pareos Diarios', '3. Upsert Movimientos en Supabase', '📊 Resumen: Movimientos'))]

cred_google = {
    "googleApi": {
        "id": "XHGqePhAYeBdE6zw",
        "name": "Google Service Account account"
    }
}

cred_postgres = {
    "postgres": {
        "id": "btR7zwShyhyAPRUg",
        "name": "Postgres account"
    }
}

js_code_movimientos = """// NODO CODE: FILTRAR Y NORMALIZAR PAREOS DIARIOS (MOVIMIENTOS ACTIVOS DE HOY)
const rows = $input.all().map(i => i.json);
const mesesLargo = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

const hoy = new Date();
const diaHoy = hoy.getDate();
const mesHoy = hoy.getMonth();
const regexFechaHoy = new RegExp(`\\\\b0?${diaHoy}\\\\s+${mesesLargo[mesHoy]}\\\\b`, 'i');

// 1. Detectar columna de fecha y de chofer de hoy en cabecera
let colFechaHoy = -1;
if (rows.length > 0) {
  const row0 = rows[0];
  const keys = Object.keys(row0);
  for (let c = 0; c < keys.length; c++) {
    const val = String(row0[keys[c]] || '').toLowerCase().trim();
    if (regexFechaHoy.test(val) || val.includes(`${diaHoy}/${mesHoy + 1}/`) || val.includes(`${String(diaHoy).padStart(2, '0')}/${String(mesHoy + 1).padStart(2, '0')}/`)) {
      colFechaHoy = c;
      break;
    }
  }
}

// Si no encontró fecha en cabecera, usar stride: 27 + 13 * (diaHoy - 1)
const colChoferHoy = colFechaHoy >= 3 ? (colFechaHoy - 3) : (27 + 13 * (diaHoy - 1));

const blacklist = new Set([
  'TRACTOR', 'SEMI', 'CHOFER', 'NOMBRE', 'APELLIDO', '1', '0', '-', 'S/A', 'VACANTE',
  'FECHA', 'N°', 'CISTERNADO', 'TOTAL', 'LIVIANO', 'METANOL', 'CAMPO', 'GLP', 'SOCIO', 'OCTUBRE'
]);

const pareos = [];
let currentServicio = 'GENERAL';

for (let i = 1; i < rows.length; i++) {
  const row = rows[i];
  if (!row) continue;
  const values = Object.values(row);

  const colA = String(values[0] || '').trim();
  const colC = String(values[2] || '').trim();
  const colE = String(values[4] || '').trim();
  const colF = String(values[5] || '').trim();

  // Detección de fila cabecera de Categoría / Servicio
  if (colA && !colC && !colE && !colF) {
    const upA = colA.toUpperCase();
    if (!upA.includes('FECHA') && !upA.includes('N°') && !upA.includes('OCTUBRE')) {
      currentServicio = upA;
    }
    continue;
  }

  const tractor = colE.toUpperCase().replace(/\\s+/g, '');
  const semi = colF.toUpperCase().replace(/\\s+/g, '');
  const nUte = colC.replace(/[^0-9]/g, '');

  if (!tractor && !semi && !nUte) continue;
  if (tractor === 'TRACTOR' || semi === 'SEMI') continue;

  const rawChofer = colChoferHoy < values.length ? String(values[colChoferHoy] || '').trim() : '';
  if (!rawChofer || rawChofer === '1' || rawChofer.length < 3 || !/[a-zA-Z]/.test(rawChofer) || blacklist.has(rawChofer.toUpperCase())) {
    continue;
  }

  pareos.push({
    patente_tractor: tractor || '',
    patente_semi: semi || '',
    n_ute: nUte || null,
    chofer_nombre: rawChofer.toUpperCase(),
    servicio_denominacion: currentServicio,
    dia_operativo: diaHoy
  });
}

return pareos.map(p => ({ json: p }));
"""

sql_upsert_movimientos = """DO $$
DECLARE
  v_unit_id UUID := NULL;
  v_chofer_id UUID := NULL;
  v_trac_id UUID := NULL;
  v_semi_id UUID := NULL;
  v_pat_trac TEXT := TRIM('{{ $json.patente_tractor || "" }}');
  v_pat_semi TEXT := TRIM('{{ $json.patente_semi || "" }}');
  v_ute TEXT := NULLIF(TRIM('{{ $json.n_ute || "" }}'), '');
  v_chofer_nombre TEXT := TRIM('{{ $json.chofer_nombre || "" }}');
BEGIN
  -- 1. Resolver id_unidad por Tractor, Semi o N° UTE
  IF v_pat_trac <> '' THEN
    SELECT id INTO v_trac_id FROM public.tractores WHERE UPPER(patente) = UPPER(v_pat_trac) LIMIT 1;
    IF v_trac_id IS NOT NULL THEN
      SELECT id INTO v_unit_id FROM public.unidades WHERE tractor_id = v_trac_id LIMIT 1;
    END IF;
  END IF;

  IF v_unit_id IS NULL AND v_pat_semi <> '' THEN
    SELECT id INTO v_semi_id FROM public.semis WHERE UPPER(patente) = UPPER(v_pat_semi) LIMIT 1;
    IF v_semi_id IS NOT NULL THEN
      SELECT id INTO v_unit_id FROM public.unidades WHERE semi_id = v_semi_id LIMIT 1;
    END IF;
  END IF;

  IF v_unit_id IS NULL AND v_ute IS NOT NULL THEN
    SELECT id INTO v_unit_id FROM public.unidades WHERE n_ute = v_ute LIMIT 1;
  END IF;

  -- 2. Resolver id_chofer por Nombre
  IF v_chofer_nombre <> '' THEN
    SELECT id INTO v_chofer_id FROM public.choferes WHERE UPPER(nombre) = UPPER(v_chofer_nombre) LIMIT 1;
  END IF;

  -- 3. Upsert atómico en public.movimientos si ambos existen
  IF v_unit_id IS NOT NULL AND v_chofer_id IS NOT NULL THEN
    -- Despejar pareos previos de esta unidad o de este chofer
    DELETE FROM public.movimientos WHERE id_unidad = v_unit_id OR id_chofer = v_chofer_id;

    -- Insertar el movimiento activo (el trigger trg_movimientos_sync actualiza choferes.unidad_id y los estados)
    INSERT INTO public.movimientos (id_unidad, id_chofer, actualizado_el)
    VALUES (v_unit_id, v_chofer_id, NOW())
    ON CONFLICT (id_unidad) DO UPDATE SET 
      id_chofer = EXCLUDED.id_chofer,
      actualizado_el = NOW();
  END IF;
END $$;"""

new_nodes = [
    {
        "parameters": {
            "content": "## 🔄 PARTICIÓN 6: MOVIMIENTOS ACTIVOS DE HOY\n- **Origen:** Planilla mensual Movimientos (`A1:ZZ350`).\n- **Detección Dinámica:** Localiza la columna del día operativo actual y vincula unidad <-> chofer.\n- **Supabase:** `UPSERT` atómico en `public.movimientos` y sincronización en cascada vía trigger.",
            "height": 380,
            "width": 1600,
            "color": 4
        },
        "id": "note-movimientos",
        "name": "Nota: Movimientos",
        "type": "n8n-nodes-base.stickyNote",
        "typeVersion": 1,
        "position": [-48, 2240]
    },
    {
        "parameters": {},
        "id": "trig-manual-mov",
        "name": "▶️ Disparar: Movimientos Activos",
        "type": "n8n-nodes-base.manualTrigger",
        "typeVersion": 1,
        "position": [0, 2320]
    },
    {
        "parameters": {
            "httpMethod": "POST",
            "path": "recorte-movimientos",
            "options": {}
        },
        "id": "trig-webhook-mov",
        "name": "⚡ Webhook: Movimientos",
        "type": "n8n-nodes-base.webhook",
        "typeVersion": 2,
        "position": [0, 2480],
        "webhookId": "recorte-movimientos"
    },
    {
        "parameters": {
            "assignments": {
                "assignments": [
                    {
                        "id": "p-sp-mov",
                        "name": "spreadsheetId",
                        "value": "={{ $json.body?.spreadsheetId || $json.spreadsheetId || '14Mb5rD853zxDkaLDS-IrW-OBDTDBjuJxn_3olXeWlkc' }}",
                        "type": "string"
                    },
                    {
                        "id": "p-sh-mov",
                        "name": "sheetName",
                        "value": "={{ $json.body?.sheetName || $json.sheetName || 'OCTUBRE 2026- Mov.Unidades y Choferes' }}",
                        "type": "string"
                    },
                    {
                        "id": "p-rg-mov",
                        "name": "range",
                        "value": "={{ $json.body?.range || $json.range || 'A1:ZZ350' }}",
                        "type": "string"
                    }
                ]
            },
            "options": {}
        },
        "id": "set-config-mov",
        "name": "⚙️ Configuración: Movimientos",
        "type": "n8n-nodes-base.set",
        "typeVersion": 3.4,
        "position": [240, 2400],
        "notesInFlow": True,
        "notes": "Parámetros de extracción de la planilla mensual de Movimientos."
    },
    {
        "parameters": {
            "authentication": "serviceAccount",
            "operation": "read",
            "documentId": {
                "__rl": True,
                "value": "={{ $json.spreadsheetId }}",
                "mode": "id"
            },
            "sheetName": {
                "__rl": True,
                "value": "={{ $json.sheetName }}",
                "mode": "name"
            },
            "options": {}
        },
        "id": "read-sheets-mov",
        "name": "1. Leer Movimientos (Google Sheets)",
        "type": "n8n-nodes-base.googleSheets",
        "typeVersion": 4.5,
        "position": [512, 2400],
        "credentials": cred_google
    },
    {
        "parameters": {
            "jsCode": js_code_movimientos
        },
        "id": "code-mov",
        "name": "2. Filtrar y Normalizar Pareos Diarios",
        "type": "n8n-nodes-base.code",
        "typeVersion": 2,
        "position": [768, 2400]
    },
    {
        "parameters": {
            "operation": "executeQuery",
            "query": sql_upsert_movimientos
        },
        "id": "db-mov",
        "name": "3. Upsert Movimientos en Supabase",
        "type": "n8n-nodes-base.postgres",
        "typeVersion": 2.5,
        "position": [1024, 2400],
        "credentials": cred_postgres
    },
    {
        "parameters": {
            "jsCode": """const items = $('2. Filtrar y Normalizar Pareos Diarios').all();
return [{
  json: {
    estado: '✅ Movimientos activos sincronizados exitosamente',
    total_pareos_hoy: items.length,
    origen: 'Movimientos Unidades y Choferes (Día Operativo)',
    destino: 'public.movimientos (con sync en choferes.unidad_id y unidades)',
    timestamp: new Date().toISOString()
  }
}];"""
        },
        "id": "rep-mov",
        "name": "📊 Resumen: Movimientos",
        "type": "n8n-nodes-base.code",
        "typeVersion": 2,
        "position": [1280, 2400]
    }
]

nodes.extend(new_nodes)

# Conexiones internas de la partición de Movimientos
connections["▶️ Disparar: Movimientos Activos"] = {
    "main": [[{"node": "⚙️ Configuración: Movimientos", "type": "main", "index": 0}]]
}
connections["⚡ Webhook: Movimientos"] = {
    "main": [[{"node": "⚙️ Configuración: Movimientos", "type": "main", "index": 0}]]
}
connections["⚙️ Configuración: Movimientos"] = {
    "main": [[{"node": "1. Leer Movimientos (Google Sheets)", "type": "main", "index": 0}]]
}
connections["1. Leer Movimientos (Google Sheets)"] = {
    "main": [[{"node": "2. Filtrar y Normalizar Pareos Diarios", "type": "main", "index": 0}]]
}
connections["2. Filtrar y Normalizar Pareos Diarios"] = {
    "main": [[{"node": "3. Upsert Movimientos en Supabase", "type": "main", "index": 0}]]
}
connections["3. Upsert Movimientos en Supabase"] = {
    "main": [[{"node": "📊 Resumen: Movimientos", "type": "main", "index": 0}]]
}

# Conectar al Disparador Global
global_conn = connections.get("🌐 Disparar Todo: Bases Organización", {}).get("main", [[]])[0]
if not any(target.get("node") == "⚙️ Configuración: Movimientos" for target in global_conn):
    global_conn.append({"node": "⚙️ Configuración: Movimientos", "type": "main", "index": 0})
connections["🌐 Disparar Todo: Bases Organización"] = {"main": [global_conn]}

wf_name = "Bases Organización (Choferes, Tractores, Semis, Unidades, Días, Movimientos)"
wf["name"] = wf_name
wf["nodes"] = nodes
wf["connections"] = connections

# Guardar en archivo JSON
with open(wf_file, 'w', encoding='utf-8') as f:
    json.dump(wf, f, indent=2, ensure_ascii=False)
print("✅ Archivo JSON actualizado con 6 particiones:", wf_file)

# Guardar en SQLite de n8n
con = sqlite3.connect(db_path)
cur = con.cursor()

wf_id = 'basesOrgTractores01'
nodes_json = json.dumps(wf['nodes'])
connections_json = json.dumps(wf['connections'])
settings_json = json.dumps(wf.get('settings', {}))
now_str = datetime.now().strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]
ver_id = str(uuid.uuid4())

cur.execute("""
    UPDATE workflow_entity 
    SET name = ?, nodes = ?, connections = ?, settings = ?, updatedAt = ?, versionId = ?
    WHERE id = ?
""", (wf_name, nodes_json, connections_json, settings_json, now_str, ver_id, wf_id))

con.commit()
con.close()
print(f"✅ Workflow '{wf_id}' actualizado con éxito en la base SQLite de n8n.")
