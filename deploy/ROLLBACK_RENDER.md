# 🔄 Guía de Reversión: De Railway a Render (Rollback)

> **Contexto:** Esta configuración temporal fue aplicada debido a la suspensión de los Web Services en Render.  
> Los clientes estáticos (**Diagramas Kiosko** y **DASH**) fueron apuntados a `https://diagramasnode-production.up.railway.app`.

Una vez que el servicio en Render vuelva a estar activo (`https://diagramasnode.onrender.com`), sigue estos pasos para volver a la configuración original:

---

## 📋 Archivos Modificados a Revertir

### 1. `public/index.html` (Línea ~386)
Descomentar la línea de Render y comentar la de Railway:
```javascript
// --- [TAG: CONEXIÓN BACKEND NATIVO (NODE.JS)] ---
const BACKEND_URL = "https://diagramasnode.onrender.com"; // RENDER (ACTIVO)
// const BACKEND_URL = "https://diagramasnode-production.up.railway.app";
```

---

### 2. `DASH/js/config.js` (Línea ~3)
Descomentar la línea de Render:
```javascript
const PROD_URL = 'https://diagramasnode.onrender.com';
// const PROD_URL = 'https://diagramasnode-production.up.railway.app';
```

---

### 3. `public/modulo_auth.js` (Línea ~81)
Cambiar la URL de fallback de vuelta a Render:
```javascript
"https://diagramasnode.onrender.com"
```

---

## 📡 Webhooks de Google Apps Script

### 4. Actualizar el trigger de Google Sheets
Si apuntaste los triggers de Apps Script a Railway para la recepción de viajes o celdas, reconfigura el endpoint a:
```text
https://diagramasnode.onrender.com/api/webhook/google
```

---

## ⚙️ Microservicio de KM (`km-service`)

### 5. Variables de entorno en Render
Verifica que en el panel de Render los dos servicios mantengan la comunicación cruzada:
* En **`diagramasnode`** -> Environment:
  `KM_SERVICE_URL = https://km-extractor-service.onrender.com`
* En **`km-extractor-service`** -> Environment:
  `MAIN_BACKEND_URL = https://diagramasnode.onrender.com`
