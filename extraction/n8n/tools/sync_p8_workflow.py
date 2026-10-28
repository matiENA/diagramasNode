import sqlite3
import json
import sys

sys.stdout.reconfigure(encoding='utf-8')

db_path = r'C:\Users\Matias Rodriguez\.n8n\database.sqlite'
json_path = r'C:\Users\Matias Rodriguez\Documents\eor_v1\extraction\n8n\workflows\bases_organizacion_tractores.json'

conn = sqlite3.connect(db_path)
c = conn.cursor()
row = c.execute('SELECT id, name, active, nodes, connections, settings, staticData FROM workflow_entity WHERE id = ?', ('basesOrgTractores01',)).fetchone()

if not row:
    print("Workflow not found!")
    sys.exit(1)

wf_id, name, active, nodes_raw, conn_raw, settings_raw, static_raw = row
nodes = json.loads(nodes_raw)
connections = json.loads(conn_raw)

# Actualizar el nodo de Configuración de Sync Queue para incluir la URL del microservicio de Render
for n in nodes:
    if n['name'] == '⚙️ Configuración: Sync Queue (Impresión a Sheets)':
        for a in n.get('parameters', {}).get('assignments', {}).get('assignments', []):
            if a.get('name') == 'apiUrl':
                a['value'] = "={{ $json.body?.apiUrl || $json.apiUrl || 'https://eor-sync-worker.onrender.com/api/sync/run' }}"
                print("Updated apiUrl in config node")
    
    if n['name'] == '2. Consumir Cola e Imprimir en Sheets (Worker)':
        # Actualizar ruta local a eor_v1/apps/backend con fallback
        n['parameters']['command'] = '=cd /d "C:\\Users\\Matias Rodriguez\\Documents\\eor_v1\\apps\\backend" && node sync/syncQueueConsumer.js --limit={{ $(\'⚙️ Configuración: Sync Queue (Impresión a Sheets)\').first().json.batchLimit || 50 }} {{ $(\'⚙️ Configuración: Sync Queue (Impresión a Sheets)\').first().json.dryRun ? \'--dry-run\' : \'\' }}'
        print("Updated executeCommand node path")

# Guardar en SQLite
new_nodes_raw = json.dumps(nodes, ensure_ascii=False)
c.execute('UPDATE workflow_entity SET nodes = ?, updatedAt = datetime(\'now\') WHERE id = ?', (new_nodes_raw, 'basesOrgTractores01'))
conn.commit()
print("Committed update to n8n database.sqlite")

# Exportar a bases_organizacion_tractores.json sincronizado
full_wf = {
    "name": name,
    "nodes": nodes,
    "connections": connections,
    "active": bool(active),
    "settings": json.loads(settings_raw) if settings_raw else {},
    "staticData": json.loads(static_raw) if static_raw else None
}

with open(json_path, 'w', encoding='utf-8') as f:
    json.dump(full_wf, f, indent=2, ensure_ascii=False)

print(f"Exported synchronized workflow to {json_path}")
conn.close()
