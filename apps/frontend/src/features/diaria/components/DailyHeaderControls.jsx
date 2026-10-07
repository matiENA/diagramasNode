import React from 'react';
import { Search, Calendar, ChevronLeft, ChevronRight, RotateCcw, Filter } from 'lucide-react';

export const DailyHeaderControls = ({
  fechaContexto,
  onChangeFecha,
  filters,
  onChangeFilter,
  totalCount,
}) => {
  // Manejo de cambio de días (< Ayer, Hoy, Mañana >)
  const shiftDay = (days) => {
    const d = new Date(fechaContexto + 'T12:00:00');
    d.setDate(d.getDate() + 1 * days);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    onChangeFecha(`${yyyy}-${mm}-${dd}`);
  };

  const setToday = () => {
    const today = new Date().toISOString().split('T')[0];
    onChangeFecha(today);
  };

  const isToday = fechaContexto === new Date().toISOString().split('T')[0];

  const servicios = ['TODOS', 'METANOL', 'LIVIANO', 'CAMPO', 'GLP', 'YPF', 'ABASTECEDORES'];

  const estados = [
    { id: 'TODOS', label: 'Todos' },
    { id: 'ACTIVOS', label: '🟢 Activos' },
    { id: 'FRANCOS', label: '🔵 Francos (F)' },
    { id: 'VACACIONES', label: '🟡 Vacaciones (V)' },
    { id: 'LICENCIAS', label: '🔴 Licencias (IND/E)' },
  ];

  return (
    <div className="daily-controls-bar">
      {/* 1. Selector Central de Fecha Contexto */}
      <div className="daily-date-control-group">
        <button
          onClick={() => shiftDay(-1)}
          className="btn-date-nav"
          title="Día anterior"
        >
          <ChevronLeft size={16} />
        </button>

        <div className="date-input-wrapper">
          <Calendar size={15} className="date-icon" />
          <input
            type="date"
            value={fechaContexto}
            onChange={(e) => onChangeFecha(e.target.value)}
            className="date-picker-input"
          />
        </div>

        <button
          onClick={() => shiftDay(1)}
          className="btn-date-nav"
          title="Día siguiente"
        >
          <ChevronRight size={16} />
        </button>

        {!isToday && (
          <button
            onClick={setToday}
            className="btn-today-pill"
            title="Volver a la fecha de hoy"
          >
            <RotateCcw size={12} />
            <span>Hoy</span>
          </button>
        )}
      </div>

      {/* 2. Buscador Reactivo */}
      <div className="filter-search-box" style={{ maxWidth: '320px', flex: 1 }}>
        <Search size={15} className="filter-search-icon" />
        <input
          type="text"
          placeholder="Buscar chofer, tractor, semi, UTE..."
          value={filters.search}
          onChange={(e) => onChangeFilter('search', e.target.value)}
          className="filter-search-input"
        />
      </div>

      {/* 3. Selector de Servicio */}
      <div className="select-service-wrapper">
        <select
          value={filters.servicio}
          onChange={(e) => onChangeFilter('servicio', e.target.value)}
          className="select-service-input"
        >
          {servicios.map((s) => (
            <option key={s} value={s}>
              {s === 'TODOS' ? 'Todos los Servicios' : s}
            </option>
          ))}
        </select>
      </div>

      {/* 4. Contador de Choferes */}
      <div className="daily-count-badge">
        <span>{totalCount} Conductores</span>
      </div>
    </div>
  );
};
