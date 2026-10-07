# Directrices del Proyecto EOR

## Reglas de Reactividad y Rendimiento
- Para el manejo del pareo **Unidad + Chofer** en la Vista Diaria (`view_diaria_operativa`) y el **Día de Diagramas** en el Módulo Individual (`view_calendario_diagrama_km`), consulte la regla canónica:
  - [.agents/rules/reactividad-react.md](.agents/rules/reactividad-react.md)

## Principios Clave:
1. **Desunión (`chofer = 1`)**: Si la columna del chofer es `"1"`, `""`, `"-"`, `"0"`, `"S/A"` o `"VACANTE"`, debe tratarse como una desunión explícita (`DELETE` de `movimientos` y liberación de `choferes.unidad_id = null`).
2. **Reactividad Híbrida**: Suscripción Realtime en Supabase (`movimientos`, `choferes`, `unidades`, `diagramas`) + TanStack Query cache + Optimistic UI updates.
3. **Módulo Individual y Diagramas**:
   - Acceso $O(1)$ a días y KMs mediante diccionario aplanado `tripsMap`.
   - Payload compactado con `tira_dias` y `dias_km`.
4. **Límites de Egress y RAM**:
   - Mantener respuestas Gzip de vistas en < 3 KB.
   - TanStack Query cache en cliente < 5 MB de RAM.
   - Logqueries acotados mediante índices relacionales en PostgreSQL.

## Mapa del proyecto unificado (eor_v1)
- Estructura y reglas de ubicación: [.agents/rules/estructura-proyecto.md](.agents/rules/estructura-proyecto.md)
- Despliegue (Render: backend free + Static Site): [docs/DEPLOY_RENDER.md](docs/DEPLOY_RENDER.md)
- Backend único: `apps/backend` (todas las rutas). Frontend: `apps/frontend`. Extracción local (n8n + loader): `extraction/`. SQL: `supabase/`.
- La v1 no cambia lógica funcional; mejoras pendientes en [docs/ROADMAP_v1.1.md](docs/ROADMAP_v1.1.md).