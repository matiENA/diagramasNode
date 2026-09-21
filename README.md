# 🚀 Diagramas EOR — Backend Híbrido de Alto Rendimiento

Backend central desacoplado y optimizado para la gestión operativa, diagramas, asignación de unidades, choferes y novedades en tiempo real. 

Diseñado específicamente para operar con **alta eficiencia y baja huella de memoria RAM** en infraestructuras cloud con recursos acotados (como instancias de 512 MB en Render o contenedores Docker ligeros).

---

## 🏗️ Arquitectura General del Sistema

El sistema utiliza una arquitectura **híbrida y distribuida** compuesta por:

1. **Backend Principal (`diagramasnode` - Puerto 3000)**:
   - Servidor HTTP Express con compresión de respuestas (`compression`).
   - Servidor WebSocket en tiempo real con **Socket.io** (con namespace dedicado `/dash` para eventos ligeros).
   - Motor de caché reactivo en RAM (`cache/builder.js`) para lecturas ultrarrápidas $O(1)$.
   - Conector nativo de base de datos **PostgreSQL (`pg` / node-postgres)** con connection pool restringido.
   - Módulos de sincronización con Google Sheets (Master, Movimientos, Novedades, Estados).

2. **Microservicio Aislado de Kilómetros (`km-service/` - Puerto 3001)**:
   - Proceso Node.js independiente cuya única responsabilidad es descargar, procesar e indexar la planilla masiva de Kilómetros.
   - **Ahorro de RAM**: Alivia más de **100 MB de memoria RAM** del backend principal.
   - Provee índices *Hot* (últimos 12 meses para vincular a choferes) y *Cold* (consultas históricas bajo demanda).

3. **Capa de Persistencia y Bases de Datos**:
   - **PostgreSQL (`pg`)**: Consultas transaccionales y de autenticación de alta velocidad con consumo mínimo de RAM (~1.2 MB de Heap).
   - **Supabase REST (Fallback)**: Mecanismo de respaldo automático en caso de no disponer de cadena de conexión directa.
   - **Google Sheets API v4**: Fuente de datos operativa para hojas de ruta, aptos médicos, observaciones e ingresos de personal.

```mermaid
flowchart TD
    ClientFrontend[💻 Frontend / PWA / Dash] -->|HTTP / WebSockets| MainBackend[⚡ Backend Principal - Puerto 3000]
    
    subgraph RAM_Optimization[Ecosistema de Memoria Optimizada]
        MainBackend -->|Consultas SQL ultraligeras| PGClient[(🐘 PostgreSQL via pg Pool)]
        MainBackend -->|Fallback REST| SupabaseAPI[(☁️ Supabase REST)]
        MainBackend -->|Bajo demanda / API REST| KMService[🚗 Microservicio KM - Puerto 3001]
        MainBackend -->|Sync / Webhooks| GoogleSheets[(📊 Google Sheets API)]
        KMService -->|Indexación exclusiva| SheetKM[(📄 Planilla KM)]
    end
```

---

## ⚡ Estrategias de Reducción y Control de RAM

| Estrategia | Implementación | Beneficio de Memoria |
|---|---|---|
| **Cliente PostgreSQL Nativo (`pg`)** | Pool singleton configurado en [utils/db.js](file:///c:/Users/Matias%20Rodriguez/Desktop/jAVI/diagramas/diagramasnode/utils/db.js) | Huella de solo **~1.25 MB de Heap**, evitando el peso de ORMs (>100 MB). |
| **Connection Pooling Restringido** | `max: 5`, `idleTimeoutMillis: 10000`, `maxUses: 7500` | Evita saturar sockets de red y recicla clientes para forzar limpieza del Garbage Collector. |
| **Partición de Microservicio** | `km-service/` desacoplado | El parseo de arrays gigantes de 50.000 filas ocurre en un proceso separado. |
| **Caché Reactivo Compartido** | `cacheDatosGlobales` en RAM | Todas las rutas de lectura leen del mismo puntero sin duplicar copias en memoria. |
| **Compresión Gzip en Tránsito** | `app.use(compression())` | Reduce el tamaño de los payloads JSON transmitidos hasta en un 80%. |
| **Payloads de Socket.io Reducidos** | Exclusión de historiales pesados en el broadcast | Solo se emite la estructura viva del diagrama; los historiales se piden bajo demanda. |

---

## 📁 Estructura del Repositorio

```text
├── cache/
│   └── builder.js          # Polling y construcción del árbol de caché global en RAM
├── km-service/             # Microservicio desacoplado de kilómetros
│   ├── server.js           # Servidor independiente de km-service (puerto 3001)
│   └── package.json        # Dependencias exclusivas del microservicio
├── routes/
│   ├── auth.js             # Login híbrido (Google Sheets -> PostgreSQL pg -> Supabase)
│   ├── dash.js             # API ultra ligera para el panel DASH (flota y usuarios)
│   ├── fotos.js            # Carga y vinculación de fotos a ImgBB
│   └── proxy.js            # Escritura bidireccional hacia Google Sheets
├── scripts/
│   ├── test-pg-ram.js      # Medición de huella de memoria RAM y parámetros del pool pg
│   ├── test-ram-local.js   # Diagnóstico de puertos 3000/3001 y estado de conexiones
│   └── test-integration-local.js # Prueba de integración del endpoint /api/db/status
├── utils/
│   ├── db.js               # Pool y cliente centralizado de PostgreSQL optimizado
│   ├── kmClient.js         # Cliente HTTP hacia la partición de microservicio KM
│   └── shared.js           # Autenticación Google Sheets, fechas y constantes
├── bot/                    # Asistente conversacional con IA Gemini (entorno local)
├── server.js               # Servidor principal Express + Socket.IO
├── render.yaml             # Blueprint de despliegue multi-servicio en Render
└── package.json            # Configuración y scripts del proyecto principal
```

---

## 📡 Endpoints de la API Principal

### Diagnóstico, Salud y Métricas
- `GET /health`: Estado HTTP 200 rápido del servidor principal.
- `GET /api/db/status`: **(Nuevo)** Reporte en vivo del cliente `pg`, parámetros del pool, latencia de base de datos y uso exacto de memoria RAM (`heapUsed`, `heapTotal`, `rss`).
- `GET /api/km/status`: Estado de enlace con el microservicio de kilómetros (local o nube).
- `GET /api/datos`: Entrega el árbol completo de diagramas, unidades y choferes desde la memoria RAM.

### Autenticación y Usuarios
- `POST /api/auth/login`: Validación de credenciales en cascada:
  1. Hoja `'DB_Usuarios'` en Google Sheets.
  2. Consulta SQL optimizada en PostgreSQL vía `pg` (`SELECT id, usuario, rol FROM usuarios_auth ...`).
  3. Fallback a cliente Supabase REST.

### Consultas Históricas y Operación
- `GET /api/viajes/historial`: Consulta histórica de viajes (prioridad: RAM $\rightarrow$ Microservicio KM $\rightarrow$ Cold Storage en Sheets).
- `POST /api/webhook/km-updated`: Webhook que recibe pings del microservicio cuando se actualizan kilómetros.
- `POST /api/webhook`: Inyección reactiva de cambios directos desde Google Apps Script.
- `POST /api/proxy/observacion`: Escritura de observaciones operativas en las planillas.
- `POST /api/proxy/estado-chofer`: Actualización en vivo del estado de un chofer en la planilla maestra.
- `POST /api/subir-foto`: Carga de imagen a ImgBB y sincronización con el legajo del chofer.

---

## ⚙️ Variables de Entorno (`.env`)

Copia `.env.example` a `.env` y configura los valores correspondientes:

```env
PORT=3000

# ==============================================================
# 🐘 POSTGRESQL NATIVO (pg / node-postgres)
# ==============================================================
# Cadena de conexión directa o Pooler (ej. Supabase Transaction Pooler en puerto 6543)
DATABASE_URL=postgresql://postgres:[PASSWORD]@[HOST]:6543/postgres?pgbouncer=true
PG_MAX_CONNECTIONS=5
PG_IDLE_TIMEOUT=10000

# ==============================================================
# ☁️ SUPABASE (Fallback REST)
# ==============================================================
SUPABASE_URL=https://tu-proyecto.supabase.co
SUPABASE_KEY=tu-anon-o-service-key

# ==============================================================
# 🚗 PARTICIÓN DE RAM: MICROSERVICIO DE KILÓMETROS
# ==============================================================
# En local: http://localhost:3001 | En producción: URL de Render
KM_SERVICE_URL=http://localhost:3001

# ==============================================================
# 📊 GOOGLE CLOUD SERVICE ACCOUNT & SPREADSHEETS
# ==============================================================
GOOGLE_SERVICE_ACCOUNT_EMAIL=tu-cuenta@iam.gserviceaccount.com
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
SPREADSHEET_ID=1eQ9Y5diL5fwxYTxvseNgZJFbX-lSUQ13axbp3cLiqPc
MES_MOVIMIENTOS_ID=1Bwj8WCykMn_FbZhQ_FqnDH3K_WCod52YTSvsaxIDNS8
SHEET_KM_ID=1Wr-_P4mDvldif_cAx08sp7yT8uTUrajI2HQAJF6tnGM

# ==============================================================
# 🤖 SERVICIOS EXTERNOS
# ==============================================================
IMGBB_API_KEY=tu-key
GEMINI_API_KEY=tu-key
```

---

## 🧪 Pruebas y Diagnóstico en Localhost

El proyecto incluye suites de diagnóstico preparadas para verificar el consumo de RAM y el estado de los puertos:

### 1. Test de Parámetros y Huella de Memoria de `pg`
Mide la huella base del runtime y el impacto de cargar el driver `pg` y el Pool:
```bash
npm run test:pg
```

### 2. Diagnóstico de Puertos y Memoria RAM Local (3000 y 3001)
Verifica que el microservicio y el backend principal se comuniquen de forma óptima:
```bash
npm run test:ram
```

### 3. Iniciar Servicios en Entorno Local

* **Opción recomendada (Ambos servicios en local para mínimo consumo):**
  ```bash
  # Terminal 1: Iniciar microservicio de kilómetros
  npm run start:km

  # Terminal 2: Iniciar backend principal conectado a la RAM del microservicio local
  npm run start:main:local
  ```

* **Iniciar solo backend principal conectado al microservicio en Render:**
  ```bash
  npm run start:main
  ```

---

## ☁️ Despliegue en Render

El repositorio cuenta con un archivo [render.yaml](file:///c:/Users/Matias%20Rodriguez/Desktop/jAVI/diagramas/diagramasnode/render.yaml) configurado como **Blueprint** para levantar automáticamente ambos servicios en la capa gratuita:
1. `diagramasnode`: Web Service principal (`rootDir: .`).
2. `km-extractor-service`: Web Service aislado de extracción (`rootDir: km-service`).
