import sqlite3
import json
import uuid
from datetime import datetime

db_path = r'C:\Users\Matias Rodriguez\.n8n\database.sqlite'
wf_file = r'c:\Users\Matias Rodriguez\Documents\server_local\n8n\workflows\bases_organizacion_tractores.json'
wf_dias_file = r'c:\Users\Matias Rodriguez\Documents\server_local\n8n\workflows\operativas_diarias_diagrama.json'

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

spreadsheet_id_diag = "1mhfXpFCF6upMlnRnZjDdBVS_wqTx5q8v0qQArNCnNAU"
sheet_name_diag = "Oct-26"
range_diag_chof = "A6:D350"
range_diag_dias = "A5:AN350"

spreadsheet_id_mov = "14Mb5rD853zxDkaLDS-IrW-OBDTDBjuJxn_3olXeWlkc"
sheet_name_mov = "OCTUBRE 2026- Mov.Unidades y Choferes"
range_mov = "A1:F350"

js_code_dias = """// NODO CODE: NORMALIZAR MATRIZ DE DÍAS Y CONTABILIZADOR CANÓNICO
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

# Definición de todos los nodos de las 5 particiones
nodes = [
  # BANNER GENERAL
  {
    "parameters": {
      "content": "# 🏢 BASES ORGANIZACIÓN Y OPERATIVAS (5 PARTICIONES INTEGRADAS)\n**5 Particiones Independientes con Triggers Manuales y Webhooks Aislados + Disparador Global.**\n- **Partición 1 (Choferes Base):** Diagramas EOR (Tab mensual `Oct-26`, cols A:D catálogo ligero).\n- **Partición 2 (Tractores):** Movimientos (Col E, marcas y estados preservados).\n- **Partición 3 (Semis):** Movimientos (Cols F y D, cisternados asociados).\n- **Partición 4 (Unidades):** Build relacional (`n_ute + tractor_id + semi_id + servicio_id`).\n- **Partición 5 (Días Diagrama):** Diagramas EOR (Tab mensual `Oct-26`, cabecera fila 5 y datos fila 6, matriz diaria y contabilizador).",
      "height": 180,
      "width": 1900,
      "color": 6
    },
    "id": "note-header",
    "name": "Banner: Bases Organización",
    "type": "n8n-nodes-base.stickyNote",
    "typeVersion": 1,
    "position": [-304, -80]
  },
  {
    "parameters": {
      "content": "### 🌐 DISPARADOR GLOBAL\nSincroniza las 5 particiones en paralelo con un solo clic.",
      "height": 400,
      "width": 240,
      "color": 7
    },
    "id": "note-global-trig",
    "name": "Nota: Trigger Global",
    "type": "n8n-nodes-base.stickyNote",
    "typeVersion": 1,
    "position": [-304, 888]
  },
  {
    "parameters": {},
    "id": "trig-global",
    "name": "🌐 Disparar Todo: Bases Organización",
    "type": "n8n-nodes-base.manualTrigger",
    "typeVersion": 1,
    "position": [-256, 1048]
  },

  # PARTICIÓN 1: CHOFERES
  {
    "parameters": {
      "content": "## 👥 PARTICIÓN 1: LISTA CHOFERES (DIAGRAMAS EOR REV01)\n- **Origen:** Tab mensual ligera (`Oct-26`), rango `A6:D350` (Legajo, Nombre, Servicio, Diagrama Tipo).\n- **Supabase:** `UPSERT` en `public.choferes`.",
      "height": 380,
      "width": 1600,
      "color": 6
    },
    "id": "note-choferes",
    "name": "Nota: Choferes",
    "type": "n8n-nodes-base.stickyNote",
    "typeVersion": 1,
    "position": [-48, 112]
  },
  {
    "parameters": {},
    "id": "trig-manual-chof",
    "name": "▶️ Disparar: Choferes",
    "type": "n8n-nodes-base.manualTrigger",
    "typeVersion": 1,
    "position": [0, 192]
  },
  {
    "parameters": {
      "httpMethod": "POST",
      "path": "recorte-choferes",
      "options": {}
    },
    "id": "trig-webhook-chof",
    "name": "⚡ Webhook: Choferes (Diagramas)",
    "type": "n8n-nodes-base.webhook",
    "typeVersion": 2,
    "position": [0, 352],
    "webhookId": "recorte-choferes"
  },
  {
    "parameters": {
      "assignments": {
        "assignments": [
          {"id": "p-sp-chof", "name": "spreadsheetId", "value": "={{ $json.body?.spreadsheetId || $json.spreadsheetId || '" + spreadsheet_id_diag + "' }}", "type": "string"},
          {"id": "p-sh-chof", "name": "sheetName", "value": "={{ $json.body?.sheetName || $json.sheetName || '" + sheet_name_diag + "' }}", "type": "string"},
          {"id": "p-rg-chof", "name": "range", "value": "={{ $json.body?.range || $json.range || '" + range_diag_chof + "' }}", "type": "string"}
        ]
      },
      "options": {}
    },
    "id": "set-config-chof",
    "name": "⚙️ Configuración: Choferes",
    "type": "n8n-nodes-base.set",
    "typeVersion": 3.4,
    "position": [240, 272],
    "notesInFlow": True,
    "notes": "Parámetros para Choferes (Diagramas EOR 2026: cambia anualmente, pestaña mensual)."
  },
  {
    "parameters": {
      "authentication": "serviceAccount",
      "operation": "read",
      "documentId": {"__rl": True, "value": "={{ $json.spreadsheetId }}", "mode": "id"},
      "sheetName": {"__rl": True, "value": "={{ $json.sheetName }}", "mode": "name"},
      "options": {}
    },
    "id": "read-sheets-chof",
    "name": "1. Leer Diagramas (Choferes Mes)",
    "type": "n8n-nodes-base.googleSheets",
    "typeVersion": 4.5,
    "position": [512, 272],
    "credentials": cred_google
  },
  {
    "parameters": {
      "jsCode": """const rows = $input.all();
const choferesMap = new Map();
const blacklist = new Set([
  'APELLIDO Y NOMBRE', 'PERSONAL ACTIVO', 'LEGAJO', 'CUENTA', 
  'SERVICIO', 'DIAGRAMA', 'TOTAL', 'CHOFER', 'NOMBRE', 'FECHA', 
  'PASIVO EN BASE', 'PASIVO', 'FECHA', 'NOMENCLATURAS'
]);

for (const item of rows) {
  const row = item.json;
  const rawLegajo = String(
    row.col_1 ?? row.LEGAJO ?? row.legajo ?? row['0'] ?? ''
  ).trim();
  const rawNombre = String(
    row.col_2 ?? row['APELLIDO Y NOMBRE'] ?? row.nombre ?? row['1'] ?? ''
  ).trim().toUpperCase();
  const rawServicio = String(
    row.col_3 ?? row.SERVICIO ?? row.CUENTA ?? row.servicio ?? row['2'] ?? ''
  ).trim().toUpperCase();
  const rawDiag = String(
    row.col_4 ?? row.DIAGRAMA ?? row.diagrama ?? row['3'] ?? ''
  ).trim().toUpperCase();

  if (!rawNombre || rawNombre.length < 3 || /^\\d+$/.test(rawNombre) || blacklist.has(rawNombre)) {
    continue;
  }
  if (/^[A-Z]{3}-\\d{2}$/i.test(rawNombre) || rawNombre.startsWith('%')) {
    continue;
  }
  if (rawNombre.includes('TOTAL') || rawNombre.includes('ACTIVO') || rawNombre.includes('FRANCO') || 
      rawNombre.includes('ENFERM') || rawNombre.includes('VACAC') || rawNombre.includes('SUSPEN') || 
      rawNombre.includes('AUSENT') || rawNombre.includes('INGRES') || rawNombre.includes('DIAS')) {
    continue;
  }

  if (!choferesMap.has(rawNombre)) {
    choferesMap.set(rawNombre, {
      nombre: rawNombre.replace(/'/g, "''"),
      legajo: (rawLegajo && rawLegajo !== '-' && /^\\d+$/.test(rawLegajo)) ? rawLegajo : null,
      c_servicio: (rawServicio && rawServicio !== '-') ? rawServicio.replace(/'/g, "''") : 'S/A',
      diagrama_tipo: (rawDiag && rawDiag !== '-') ? rawDiag.replace(/'/g, "''") : null,
      estado: 'inactivo',
      actualizado_el: new Date().toISOString()
    });
  }
}
return Array.from(choferesMap.values()).map(c => ({ json: c }));"""
    },
    "id": "code-chof",
    "name": "2. Filtrar y Normalizar Choferes",
    "type": "n8n-nodes-base.code",
    "typeVersion": 2,
    "position": [768, 272]
  },
  {
    "parameters": {
      "operation": "executeQuery",
      "query": """DO $$
DECLARE
  v_ch_id UUID := NULL;
  v_srv_id UUID := NULL;
  v_srv_name TEXT := TRIM('{{ $json.c_servicio || "" }}');
  v_legajo TEXT := NULLIF(TRIM('{{ $json.legajo || "" }}'), '');
  v_nombre TEXT := TRIM('{{ $json.nombre || "" }}');
BEGIN
  IF v_srv_name <> '' AND v_srv_name <> 'S/A' THEN
    INSERT INTO public.servicios_choferes (denominacion)
    VALUES (v_srv_name)
    ON CONFLICT (denominacion) DO NOTHING;
    
    SELECT id INTO v_srv_id 
    FROM public.servicios_choferes 
    WHERE UPPER(denominacion) = UPPER(v_srv_name) 
    LIMIT 1;
  END IF;

  IF v_legajo IS NOT NULL THEN
    SELECT id INTO v_ch_id FROM public.choferes WHERE legajo = v_legajo LIMIT 1;
  END IF;
  
  IF v_ch_id IS NULL AND v_nombre <> '' THEN
    SELECT id INTO v_ch_id FROM public.choferes WHERE UPPER(nombre) = UPPER(v_nombre) LIMIT 1;
  END IF;

  IF v_ch_id IS NOT NULL THEN
    UPDATE public.choferes
    SET legajo = COALESCE(v_legajo, choferes.legajo),
        servicio_id = COALESCE(v_srv_id, choferes.servicio_id),
        actualizado_el = NOW()
    WHERE id = v_ch_id;
  ELSE
    INSERT INTO public.choferes (nombre, legajo, servicio_id, estado, actualizado_el)
    VALUES (v_nombre, v_legajo, v_srv_id, 'inactivo', NOW());
  END IF;
END $$;"""
    },
    "id": "db-chof",
    "name": "3. Upsert Choferes en Supabase",
    "type": "n8n-nodes-base.postgres",
    "typeVersion": 2.5,
    "position": [1024, 272],
    "credentials": cred_postgres
  },
  {
    "parameters": {
      "jsCode": """const items = $('2. Filtrar y Normalizar Choferes').all();
return [{
  json: {
    estado: '✅ Choferes sincronizados exitosamente',
    total_choferes_procesados: items.length,
    origen: 'Diagramas EOR REV01 (Pestaña mensual)',
    destino: 'public.choferes',
    timestamp: new Date().toISOString()
  }
}];"""
    },
    "id": "rep-chof",
    "name": "📊 Resumen: Lista Choferes",
    "type": "n8n-nodes-base.code",
    "typeVersion": 2,
    "position": [1280, 272]
  },

  # PARTICIÓN 2: TRACTORES
  {
    "parameters": {
      "content": "## 🚜 PARTICIÓN 2: TRACTORES (MOVIMIENTOS)\n- **Origen:** Columna E de Movimientos (Tractor).\n- **Supabase:** `UPSERT` en `public.tractores`.",
      "height": 380,
      "width": 1600,
      "color": 6
    },
    "id": "note-tractores",
    "name": "Nota: Tractores",
    "type": "n8n-nodes-base.stickyNote",
    "typeVersion": 1,
    "position": [-48, 512]
  },
  {
    "parameters": {},
    "id": "trig-manual-trac",
    "name": "▶️ Disparar: Tractores",
    "type": "n8n-nodes-base.manualTrigger",
    "typeVersion": 1,
    "position": [0, 592]
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
    "position": [0, 752],
    "webhookId": "recorte-tractores"
  },
  {
    "parameters": {
      "assignments": {
        "assignments": [
          {"id": "p-sp-trac", "name": "spreadsheetId", "value": "={{ $json.body?.spreadsheetId || $json.spreadsheetId || '" + spreadsheet_id_mov + "' }}", "type": "string"},
          {"id": "p-sh-trac", "name": "sheetName", "value": "={{ $json.body?.sheetName || $json.sheetName || '" + sheet_name_mov + "' }}", "type": "string"},
          {"id": "p-rg-trac", "name": "range", "value": "={{ $json.body?.range || $json.range || '" + range_mov + "' }}", "type": "string"}
        ]
      },
      "options": {}
    },
    "id": "set-config-trac",
    "name": "⚙️ Configuración: Tractores",
    "type": "n8n-nodes-base.set",
    "typeVersion": 3.4,
    "position": [240, 672],
    "notesInFlow": True,
    "notes": "Parámetros individuales para la partición de Tractores."
  },
  {
    "parameters": {
      "authentication": "serviceAccount",
      "operation": "read",
      "documentId": {"__rl": True, "value": "={{ $json.spreadsheetId }}", "mode": "id"},
      "sheetName": {"__rl": True, "value": "={{ $json.sheetName }}", "mode": "name"},
      "options": {}
    },
    "id": "read-sheets-trac",
    "name": "1. Leer Movimientos (Tractores)",
    "type": "n8n-nodes-base.googleSheets",
    "typeVersion": 4.5,
    "position": [512, 672],
    "credentials": cred_google
  },
  {
    "parameters": {
      "jsCode": """const rows = $input.all();
const tractoresMap = new Map();
let currentServicio = 'GENERAL';
const blacklist = new Set(['TRACTOR', 'PATENTE', 'SEMI', 'CISTERNADO', 'NOVEDADES', 'LIVIANO', 'METANOL', 'CAMPO', 'GLP', 'SOCIO', 'SEPTIEMBRE', 'OCTUBRE', 'FECHA', 'N']);

for (const item of rows) {
  const row = item.json;
  const colA = String(row.col_1 || row['0'] || Object.values(row)[0] || '').trim().toUpperCase();
  const colE = String(row.col_5 || row['4'] || Object.values(row)[4] || '').trim().toUpperCase();

  if (colA && ['LIVIANO', 'METANOL', 'CAMPO', 'GLP', 'SOCIO', 'GENERAL', 'DISTRIBUCION'].includes(colA)) {
    currentServicio = colA;
  }

  const rawTractor = colE.replace(/[^A-Z0-9]/g, '');
  if (!rawTractor || rawTractor.length < 5 || rawTractor.length > 8 || blacklist.has(rawTractor)) {
    continue;
  }

  if (!tractoresMap.has(rawTractor)) {
    tractoresMap.set(rawTractor, {
      patente: rawTractor,
      servicio: currentServicio,
      estado: 'disponible',
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
    "position": [768, 672]
  },
  {
    "parameters": {
      "operation": "executeQuery",
      "query": """DO $$
DECLARE
  v_srv_id UUID := NULL;
  v_srv_name TEXT := TRIM('{{ $json.servicio || "" }}');
  v_patente TEXT := TRIM('{{ $json.patente || "" }}');
BEGIN
  IF v_patente = '' THEN
    RETURN;
  END IF;

  IF v_srv_name <> '' THEN
    INSERT INTO public.servicios_unidades (denominacion)
    VALUES (v_srv_name)
    ON CONFLICT (denominacion) DO NOTHING;
    
    SELECT id INTO v_srv_id 
    FROM public.servicios_unidades 
    WHERE UPPER(denominacion) = UPPER(v_srv_name) 
    LIMIT 1;
  END IF;

  INSERT INTO public.tractores (patente, servicio_id, estado, actualizado_el)
  VALUES (v_patente, v_srv_id, 'disponible', NOW())
  ON CONFLICT (patente) 
  DO UPDATE SET 
    servicio_id = COALESCE(v_srv_id, public.tractores.servicio_id),
    actualizado_el = NOW();
END $$;"""
    },
    "id": "db-trac",
    "name": "3. Upsert Tractores en Supabase",
    "type": "n8n-nodes-base.postgres",
    "typeVersion": 2.5,
    "position": [1024, 672],
    "credentials": cred_postgres
  },
  {
    "parameters": {
      "jsCode": """const items = $('2. Filtrar y Normalizar Tractores').all();
return [{
  json: {
    estado: '✅ Tractores sincronizados exitosamente',
    total_tractores_procesados: items.length,
    origen: 'Movimientos (Columna E)',
    destino: 'public.tractores',
    timestamp: new Date().toISOString()
  }
}];"""
    },
    "id": "rep-trac",
    "name": "📊 Resumen: Tractores",
    "type": "n8n-nodes-base.code",
    "typeVersion": 2,
    "position": [1280, 672]
  },

  # PARTICIÓN 3: SEMIS
  {
    "parameters": {
      "content": "## 🛢️ PARTICIÓN 3: SEMIS + CISTERNADO (MOVIMIENTOS)\n- **Origen:** Columnas F (Semi) y D (Cisternado) de Movimientos.\n- **Supabase:** `UPSERT` en `public.semis`.",
      "height": 380,
      "width": 1600,
      "color": 6
    },
    "id": "note-semis",
    "name": "Nota: Semis",
    "type": "n8n-nodes-base.stickyNote",
    "typeVersion": 1,
    "position": [-48, 912]
  },
  {
    "parameters": {},
    "id": "trig-manual-semis",
    "name": "▶️ Disparar: Semis + Cisternado",
    "type": "n8n-nodes-base.manualTrigger",
    "typeVersion": 1,
    "position": [0, 992]
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
    "position": [0, 1152],
    "webhookId": "recorte-semis"
  },
  {
    "parameters": {
      "assignments": {
        "assignments": [
          {"id": "p-sp-semis", "name": "spreadsheetId", "value": "={{ $json.body?.spreadsheetId || $json.spreadsheetId || '" + spreadsheet_id_mov + "' }}", "type": "string"},
          {"id": "p-sh-semis", "name": "sheetName", "value": "={{ $json.body?.sheetName || $json.sheetName || '" + sheet_name_mov + "' }}", "type": "string"},
          {"id": "p-rg-semis", "name": "range", "value": "={{ $json.body?.range || $json.range || '" + range_mov + "' }}", "type": "string"}
        ]
      },
      "options": {}
    },
    "id": "set-config-semis",
    "name": "⚙️ Configuración: Semis",
    "type": "n8n-nodes-base.set",
    "typeVersion": 3.4,
    "position": [240, 1072],
    "notesInFlow": True,
    "notes": "Parámetros individuales para la partición de Semis y Cisternado."
  },
  {
    "parameters": {
      "authentication": "serviceAccount",
      "operation": "read",
      "documentId": {"__rl": True, "value": "={{ $json.spreadsheetId }}", "mode": "id"},
      "sheetName": {"__rl": True, "value": "={{ $json.sheetName }}", "mode": "name"},
      "options": {}
    },
    "id": "read-sheets-semis",
    "name": "1. Leer Movimientos (Semis)",
    "type": "n8n-nodes-base.googleSheets",
    "typeVersion": 4.5,
    "position": [512, 1072],
    "credentials": cred_google
  },
  {
    "parameters": {
      "jsCode": """const rows = $input.all();
const semisMap = new Map();
let currentServicio = 'GENERAL';
const blacklist = new Set(['TRACTOR', 'PATENTE', 'SEMI', 'CISTERNADO', 'NOVEDADES', 'LIVIANO', 'METANOL', 'CAMPO', 'GLP', 'SOCIO', 'SEPTIEMBRE', 'OCTUBRE', 'FECHA', 'N']);

for (const item of rows) {
  const row = item.json;
  const colA = String(row.col_1 || row['0'] || Object.values(row)[0] || '').trim().toUpperCase();
  const colD = String(row.col_4 || row['3'] || Object.values(row)[3] || '').trim();
  const colF = String(row.col_6 || row['5'] || Object.values(row)[5] || '').trim().toUpperCase();

  if (colA && ['LIVIANO', 'METANOL', 'CAMPO', 'GLP', 'SOCIO', 'GENERAL', 'DISTRIBUCION'].includes(colA)) {
    currentServicio = colA;
  }

  const rawSemi = colF.replace(/[^A-Z0-9]/g, '');
  if (!rawSemi || rawSemi.length < 5 || rawSemi.length > 8 || blacklist.has(rawSemi)) {
    continue;
  }

  const rawCisternado = colD && colD !== '-' ? colD.trim() : null;

  if (!semisMap.has(rawSemi)) {
    semisMap.set(rawSemi, {
      patente: rawSemi,
      cisternado: rawCisternado,
      servicio: currentServicio,
      estado: 'disponible',
      actualizado_el: new Date().toISOString()
    });
  } else if (rawCisternado && !semisMap.get(rawSemi).cisternado) {
    semisMap.get(rawSemi).cisternado = rawCisternado;
  }
}
return Array.from(semisMap.values()).map(s => ({ json: s }));"""
    },
    "id": "code-semis",
    "name": "2. Filtrar y Normalizar Semis",
    "type": "n8n-nodes-base.code",
    "typeVersion": 2,
    "position": [768, 1072]
  },
  {
    "parameters": {
      "operation": "executeQuery",
      "query": """DO $$
DECLARE
  v_srv_id UUID := NULL;
  v_srv_name TEXT := TRIM('{{ $json.servicio || "" }}');
  v_patente TEXT := TRIM('{{ $json.patente || "" }}');
  v_cisternado TEXT := NULLIF(TRIM('{{ $json.cisternado || "" }}'), '');
BEGIN
  IF v_patente = '' THEN
    RETURN;
  END IF;

  IF v_srv_name <> '' THEN
    INSERT INTO public.servicios_unidades (denominacion)
    VALUES (v_srv_name)
    ON CONFLICT (denominacion) DO NOTHING;
    
    SELECT id INTO v_srv_id 
    FROM public.servicios_unidades 
    WHERE UPPER(denominacion) = UPPER(v_srv_name) 
    LIMIT 1;
  END IF;

  INSERT INTO public.semis (patente, cisternado, servicio_id, estado, actualizado_el)
  VALUES (v_patente, v_cisternado, v_srv_id, 'disponible', NOW())
  ON CONFLICT (patente) 
  DO UPDATE SET 
    cisternado = COALESCE(v_cisternado, public.semis.cisternado),
    servicio_id = COALESCE(v_srv_id, public.semis.servicio_id),
    actualizado_el = NOW();
END $$;"""
    },
    "id": "db-semis",
    "name": "3. Upsert Semis en Supabase",
    "type": "n8n-nodes-base.postgres",
    "typeVersion": 2.5,
    "position": [1024, 1072],
    "credentials": cred_postgres
  },
  {
    "parameters": {
      "jsCode": """const items = $('2. Filtrar y Normalizar Semis').all();
return [{
  json: {
    estado: '✅ Semis sincronizados exitosamente',
    total_semis_procesados: items.length,
    origen: 'Movimientos (Columnas F y D)',
    destino: 'public.semis',
    timestamp: new Date().toISOString()
  }
}];"""
    },
    "id": "rep-semis",
    "name": "📊 Resumen: Semis",
    "type": "n8n-nodes-base.code",
    "typeVersion": 2,
    "position": [1280, 1072]
  },

  # PARTICIÓN 4: UNIDADES
  {
    "parameters": {
      "content": "## 🚛 PARTICIÓN 4: BUILD LISTA DE UNIDADES (ACOPLE)\n- **Origen:** Columnas C (N° UTE), E (Tractor) y F (Semi) de Movimientos.\n- **Supabase:** Sincronización en `public.unidades`.",
      "height": 380,
      "width": 1600,
      "color": 6
    },
    "id": "note-unidades",
    "name": "Nota: Unidades",
    "type": "n8n-nodes-base.stickyNote",
    "typeVersion": 1,
    "position": [-48, 1312]
  },
  {
    "parameters": {},
    "id": "trig-manual-uni",
    "name": "▶️ Disparar: Build Lista de Unidades",
    "type": "n8n-nodes-base.manualTrigger",
    "typeVersion": 1,
    "position": [0, 1392]
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
    "position": [0, 1552],
    "webhookId": "recorte-unidades"
  },
  {
    "parameters": {
      "assignments": {
        "assignments": [
          {"id": "p-sp-uni", "name": "spreadsheetId", "value": "={{ $json.body?.spreadsheetId || $json.spreadsheetId || '" + spreadsheet_id_mov + "' }}", "type": "string"},
          {"id": "p-sh-uni", "name": "sheetName", "value": "={{ $json.body?.sheetName || $json.sheetName || '" + sheet_name_mov + "' }}", "type": "string"},
          {"id": "p-rg-uni", "name": "range", "value": "={{ $json.body?.range || $json.range || '" + range_mov + "' }}", "type": "string"}
        ]
      },
      "options": {}
    },
    "id": "set-config-uni",
    "name": "⚙️ Configuración: Unidades",
    "type": "n8n-nodes-base.set",
    "typeVersion": 3.4,
    "position": [240, 1472],
    "notesInFlow": True,
    "notes": "Parámetros individuales para el Build de Lista de Unidades."
  },
  {
    "parameters": {
      "authentication": "serviceAccount",
      "operation": "read",
      "documentId": {"__rl": True, "value": "={{ $json.spreadsheetId }}", "mode": "id"},
      "sheetName": {"__rl": True, "value": "={{ $json.sheetName }}", "mode": "name"},
      "options": {}
    },
    "id": "read-sheets-uni",
    "name": "1. Leer Movimientos (Unidades)",
    "type": "n8n-nodes-base.googleSheets",
    "typeVersion": 4.5,
    "position": [512, 1472],
    "credentials": cred_google
  },
  {
    "parameters": {
      "jsCode": """const rows = $input.all();
const unidadesList = [];
let currentServicio = 'GENERAL';
const blacklist = new Set(['TRACTOR', 'PATENTE', 'SEMI', 'CISTERNADO', 'NOVEDADES', 'LIVIANO', 'METANOL', 'CAMPO', 'GLP', 'SOCIO', 'SEPTIEMBRE', 'OCTUBRE', 'FECHA', 'N']);

for (const item of rows) {
  const row = item.json;
  const colA = String(row.col_1 || row['0'] || Object.values(row)[0] || '').trim().toUpperCase();
  const colC = String(row.col_3 || row['2'] || Object.values(row)[2] || '').trim();
  const colE = String(row.col_5 || row['4'] || Object.values(row)[4] || '').trim().toUpperCase();
  const colF = String(row.col_6 || row['5'] || Object.values(row)[5] || '').trim().toUpperCase();

  if (colA && ['LIVIANO', 'METANOL', 'CAMPO', 'GLP', 'SOCIO', 'GENERAL', 'DISTRIBUCION'].includes(colA)) {
    currentServicio = colA;
  }

  const rawTractor = colE.replace(/[^A-Z0-9]/g, '');
  const rawSemi = colF.replace(/[^A-Z0-9]/g, '');

  const validTractor = (rawTractor && rawTractor.length >= 5 && rawTractor.length <= 8 && !blacklist.has(rawTractor)) ? rawTractor : null;
  const validSemi = (rawSemi && rawSemi.length >= 5 && rawSemi.length <= 8 && !blacklist.has(rawSemi)) ? rawSemi : null;

  if (!validTractor && !validSemi) continue;

  const rawUte = colC.replace(/[^0-9]/g, '');
  const nUte = rawUte ? parseInt(rawUte, 10) : null;

  unidadesList.push({
    n_ute: nUte,
    patente_tractor: validTractor,
    patente_semi: validSemi,
    servicio_nombre: currentServicio,
    estado: 'disponible',
    actualizado_el: new Date().toISOString()
  });
}
return unidadesList.map(u => ({ json: u }));"""
    },
    "id": "code-uni",
    "name": "2. Mapear Formaciones (Unidades)",
    "type": "n8n-nodes-base.code",
    "typeVersion": 2,
    "position": [768, 1472]
  },
  {
    "parameters": {
      "operation": "executeQuery",
      "query": """DO $$
DECLARE
  v_trac_id UUID := NULL;
  v_semi_id UUID := NULL;
  v_srv_id UUID := NULL;
  v_unit_id UUID := NULL;
  v_curr_trac UUID := NULL;
  v_curr_semi UUID := NULL;
  v_ute TEXT := NULLIF(TRIM('{{ $json.n_ute || "" }}'), '');
  v_pat_trac TEXT := TRIM('{{ $json.patente_tractor || "" }}');
  v_pat_semi TEXT := TRIM('{{ $json.patente_semi || "" }}');
  v_srv_name TEXT := TRIM('{{ $json.servicio_nombre || "" }}');
BEGIN
  IF v_pat_trac <> '' THEN
    SELECT id INTO v_trac_id FROM public.tractores WHERE UPPER(patente) = UPPER(v_pat_trac) LIMIT 1;
  END IF;

  IF v_pat_semi <> '' THEN
    SELECT id INTO v_semi_id FROM public.semis WHERE UPPER(patente) = UPPER(v_pat_semi) LIMIT 1;
  END IF;

  IF v_srv_name <> '' THEN
    INSERT INTO public.servicios_unidades (denominacion)
    VALUES (v_srv_name)
    ON CONFLICT (denominacion) DO NOTHING;
    
    SELECT id INTO v_srv_id 
    FROM public.servicios_unidades 
    WHERE UPPER(denominacion) = UPPER(v_srv_name) 
    LIMIT 1;
  END IF;

  IF v_trac_id IS NOT NULL THEN
    SELECT id, tractor_id, semi_id INTO v_unit_id, v_curr_trac, v_curr_semi FROM public.unidades WHERE tractor_id = v_trac_id LIMIT 1;
  END IF;

  IF v_unit_id IS NULL AND v_semi_id IS NOT NULL THEN
    SELECT id, tractor_id, semi_id INTO v_unit_id, v_curr_trac, v_curr_semi FROM public.unidades WHERE semi_id = v_semi_id LIMIT 1;
  END IF;

  IF v_unit_id IS NULL AND v_ute IS NOT NULL THEN
    SELECT id, tractor_id, semi_id INTO v_unit_id, v_curr_trac, v_curr_semi FROM public.unidades WHERE n_ute = v_ute LIMIT 1;
  END IF;

  IF v_unit_id IS NOT NULL THEN
    UPDATE public.unidades
    SET n_ute = COALESCE(v_ute, unidades.n_ute),
        tractor_id = COALESCE(v_trac_id, unidades.tractor_id),
        semi_id = COALESCE(v_semi_id, unidades.semi_id),
        servicio_id = COALESCE(v_srv_id, unidades.servicio_id),
        fecha_acople = CASE 
          WHEN (v_trac_id IS DISTINCT FROM v_curr_trac OR v_semi_id IS DISTINCT FROM v_curr_semi) THEN NOW()
          ELSE unidades.fecha_acople 
        END
    WHERE id = v_unit_id;
  ELSE
    INSERT INTO public.unidades (n_ute, tractor_id, semi_id, servicio_id, fecha_acople, estado)
    VALUES (v_ute, v_trac_id, v_semi_id, v_srv_id, NOW(), 'disponible');
  END IF;
END $$;"""
    },
    "id": "db-uni",
    "name": "3. Sincronizar Formaciones en Supabase",
    "type": "n8n-nodes-base.postgres",
    "typeVersion": 2.5,
    "position": [1024, 1472],
    "credentials": cred_postgres
  },
  {
    "parameters": {
      "jsCode": """const items = $('2. Mapear Formaciones (Unidades)').all();
return [{
  json: {
    estado: '✅ Formaciones de unidades sincronizadas',
    total_unidades_procesadas: items.length,
    origen: 'Movimientos (Columnas C, E, F)',
    destino: 'public.unidades (con tractor_id y semi_id)',
    timestamp: new Date().toISOString()
  }
}];"""
    },
    "id": "rep-uni",
    "name": "📊 Resumen: Lista de Unidades",
    "type": "n8n-nodes-base.code",
    "typeVersion": 2,
    "position": [1280, 1472]
  },

  # PARTICIÓN 5: DÍAS DIAGRAMA (OPERATIVAS DIARIAS)
  {
    "parameters": {
      "content": "## 📅 PARTICIÓN 5: DÍAS DIAGRAMA (OPERATIVAS DIARIAS - DIAGRAMAS EOR)\n- **Origen:** Pestaña mensual activa (`Oct-26`), cabecera en fila 5 (`1-10..31-10`) y choferes desde fila 6.\n- **Motor:** Mapeo de calendario ISO + Contabilizador canónico de turnos trabajados, francos, vacaciones y ausencias.\n- **Supabase:** `UPSERT` en `public.diagramas` (matriz JSONB y métricas) y actualización de contabilizador en `public.choferes`.",
      "height": 380,
      "width": 1600,
      "color": 5
    },
    "id": "note-dias",
    "name": "Nota: Días Diagrama",
    "type": "n8n-nodes-base.stickyNote",
    "typeVersion": 1,
    "position": [-48, 1712]
  },
  {
    "parameters": {},
    "id": "trig-manual-dias",
    "name": "▶️ Disparar: Días Diagrama",
    "type": "n8n-nodes-base.manualTrigger",
    "typeVersion": 1,
    "position": [0, 1792]
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
    "position": [0, 1952],
    "webhookId": "operativa-dias-diagrama"
  },
  {
    "parameters": {
      "assignments": {
        "assignments": [
          {"id": "p-sp-dias", "name": "spreadsheetId", "value": spreadsheet_id_diag, "type": "string"},
          {"id": "p-sh-dias", "name": "sheetName", "value": "={{ $json.body?.sheetName || $json.sheetName || 'Oct-26' }}", "type": "string"},
          {"id": "p-rg-dias", "name": "range", "value": "={{ $json.body?.range || $json.range || 'A5:AN350' }}", "type": "string"},
          {"id": "p-an-dias", "name": "anio", "value": "={{ $json.body?.anio || $json.anio || 2026 }}", "type": "number"}
        ]
      },
      "options": {}
    },
    "id": "set-config-dias",
    "name": "⚙️ Configuración: Días Diagrama",
    "type": "n8n-nodes-base.set",
    "typeVersion": 3.4,
    "position": [240, 1872],
    "notesInFlow": True,
    "notes": "Planilla Diagramas EOR (cambio anual de ID, pestaña mensual activa)."
  },
  {
    "parameters": {
      "authentication": "serviceAccount",
      "operation": "read",
      "documentId": {"__rl": True, "value": "={{ $json.spreadsheetId }}", "mode": "id"},
      "sheetName": {"__rl": True, "value": "={{ $json.sheetName }}", "mode": "name"},
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
    "position": [512, 1872],
    "credentials": cred_google
  },
  {
    "parameters": {
      "jsCode": js_code_dias
    },
    "id": "code-dias",
    "name": "2. Normalizar Calendario y Contabilizador",
    "type": "n8n-nodes-base.code",
    "typeVersion": 2,
    "position": [768, 1872]
  },
  {
    "parameters": {
      "operation": "executeQuery",
      "query": """DO $$
DECLARE
  v_chofer_id UUID := NULL;
  v_diag_id UUID := NULL;
  v_srv_id UUID := NULL;
  v_legajo TEXT := NULLIF(TRIM('{{ $json.legajo || "" }}'), '');
  v_nombre TEXT := TRIM('{{ $json.chofer_nombre || "" }}');
  v_srv_name TEXT := TRIM('{{ $json.servicio || "" }}');
  v_diag_tipo TEXT := NULLIF(TRIM('{{ $json.diagrama_tipo || "" }}'), '');
  v_dias JSONB := '{{ $json.dias_json_str }}'::jsonb;
  v_contabilizador JSONB := '{{ $json.contabilizador_json_str }}'::jsonb;
BEGIN
  IF v_legajo IS NOT NULL THEN
    SELECT id INTO v_chofer_id FROM public.choferes WHERE legajo = v_legajo LIMIT 1;
  END IF;

  IF v_chofer_id IS NULL AND v_nombre <> '' THEN
    SELECT id INTO v_chofer_id FROM public.choferes WHERE UPPER(nombre) = UPPER(v_nombre) LIMIT 1;
  END IF;

  IF v_chofer_id IS NULL AND v_nombre <> '' THEN
    IF v_srv_name <> '' AND v_srv_name <> 'S/A' THEN
      INSERT INTO public.servicios_choferes (denominacion)
      VALUES (v_srv_name)
      ON CONFLICT (denominacion) DO NOTHING;
      SELECT id INTO v_srv_id FROM public.servicios_choferes WHERE UPPER(denominacion) = UPPER(v_srv_name) LIMIT 1;
    END IF;

    INSERT INTO public.choferes (nombre, legajo, servicio_id, estado, actualizado_el)
    VALUES (v_nombre, v_legajo, v_srv_id, 'inactivo', NOW())
    RETURNING id INTO v_chofer_id;
  END IF;

  IF v_chofer_id IS NOT NULL THEN
    SELECT id INTO v_diag_id 
    FROM public.diagramas 
    WHERE chofer_id = v_chofer_id AND mes_tab = '{{ $json.mes_tab }}' 
    LIMIT 1;

    IF v_diag_id IS NOT NULL THEN
      UPDATE public.diagramas
      SET diagrama_tipo = COALESCE(v_diag_tipo, public.diagramas.diagrama_tipo),
          anio = {{ $json.anio }},
          mes_numero = {{ $json.mes_numero }},
          dias = v_dias,
          tira_dias = '{{ $json.tira_dias }}',
          contabilizador = v_contabilizador,
          actualizado_el = NOW()
      WHERE id = v_diag_id;
    ELSE
      INSERT INTO public.diagramas (
        chofer_id,
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
        v_diag_tipo,
        '{{ $json.mes_tab }}',
        {{ $json.anio }},
        {{ $json.mes_numero }},
        v_dias,
        '{{ $json.tira_dias }}',
        v_contabilizador,
        NOW()
      );
    END IF;
  END IF;
END $$;"""
    },
    "id": "db-dias",
    "name": "3. Upsert en public.diagramas y Choferes",
    "type": "n8n-nodes-base.postgres",
    "typeVersion": 2.5,
    "position": [1024, 1872],
    "credentials": cred_postgres
  },
  {
    "parameters": {
      "jsCode": """const normalizedItems = $('2. Normalizar Calendario y Contabilizador').all();
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
    "position": [1280, 1872]
  }
]

# Conexiones
connections = {
  "🌐 Disparar Todo: Bases Organización": {
    "main": [
      [
        {"node": "⚙️ Configuración: Choferes", "type": "main", "index": 0},
        {"node": "⚙️ Configuración: Tractores", "type": "main", "index": 0},
        {"node": "⚙️ Configuración: Semis", "type": "main", "index": 0},
        {"node": "⚙️ Configuración: Unidades", "type": "main", "index": 0},
        {"node": "⚙️ Configuración: Días Diagrama", "type": "main", "index": 0}
      ]
    ]
  },
  "▶️ Disparar: Choferes": {
    "main": [[{"node": "⚙️ Configuración: Choferes", "type": "main", "index": 0}]]
  },
  "⚡ Webhook: Choferes (Diagramas)": {
    "main": [[{"node": "⚙️ Configuración: Choferes", "type": "main", "index": 0}]]
  },
  "⚙️ Configuración: Choferes": {
    "main": [[{"node": "1. Leer Diagramas (Choferes Mes)", "type": "main", "index": 0}]]
  },
  "1. Leer Diagramas (Choferes Mes)": {
    "main": [[{"node": "2. Filtrar y Normalizar Choferes", "type": "main", "index": 0}]]
  },
  "2. Filtrar y Normalizar Choferes": {
    "main": [[{"node": "3. Upsert Choferes en Supabase", "type": "main", "index": 0}]]
  },
  "3. Upsert Choferes en Supabase": {
    "main": [[{"node": "📊 Resumen: Lista Choferes", "type": "main", "index": 0}]]
  },
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
  },
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
}

unified_workflow = {
  "name": "Bases Organización (Choferes, Tractores, Semis, Unidades, Días)",
  "nodes": nodes,
  "connections": connections,
  "settings": {
    "executionOrder": "v1"
  }
}

# Guardar archivo físico
with open(wf_file, 'w', encoding='utf-8') as f:
    json.dump(unified_workflow, f, indent=2, ensure_ascii=False)
print("Saved 5-partition workflow to file:", wf_file)

# Actualizar en base de datos SQLite de n8n
con = sqlite3.connect(db_path)
cur = con.cursor()

wf_id = 'basesOrgTractores01'
wf_name = unified_workflow['name']
nodes_json = json.dumps(unified_workflow['nodes'])
connections_json = json.dumps(unified_workflow['connections'])
settings_json = json.dumps(unified_workflow.get('settings', {}))
now_str = datetime.now().strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]
ver_id = str(uuid.uuid4())

cur.execute("""
    UPDATE workflow_entity 
    SET name = ?, nodes = ?, connections = ?, settings = ?, updatedAt = ?, versionId = ?
    WHERE id = ?
""", (wf_name, nodes_json, connections_json, settings_json, now_str, ver_id, wf_id))

con.commit()
con.close()
print("Workflow 'basesOrgTractores01' successfully updated in SQLite with dataLocationOnSheet fixed!")
