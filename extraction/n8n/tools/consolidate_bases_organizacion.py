import sqlite3
import json
import uuid
from datetime import datetime

db_path = r'C:\Users\Matias Rodriguez\.n8n\database.sqlite'
wf_file = r'c:\Users\Matias Rodriguez\Documents\server_local\n8n\workflows\bases_organizacion_tractores.json'

workflow = {
  "name": "Bases Organización (Tractores, Semis, Unidades)",
  "nodes": [
    # =========================================================================
    # BANNER Y NOTAS EXPLICATIVAS
    # =========================================================================
    {
      "parameters": {
        "content": "# 🏢 BASES ORGANIZACIÓN (ESPACIO CENTRAL)\n**Recorte y Build de Flota Base desde Movimientos Octubre 2.1**\n- **Rama 1:** Tractores (Normalización, deduplicación y pareo de marcas).\n- **Rama 2:** Semis + Cisternado (Normalización, deduplicación y pareo de marcas).\n- **Rama 3:** Build Lista de Unidades (Vinculación relacional `n_ute + tractor_id + semi_id + servicio_id`).\n\n*Nota Migración:* Usa tu cuenta actual en los nodos de Sheets. Al tener la cuenta corporativa, solo cambias la credencial aquí sin tocar nada más.",
        "height": 200,
        "width": 1780,
        "color": 6
      },
      "id": "note-header",
      "name": "Banner: Bases Organización",
      "type": "n8n-nodes-base.stickyNote",
      "typeVersion": 1,
      "position": [-40, -140]
    },
    {
      "parameters": {
        "content": "## 🚜 RAMA 1: RECORTE DE TRACTORES\n- Lee `Col E` (Tractor) de la hoja mensual.\n- Descarta íconos/emojis (`🟢`, `🟡`, etc.).\n- Hereda el servicio desde cabeceras.\n- `UPSERT` en `public.tractores` preservando la marca intacta.",
        "height": 340,
        "width": 1780,
        "color": 5
      },
      "id": "note-tractores",
      "name": "Nota: Tractores",
      "type": "n8n-nodes-base.stickyNote",
      "typeVersion": 1,
      "position": [-40, 100]
    },
    {
      "parameters": {
        "content": "## 🛢️ RAMA 2: RECORTE DE SEMIS + CISTERNADO\n- Lee `Col F` (SEMI) y `Col D` (Cisternado: ej. `7-7-5-5-6-7`).\n- Descarta íconos/emojis.\n- `UPSERT` en `public.semis` preservando la marca y actualizando cisternado.",
        "height": 340,
        "width": 1780,
        "color": 4
      },
      "id": "note-semis",
      "name": "Nota: Semis",
      "type": "n8n-nodes-base.stickyNote",
      "typeVersion": 1,
      "position": [-40, 480]
    },
    {
      "parameters": {
        "content": "## 🚛 RAMA 3: BUILD LISTA DE UNIDADES (ACOPLE CANÓNICO)\n- Cruza `n_ute` (Col C), `Tractor` (Col E) y `SEMI` (Col F) bajo su `Servicio`.\n- Vincula los UUIDs canónicos de `public.tractores` y `public.semis`.\n- Inserta o actualiza en `public.unidades` con fecha de acople.",
        "height": 340,
        "width": 1780,
        "color": 3
      },
      "id": "note-unidades",
      "name": "Nota: Unidades",
      "type": "n8n-nodes-base.stickyNote",
      "typeVersion": 1,
      "position": [-40, 860]
    },

    # =========================================================================
    # CONFIGURACIÓN MENSUAL (CENTRAL)
    # =========================================================================
    {
      "parameters": {
        "assignments": {
          "assignments": [
            {
              "id": "param-spreadsheet-id",
              "name": "spreadsheetId",
              "value": "14Mb5rD853zxDkaLDS-IrW-OBDTDBjuJxn_3olXeWlkc",
              "type": "string"
            },
            {
              "id": "param-tab-name",
              "name": "sheetName",
              "value": "OCTUBRE 2026- Mov.Unidades y Choferes",
              "type": "string"
            },
            {
              "id": "param-range",
              "name": "range",
              "value": "A1:F350",
              "type": "string"
            }
          ]
        },
        "options": {}
      },
      "id": "set-config",
      "name": "⚙️ Configuración Mensual",
      "type": "n8n-nodes-base.set",
      "typeVersion": 3.4,
      "position": [360, -40],
      "notesInFlow": True,
      "notes": "Edita aquí mensualmente el ID y la pestaña de Movimientos."
    },

    # =========================================================================
    # RAMA 1: TRACTORES
    # =========================================================================
    {
      "parameters": {},
      "id": "trig-manual-trac",
      "name": "▶️ Disparar: Tractores",
      "type": "n8n-nodes-base.manualTrigger",
      "typeVersion": 1,
      "position": [40, 200]
    },
    {
      "parameters": {
        "httpMethod": "POST",
        "path": "recorte-tractores",
        "options": {}
      },
      "id": "trig-webhook-trac",
      "name": "⚡ Webhook: Tractores (Col E)",
      "type": "n8n-nodes-base.webhook",
      "typeVersion": 2,
      "position": [40, 340],
      "webhookId": "recorte-tractores"
    },
    {
      "parameters": {
        "operation": "read",
        "documentId": {
          "__rl": True,
          "value": "={{ $('⚙️ Configuración Mensual').item.json.spreadsheetId }}",
          "mode": "id"
        },
        "sheetName": {
          "__rl": True,
          "value": "={{ $('⚙️ Configuración Mensual').item.json.sheetName }}",
          "mode": "name"
        },
        "options": {
          "range": "={{ $('⚙️ Configuración Mensual').item.json.range }}"
        }
      },
      "id": "read-sheets-trac",
      "name": "1. Leer Movimientos (Tractores)",
      "type": "n8n-nodes-base.googleSheets",
      "typeVersion": 4.5,
      "position": [360, 260]
    },
    {
      "parameters": {
        "jsCode": """// NODO CODE: RECORTE Y NORMALIZACIÓN DE TRACTORES
const rows = $input.all();
const tractoresMap = new Map();
let currentServicio = 'GENERAL';
const blacklist = new Set(['TRACTOR', 'PATENTE', 'SEMI', 'CISTERNADO', 'NOVEDADES', 'LIVIANO', 'METANOL', 'CAMPO', 'GLP', 'SOCIO', 'SEPTIEMBRE', 'OCTUBRE', 'FECHA', 'N']);

for (const item of rows) {
  const row = item.json;
  const colA = String(row['N'] || row['0'] || Object.values(row)[0] || '').trim();
  const colC = String(row['N° UTE'] || row['2'] || Object.values(row)[2] || '').trim();
  const colE = String(row['Tractor'] || row['4'] || Object.values(row)[4] || '').trim();
  const colF = String(row['SEMI'] || row['5'] || Object.values(row)[5] || '').trim();

  if (colA && !colC && !colE && !colF) {
    const upA = colA.toUpperCase();
    if (!upA.includes('FECHA') && !upA.includes('N°') && !upA.includes('OCTUBRE') && !upA.includes('NOVEDADES')) {
      currentServicio = upA;
    }
    continue;
  }

  const rawTractor = colE.toUpperCase().replace(/\\s+/g, '');
  if (!rawTractor || blacklist.has(rawTractor) || rawTractor.length < 5) continue;

  if (!tractoresMap.has(rawTractor)) {
    tractoresMap.set(rawTractor, {
      patente: rawTractor,
      servicio_denominacion: currentServicio,
      estado: 'disponible',
      n_ute: colC || null,
      actualizado_el: new Date().toISOString()
    });
  }
}
return Array.from(tractoresMap.values()).map(t => ({ json: t }));"""
      },
      "id": "code-trac",
      "name": "2. Filtrar y Normalizar Tractores",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [640, 260]
    },
    {
      "parameters": {
        "operation": "executeQuery",
        "query": "INSERT INTO public.tractores (patente, estado, actualizado_el)\nVALUES ('{{ $json.patente }}', '{{ $json.estado }}', NOW())\nON CONFLICT (patente) DO UPDATE\nSET estado = EXCLUDED.estado,\n    actualizado_el = NOW();"
      },
      "id": "db-trac",
      "name": "3. Upsert Tractores en Supabase",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 2.5,
      "position": [920, 260]
    },
    {
      "parameters": {
        "jsCode": """const items = $input.all();
return [{
  json: {
    timestamp: new Date().toLocaleString('es-AR'),
    modulo: 'Bases Organización - Tractores',
    total_tractores_sincronizados: items.length,
    estado: '✅ Catálogo de tractores actualizado en Supabase (marcas preservadas)',
    muestra: items.slice(0, 5).map(i => i.json.patente || i.json)
  }
}];"""
      },
      "id": "rep-trac",
      "name": "📊 Resumen: Tractores",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [1200, 260]
    },

    # =========================================================================
    # RAMA 2: SEMIS + CISTERNADO
    # =========================================================================
    {
      "parameters": {},
      "id": "trig-manual-semis",
      "name": "▶️ Disparar: Semis + Cisternado",
      "type": "n8n-nodes-base.manualTrigger",
      "typeVersion": 1,
      "position": [40, 580]
    },
    {
      "parameters": {
        "httpMethod": "POST",
        "path": "recorte-semis",
        "options": {}
      },
      "id": "trig-webhook-semis",
      "name": "⚡ Webhook: Semis / Cisternado",
      "type": "n8n-nodes-base.webhook",
      "typeVersion": 2,
      "position": [40, 720],
      "webhookId": "recorte-semis"
    },
    {
      "parameters": {
        "operation": "read",
        "documentId": {
          "__rl": True,
          "value": "={{ $('⚙️ Configuración Mensual').item.json.spreadsheetId }}",
          "mode": "id"
        },
        "sheetName": {
          "__rl": True,
          "value": "={{ $('⚙️ Configuración Mensual').item.json.sheetName }}",
          "mode": "name"
        },
        "options": {
          "range": "={{ $('⚙️ Configuración Mensual').item.json.range }}"
        }
      },
      "id": "read-sheets-semis",
      "name": "1. Leer Movimientos (Semis)",
      "type": "n8n-nodes-base.googleSheets",
      "typeVersion": 4.5,
      "position": [360, 640]
    },
    {
      "parameters": {
        "jsCode": """// NODO CODE: RECORTE Y NORMALIZACIÓN DE SEMIS + CISTERNADO
const rows = $input.all();
const semisMap = new Map();
let currentServicio = 'GENERAL';
const blacklist = new Set(['TRACTOR', 'PATENTE', 'SEMI', 'CISTERNADO', 'NOVEDADES', 'LIVIANO', 'METANOL', 'CAMPO', 'GLP', 'SOCIO', 'SEPTIEMBRE', 'OCTUBRE', 'FECHA', 'N']);

for (const item of rows) {
  const row = item.json;
  const colA = String(row['N'] || row['0'] || Object.values(row)[0] || '').trim();
  const colC = String(row['N° UTE'] || row['2'] || Object.values(row)[2] || '').trim();
  const colD = String(row['Cisternado'] || row['3'] || Object.values(row)[3] || '').trim();
  const colE = String(row['Tractor'] || row['4'] || Object.values(row)[4] || '').trim();
  const colF = String(row['SEMI'] || row['5'] || Object.values(row)[5] || '').trim();

  if (colA && !colC && !colE && !colF) {
    const upA = colA.toUpperCase();
    if (!upA.includes('FECHA') && !upA.includes('N°') && !upA.includes('OCTUBRE') && !upA.includes('NOVEDADES')) {
      currentServicio = upA;
    }
    continue;
  }

  const rawSemi = colF.toUpperCase().replace(/\\s+/g, '');
  if (!rawSemi || blacklist.has(rawSemi) || rawSemi.length < 5) continue;

  const cisternadoLimpio = colD && colD !== '-' ? colD.trim() : null;

  if (!semisMap.has(rawSemi)) {
    semisMap.set(rawSemi, {
      patente: rawSemi,
      cisternado: cisternadoLimpio,
      servicio_denominacion: currentServicio,
      estado: 'disponible',
      n_ute: colC || null,
      actualizado_el: new Date().toISOString()
    });
  } else {
    const existing = semisMap.get(rawSemi);
    if (!existing.cisternado && cisternadoLimpio) {
      existing.cisternado = cisternadoLimpio;
    }
  }
}
return Array.from(semisMap.values()).map(s => ({ json: s }));"""
      },
      "id": "code-semis",
      "name": "2. Filtrar y Normalizar Semis",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [640, 640]
    },
    {
      "parameters": {
        "operation": "executeQuery",
        "query": "INSERT INTO public.semis (patente, cisternado, estado, actualizado_el)\nVALUES ('{{ $json.patente }}', {{ $json.cisternado ? \"'\" + $json.cisternado + \"'\" : \"NULL\" }}, '{{ $json.estado }}', NOW())\nON CONFLICT (patente) DO UPDATE\nSET cisternado = COALESCE(EXCLUDED.cisternado, semis.cisternado),\n    estado = EXCLUDED.estado,\n    actualizado_el = NOW();"
      },
      "id": "db-semis",
      "name": "3. Upsert Semis en Supabase",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 2.5,
      "position": [920, 640]
    },
    {
      "parameters": {
        "jsCode": """const items = $input.all();
const total = items.length;
const conCis = items.filter(i => i.json.cisternado).length;
return [{
  json: {
    timestamp: new Date().toLocaleString('es-AR'),
    modulo: 'Bases Organización - Semis y Cisternado',
    total_semis_sincronizados: total,
    con_cisternado: conCis,
    sin_cisternado: total - conCis,
    estado: '✅ Catálogo de semis y cisternados actualizado en Supabase (marcas preservadas)',
    muestra: items.slice(0, 5).map(i => `${i.json.patente || i.json} (${i.json.cisternado || 'S/C'})`)
  }
}];"""
      },
      "id": "rep-semis",
      "name": "📊 Resumen: Semis",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [1200, 640]
    },

    # =========================================================================
    # RAMA 3: BUILD LISTA DE UNIDADES
    # =========================================================================
    {
      "parameters": {},
      "id": "trig-manual-uni",
      "name": "▶️ Disparar: Build Lista de Unidades",
      "type": "n8n-nodes-base.manualTrigger",
      "typeVersion": 1,
      "position": [40, 960]
    },
    {
      "parameters": {
        "httpMethod": "POST",
        "path": "recorte-unidades",
        "options": {}
      },
      "id": "trig-webhook-uni",
      "name": "⚡ Webhook: Acople Unidades",
      "type": "n8n-nodes-base.webhook",
      "typeVersion": 2,
      "position": [40, 1100],
      "webhookId": "recorte-unidades"
    },
    {
      "parameters": {
        "operation": "read",
        "documentId": {
          "__rl": True,
          "value": "={{ $('⚙️ Configuración Mensual').item.json.spreadsheetId }}",
          "mode": "id"
        },
        "sheetName": {
          "__rl": True,
          "value": "={{ $('⚙️ Configuración Mensual').item.json.sheetName }}",
          "mode": "name"
        },
        "options": {
          "range": "={{ $('⚙️ Configuración Mensual').item.json.range }}"
        }
      },
      "id": "read-sheets-uni",
      "name": "1. Leer Movimientos (Unidades)",
      "type": "n8n-nodes-base.googleSheets",
      "typeVersion": 4.5,
      "position": [360, 1020]
    },
    {
      "parameters": {
        "jsCode": """// NODO CODE: MAPEAR FORMACIONES DE UNIDADES (ACOPLE TRACTOR + SEMI + UTE)
const rows = $input.all();
const unidadesList = [];
let currentServicio = 'GENERAL';
const blacklist = new Set(['TRACTOR', 'PATENTE', 'SEMI', 'CISTERNADO', 'NOVEDADES', 'LIVIANO', 'METANOL', 'CAMPO', 'GLP', 'SOCIO', 'SEPTIEMBRE', 'OCTUBRE', 'FECHA', 'N']);

for (const item of rows) {
  const row = item.json;
  const colA = String(row['N'] || row['0'] || Object.values(row)[0] || '').trim();
  const colC = String(row['N° UTE'] || row['2'] || Object.values(row)[2] || '').trim();
  const colD = String(row['Cisternado'] || row['3'] || Object.values(row)[3] || '').trim();
  const colE = String(row['Tractor'] || row['4'] || Object.values(row)[4] || '').trim();
  const colF = String(row['SEMI'] || row['5'] || Object.values(row)[5] || '').trim();

  if (colA && !colC && !colE && !colF) {
    const upA = colA.toUpperCase();
    if (!upA.includes('FECHA') && !upA.includes('N°') && !upA.includes('OCTUBRE') && !upA.includes('NOVEDADES')) {
      currentServicio = upA;
    }
    continue;
  }

  const rawTractor = colE.toUpperCase().replace(/\\s+/g, '');
  const rawSemi = colF.toUpperCase().replace(/\\s+/g, '');
  const nUte = colC ? colC.trim() : null;

  if ((!rawTractor && !rawSemi && !nUte) || blacklist.has(rawTractor) || blacklist.has(rawSemi)) {
    continue;
  }

  unidadesList.push({
    n_ute: nUte,
    tractor: rawTractor && rawTractor.length >= 5 ? rawTractor : null,
    semi: rawSemi && rawSemi.length >= 5 ? rawSemi : null,
    cisternado: colD && colD !== '-' ? colD.trim() : null,
    servicio: currentServicio,
    estado: 'disponible'
  });
}
return unidadesList.map(u => ({ json: u }));"""
      },
      "id": "code-uni",
      "name": "2. Mapear Formaciones (Unidades)",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [640, 1020]
    },
    {
      "parameters": {
        "operation": "executeQuery",
        "query": """DO $$
DECLARE
  v_tr_id UUID := NULL;
  v_se_id UUID := NULL;
  v_srv_id UUID := NULL;
  v_uni_id UUID := NULL;
BEGIN
  IF '{{ $json.tractor || "" }}' <> '' THEN
    SELECT id INTO v_tr_id FROM public.tractores WHERE patente = '{{ $json.tractor }}' LIMIT 1;
  END IF;
  
  IF '{{ $json.semi || "" }}' <> '' THEN
    SELECT id INTO v_se_id FROM public.semis WHERE patente = '{{ $json.semi }}' LIMIT 1;
  END IF;

  SELECT id INTO v_srv_id FROM public.servicios_unidades WHERE UPPER(denominacion) = UPPER('{{ $json.servicio }}') LIMIT 1;

  -- Buscar si ya existe la formación
  IF v_tr_id IS NOT NULL THEN
    SELECT id INTO v_uni_id FROM public.unidades WHERE tractor_id = v_tr_id LIMIT 1;
  ELSIF v_se_id IS NOT NULL THEN
    SELECT id INTO v_uni_id FROM public.unidades WHERE semi_id = v_se_id LIMIT 1;
  ELSIF '{{ $json.n_ute || "" }}' <> '' THEN
    SELECT id INTO v_uni_id FROM public.unidades WHERE n_ute = '{{ $json.n_ute }}' LIMIT 1;
  END IF;

  IF v_uni_id IS NOT NULL THEN
    UPDATE public.unidades
    SET n_ute = COALESCE(NULLIF('{{ $json.n_ute }}', ''), n_ute),
        tractor_id = v_tr_id,
        semi_id = v_se_id,
        servicio_id = COALESCE(v_srv_id, servicio_id),
        estado = '{{ $json.estado }}'
    WHERE id = v_uni_id;
  ELSE
    INSERT INTO public.unidades (n_ute, tractor_id, semi_id, servicio_id, estado, fecha_acople)
    VALUES (NULLIF('{{ $json.n_ute }}', ''), v_tr_id, v_se_id, v_srv_id, '{{ $json.estado }}', NOW());
  END IF;
END $$;"""
      },
      "id": "db-uni",
      "name": "3. Sincronizar Formaciones en Supabase",
      "type": "n8n-nodes-base.postgres",
      "typeVersion": 2.5,
      "position": [920, 1020]
    },
    {
      "parameters": {
        "jsCode": """const items = $input.all();
return [{
  json: {
    timestamp: new Date().toLocaleString('es-AR'),
    modulo: 'Bases Organización - Lista de Unidades',
    total_formaciones_procesadas: items.length,
    estado: '✅ Lista de unidades vinculada con éxito en Supabase',
    muestra: items.slice(0, 5).map(i => `UTE #${i.json.n_ute || 'S/N'}: Tr=[${i.json.tractor || 'N/A'}] Semi=[${i.json.semi || 'N/A'}]`)
  }
}];"""
      },
      "id": "rep-uni",
      "name": "📊 Resumen: Lista de Unidades",
      "type": "n8n-nodes-base.code",
      "typeVersion": 2,
      "position": [1200, 1020]
    }
  ],
  "connections": {
    # RAMA 1: TRACTORES
    "▶️ Disparar: Tractores": {
      "main": [[{"node": "⚙️ Configuración Mensual", "type": "main", "index": 0}]]
    },
    "⚡ Webhook: Tractores (Col E)": {
      "main": [[{"node": "⚙️ Configuración Mensual", "type": "main", "index": 0}]]
    },
    "⚙️ Configuración Mensual": {
      "main": [
        [
          {"node": "1. Leer Movimientos (Tractores)", "type": "main", "index": 0},
          {"node": "1. Leer Movimientos (Semis)", "type": "main", "index": 0},
          {"node": "1. Leer Movimientos (Unidades)", "type": "main", "index": 0}
        ]
      ]
    },
    "1. Leer Movimientos (Tractores)": {
      "main": [[{"node": "2. Filtrar y Normalizar Tractores", "type": "main", "index": 0}]]
    },
    "2. Filtrar y Normalizar Tractores": {
      "main": [[{"node": "3. Upsert Tractores en Supabase", "type": "main", "index": 0}]]
    },
    "3. Upsert Tractores en Supabase": {
      "main": [[{"node": "📊 Resumen: Tractores", "type": "main", "index": 0}]]
    },

    # RAMA 2: SEMIS
    "▶️ Disparar: Semis + Cisternado": {
      "main": [[{"node": "⚙️ Configuración Mensual", "type": "main", "index": 0}]]
    },
    "⚡ Webhook: Semis / Cisternado": {
      "main": [[{"node": "⚙️ Configuración Mensual", "type": "main", "index": 0}]]
    },
    "1. Leer Movimientos (Semis)": {
      "main": [[{"node": "2. Filtrar y Normalizar Semis", "type": "main", "index": 0}]]
    },
    "2. Filtrar y Normalizar Semis": {
      "main": [[{"node": "3. Upsert Semis en Supabase", "type": "main", "index": 0}]]
    },
    "3. Upsert Semis en Supabase": {
      "main": [[{"node": "📊 Resumen: Semis", "type": "main", "index": 0}]]
    },

    # RAMA 3: UNIDADES
    "▶️ Disparar: Build Lista de Unidades": {
      "main": [[{"node": "⚙️ Configuración Mensual", "type": "main", "index": 0}]]
    },
    "⚡ Webhook: Acople Unidades": {
      "main": [[{"node": "⚙️ Configuración Mensual", "type": "main", "index": 0}]]
    },
    "1. Leer Movimientos (Unidades)": {
      "main": [[{"node": "2. Mapear Formaciones (Unidades)", "type": "main", "index": 0}]]
    },
    "2. Mapear Formaciones (Unidades)": {
      "main": [[{"node": "3. Sincronizar Formaciones en Supabase", "type": "main", "index": 0}]]
    },
    "3. Sincronizar Formaciones en Supabase": {
      "main": [[{"node": "📊 Resumen: Lista de Unidades", "type": "main", "index": 0}]]
    }
  },
  "settings": {
    "executionOrder": "v1"
  }
}

# Guardar en archivo JSON
with open(wf_file, 'w', encoding='utf-8') as f:
    json.dump(workflow, f, indent=2, ensure_ascii=False)
print("Saved unified workflow to file:", wf_file)

# Guardar en n8n SQLite
con = sqlite3.connect(db_path)
cur = con.cursor()

wf_id = 'basesOrgTractores01'
wf_name = workflow['name']
nodes_json = json.dumps(workflow['nodes'])
connections_json = json.dumps(workflow['connections'])
settings_json = json.dumps(workflow.get('settings', {}))
now_str = datetime.now().strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]
ver_id = str(uuid.uuid4())

cur.execute("""
    UPDATE workflow_entity 
    SET name = ?, nodes = ?, connections = ?, settings = ?, updatedAt = ?, versionId = ?
    WHERE id = ?
""", (wf_name, nodes_json, connections_json, settings_json, now_str, ver_id, wf_id))
print("Updated basesOrgTractores01 in n8n database.")

# Borrar workflow redundante basesOrgSemis01 si existe
cur.execute("DELETE FROM workflow_entity WHERE id = 'basesOrgSemis01'")
cur.execute("DELETE FROM shared_workflow WHERE workflowId = 'basesOrgSemis01'")
print("Cleaned up redundant basesOrgSemis01 from n8n database.")

con.commit()
con.close()
print("All consolidated successfully!")
