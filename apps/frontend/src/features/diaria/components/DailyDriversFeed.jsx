import React, { useMemo } from 'react';
import { useDailyDrivers, getDriverDayStatus, calculateDriverReturn } from '../hooks/useDailyDrivers';
import { useDailyKm } from '../hooks/useDailyKm';
import { DailyDriverCard } from './DailyDriverCard';
import { Users, AlertCircle, Loader2 } from 'lucide-react';

export const DailyDriversFeed = ({ fechaContexto, filters, onSelectDriver }) => {
  const {
    data,
    isLoading,
    isError,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useDailyDrivers(filters, fechaContexto);

  // Consulta de kilómetros y hojas de ruta para la fecha contexto
  const { data: kmMap } = useDailyKm(fechaContexto);

  // Aplanar páginas de conductores
  const allDrivers = useMemo(() => {
    return data?.pages?.flatMap((page) => page.drivers) || [];
  }, [data]);

  // Filtro secundario en cliente por Estado del Día y Personal que Retorna
  const filteredDrivers = useMemo(() => {
    let list = allDrivers;

    if (filters.estado && filters.estado !== 'TODOS') {
      list = list.filter((driver) => {
        const st = getDriverDayStatus(driver, fechaContexto);
        if (filters.estado === 'ACTIVOS') return st.type === 'OPERATIVO';
        if (filters.estado === 'FRANCOS') return st.type === 'FRANCO';
        if (filters.estado === 'VACACIONES') return st.type === 'VACACIONES';
        if (filters.estado === 'LICENCIAS') return st.type === 'LICENCIA';
        return true;
      });
    }

    if (filters.retornan) {
      list = list.filter((driver) => {
        if (driver.retorno_info) return true;
        const ret = calculateDriverReturn(driver, fechaContexto);
        return Boolean(ret);
      });
    }

    return list;
  }, [allDrivers, filters.estado, filters.retornan, fechaContexto]);

  if (isLoading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', padding: '1rem 0' }}>
        {[1, 2, 3, 4, 5, 6].map((i) => (
          <div key={i} className="daily-driver-skeleton">
            <div className="skeleton-avatar" />
            <div className="skeleton-content">
              <div className="skeleton-bar" style={{ width: '40%' }} />
              <div className="skeleton-bar" style={{ width: '70%', height: '14px' }} />
            </div>
            <div className="skeleton-badge" />
          </div>
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="daily-empty-box error">
        <AlertCircle size={36} color="#dc2626" />
        <h3 style={{ fontWeight: 800, marginTop: '0.5rem' }}>Error al consultar la grilla diaria</h3>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>{error?.message || 'Error de conexión'}</p>
      </div>
    );
  }

  if (filteredDrivers.length === 0) {
    return (
      <div className="daily-empty-box">
        <Users size={36} style={{ color: 'var(--text-muted)' }} />
        <h3 style={{ fontWeight: 800, marginTop: '0.5rem' }}>
          {filters.retornan ? 'No se encontraron choferes con retorno' : 'No se encontraron conductores'}
        </h3>
        <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
          {filters.retornan
            ? `No hay conductores con retorno programado para la fecha ${fechaContexto}.`
            : `Prueba cambiando la fecha contexto (${fechaContexto}) o ajustando los filtros de búsqueda.`}
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      {filteredDrivers.map((driver) => (
        <DailyDriverCard
          key={driver.chofer_id}
          driver={driver}
          fechaContexto={fechaContexto}
          kmInfo={kmMap?.[driver.chofer_id]}
          onSelectDriver={onSelectDriver}
        />
      ))}

      {/* Botón o trigger de Carga Paginada */}
      {hasNextPage && (
        <div style={{ padding: '1.5rem', textAlign: 'center' }}>
          <button
            onClick={() => fetchNextPage()}
            disabled={isFetchingNextPage}
            className="btn-load-more-drivers"
          >
            {isFetchingNextPage ? (
              <>
                <Loader2 size={16} className="animate-spin" />
                <span>Cargando más conductores...</span>
              </>
            ) : (
              <span>Cargar más conductores</span>
            )}
          </button>
        </div>
      )}
    </div>
  );
};
