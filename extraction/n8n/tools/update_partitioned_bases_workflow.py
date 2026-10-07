import sqlite3
import json
import uuid
from datetime import datetime

db_path = r'C:\Users\Matias Rodriguez\.n8n\database.sqlite'
wf_file = r'c:\Users\Matias Rodriguez\Documents\server_local\n8n\workflows\bases_organizacion_tractores.json'

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

spreadsheet_id_oct = "14Mb5rD853zxDkaLDS-IrW-OBDTDBjuJxn_3olXeWlkc"
sheet_name_oct = "OCTUBRE 2026- Mov.Unidades y Choferes"
range_oct = "A1:F350"

workflow = {
  "name": "Bases Organización (Tractores, Semis, Unidades)",
  "nodes": [
    # =========================================================================
    # STICKY NOTES Y BANNERS VISUALES
    # =========================================================================
    {
      "parameters": {
        "content": "# 🏢 BASES ORGANIZACIÓN (ESPACIO MODULAR)\n**Particiones independientes con triggers y webhooks individuales + Disparador Global.**\n- Cada partición tiene su propio nodo de configuración (`⚙️ Configuración: ...`) para parametrizar ID, hoja y rango de forma aislada.\n- Puedes disparar cada partición por separado o pulsar el botón global para sincronizar todo el conjunto.",
        "height": 160,
        "width": 1840,
        "color": 6
      },
      "id": "note-header",
      "name": "Banner: Bases Organización",
      "type": "n8n-nodes-base.stickyNote",
      "typeVersion": 1,
      "position": [-300, -60]
    },
    {
      "parameters": {
        "content": "### 🌐 DISPARADOR GLOBAL\nEjecuta las 3 particiones en paralelo con un solo clic.",
        "height": 380,
        "width": 240,
        "color": 7
      },
      "id": "note-global-trig",
      "name": "Nota: Trigger Global",
      "type": "n8n-nodes-base.stickyNote",
      "typeVersion": 1,
      "position": [-300, 480]
    },
    {
      "parameters": {
        "content": "## 🚜 PARTICIÓN 1: TRACTORES\n- **Origen:** Col E (Tractor) de Movimientos.\n- **Reglas:** Sin íconos de estado. Categoría heredada de cabecera. Patente limpia.\n- **Supabase:** `UPSERT` en `public.tractores` preservando la marca intacta.",
        "height": 380,
        "width": 1580,
        "color": 5
      },
      "id": "note-tractores",
      "name": "Nota: Tractores",
      "type": "n8n-nodes-base.stickyNote",
      "typeVersion": 1,
      "position": [-40, 120]
    },
    {
      "parameters": {
        "content": "## 🛢️ PARTICIÓN 2: SEMIS + CISTERNADO\n- **Origen:** Col F (SEMI) y Col D (Cisternado: ej. `7-7-5-5-6-7`).\n- **Reglas:** Sin íconos de estado. Patente limpia. Cisternado asignado.\n- **Supabase:** `UPSERT` en `public.semis` preservando la marca intacta.",
        "height": 380,
        "width": 1580,
        "color": 4
      },
      "id": "note-semis",
      "name": "Nota: Semis",
      "type": "n8n-nodes-base.stickyNote",
      "typeVersion": 1,
      "position": [-40, 520]
    },
    {
      "parameters": {
        "content": "## 🚛 PARTICIÓN 3: BUILD LISTA DE UNIDADES (ACOPLE)\n- **Origen:** Cruce de `n_ute` (Col C), `Tractor` (Col E) y `SEMI` (Col F).\n- **Supabase:** Resuelve UUIDs de tractores y semis vía PL/pgSQL sin duplicados.",
        "height": 380,
        "width": 1580,
        "color": 3
      },
      "id": "note-unidades",
      "name": "Nota: Unidades",
      "type": "n8n-nodes-base.stickyNote",
      "typeVersion": 1,
      "position": [-40, 920]
    },

    # =========================================================================
    # DISPARADOR GLOBAL
    # =========================================================================
    {
      "parameters": {},
      "id": "trig-global",
      "name": "🌐 Disparar Todo: Bases Organización",
      "type": "n8n-nodes-base.manualTrigger",
      "typeVersion": 1,
      "position": [-260, 640]
    },

    # =========================================================================
    # PARTICIÓN 1: TRACTORES
    # =========================================================================
    {
      "parameters": {},
      "id": "trig-manual-trac",
      "name": "▶️ Disparar: Tractores",
      "type": "n8n-nodes-base.manualTrigger",
      "typeVersion": 1,
      "position": [0, 200]
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
      "position": [0, 360],
      "webhookId": "recorte-tractores"
    },
    {
      "parameters": {
        "assignments": {
          "assignments": [
            {
              "id": "param-spreadsheet-id-trac",
              "name": "spreadsheetId",
              "value": spreadsheet_id_oct,
              "type": "string"
            },
            {
              "id": "param-tab-name-trac",
              "name": "sheetName",
              "value": sheet_name_oct,
              "type": "string"
            },
            {
              "id": "param-range-trac",
              "name": "range",
              "value": range_oct,
              "type": "string"
            }
          ]
        },
        "options": {}
      },
      "id": "set-config-trac",
      "name": "⚙️ Configuración: Tractores",
      "type": "n8n-nodes-base.set",
      "typeVersion": 3.4,
      "position": [240, 280],
      "notesInFlow": True,
      "notes": "Parámetros individuales para la partición de Tractores."
    },
    {
      "parameters": {
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
          "range": "={{ $json.range }}"
        }
      },
      "id": "read-sheets-trac",
      "name": "1. Leer Movimientos (Tractores)",
      "type": "n8n-nodes-base.googleSheets",
      "typeVersion": 4.5,
      "position": [500, 280],
      "credentials": cred_google
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
      "position": [760, 280]
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
      "position": [1020, 280],
      "credentials": cred_postgres
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
      "position": [1280, 280]
    },

    # =========================================================================
    # PARTICIÓN 2: SEMIS + CISTERNADO
    # =========================================================================
    {
      "parameters": {},
      "id": "trig-manual-semis",
      "name": "▶️ Disparar: Semis + Cisternado",
      "type": "n8n-nodes-base.manualTrigger",
      "typeVersion": 1,
      "position": [0, 600]
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
      "position": [0, 760],
      "webhookId": "recorte-semis"
    },
    {
      "parameters": {
        "assignments": {
          "assignments": [
            {
              "id": "param-spreadsheet-id-semis",
              "name": "spreadsheetId",
              "value": spreadsheet_id_oct,
              "type": "string"
            },
            {
              "id": "param-tab-name-semis",
              "name": "sheetName",
              "value": sheet_name_oct,
              "type": "string"
            },
            {
              "id": "param-range-semis",
              "name": "range",
              "value": range_oct,
              "type": "string"
            }
          ]
        },
        "options": {}
      },
      "id": "set-config-semis",
      "name": "⚙️ Configuración: Semis",
      "type": "n8n-nodes-base.set",
      "typeVersion": 3.4,
      "position": [240, 680],
      "notesInFlow": True,
      "notes": "Parámetros individuales para la partición de Semis y Cisternado."
    },
    {
      "parameters": {
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
          "range": "={{ $json.range }}"
        }
      },
      "id": "read-sheets-semis",
      "name": "1. Leer Movimientos (Semis)",
      "type": "n8n-nodes-base.googleSheets",
      "typeVersion": 4.5,
      "position": [500, 680],
      "credentials": cred_google
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
      "position": [760, 680]
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
      "position": [1020, 680],
      "credentials": cred_postgres
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
      "position": [1280, 680]
    },

    # =========================================================================
    # PARTICIÓN 3: BUILD LISTA DE UNIDADES
    # =========================================================================
    {
      "parameters": {},
      "id": "trig-manual-uni",
      "name": "▶️ Disparar: Build Lista de Unidades",
      "type": "n8n-nodes-base.manualTrigger",
      "typeVersion": 1,
      "position": [0, 1000]
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
      "position": [0, 1160],
      "webhookId": "recorte-unidades"
    },
    {
      "parameters": {
        "assignments": {
          "assignments": [
            {
              "id": "param-spreadsheet-id-uni",
              "name": "spreadsheetId",
              "value": spreadsheet_id_oct,
              "type": "string"
            },
            {
              "id": "param-tab-name-uni",
              "name": "sheetName",
              "value": sheet_name_oct,
              "type": "string"
            },
            {
              "id": "param-range-uni",
              "name": "range",
              "value": range_oct,
              "type": "string"
            }
          ]
        },
        "options": {}
      },
      "id": "set-config-uni",
      "name": "⚙️ Configuración: Unidades",
      "type": "n8n-nodes-base.set",
      "typeVersion": 3.4,
      "position": [240, 1080],
      "notesInFlow": True,
      "notes": "Parámetros individuales para el Build de Lista de Unidades."
    },
    {
      "parameters": {
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
          "range": "={{ $json.range }}"
        }
      },
      "id": "read-sheets-uni",
      "name": "1. Leer Movimientos (Unidades)",
      "type": "n8n-nodes-base.googleSheets",
      "typeVersion": 4.5,
      "position": [500, 1080],
      "credentials": cred_google
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
      "position": [760, 1080]
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
      "position": [1020, 1080],
      "credentials": cred_postgres
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
      "position": [1280, 1080]
    }
  ],
  "connections": {
    # TRIGGER GLOBAL
    "🌐 Disparar Todo: Bases Organización": {
      "main": [
        [
          {"node": "⚙️ Configuración: Tractores", "type": "main", "index": 0},
          {"node": "⚙️ Configuración: Semis", "type": "main", "index": 0},
          {"node": "⚙️ Configuración: Unidades", "type": "main", "index": 0}
        ]
      ]
    },

    # PARTICIÓN 1: TRACTORES
    "▶️ Disparar: Tractores": {
      "main": [[{"node": "⚙️ Configuración: Tractores", "type": "main", "index": 0}]]
    },
    "⚡ Webhook: Tractores (Col E)": {
      "main": [[{"node": "⚙️ Configuración: Tractores", "type": "main", "index": 0}]]
    },
    "⚙️ Configuración: Tractores": {
      "main": [[{"node": "1. Leer Movimientos (Tractores)", "type": "main", "index": 0}]]
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

    # PARTICIÓN 2: SEMIS
    "▶️ Disparar: Semis + Cisternado": {
      "main": [[{"node": "⚙️ Configuración: Semis", "type": "main", "index": 0}]]
    },
    "⚡ Webhook: Semis / Cisternado": {
      "main": [[{"node": "⚙️ Configuración: Semis", "type": "main", "index": 0}]]
    },
    "⚙️ Configuración: Semis": {
      "main": [[{"node": "1. Leer Movimientos (Semis)", "type": "main", "index": 0}]]
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

    # PARTICIÓN 3: UNIDADES
    "▶️ Disparar: Build Lista de Unidades": {
      "main": [[{"node": "⚙️ Configuración: Unidades", "type": "main", "index": 0}]]
    },
    "⚡ Webhook: Acople Unidades": {
      "main": [[{"node": "⚙️ Configuración: Unidades", "type": "main", "index": 0}]]
    },
    "⚙️ Configuración: Unidades": {
      "main": [[{"node": "1. Leer Movimientos (Unidades)", "type": "main", "index": 0}]]
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

# 1. Guardar archivo físico
with open(wf_file, 'w', encoding='utf-8') as f:
    json.dump(workflow, f, indent=2, ensure_ascii=False)
print("Saved partitioned workflow to file:", wf_file)

# 2. Actualizar en n8n SQLite
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
print("Updated basesOrgTractores01 in n8n database with individual partitions and global trigger.")

con.commit()
con.close()
print("All partitions updated cleanly with preserved credentials!")
