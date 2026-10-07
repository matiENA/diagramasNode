import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/apiClient';
import { queryKeys } from '@/api/queryKeys';
import { Search, ExternalLink } from 'lucide-react';

const formatDate = (val) => {
  if (!val) return '—';
  try {
    const d = new Date(val);
    if (isNaN(d.getTime())) return String(val);
    return d.toLocaleDateString('es-AR', { timeZone: 'UTC', day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch {
    return String(val);
  }
};

/**
  * Evalúa el estado de una fecha respecto a la fecha actual:
  * - 'vencida': anterior a hoy -> ROJO
  * - 'por_vencer': dentro de los próximos 30 días (1 mes) -> AMARILLO
  * - 'al_dia': más de 30 días -> NORMAL
  */
const evaluateDateStatus = (val) => {
  if (!val) return 'none';
  const d = new Date(val);
  if (isNaN(d.getTime())) return 'none';

  const now = new Date();
  now.setHours(0, 0, 0, 0);

  const target = new Date(d);
  target.setHours(0, 0, 0, 0);

  const diffMs = target.getTime() - now.getTime();
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays < 0) {
    return 'vencida';
  }
  if (diffDays <= 30) {
    return 'por_vencer';
  }
  return 'al_dia';
};

const renderDateCell = (val) => {
  if (!val) return <span style={{ color: 'var(--text-muted)' }}>—</span>;
  const status = evaluateDateStatus(val);
  const formatted = formatDate(val);

  if (status === 'vencida') {
    return (
      <span
        style={{
          display: 'inline-block',
          padding: '0.2rem 0.5rem',
          borderRadius: '4px',
          fontSize: '0.78rem',
          fontWeight: 800,
          fontFamily: 'var(--font-mono)',
          backgroundColor: 'rgba(239, 68, 68, 0.12)',
          color: '#dc2626',
          border: '1px solid rgba(239, 68, 68, 0.3)',
        }}
        title="Vencido"
      >
        {formatted}
      </span>
    );
  }

  if (status === 'por_vencer') {
    return (
      <span
        style={{
          display: 'inline-block',
          padding: '0.2rem 0.5rem',
          borderRadius: '4px',
          fontSize: '0.78rem',
          fontWeight: 800,
          fontFamily: 'var(--font-mono)',
          backgroundColor: 'rgba(245, 158, 11, 0.12)',
          color: '#d97706',
          border: '1px solid rgba(245, 158, 11, 0.3)',
        }}
        title="Por vencer (menos de 1 mes)"
      >
        {formatted}
      </span>
    );
  }

  return (
    <span style={{ fontFamily: 'var(--font-mono)', fontSize: '0.8rem', color: 'var(--text-main)', fontWeight: 600 }}>
      {formatted}
    </span>
  );
};

export const FlotaModule = ({ onNavigateToIndividual }) => {
  const [search, setSearch] = useState('');

  const { data: unidades, isLoading, isError, error } = useQuery({
    queryKey: queryKeys.flota.all,
    queryFn: () => apiClient.getFlota(),
    staleTime: 1000 * 60 * 5, // 5 min en RAM
    gcTime: 1000 * 60 * 30,
  });

  const handleDriverClick = (choferId) => {
    if (!choferId) return;
    if (typeof onNavigateToIndividual === 'function') {
      onNavigateToIndividual(choferId);
    } else {
      const url = new URL(window.location);
      url.searchParams.set('chofer', choferId);
      window.history.pushState({}, '', url);
      window.dispatchEvent(new CustomEvent('navigate-tab', { detail: { tab: 'individual', chofer: choferId } }));
    }
  };

  const filteredUnidades = (unidades || []).filter((u) => {
    if (search.trim()) {
      const term = search.toLowerCase();
      const matchTr = u.tractor && u.tractor.toLowerCase().includes(term);
      const matchSe = u.semi && u.semi.toLowerCase().includes(term);
      const matchDiag = u.dia_diagrama && String(u.dia_diagrama).toLowerCase().includes(term);
      const matchCh = u.chofer_nombre && u.chofer_nombre.toLowerCase().includes(term);
      return matchTr || matchSe || matchDiag || matchCh;
    }
    return true;
  });

  return (
    <div className="module-container">
      {/* Header del Módulo */}
      <div className="module-header">
        <div>
          <h2 className="module-title">Control de Flota y Vencimientos</h2>
          <p className="module-subtitle">Equipos, día de diagrama con acceso a ficha individual y control de vencimientos (VTV y MAS)</p>
        </div>

        {/* Buscador Rápido */}
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <div className="filter-search-box" style={{ width: '300px' }}>
            <Search size={15} className="filter-search-icon" />
            <input
              type="text"
              placeholder="Buscar tractor, semi, día o chofer..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="filter-search-input"
            />
          </div>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-muted)', fontWeight: 600 }}>
            {filteredUnidades.length} unidades
          </span>
        </div>
      </div>

      {/* Tabla de Flota */}
      {isLoading ? (
        <div style={{ padding: '3rem', textAlign: 'center' }}>
          <div className="spinner-pulse" />
          <p style={{ marginTop: '0.5rem', color: 'var(--text-muted)' }}>Consultando flota operativa...</p>
        </div>
      ) : isError ? (
        <div style={{ padding: '2rem', color: '#dc2626' }}>Error: {error?.message}</div>
      ) : (
        <div className="data-table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                <th>Tractor</th>
                <th>Semi</th>
                <th style={{ textAlign: 'center' }}>Día Diagrama</th>
                <th>VTV Tractor</th>
                <th>MAS Tractor</th>
                <th>VTV Semi</th>
                <th>MAS Semi</th>
              </tr>
            </thead>
            <tbody>
              {filteredUnidades.map((u) => (
                <tr key={u.unidad_id}>
                  <td style={{ fontWeight: 700, fontFamily: 'var(--font-mono)' }}>{u.tractor || '—'}</td>
                  <td style={{ fontFamily: 'var(--font-mono)' }}>{u.semi || '—'}</td>
                  <td style={{ textAlign: 'center' }}>
                    {u.chofer_id ? (
                      <button
                        type="button"
                        onClick={() => handleDriverClick(u.chofer_id)}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '0.3rem',
                          minWidth: '2.4rem',
                          padding: '0.25rem 0.55rem',
                          borderRadius: 'var(--radius-sm)',
                          fontSize: '0.82rem',
                          fontWeight: 800,
                          fontFamily: 'var(--font-mono)',
                          backgroundColor: u.dia_diagrama && u.dia_diagrama !== '-' ? 'rgba(59, 130, 246, 0.12)' : 'rgba(148, 163, 184, 0.1)',
                          color: u.dia_diagrama && u.dia_diagrama !== '-' ? '#2563eb' : '#64748b',
                          border: u.dia_diagrama && u.dia_diagrama !== '-' ? '1px solid rgba(59, 130, 246, 0.3)' : '1px solid rgba(148, 163, 184, 0.2)',
                          cursor: 'pointer',
                          transition: 'all 0.15s ease',
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.backgroundColor = 'rgba(59, 130, 246, 0.22)';
                          e.currentTarget.style.transform = 'translateY(-1px)';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.backgroundColor = u.dia_diagrama && u.dia_diagrama !== '-' ? 'rgba(59, 130, 246, 0.12)' : 'rgba(148, 163, 184, 0.1)';
                          e.currentTarget.style.transform = 'none';
                        }}
                        title={`Clic para abrir ficha individual de ${u.chofer_nombre || 'chofer'}`}
                      >
                        <span>{u.dia_diagrama || '—'}</span>
                        <ExternalLink size={11} style={{ opacity: 0.6 }} />
                      </button>
                    ) : (
                      <span
                        style={{
                          display: 'inline-block',
                          minWidth: '2.4rem',
                          padding: '0.25rem 0.55rem',
                          borderRadius: 'var(--radius-sm)',
                          fontSize: '0.82rem',
                          fontWeight: 700,
                          fontFamily: 'var(--font-mono)',
                          backgroundColor: 'rgba(148, 163, 184, 0.1)',
                          color: '#94a3b8',
                          border: '1px solid rgba(148, 163, 184, 0.2)',
                        }}
                      >
                        —
                      </span>
                    )}
                  </td>
                  <td>{renderDateCell(u.vtv_tr)}</td>
                  <td>{renderDateCell(u.mas_tr)}</td>
                  <td>{renderDateCell(u.vtv_semi)}</td>
                  <td>{renderDateCell(u.mas_semi)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
