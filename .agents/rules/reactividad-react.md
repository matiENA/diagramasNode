# Regla de Reactividad en la Interfaz React: Pareo Unidad-Chofer y Diagrama Individual

## 1. Contexto y Propósito
Esta regla establece el estándar de arquitectura reactiva, flujo de sincronización de datos y directrices de optimización (logquery, egress de red y consumo de RAM) para:
1. **Pareo de Unidad + Chofer** en la Vista Diaria (`DailyDriverCard`, `view_diaria_operativa`, `view_movimientos`).
2. **Día de Diagramas y KMs** en el Módulo Individual (`IndividualModule`, `TrimestralCalendar`, `view_calendario_diagrama_km`).

---

## 2. Arquitectura de Reactividad Híbrida (WebSockets + Polling + Optimistic UI)

### Capa 1: Suscripciones Realtime vía Supabase (WebSockets)
- **Canal Global (`useRealtimeSync`)**:
  - Escucha eventos `INSERT`, `UPDATE`, `DELETE` en el schema `public` para las tablas: `movimientos`, `choferes`, `unidades`.
  - Invalida selectivamente las queries activas de TanStack Query:
    - `queryKeys.diaria.all`
    - `queryKeys.movimientos.all`
    - `queryKeys.flota.all`
- **Canal Específico (`useCalendarDiagramaKm`)**:
  - Suscripción filtrada por chofer: `table: 'diagramas'`, filtro `chofer_id=eq.${choferId}`.
  - Invalida `queryKeys.individual.calendar(choferId)` solo cuando cambian los días de ese chofer.

### Capa 2: Caché Inteligente y Polling de Respaldo (TanStack Query)
- **Vista Diaria (`useDailyDrivers`)**:
  - `staleTime: 10000` (10 segundos).
  - `refetchInterval: 15000` (15 segundos para capturar sincronizaciones de Google Sheets/n8n).
  - `refetchOnWindowFocus: true` (refresco inmediato al volver a la pestaña).
- **Módulo Individual (`useIndividualChofer` y `useCalendarDiagramaKm`)**:
  - Catálogo de choferes (`queryKeys.individual.catalog`): `staleTime: 30 min` (baja volatilidad).
  - Detalle individual: `staleTime: 30 seg`, `gcTime: 30 min`.
  - Calendario: Cacheado por combinación `[choferId, zoomLevel, targetTabs]`.

### Capa 3: Actualizaciones Optimistas (Optimistic UI)
- Al ejecutar acciones de asignación o desunión (`useAssignUnit`):
  - Actualizar inmediatamente el cache de TanStack Query (`queryClient.setQueryData`) para reflejar el estado en la interfaz en < 16 ms.
  - En caso de error en el backend, revertir automáticamente usando el snapshot previo de `onMutate`.

---

## 3. Proceso de Renderizado

### A. Unidad + Chofer (Tarjeta Diaria)
1. **Detección de Asignación**:
   - Se evalúa si el registro contiene `driver.tractor`, `driver.semi` o `driver.n_ute`.
2. **Estado Asignado**:
   - Renderiza badges con EasyCopy: `TRAC` (patente), `SEMI` (patente), `UTE` (móvil).
   - Botón de reasignación (icono camión/engranaje).
   - Acordeón expandido muestra vencimientos de VTV/MASS de tractor y semi.
3. **Estado Desunido (`chofer = 1` o sin asignar)**:
   - Renderiza botón dashed destacado: **`+ Asignar`**.
   - Acordeón expandido muestra indicador neutro: `⚪ Conductor sin unidad asignada (disponible)`.

### B. Día de Diagramas en Individual (Trimestral/Anual)
1. **Extracción y Compactación**:
   - Backend entrega `tira_dias` (cadena de caracteres compacta ej. `"FFFFDD...VV"`) y `dias_km` (mapa JSON `{ [isoDate]: { km, hr } }`).
2. **Mapeo en Memoria O(1)**:
   - El hook frontend transforma `dias_km` a un mapa plano `tripsMap` indexado por fecha `YYYY-MM-DD`.
3. **Selección Matricial (Shift + Clic)**:
   - Permite seleccionar rangos operativos calculando en caliente total de KMs y viajes sin reconsultar el servidor.

---

## 4. Perfil de Consumo y Estimaciones (Logquery, Data Egress y RAM)

| Parámetro | Escenario / Métrica | Estimación por Usuario Activo | Impacto y Optimización |
| :--- | :--- | :--- | :--- |
| **Logquery (Postgres / Node)** | Reposo con Polling (15s) | ~4 queries/minuto | Índices en `id_unidad`, `chofer_id` y vistas relacionales; ejecución en < 5ms. |
| | Realtime (Evento de Sync) | 1 query de re-fetch por invalidación | El canal WebSocket no hace polling a DB; solo dispara re-fetch ante eventos confirmados. |
| | Navegación Individual | 2 queries al cambiar de chofer (perfil + calendario) | Cacheado 30s-30min; cambios repetidos entre los mismos choferes consumen 0 queries. |
| **Data Egress (Red)** | Vista Diaria (50 registros) | ~2.8 KB (Gzip) / petición | Polling cada 15s consume ~670 KB/hora por cliente activo. |
| | Calendario 90 días (3 meses) | ~800 Bytes (Gzip) por chofer | Formato compactado `tira_dias` reduce el payload en un 88% respecto a JSON de 90 objetos. |
| | Calendario 12 meses | ~2.5 KB (Gzip) por chofer | Solo se solicita cuando el usuario expande al zoom anual. |
| | WebSockets (Heartbeat + Payloads) | ~150 Bytes por evento | Consumo despreciable (< 50 KB/hora en reposo). |
| **Uso de RAM (Cliente React)** | TanStack Query Cache | ~2 MB - 4 MB | Dataset completo de 270 choferes y unidades en memoria del navegador. |
| | Component Tree / DOM | ~3 MB - 5 MB | Virtualización y acordeones desacoplados evitan sobrecargar el DOM. |
| | Total Pestaña Navegador | ~40 MB - 60 MB | Muy ligero para equipos de baja y media gama. |
| **Uso de RAM (Backend Node)** | Proceso Node.js (Render) | ~80 MB - 110 MB | Caché de Sheets en RAM (30s) ocupa < 1 MB. Pool pg de 15 conexiones ocupa ~20 MB. |
