import sqlite3
import json
import uuid
from datetime import datetime

db_path = r'C:\Users\Matias Rodriguez\.n8n\database.sqlite'
wf_file = r'c:\Users\Matias Rodriguez\Documents\server_local\n8n\workflows\operativas_diarias_diagrama.json'

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

spreadsheet_id_diag = "1mhfXpFCF6upMlnRnZjDdBVS_wqTx5q8v0qQArNCnNAU" # Diagramas EOR REV01 2026
sheet_name_diag = "Oct-26"
range_diag = "A5:AN350"

workflow = {
  "name": "Operativas Diarias - Días Diagrama",
  "nodes": [
    # =========================================================================
    # BANNER GENERAL
    # =========================================================================
    {
      "parameters": {
        "content": "# 📅 OPERATIVAS DIARIAS: DÍAS DIAGRAMA (DIAGRAMAS EOR REV01 2026)\n**Extracción y Contabilización de la Matriz de Días Mensual por Chofer.**\n- **Origen:** Planilla Diagramas EOR REV01 2026 (`1mhfXpFCF6upMlnRnZjDdBVS_wqTx5q8v0qQArNCnNAU`), pestaña activa (`Oct-26`).\n- **Rango:** `A5:AN350` (Encabezados de días `1-10..31-10` y choferes activos).\n- **Motor:** Mapeo de calendario ISO + Contabilizador canónico de turnos trabajados, francos, vacaciones y ausencias.\n- **Destino Supabase:** `public.diagramas` (matriz JSONB y métricas) y actualización de contabilizador en `public.choferes`.",
        "height": 180,
        "width": 1640,
        "color": 5
      },
      "id": "note-banner-dias",
      "name": "Banner: Operativas Diarias",
      "type": "n8n-nodes-base.stickyNote",
      "typeVersion": 1,
      "position": [-60, 160]
    },

    # =========================================================================
    # DISPARADORES (MANUAL Y WEBHOOK)
    # =========================================================================
    {
      "parameters": {},
      "id": "trig-manual-dias",
      "name": "▶️ Disparar: Días Diagrama",
      "type": "n8n-nodes-base.manualTrigger",
      "typeVersion": 1,
      "position": [0, 420]
    },
    {
      "parameters": {
        "httpMethod": "POST",
        "path": "operativa-dias-diagrama",
        "options": {}
      },
      "id": "trig-webhook-dias",
      "name": "⚡ Webhook: Días Diagrama",
      "type": "n8n-nodes-base.webhook",
      "typeVersion": 2,
      "position": [0, 580],
      "webhookId": "operativa-dias-diagrama"
    },

    # =========================================================================
    # CONFIGURACIÓN
    # =========================================================================
    {
      "parameters": {
        "assignments": {
          "assignments": [
            {
              "id": "param-spreadsheet-id-dias",
              "name": "spreadsheetId",
              "value": spreadsheet_id_diag,
              "type": "string"
            },
            {
              "id": "param-sheet-name-dias",
              "name": "sheetName",
              "value": "={{ $json.body?.sheetName || $json.sheetName || 'Oct-26' }}",
              "type": "string"
            },
            {
              "id": "param-range-dias",
              "name": "range",
              "value": "={{ $json.body?.range || $json.range || 'A5:AN350' }}",
              "type": "string"
            },
            {
              "id": "param-anio-dias",
              "name": "anio",
              "value": "={{ $json.body?.anio || $json.anio || 2026 }}",
              "type": "number"
            }
          ]
        },
        "options": {}
      },
      "id": "set-config-dias",
      "name": "⚙️ Configuración: Días Diagrama",
      "type": "n8n-nodes-base.set",
      "typeVersion": 3.4,
      "position": [260, 480],
      "notesInFlow": True,
      "notes": "Planilla Diagramas EOR (cambio anual de ID, pestaña mensual activa)."
    },

    # =========================================================================
    # 1. LEER GOOGLE SHEETS
    # =========================================================================
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
        "options": {
          "dataLocationOnSheet": {
            "values": {
              "rangeDefinition": "specifyRange",
              "headerRow": 5,
              "firstDataRow": 6
            }
          }
        }
      },
      "id": "read-sheets-dias",
      "name": "1. Leer Matriz Diagramas (Google Sheets)",
      "type": "n8n-nodes-base.googleSheets",
      "typeVersion": 4.5,
      "position": [520, 480],
      "credentials": cred_google
    },

    # =========================================================================
    # 2. NORMALIZAR CALENDARIO Y CONTABILIZADOR
    # =========================================================================
    {
      "parameters": {
        "jsCode": """// NODO CODE: NORMALIZAR MATRIZ DE DÍAS Y CONTABILIZADOR CANÓNICO
const items = $input.all().map(i => i.json);
const configNode = $('⚙️ Configuración: Días Diagrama').first().json;
const mesTab = String(configNode.sheetName || 'Oct-26').trim();
const anio = Number(configNode.anio || 2026);

function getBaseState(val) {
  if (val === undefined || val === null) return '';
  const str = String(val).trim().toUpperCase();
  if (str.includes('+')) return str.split('+')[0].trim();
  return str;
}

function contabilizarDias(diasMap) {
  let trabajados = 0, francos = 0, vacaciones = 0, ausencias = 0, inactivos = 0;
  const desglose = { enfermedad: 0, art: 0, indisposicion: 0, suspension: 0, ausencia: 0, permiso: 0, otros: 0 };
  const entries = Object.entries(diasMap || {});
  for (const [, val] of entries) {
    if (!val || val === '-' || val === '0' || val === 'NULL' || val === 'UNDEFINED' || val === '') {
      inactivos++;
      continue;
    }
    const base = getBaseState(val);
    if ((!isNaN(base) && base !== '') || base === 'O' || base === 'OPERATIVO') {
      trabajados++;
    } else if (['F', 'FSF', 'FRANCO', 'RPT'].includes(base)) {
      francos++;
    } else if (['V', 'VSF', 'VACACIONES'].includes(base)) {
      vacaciones++;
    } else if (['E', 'ART', 'IND', 'IIND', 'A', 'S', 'P', 'MED', 'SUSP', 'LIC'].some(k => base.includes(k))) {
      ausencias++;
      if (base === 'E' || base.startsWith('MED')) desglose.enfermedad++;
      else if (base === 'ART') desglose.art++;
      else if (base.startsWith('IND')) desglose.indisposicion++;
      else if (base === 'S' || base.startsWith('SUSP')) desglose.suspension++;
      else if (base === 'A') desglose.ausencia++;
      else if (base === 'P') desglose.permiso++;
      else desglose.otros++;
    } else {
      desglose.otros++;
    }
  }
  return { total_evaluados: entries.length, trabajados, francos, vacaciones, ausencias, inactivos, desglose };
}

const blacklist = new Set([
  'APELLIDO Y NOMBRE', 'PERSONAL ACTIVO', 'LEGAJO', 'CUENTA', 'SERVICIO', 
  'DIAGRAMA', 'TOTAL', 'CHOFER', 'NOMBRE', 'FECHA', 'PASIVO EN BASE', 'PASIVO', 'NOMENCLATURAS'
]);
const monthNames = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const mesTabLower = mesTab.toLowerCase();
const mIdx = monthNames.findIndex(m => mesTabLower.includes(m));
const mesNumero = mIdx !== -1 ? mIdx + 1 : (new Date().getMonth() + 1);
const mesStr = String(mesNumero).padStart(2, '0');

const choferesMap = new Map();

for (const row of items) {
  const rawLegajo = String(row.col_1 ?? row.LEGAJO ?? row.legajo ?? row['0'] ?? '').trim();
  const rawNombre = String(row.col_2 ?? row['APELLIDO Y NOMBRE'] ?? row.nombre ?? row['1'] ?? '').trim().toUpperCase();
  const rawServicio = String(row.col_3 ?? row.SERVICIO ?? row.CUENTA ?? row.servicio ?? row['2'] ?? '').trim().toUpperCase();
  const rawDiag = String(row.col_4 ?? row.DIAGRAMA ?? row.diagrama ?? row['3'] ?? '').trim().toUpperCase();

  if (!rawNombre || rawNombre.length < 3 || /^\\d+$/.test(rawNombre) || blacklist.has(rawNombre)) continue;
  if (/^[A-Z]{3}-\\d{2}$/i.test(rawNombre) || rawNombre.startsWith('%')) continue;
  if (rawNombre.includes('TOTAL') || rawNombre.includes('ACTIVO') || rawNombre.includes('FRANCO') || 
      rawNombre.includes('ENFERM') || rawNombre.includes('VACAC') || rawNombre.includes('SUSPEN') || 
      rawNombre.includes('AUSENT') || rawNombre.includes('INGRES') || rawNombre.includes('DIAS')) continue;

  // Extraer todas las columnas de días (claves con formato D-M o DD-MM)
  const dayEntries = [];
  for (const k of Object.keys(row)) {
    const m = k.trim().match(/^(\\d+)[\\/\\-](\\d+)$/);
    if (m) {
      dayEntries.push({ key: k, dayNum: parseInt(m[1], 10) });
    }
  }
  dayEntries.sort((a, b) => a.dayNum - b.dayNum);

  const diasMap = {};
  const tiraArr = [];

  for (const d of dayEntries) {
    const val = (row[d.key] !== undefined && row[d.key] !== null && String(row[d.key]).trim() !== '') ? String(row[d.key]).trim().toUpperCase() : '-';
    const cleanVal = val === '' ? '-' : val;
    const isoDate = `${anio}-${mesStr}-${String(d.dayNum).padStart(2, '0')}`;
    diasMap[isoDate] = cleanVal;
    tiraArr.push(cleanVal);
  }

  const contabilizador = contabilizarDias(diasMap);

  if (!choferesMap.has(rawNombre)) {
    choferesMap.set(rawNombre, {
      chofer_nombre: rawNombre.replace(/'/g, "''"),
      legajo: (rawLegajo && rawLegajo !== '-' && /^\\d+$/.test(rawLegajo)) ? rawLegajo : null,
      servicio: (rawServicio && rawServicio !== '-') ? rawServicio.replace(/'/g, "''") : 'S/A',
      diagrama_tipo: (rawDiag && rawDiag !== '-') ? rawDiag.replace(/'/g, "''") : null,
      mes_tab: mesTab,
      anio: anio,
      mes_numero: mesNumero,
      dias: diasMap,
      tira_dias: tiraArr.join(','),
      contabilizador: contabilizador,
      dias_json_str: JSON.stringify(diasMap).replace(/'/g, "''"),
      contabilizador_json_str: JSON.stringify(contabilizador).replace(/'/g, "''")
    });
  }
}

return Array.from(choferesMap.values()).map(c => ({ json: c }));"""
      },
      "id": "code-dias",
      "name": "2. Normalizar Calendario y Contabilizador",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [780, 480]
    },

    # =========================================================================
    # 3. UPSERT EN SUPABASE
    # =========================================================================
    {
      "parameters": {
        "operation": "executeQuery",
        "query": """DO $$
DECLARE
  v_chofer_id UUID := NULL;
  v_dias JSONB := '{{ $json.dias_json_str }}'::jsonb;
  v_contabilizador JSONB := '{{ $json.contabilizador_json_str }}'::jsonb;
BEGIN
  -- 1. Buscar chofer_id por legajo o por nombre
  IF '{{ $json.legajo || "" }}' <> '' THEN
    SELECT id INTO v_chofer_id FROM public.choferes WHERE legajo = '{{ $json.legajo }}' LIMIT 1;
  END IF;

  IF v_chofer_id IS NULL THEN
    SELECT id INTO v_chofer_id FROM public.choferes WHERE UPPER(nombre) = UPPER('{{ $json.chofer_nombre }}') LIMIT 1;
  END IF;

  -- 2. Upsert en public.diagramas
  INSERT INTO public.diagramas (
    chofer_id,
    chofer_nombre,
    legajo,
    servicio,
    diagrama_tipo,
    mes_tab,
    anio,
    mes_numero,
    dias,
    tira_dias,
    contabilizador,
    actualizado_el
  )
  VALUES (
    v_chofer_id,
    '{{ $json.chofer_nombre }}',
    NULLIF('{{ $json.legajo || "" }}', ''),
    NULLIF('{{ $json.servicio || "" }}', ''),
    NULLIF('{{ $json.diagrama_tipo || "" }}', ''),
    '{{ $json.mes_tab }}',
    {{ $json.anio }},
    {{ $json.mes_numero }},
    v_dias,
    '{{ $json.tira_dias }}',
    v_contabilizador,
    NOW()
  )
  ON CONFLICT (chofer_nombre, mes_tab)
  DO UPDATE SET
    chofer_id = COALESCE(v_chofer_id, public.diagramas.chofer_id),
    legajo = COALESCE(NULLIF('{{ $json.legajo || "" }}', ''), public.diagramas.legajo),
    servicio = COALESCE(NULLIF('{{ $json.servicio || "" }}', ''), public.diagramas.servicio),
    diagrama_tipo = COALESCE(NULLIF('{{ $json.diagrama_tipo || "" }}', ''), public.diagramas.diagrama_tipo),
    dias = v_dias,
    tira_dias = '{{ $json.tira_dias }}',
    contabilizador = v_contabilizador,
    actualizado_el = NOW();

  -- 3. Actualizar contabilizador en public.choferes si existe el chofer
  IF v_chofer_id IS NOT NULL THEN
    UPDATE public.choferes
    SET contabilizador = v_contabilizador,
        actualizado_el = NOW()
    WHERE id = v_chofer_id;
  END IF;
END $$;"""
      },
      "id": "db-dias",
      "name": "3. Upsert en public.diagramas y Choferes",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 2.5,
      "position": [1040, 480],
      "credentials": cred_postgres
    },

    # =========================================================================
    # 4. RESUMEN / REPORTE
    # =========================================================================
    {
      "parameters": {
        "jsCode": """// NODO CODE: RESUMEN DE DÍAS DIAGRAMA
const normalizedItems = $('2. Normalizar Calendario y Contabilizador').all();
const totalChoferes = normalizedItems.length;

let totalTrabajados = 0;
let totalFrancos = 0;
let totalVacaciones = 0;
let totalAusencias = 0;
let mesTab = 'Oct-26';

for (const item of normalizedItems) {
  const c = item.json.contabilizador || {};
  totalTrabajados += (c.trabajados || 0);
  totalFrancos += (c.francos || 0);
  totalVacaciones += (c.vacaciones || 0);
  totalAusencias += (c.ausencias || 0);
  if (item.json.mes_tab) mesTab = item.json.mes_tab;
}

return [{
  json: {
    estado: '✅ Sincronización exitosa de Días Diagrama',
    mes_tab: mesTab,
    total_choferes_procesados: totalChoferes,
    metricas_acumuladas: {
      turnos_trabajados: totalTrabajados,
      francos_totales: totalFrancos,
      dias_vacaciones: totalVacaciones,
      ausencias_licencias: totalAusencias
    },
    tablas_actualizadas: [
      'public.diagramas (matriz mensual por chofer)',
      'public.choferes (contabilizador actualizado)'
    ],
    timestamp: new Date().toISOString()
  }
}];"""
      },
      "id": "rep-dias",
      "name": "📊 Resumen: Días Diagrama",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [1300, 480]
    }
  ],
  "connections": {
    "▶️ Disparar: Días Diagrama": {
      "main": [[{"node": "⚙️ Configuración: Días Diagrama", "type": "main", "index": 0}]]
    },
    "⚡ Webhook: Días Diagrama": {
      "main": [[{"node": "⚙️ Configuración: Días Diagrama", "type": "main", "index": 0}]]
    },
    "⚙️ Configuración: Días Diagrama": {
      "main": [[{"node": "1. Leer Matriz Diagramas (Google Sheets)", "type": "main", "index": 0}]]
    },
    "1. Leer Matriz Diagramas (Google Sheets)": {
      "main": [[{"node": "2. Normalizar Calendario y Contabilizador", "type": "main", "index": 0}]]
    },
    "2. Normalizar Calendario y Contabilizador": {
      "main": [[{"node": "3. Upsert en public.diagramas y Choferes", "type": "main", "index": 0}]]
    },
    "3. Upsert en public.diagramas y Choferes": {
      "main": [[{"node": "📊 Resumen: Días Diagrama", "type": "main", "index": 0}]]
    }
  },
  "settings": {
    "executionOrder": "v1"
  }
}

# 1. Guardar archivo físico en el repositorio
with open(wf_file, 'w', encoding='utf-8') as f:
    json.dump(workflow, f, indent=2, ensure_ascii=False)
print("Saved workflow file:", wf_file)

# 2. Inyectar o actualizar en SQLite de n8n
con = sqlite3.connect(db_path)
cur = con.cursor()

wf_id = 'operativasDiasDiagrama01'
wf_name = workflow['name']
nodes_json = json.dumps(workflow['nodes'])
connections_json = json.dumps(workflow['connections'])
settings_json = json.dumps(workflow.get('settings', {}))
now_str = datetime.now().strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]
ver_id = str(uuid.uuid4())

# Check if exists
cur.execute("SELECT id FROM workflow_entity WHERE id = ?", (wf_id,))
row = cur.fetchone()

if row:
    cur.execute("""
        UPDATE workflow_entity 
        SET name = ?, nodes = ?, connections = ?, settings = ?, updatedAt = ?, versionId = ?
        WHERE id = ?
    """, (wf_name, nodes_json, connections_json, settings_json, now_str, ver_id, wf_id))
    print("Workflow updated in SQLite successfully!")
else:
    cur.execute("""
        INSERT INTO workflow_entity (id, name, active, nodes, connections, settings, createdAt, updatedAt, versionId)
        VALUES (?, ?, 0, ?, ?, ?, ?, ?, ?)
    """, (wf_id, wf_name, nodes_json, connections_json, settings_json, now_str, now_str, ver_id))
    print("Workflow created in SQLite successfully!")

con.commit()
con.close()
