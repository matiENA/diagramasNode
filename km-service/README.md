# 🚗 Microservicio de Extracción de Kilómetros

Microservicio desacoplado y autónomo diseñado para particionar la memoria RAM del sistema **Diagramas EOR**. Su función exclusiva es extraer, indexar y servir los datos de la planilla Google Sheet de Kilómetros (`1Wr-_P4mDvldif_cAx08sp7yT8uTUrajI2HQAJF6tnGM` hoja `'KM'`).

---

## 🎯 Beneficios de la Arquitectura
1. **Partición de RAM**: El servidor principal (`https://diagramas-hp1p.onrender.com/`) ya no gasta memoria descargando ni parseando decenas de miles de filas crudas.
2. **Índice Hot & Cold**:
   - **Hot (12 meses)**: Se mantiene en RAM para vinculación inmediata como subnodos a los choferes del diagrama.
   - **Cold (Histórico completo)**: Indexado en memoria por chofer para consultas históricas instantáneas O(1).
3. **Resiliencia Total**: Si este microservicio estuviera temporalmente inactivo, el servidor principal recurre automáticamente a su extractor de respaldo.

---

## 📡 Endpoints de la API

| Método | Endpoint | Descripción |
|---|---|---|
| `GET` | `/health` | Chequeo de salud, memoria RAM usada, choferes y viajes activos. |
| `GET` | `/api/km/viajes` | Catálogo de viajes de los últimos 12 meses (consumido por la RAM principal). |
| `GET` | `/api/km/viajes/:chofer` | Viajes activos de un chofer en particular. |
| `GET` | `/api/km/historial` | Consulta histórica sobre demanda con query params `chofer`, `desde`, `hasta`. |
| `POST` | `/api/km/hoja-ruta` | Registra/actualiza hojas de ruta en memoria y en Google Sheets. |
| `POST` | `/api/km/sync` | Dispara una re-extracción manual inmediata en segundo plano. |
| `GET` | `/api/km/stats` | Métricas detalladas del servicio. |

---

## 🚀 Despliegue en Render (2 minutos)

1. En el dashboard de **Render**, haz clic en **New +** -> **Web Service**.
2. Conecta el repositorio: `matiENA/diagramasNode`.
3. Configuración del servicio:
   - **Name**: `km-extractor-service` (o el nombre que elijas)
   - **Root Directory**: `km-service`  *(¡Importante!)*
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Instance Type**: `Free`
4. En **Environment Variables**, añade:
   - `GOOGLE_SERVICE_ACCOUNT_EMAIL`: (mismo valor que en el backend principal)
   - `GOOGLE_PRIVATE_KEY`: (mismo valor que en el backend principal)
   - `MAIN_BACKEND_URL`: `https://diagramas-hp1p.onrender.com`
5. Crea el servicio y copia la URL generada (ej. `https://km-extractor-service.onrender.com`).
6. En el backend principal (`diagramas-hp1p.onrender.com`), añade en sus Environment Variables:
   - `KM_SERVICE_URL`: `https://km-extractor-service.onrender.com`

¡Listo! A partir de ese momento, la RAM de kilómetros se particiona automáticamente.
