import React from 'react';
import { Search, Filter, X, ShieldAlert, Truck } from 'lucide-react';

export const FiltersSidebar = ({ filters, onFilterChange, onResetFilters }) => {
  const servicios = ['TODOS', 'METANOL', 'LIVIANO', 'CAMPO', 'GLP', 'YPF', 'ABASTECEDORES'];

  const estadosOperativos = [
    { id: 'TODOS', label: 'Todos los estados' },
    { id: 'ACTIVOS', label: '🟢 Activos (Trabajando)' },
    { id: 'FRANCOS', label: '🔵 Francos (F)' },
    { id: 'VACACIONES', label: '🟡 Vacaciones (V)' },
    { id: 'LICENCIAS', label: '🔴 Licencias / Indispuesto' },
  ];

  const alertas = [
    { id: 'TODAS', label: 'Sin filtro de alerta' },
    { id: 'DOCS_VENCIDOS', label: '🔴 Documentación Chofer Vencida' },
    { id: 'UNIDAD_VENCIDA', label: '🚚 Unidad (VTV/MASS) Vencida' },
    { id: 'CUALQUIER_ALERTA', label: '⚠️ Cualquier Alerta Activa' },
  ];

  return (
    <div className="filters-content" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      {/* Cabecera de Filtros */}
      <div className="filters-header">
        <h3 className="filters-heading">
          <Filter size={16} />
          <span>Filtros Operativos</span>
        </h3>
        <button
          onClick={onResetFilters}
          className="btn-clear-filters"
          title="Restablecer todos los filtros"
        >
          Limpiar
        </button>
      </div>

      {/* Buscador de Chofer, Tractor, Semi o UTE */}
      <div className="filter-search-box">
        <Search size={15} className="filter-search-icon" />
        <input
          type="text"
          className="filter-search-input"
          placeholder="Buscar chofer, tractor, semi, UTE..."
          value={filters.search || ''}
          onChange={(e) => onFilterChange('search', e.target.value)}
        />
        {filters.search && (
          <button
            onClick={() => onFilterChange('search', '')}
            style={{ position: 'absolute', right: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }}
          >
            <X size={14} />
          </button>
        )}
      </div>

      {/* Filtro Principal: Personal que Retorna */}
      <div className="filter-section">
        <button
          type="button"
          onClick={() => onFilterChange('retornan', !filters.retornan)}
          className={`filter-chip-btn ${filters.retornan ? 'active' : ''}`}
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0.6rem 0.85rem',
            fontWeight: 800,
            fontSize: '0.8rem',
            backgroundColor: filters.retornan ? '#4338ca' : '#eef2ff',
            color: filters.retornan ? '#ffffff' : '#3730a3',
            border: filters.retornan ? '1px solid #3730a3' : '1px solid #c7d2fe',
            borderRadius: 'var(--radius-sm)',
            cursor: 'pointer',
            transition: 'all 0.15s ease',
          }}
          title="Mostrar únicamente choferes con retorno programado o que retornan hoy"
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <span>🔄</span>
            <span>Personal que Retorna</span>
          </span>
          {filters.retornan && <span style={{ fontSize: '0.75rem' }}>✓</span>}
        </button>
      </div>

      {/* Filtro por Estado Operativo del Día */}
      <div className="filter-section">
        <span className="filter-label">Estado del Día</span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
          {estadosOperativos.map((st) => {
            const isSelected = (filters.estado || 'TODOS') === st.id;
            return (
              <button
                key={st.id}
                onClick={() => onFilterChange('estado', st.id)}
                className={`filter-chip-btn ${isSelected ? 'active' : ''}`}
                style={{ textAlign: 'left', padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-sm)' }}
              >
                {st.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Filtro por Alertas de Vencimiento */}
      <div className="filter-section">
        <span className="filter-label">Alertas de Vencimiento</span>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
          {alertas.map((al) => {
            const isSelected = (filters.alerta || 'TODAS') === al.id;
            return (
              <button
                key={al.id}
                onClick={() => onFilterChange('alerta', al.id)}
                className={`filter-chip-btn ${isSelected ? 'active' : ''}`}
                style={{ textAlign: 'left', padding: '0.5rem 0.75rem', borderRadius: 'var(--radius-sm)' }}
              >
                {al.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Filtro por Servicio */}
      <div className="filter-section">
        <span className="filter-label">Servicio</span>
        <div className="filter-chips-grid">
          {servicios.map((srv) => {
            const isSelected = (filters.servicio || 'TODOS') === srv;
            return (
              <button
                key={srv}
                onClick={() => onFilterChange('servicio', srv)}
                className={`filter-chip-btn ${isSelected ? 'active' : ''}`}
              >
                {srv}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};
