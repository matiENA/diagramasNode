import sqlite3
import json
import uuid
from datetime import datetime

db_path = r'C:\Users\Matias Rodriguez\.n8n\database.sqlite'
wf_file = r'c:\Users\Matias Rodriguez\Documents\server_local\n8n\workflows\bases_organizacion_semis.json'

with open(wf_file, 'r', encoding='utf-8') as f:
    wf_data = json.load(f)

con = sqlite3.connect(db_path)
cur = con.cursor()

# Get default project ID
proj_row = cur.execute("SELECT projectId FROM shared_workflow LIMIT 1").fetchone()
project_id = proj_row[0] if proj_row else 'EuTGb5j6v4AsAbVt'

wf_id = 'basesOrgSemis01'
wf_name = wf_data['name']
nodes_json = json.dumps(wf_data['nodes'])
connections_json = json.dumps(wf_data['connections'])
settings_json = json.dumps(wf_data.get('settings', {}))
now_str = datetime.now().strftime('%Y-%m-%d %H:%M:%S.%f')[:-3]
ver_id = str(uuid.uuid4())

# Check if exists
existing = cur.execute("SELECT id FROM workflow_entity WHERE id = ?", (wf_id,)).fetchone()
if existing:
    cur.execute("""
        UPDATE workflow_entity 
        SET name = ?, nodes = ?, connections = ?, settings = ?, updatedAt = ?, versionId = ?
        WHERE id = ?
    """, (wf_name, nodes_json, connections_json, settings_json, now_str, ver_id, wf_id))
    print(f"Updated existing workflow: {wf_id}")
else:
    cur.execute("""
        INSERT INTO workflow_entity (id, name, active, nodes, connections, settings, versionId, versionCounter, createdAt, updatedAt)
        VALUES (?, ?, 0, ?, ?, ?, ?, 1, ?, ?)
    """, (wf_id, wf_name, nodes_json, connections_json, settings_json, ver_id, now_str, now_str))
    print(f"Inserted new workflow: {wf_id}")

# Ensure shared_workflow entry
sh_exist = cur.execute("SELECT workflowId FROM shared_workflow WHERE workflowId = ?", (wf_id,)).fetchone()
if not sh_exist:
    cur.execute("""
        INSERT INTO shared_workflow (workflowId, projectId, role, createdAt, updatedAt)
        VALUES (?, ?, 'workflow:owner', ?, ?)
    """, (wf_id, project_id, now_str, now_str))
    print(f"Linked shared_workflow for project {project_id}")

con.commit()
con.close()
print("Workflow registration for Semis completed successfully.")
