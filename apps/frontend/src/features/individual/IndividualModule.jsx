import React, { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/api/apiClient';
import { queryKeys } from '@/api/queryKeys';
import { useIndividualChofer } from './hooks/useIndividualChofer';
import { DriverProfileCard } from './components/DriverProfileCard';
import { DriverDocAccordion } from './components/DriverDocAccordion';
import { TrimestralCalendar } from './components/TrimestralCalendar';
import { Search, User, Users } from 'lucide-react';

export const IndividualModule = () => {
  const [selectedChoferId, setSelectedChoferId] = useState('');
  const [search, setSearch] = useState('');

  // 1. Catálogo optimizado de choferes para el selector lateral (desde backend / vista unificada)
  const { data: choferes, isLoading: isLoadingChoferes } = useQuery({
    queryKey: queryKeys.individual.catalog,
    queryFn: () => apiClient.getCatalogoChoferesLite(),
    staleTime: 1000 * 60 * 30, // 30 min en RAM
  });

  // Soporte de Deep-Linking (?chofer=ID o nombre)
  useEffect(() => {
    if (!choferes || choferes.length === 0) return;
    const params = new URLSearchParams(window.location.search);
    const paramChofer = params.get('chofer');

    if (paramChofer) {
      const cleanParam = paramChofer.trim().toLowerCase();
      const found = choferes.find(
        (c) => c.id === paramChofer ||
               (c.dni && String(c.dni).toLowerCase() === cleanParam) ||
               c.nombre.toLowerCase().includes(cleanParam)
      );
      if (found) {
        setSelectedChoferId(found.id);
        return;
      }
    }

    // Si no hay seleccionado, pre-seleccionar el primer chofer con foto o el primer elemento
    if (!selectedChoferId) {
      const conFoto = choferes.find((c) => c.foto);
      setSelectedChoferId(conFoto ? conFoto.id : choferes[0].id);
    }
  }, [choferes]);

  // 2. Consulta unificada a la vista de chofer + unidad + datos unidad + vencimientos + avalados
  const { data: choferData, isLoading: isLoadingChoferData } = useIndividualChofer(selectedChoferId);

  const cleanSearch = search.trim().toLowerCase();
  const choferesFiltrados = (choferes || []).filter((c) =>
    c.nombre.toLowerCase().includes(cleanSearch) ||
    (c.legajo && String(c.legajo).toLowerCase().includes(cleanSearch)) ||
    (c.dni && String(c.dni).toLowerCase().includes(cleanSearch))
  );

  return (
    <div className="module-container" style={{ maxWidth: '100%', padding: '1rem 1.5rem' }}>
      
      {/* BOXGRID REESTRUCTURADO (Wireframe Canónico) */}
      <div className="individual-layout-grid">
        
        {/* ==============================================================
           COLUMNA IZQUIERDA: LISTA CHOFERES (Sidebar de Altura Completa)
           ============================================================== */}
        <aside className="individual-left-col data-table-wrapper" style={{ padding: '0.85rem', display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: '0.8rem', fontWeight: 900, textTransform: 'uppercase', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <Users size={15} style={{ color: 'var(--primary)' }} />
              <span>Lista Choferes</span>
            </span>
            <span style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-muted)' }}>
              {choferesFiltrados.length} conductores
            </span>
          </div>

          <div className="filter-search-box" style={{ width: '100%' }}>
            <Search size={14} className="filter-search-icon" />
            <input
              type="text"
              placeholder="Buscar por Nombre, DNI o Legajo..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="filter-search-input"
              style={{ fontSize: '0.8rem', padding: '0.4rem 0.5rem 0.4rem 2rem' }}
            />
          </div>

          {/* Lista scrollable de altura completa */}
          <div style={{ flex: 1, maxHeight: 'calc(100vh - 200px)', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.25rem', paddingRight: '0.2rem' }}>
            {isLoadingChoferes ? (
              <div style={{ padding: '2rem', textAlign: 'center' }}>
                <span className="spinner-pulse" style={{ width: '20px', height: '20px' }} />
              </div>
            ) : choferesFiltrados.map((c) => {
              const isSelected = c.id === selectedChoferId;
              return (
                <button
                  key={c.id}
                  onClick={() => setSelectedChoferId(c.id)}
                  style={{
                    padding: '0.45rem 0.65rem',
                    borderRadius: 'var(--radius-sm)',
                    textAlign: 'left',
                    backgroundColor: isSelected ? 'var(--primary)' : 'var(--bg-surface-muted)',
                    color: isSelected ? '#ffffff' : 'var(--text-main)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '0.4rem',
                    transition: 'all 0.12s ease',
                    border: isSelected ? '1px solid var(--primary-dark)' : '1px solid var(--border-subtle)',
                    cursor: 'pointer',
                  }}
                >
                  <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                    <span style={{ fontSize: '0.8rem', fontWeight: 800, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {c.nombre}
                    </span>
                    <span style={{ fontSize: '0.68rem', opacity: 0.85 }}>
                      Leg: {c.legajo || 'S/D'} • DNI: {c.dni || 'S/D'}
                    </span>
                  </div>

                  <span style={{
                    fontSize: '0.62rem',
                    fontWeight: 800,
                    padding: '0.1rem 0.35rem',
                    borderRadius: '4px',
                    backgroundColor: isSelected ? 'rgba(255,255,255,0.2)' : 'var(--bg-surface)',
                    color: isSelected ? '#ffffff' : 'var(--text-secondary)',
                    textTransform: 'uppercase',
                    flexShrink: 0
                  }}>
                    {c.c_servicio || 'GEN'}
                  </span>
                </button>
              );
            })}
          </div>
        </aside>

        {/* ==============================================================
           COLUMNA DERECHA: MAIN CONTENT EN 3 BLOQUES APILADOS
           1. Bloque Superior: Datos Conductor + Unidad
           2. Bloque Medio: Calendario Diagrama KMs
           3. Bloque Inferior: Vencimientos Chofer (No Colapsado), Observaciones, Aptos
           ============================================================== */}
        <main className="individual-right-col" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', minWidth: 0 }}>
          
          {selectedChoferId ? (
            <>
              {/* BLOQUE 1: DATOS UNI CHOFER */}
              {isLoadingChoferData ? (
                <div style={{ padding: '2rem', textAlign: 'center', backgroundColor: 'var(--bg-surface)', borderRadius: 'var(--radius-lg)' }}>
                  <span className="spinner-pulse" style={{ width: '22px', height: '22px' }} />
                  <p style={{ marginTop: '0.5rem', fontSize: '0.8rem', color: 'var(--text-muted)' }}>Cargando datos del chofer y unidad...</p>
                </div>
              ) : choferData ? (
                <DriverProfileCard chofer={choferData} />
              ) : null}

              {/* BLOQUE 2: CALENDARIO DIAGRAMA KMS */}
              <TrimestralCalendar
                choferId={selectedChoferId}
                choferNombre={choferData?.nombre || ''}
              />

              {/* BLOQUE 3: VENCIMIENTOS (ESTADO INICIAL NO COLAPSADO), OBSERVACIONES, APTOS */}
              <DriverDocAccordion
                choferId={selectedChoferId}
                chofer={choferData}
              />
            </>
          ) : (
            <div style={{ padding: '4rem 2rem', textAlign: 'center', backgroundColor: 'var(--bg-surface)', borderRadius: 'var(--radius-lg)', border: '1px dashed var(--border-strong)' }}>
              <User size={40} style={{ color: 'var(--text-muted)', margin: '0 auto 0.75rem auto' }} />
              <h4 style={{ fontWeight: 800 }}>Selecciona un conductor del panel izquierdo</h4>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                Visualizarás su ficha con la unidad asignada, el calendario diagrama con KMs y sus vencimientos operativos.
              </p>
            </div>
          )}

        </main>

      </div>

    </div>
  );
};
