# Guía de Colorimetría y Sistema de Tokens EOR (Actualizada)

Este documento consolida la extracción exacta de los códigos hexadecimales de la imagen de referencia (estados operativos y novedades de conductores), junto con las adaptaciones recomendadas para integrarse armoniosamente al **Design System de EOR**.

---

## 1. Extracción Exacta de la Guía Original

Los colores provienen del estándar clásico de planillas de cálculo de logística/operaciones (paleta nativa de Microsoft Excel).

| Código | Descripción | Rol Operativo | HEX Fondo | HEX Texto | Borde / Estilo |
| :---: | :--- | :--- | :---: | :---: | :--- |
| **F** | Franco | Descanso de diagrama regular | `#B4C6E7` | `#000000` | Sólido |
| **FSF** | Franco (Sin Franco) | Franco compensatorio / especial | `#B4C6E7` | `#000000` | Punteado (`dotted`) |
| **E** | Enferm. | Enfermedad médica | `#FFC7CE` | `#9C0006` | Punteado (`dotted`) |
| **V** | Vacac. | Vacaciones anuales | `#00B050` | `#000000` | Sólido |
| **VSF** | Vacac. (Sin Franco) | Vacaciones sin franco cómputo | `#00B050` | `#000000` | Punteado (`dotted`) |
| **S** | Suspen. | Suspensión disciplinaria | `#FFC000` | `#000000` | Punteado (`dotted`) |
| **A** | Ausente | Ausencia injustificada / falta | `#FF0000` | `#000000` | Sólido |
| **ART** | Ausente (ART) | Licencia médica ART | `#00B050` | `#000000` | Sólido |
| **IND** | Indispuesto | Licencia médica / Indisposición | `#7F7F7F` | `#000000` | Sólido |

> [!NOTE]
> **Ajustes de Sistema Operativo EOR**:
> 1. **Omisión de Pasivo (`P`) y Otros (`O`)**: Se omiten de los estados de diagrama diarios. En EOR el chofer pasivo es una desunión explícita (`choferes.unidad_id = null`), mientras que `O` se presta a confusión con `Operativo`.
> 2. **Adición de `IND`**: Extraído de novedades de planilla médica (`#7F7F7F` gris neutral 50%), normalizado a la escala Slate de EOR.
> 3. **ART**: En EOR se adopta la variante lavanda `#8b5cf6` para distinguir inequívocamente de Vacaciones (`#10b981`).

---

## 2. Diagnóstico UX/UI para EOR

Aplicar los colores de Excel de forma pura (`#FF0000`, `#00B050`, `#FFC000`, `#7F7F7F`) en una aplicación web moderna genera tres problemas críticos:

1. **Fatiga Visual en Grillas Densas**: En la matriz de 31 días × 150 conductores, los fondos saturados al 100% compiten con la lectura de los días consecutivos y los kilómetros recorridos.
2. **Incompatibilidad con Dark Mode**: El texto negro sobre gris oscuro o verde pierde contraste. En modo oscuro, se requiere una base translúcida (`rgba`) con texto pastel legible.
3. **Falta de contraste WCAG AA**: Letras negras sobre `#00B050` o `#7F7F7F` no alcanzan la relación de contraste mínima de 4.5:1.

---

## 3. Matriz de Adaptación al Sistema EOR

Para cumplir con los estándares de EOR (Plus Jakarta Sans, elevación suave, micro-badges y Dark Mode), cada estado se divide en:
- **Solid**: Para chips activos, indicadores laterales (stripes) y puntos de estado (`dot`).
- **Soft Light**: Para celdas del calendario mensual, badges de tabla y fondos de fila.
- **Dark Mode**: Para el tema oscuro nativo de EOR (`html.dark`).

| Código | Nombre | Sólido (Acento) | Modo Claro (Fondo / Texto / Borde) | Modo Oscuro (Fondo / Texto / Borde) |
| :---: | :--- | :---: | :--- | :--- |
| **F** | Franco | `#3b82f6` | `bg: #eff6ff` · `text: #1d4ed8` · `border: #bfdbfe` | `bg: rgba(59,130,246,0.18)` · `text: #93c5fd` · `border: rgba(96,165,250,0.35)` |
| **FSF** | Franco (SF) | `#3b82f6` | `bg: #eff6ff` · `text: #1d4ed8` · `border: #93c5fd dashed` | `bg: rgba(59,130,246,0.18)` · `text: #93c5fd` · `border: rgba(96,165,250,0.4) dashed` |
| **E** | Enfermedad | `#f43f5e` | `bg: #ffe4e6` · `text: #9f1239` · `border: #fecdd3` | `bg: rgba(244,63,94,0.18)` · `text: #fecdd3` · `border: rgba(251,113,133,0.35)` |
| **V** | Vacaciones | `#10b981` | `bg: #ecfdf5` · `text: #065f46` · `border: #a7f3d0` | `bg: rgba(16,185,129,0.18)` · `text: #6ee7b7` · `border: rgba(52,211,153,0.35)` |
| **VSF** | Vacaciones (SF) | `#10b981` | `bg: #ecfdf5` · `text: #065f46` · `border: #34d399 dashed` | `bg: rgba(16,185,129,0.18)` · `text: #6ee7b7` · `border: rgba(52,211,153,0.4) dashed` |
| **ACT** | Activo (Trabajando) | `#059669` | `bg: #f0fdf4` · `text: #166534` · `border: #bbf7d0` | `bg: rgba(5,150,105,0.18)` · `text: #86efac` · `border: rgba(34,197,94,0.35)` |
| **S** | Suspensión | `#f97316` | `bg: #fff7ed` · `text: #9a3412` · `border: #fed7aa` | `bg: rgba(249,115,22,0.18)` · `text: #fed7aa` · `border: rgba(251,146,60,0.35)` |
| **A** | Ausente | `#ef4444` | `bg: #fef2f2` · `text: #991b1b` · `border: #fecaca` | `bg: rgba(239,68,68,0.20)` · `text: #fca5a5` · `border: rgba(248,113,113,0.40)` |
| **ART** | ART (Lavanda EOR) | `#8b5cf6` | `bg: #f5f3ff` · `text: #5b21b6` · `border: #ddd6fe` | `bg: rgba(139,92,246,0.18)` · `text: #c4b5fd` · `border: rgba(167,139,250,0.35)` |
| **IND** | Indispuesto (Slate) | `#64748b` | `bg: #f1f5f9` · `text: #334155` · `border: #cbd5e1` | `bg: rgba(100,116,139,0.20)` · `text: #cbd5e1` · `border: rgba(148,163,184,0.35)` |

---

## 4. Tokens CSS (`theme.css`)

```css
/* ==============================================================
   ESTADOS DE DIAGRAMA Y NOVEDADES (EOR DESIGN SYSTEM)
   ============================================================== */
:root {
  /* Sólidos / Acentos */
  --novedad-f: #3b82f6;
  --novedad-e: #f43f5e;
  --novedad-v: #10b981;
  --novedad-s: #f97316;
  --novedad-a: #ef4444;
  --novedad-art: #8b5cf6;
  --novedad-ind: #64748b;
  --novedad-act: #059669;

  /* Modo Claro - Fondos y Textos */
  --novedad-f-bg: #eff6ff;
  --novedad-f-text: #1d4ed8;
  --novedad-f-border: #bfdbfe;

  --novedad-e-bg: #ffe4e6;
  --novedad-e-text: #9f1239;
  --novedad-e-border: #fecdd3;

  --novedad-v-bg: #ecfdf5;
  --novedad-v-text: #065f46;
  --novedad-v-border: #a7f3d0;

  --novedad-s-bg: #fff7ed;
  --novedad-s-text: #9a3412;
  --novedad-s-border: #fed7aa;

  --novedad-a-bg: #fef2f2;
  --novedad-a-text: #991b1b;
  --novedad-a-border: #fecaca;

  --novedad-art-bg: #f5f3ff;
  --novedad-art-text: #5b21b6;
  --novedad-art-border: #ddd6fe;

  --novedad-ind-bg: #f1f5f9;
  --novedad-ind-text: #334155;
  --novedad-ind-border: #cbd5e1;

  --novedad-act-bg: #f0fdf4;
  --novedad-act-text: #166534;
  --novedad-act-border: #bbf7d0;
}

/* 🌙 MODO OSCURO */
html.dark {
  --novedad-f-bg: rgba(59, 130, 246, 0.18);
  --novedad-f-text: #93c5fd;
  --novedad-f-border: rgba(96, 165, 250, 0.35);

  --novedad-e-bg: rgba(244, 63, 94, 0.18);
  --novedad-e-text: #fecdd3;
  --novedad-e-border: rgba(251, 113, 133, 0.35);

  --novedad-v-bg: rgba(16, 185, 129, 0.18);
  --novedad-v-text: #6ee7b7;
  --novedad-v-border: rgba(52, 211, 153, 0.35);

  --novedad-s-bg: rgba(249, 115, 22, 0.18);
  --novedad-s-text: #fed7aa;
  --novedad-s-border: rgba(251, 146, 60, 0.35);

  --novedad-a-bg: rgba(239, 68, 68, 0.20);
  --novedad-a-text: #fca5a5;
  --novedad-a-border: rgba(248, 113, 113, 0.40);

  --novedad-art-bg: rgba(139, 92, 246, 0.18);
  --novedad-art-text: #c4b5fd;
  --novedad-art-border: rgba(167, 139, 250, 0.35);

  --novedad-ind-bg: rgba(100, 116, 139, 0.20);
  --novedad-ind-text: #cbd5e1;
  --novedad-ind-border: rgba(148, 163, 184, 0.35);

  --novedad-act-bg: rgba(5, 150, 105, 0.18);
  --novedad-act-text: #86efac;
  --novedad-act-border: rgba(34, 197, 94, 0.35);
}
```

---

## 5. Clases de Utilidad Tailwind CSS (Grillas y Badges)

```javascript
export const NOVEDADES_STYLES = {
  F:   { bg: 'bg-blue-50 dark:bg-blue-950/40', text: 'text-blue-800 dark:text-blue-200', border: 'border-blue-200 dark:border-blue-800/60' },
  FSF: { bg: 'bg-blue-50 dark:bg-blue-950/40', text: 'text-blue-800 dark:text-blue-200', border: 'border-blue-400 border-dashed dark:border-blue-600' },
  E:   { bg: 'bg-rose-50 dark:bg-rose-950/40', text: 'text-rose-800 dark:text-rose-200', border: 'border-rose-200 dark:border-rose-800/60' },
  V:   { bg: 'bg-emerald-50 dark:bg-emerald-950/40', text: 'text-emerald-800 dark:text-emerald-200', border: 'border-emerald-200 dark:border-emerald-800/60' },
  VSF: { bg: 'bg-emerald-50 dark:bg-emerald-950/40', text: 'text-emerald-800 dark:text-emerald-200', border: 'border-emerald-400 border-dashed dark:border-emerald-600' },
  ACT: { bg: 'bg-green-50 dark:bg-green-950/40', text: 'text-green-800 dark:text-green-200', border: 'border-green-200 dark:border-green-800/60' },
  S:   { bg: 'bg-orange-50 dark:bg-orange-950/40', text: 'text-orange-800 dark:text-orange-200', border: 'border-orange-200 dark:border-orange-800/60' },
  A:   { bg: 'bg-red-50 dark:bg-red-950/40', text: 'text-red-800 dark:text-red-200', border: 'border-red-300 dark:border-red-800/60' },
  ART: { bg: 'bg-purple-50 dark:bg-purple-950/40', text: 'text-purple-800 dark:text-purple-200', border: 'border-purple-200 dark:border-purple-800/60' },
  IND: { bg: 'bg-slate-100 dark:bg-slate-900/40', text: 'text-slate-700 dark:text-slate-200', border: 'border-slate-300 dark:border-slate-700/60' },
};
```
