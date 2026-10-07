import sqlite3
import json
import uuid
import sys
from datetime import datetime

sys.stdout.reconfigure(encoding='utf-8')

db_path = r'C:\Users\Matias Rodriguez\.n8n\database.sqlite'
wf_file = r'c:\Users\Matias Rodriguez\Documents\server_local\n8n\workflows\bases_organizacion_tractores.json'

spreadsheet_id_diag = "1mhfXpFCF6upMlnRnZjDdBVS_wqTx5q8v0qQArNCnNAU"
sheet_name_diag = "Oct-26"
range_diag_chof = "A6:D350"
range_diag_dias = "A5:AN350"

spreadsheet_id_mov = "14Mb5rD853zxDkaLDS-IrW-OBDTDBjuJxn_3olXeWlkc"
sheet_name_mov = "OCTUBRE 2026- Mov.Unidades y Choferes"
range_mov = "A1:F350"

# Nuevas consultas SQL adaptadas al esquema normalizado de Supabase

sql_choferes = """DO $$
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

sql_tractores = """DO $$
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

sql_semis = """DO $$
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

sql_unidades = """DO $$
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

sql_dias = """DO $$
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

def update_workflow():
    print("🔄 Conectando a la base SQLite de n8n...")
    con = sqlite3.connect(db_path)
    cur = con.cursor()

    wf_id = 'basesOrgTractores01'
    row = cur.execute("SELECT id, name, nodes, connections, settings FROM workflow_entity WHERE id = ?", (wf_id,)).fetchone()
    if not row:
        print(f"❌ Error: No se encontró el workflow {wf_id} en {db_path}")
        con.close()
        sys.exit(1)

    wf_id, wf_name, nodes_json, connections_json, settings_json = row
    nodes = json.loads(nodes_json)
    connections = json.loads(connections_json)
    settings = json.loads(settings_json) if settings_json else {}

    print(f"✅ Workflow '{wf_name}' cargado. Nodos: {len(nodes)}")

    # Backup previo en SQLite
    cur.execute("CREATE TABLE IF NOT EXISTS workflow_entity_backup AS SELECT * FROM workflow_entity WHERE 1=0;")
    now_str = datetime.now().strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]
    cur.execute("INSERT OR REPLACE INTO workflow_entity_backup SELECT * FROM workflow_entity WHERE id = ?", (wf_id,))
    print(f"💾 Backup de seguridad creado en tabla 'workflow_entity_backup'.")

    # Modificar nodos específicos
    updated_nodes_count = 0
    for n in nodes:
        name = n.get('name', '')
        
        # 1. Choferes
        if name == '⚙️ Configuración: Choferes':
            n['parameters']['assignments']['assignments'] = [
                {"id": "p-sp-chof", "name": "spreadsheetId", "value": f"={{{{ $json.body?.spreadsheetId || $json.spreadsheetId || '{spreadsheet_id_diag}' }}}}", "type": "string"},
                {"id": "p-sh-chof", "name": "sheetName", "value": f"={{{{ $json.body?.sheetName || $json.sheetName || '{sheet_name_diag}' }}}}", "type": "string"},
                {"id": "p-rg-chof", "name": "range", "value": f"={{{{ $json.body?.range || $json.range || '{range_diag_chof}' }}}}", "type": "string"}
            ]
            updated_nodes_count += 1
            print("  • Nodo ajustado: ⚙️ Configuración: Choferes (dinámico)")
        elif name == '3. Upsert Choferes en Supabase':
            n['parameters']['query'] = sql_choferes
            updated_nodes_count += 1
            print("  • Nodo ajustado: 3. Upsert Choferes en Supabase (PL/pgSQL relacional)")

        # 2. Tractores
        elif name == '⚙️ Configuración: Tractores':
            n['parameters']['assignments']['assignments'] = [
                {"id": "p-sp-trac", "name": "spreadsheetId", "value": f"={{{{ $json.body?.spreadsheetId || $json.spreadsheetId || '{spreadsheet_id_mov}' }}}}", "type": "string"},
                {"id": "p-sh-trac", "name": "sheetName", "value": f"={{{{ $json.body?.sheetName || $json.sheetName || '{sheet_name_mov}' }}}}", "type": "string"},
                {"id": "p-rg-trac", "name": "range", "value": f"={{{{ $json.body?.range || $json.range || '{range_mov}' }}}}", "type": "string"}
            ]
            updated_nodes_count += 1
            print("  • Nodo ajustado: ⚙️ Configuración: Tractores (dinámico)")
        elif name == '3. Upsert Tractores en Supabase':
            n['parameters']['query'] = sql_tractores
            updated_nodes_count += 1
            print("  • Nodo ajustado: 3. Upsert Tractores en Supabase (PL/pgSQL relacional + servicio_id)")

        # 3. Semis
        elif name == '⚙️ Configuración: Semis':
            n['parameters']['assignments']['assignments'] = [
                {"id": "p-sp-semis", "name": "spreadsheetId", "value": f"={{{{ $json.body?.spreadsheetId || $json.spreadsheetId || '{spreadsheet_id_mov}' }}}}", "type": "string"},
                {"id": "p-sh-semis", "name": "sheetName", "value": f"={{{{ $json.body?.sheetName || $json.sheetName || '{sheet_name_mov}' }}}}", "type": "string"},
                {"id": "p-rg-semis", "name": "range", "value": f"={{{{ $json.body?.range || $json.range || '{range_mov}' }}}}", "type": "string"}
            ]
            updated_nodes_count += 1
            print("  • Nodo ajustado: ⚙️ Configuración: Semis (dinámico)")
        elif name == '3. Upsert Semis en Supabase':
            n['parameters']['query'] = sql_semis
            updated_nodes_count += 1
            print("  • Nodo ajustado: 3. Upsert Semis en Supabase (PL/pgSQL relacional + servicio_id)")

        # 4. Unidades
        elif name == '⚙️ Configuración: Unidades':
            n['parameters']['assignments']['assignments'] = [
                {"id": "p-sp-uni", "name": "spreadsheetId", "value": f"={{{{ $json.body?.spreadsheetId || $json.spreadsheetId || '{spreadsheet_id_mov}' }}}}", "type": "string"},
                {"id": "p-sh-uni", "name": "sheetName", "value": f"={{{{ $json.body?.sheetName || $json.sheetName || '{sheet_name_mov}' }}}}", "type": "string"},
                {"id": "p-rg-uni", "name": "range", "value": f"={{{{ $json.body?.range || $json.range || '{range_mov}' }}}}", "type": "string"}
            ]
            updated_nodes_count += 1
            print("  • Nodo ajustado: ⚙️ Configuración: Unidades (dinámico)")
        elif name == '3. Sincronizar Formaciones en Supabase':
            n['parameters']['query'] = sql_unidades
            updated_nodes_count += 1
            print("  • Nodo ajustado: 3. Sincronizar Formaciones en Supabase (PL/pgSQL relacional sin actualizado_el)")

        # 5. Días Diagrama
        elif name == '⚙️ Configuración: Días Diagrama':
            n['parameters']['assignments']['assignments'] = [
                {"id": "p-sp-dias", "name": "spreadsheetId", "value": f"={{{{ $json.body?.spreadsheetId || $json.spreadsheetId || '{spreadsheet_id_diag}' }}}}", "type": "string"},
                {"id": "p-sh-dias", "name": "sheetName", "value": f"={{{{ $json.body?.sheetName || $json.sheetName || '{sheet_name_diag}' }}}}", "type": "string"},
                {"id": "p-rg-dias", "name": "range", "value": f"={{{{ $json.body?.range || $json.range || '{range_diag_dias}' }}}}", "type": "string"},
                {"id": "p-an-dias", "name": "anio", "value": "={{ $json.body?.anio || $json.anio || 2026 }}", "type": "number"}
            ]
            updated_nodes_count += 1
            print("  • Nodo ajustado: ⚙️ Configuración: Días Diagrama (dinámico)")
        elif name == '3. Upsert en public.diagramas y Choferes':
            n['parameters']['query'] = sql_dias
            updated_nodes_count += 1
            print("  • Nodo ajustado: 3. Upsert en public.diagramas y Choferes (PL/pgSQL relacional por chofer_id y mes_tab)")

    print(f"\n📊 Total de nodos modificados: {updated_nodes_count}/10")

    # Guardar en archivo JSON
    new_wf_data = {
        "name": wf_name,
        "nodes": nodes,
        "connections": connections,
        "settings": settings
    }

    with open(wf_file, 'w', encoding='utf-8') as f:
        json.dump(new_wf_data, f, indent=2, ensure_ascii=False)
    print(f"📁 Archivo JSON guardado exitosamente en: {wf_file}")

    # Guardar en SQLite de n8n
    ver_id = str(uuid.uuid4())
    nodes_json_new = json.dumps(nodes)
    connections_json_new = json.dumps(connections)
    settings_json_new = json.dumps(settings)

    cur.execute("""
        UPDATE workflow_entity 
        SET nodes = ?, connections = ?, settings = ?, updatedAt = ?, versionId = ?
        WHERE id = ?
    """, (nodes_json_new, connections_json_new, settings_json_new, now_str, ver_id, wf_id))

    con.commit()
    con.close()
    print(f"🚀 Base de datos SQLite de n8n actualizada con éxito para '{wf_id}'.")

if __name__ == '__main__':
    update_workflow()
