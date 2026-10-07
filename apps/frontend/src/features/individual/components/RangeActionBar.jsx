import React, { useState, useEffect, useRef } from 'react';
import { CalendarRange, X, Route, Check } from 'lucide-react';

export const RangeActionBar = ({
  selectedRange,
  rangeKm = 0,
  tripsCount = 0,
  onClear,
  onAssignStatus,
  isPending = false,
}) => {
  const [customStatus, setCustomStatus] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    if (selectedRange?.startIso) {
      setCustomStatus('');
      // Auto-enfoque inmediato del input al seleccionar un día o rango
      const timer = setTimeout(() => {
        if (inputRef.current) {
          inputRef.current.focus();
          inputRef.current.select();
        }
      }, 40);
      return () => clearTimeout(timer);
    }
  }, [selectedRange?.startIso, selectedRange?.endIso]);

  if (!selectedRange || !selectedRange.startIso || !selectedRange.endIso) return null;

  const { startIso, endIso } = selectedRange;
  const minIso = startIso <= endIso ? startIso : endIso;
  const maxIso = startIso <= endIso ? endIso : startIso;

  const d1 = new Date(minIso + 'T12:00:00');
  const d2 = new Date(maxIso + 'T12:00:00');
  const diffTime = Math.abs(d2 - d1);
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1;

  const formatShort = (iso) => {
    const parts = iso.split('-');
    return `${parts[2]}/${parts[1]}`;
  };

  const handleApplyCustom = (e) => {
    if (e) e.preventDefault();
    const val = customStatus.trim().toUpperCase();
    if (!val) return;
    onAssignStatus(val);
    setCustomStatus('');
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleApplyCustom();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClear();
    }
  };

  return (
    <div className="range-action-bar-floating">
      {/* 1. Información de Fechas y KMs en Rango */}
      <div className="range-info-text">
        <CalendarRange size={18} style={{ color: 'var(--primary)', flexShrink: 0 }} />
        <span>
          {diffDays} {diffDays === 1 ? 'día seleccionado' : 'días seleccionados'} ({formatShort(minIso)}{diffDays > 1 ? ` al ${formatShort(maxIso)}` : ''})
        </span>

        {/* Píldora de Kilómetros en Rango */}
        <div className="range-km-pill" title="Kilómetros acumulados en el rango seleccionado">
          <Route size={14} style={{ color: '#6366f1', flexShrink: 0 }} />
          <span>
            <strong>{rangeKm.toLocaleString('es-AR')}</strong> km en rango
          </span>
          {tripsCount > 0 && (
            <span className="range-trips-sub">
              ({tripsCount} {tripsCount === 1 ? 'viaje' : 'viajes'})
            </span>
          )}
        </div>
      </div>

      {/* 2. Controles de Asignación con Optimistic UI */}
      <div className="range-actions-btns">
        {/* Input libre de asignación de diagramas */}
        <form onSubmit={handleApplyCustom} className="range-input-form">
          <input
            ref={inputRef}
            type="text"
            value={customStatus}
            onChange={(e) => setCustomStatus(e.target.value.toUpperCase())}
            onKeyDown={handleKeyDown}
            placeholder="Código (F, V, 1..35, ART...)"
            maxLength={10}
            className="range-status-input"
            disabled={isPending}
            autoFocus
          />
          <button
            type="submit"
            disabled={!customStatus.trim() || isPending}
            className="btn-range-action btn-range-apply"
            title="Asignar código ingresado (<Enter>)"
          >
            <Check size={14} />
            <span>Asignar</span>
          </button>
        </form>

        <div className="range-actions-separator" />

        {/* Botones Presets Rápidos */}
        <button
          type="button"
          onClick={() => onAssignStatus('ACTIVO')}
          disabled={isPending}
          className="btn-range-action btn-range-activo"
          title="Asignar Día Activo (correlativo numérico continuo 1..35)"
        >
          Día Activo
        </button>

        <button
          type="button"
          onClick={() => onAssignStatus('F')}
          disabled={isPending}
          className="btn-range-action btn-range-franco"
          title="Asignar Franco (F) en este rango"
        >
          Franco (F)
        </button>

        <button
          type="button"
          onClick={() => onAssignStatus('V')}
          disabled={isPending}
          className="btn-range-action btn-range-vacaciones"
          title="Asignar Vacaciones (V) en este rango"
        >
          Vacaciones (V)
        </button>

        <button
          type="button"
          onClick={() => onAssignStatus('E')}
          disabled={isPending}
          className="btn-range-action btn-range-licencia"
          title="Asignar Licencia Médica / Ausencia (E)"
        >
          Licencia (E)
        </button>

        <button
          type="button"
          onClick={() => onAssignStatus('-')}
          disabled={isPending}
          className="btn-range-action btn-range-limpiar"
          title="Limpiar asignación del rango (-)"
        >
          Limpiar (-)
        </button>

        <button
          type="button"
          onClick={onClear}
          className="btn-range-action btn-range-clear"
          title="Deseleccionar rango (<Esc>)"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
};
