import React, { useState, useMemo } from 'react';
import { Dialog, DialogPanel, DialogTitle, Transition, TransitionChild } from '@headlessui/react';
import { X, Search, Truck, AlertTriangle, Check, UserMinus, ShieldAlert } from 'lucide-react';
import { useAvailableUnits, useAssignUnit } from '../hooks/useAssignUnit';

export const UnitAssignModal = ({ isOpen, onClose, driver }) => {
  const [search, setSearch] = useState('');
  const [servicio, setServicio] = useState('TODOS');
  const [feedbackMsg, setFeedbackMsg] = useState(null);

  const { data: units, isLoading } = useAvailableUnits(servicio);
  const assignMutation = useAssignUnit();

  const filteredUnits = useMemo(() => {
    if (!units) return [];
    if (!search.trim()) return units;
    const q = search.toLowerCase().trim();
    return units.filter((u) => {
      const matchTr = u.tractor && u.tractor.toLowerCase().includes(q);
      const matchSe = u.semi && u.semi.toLowerCase().includes(q);
      const matchUte = u.n_ute && String(u.n_ute).toLowerCase().includes(q);
      const matchCh = u.chofer_nombre && u.chofer_nombre.toLowerCase().includes(q);
      return matchTr || matchSe || matchUte || matchCh;
    });
  }, [units, search]);

  if (!driver) return null;

  const handleAssign = async (unit) => {
    try {
      setFeedbackMsg({ type: 'info', text: `Asignando ${unit.tractor || unit.semi || 'unidad'} a ${driver.nombre}...` });
      await assignMutation.mutateAsync({
        choferId: driver.chofer_id || driver.id,
        choferNombre: driver.nombre,
        unidadId: unit.unidad_id,
        tractor: unit.tractor,
        semi: unit.semi,
        n_ute: unit.n_ute,
        esDesasignar: false,
      });

      setFeedbackMsg({ type: 'success', text: `✅ Unidad asignada exitosamente (BD + Sheets)` });
      setTimeout(() => {
        setFeedbackMsg(null);
        onClose();
      }, 1200);
    } catch (err) {
      setFeedbackMsg({ type: 'error', text: `❌ ${err.message}` });
    }
  };

  const handleUnassign = async () => {
    try {
      setFeedbackMsg({ type: 'info', text: `Desasignando unidad de ${driver.nombre}...` });
      await assignMutation.mutateAsync({
        choferId: driver.chofer_id || driver.id,
        choferNombre: driver.nombre,
        esDesasignar: true,
      });

      setFeedbackMsg({ type: 'success', text: `✅ Unidad desasignada (BD + Sheets)` });
      setTimeout(() => {
        setFeedbackMsg(null);
        onClose();
      }, 1200);
    } catch (err) {
      setFeedbackMsg({ type: 'error', text: `❌ ${err.message}` });
    }
  };

  const tieneUnidadAsignada = Boolean(driver.tractor || driver.semi || driver.n_ute);
  const servicios = ['TODOS', 'LIVIANO', 'METANOL', 'CAMPO', 'GLP', 'TDS', 'EURO'];

  return (
    <Transition show={isOpen} as={React.Fragment}>
      <Dialog as="div" className="modal-dialog-root" onClose={onClose} style={{ position: 'fixed', inset: 0, zIndex: 9999 }}>
        {/* Backdrop */}
        <TransitionChild
          as={React.Fragment}
          enter="ease-out duration-200"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-150"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(15, 23, 42, 0.65)', backdropFilter: 'blur(3px)' }} />
        </TransitionChild>

        <div style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}>
          <TransitionChild
            as={React.Fragment}
            enter="ease-out duration-200"
            enterFrom="opacity-0 scale-95"
            enterTo="opacity-100 scale-100"
            leave="ease-in duration-150"
            leaveFrom="opacity-100 scale-100"
            leaveTo="opacity-0 scale-95"
          >
            <DialogPanel
              style={{
                width: '100%',
                maxWidth: '680px',
                backgroundColor: 'var(--bg-surface)',
                borderRadius: 'var(--radius-lg)',
                boxShadow: 'var(--shadow-lg)',
                border: '1px solid var(--border-subtle)',
                display: 'flex',
                flexDirection: 'column',
                maxHeight: '90vh',
                overflow: 'hidden',
              }}
            >
              {/* Header Modal */}
              <div style={{ padding: '1.25rem 1.5rem', borderBottom: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <DialogTitle style={{ fontSize: '1.15rem', fontWeight: 900, color: 'var(--text-main)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <Truck size={20} style={{ color: 'var(--primary)' }} />
                    <span>Asignar Unidad Operativa</span>
                  </DialogTitle>
                  <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginTop: '0.2rem' }}>
                    Chofer: <strong style={{ color: 'var(--text-main)' }}>{driver.nombre}</strong> (Legajo: {driver.legajo || 'S/D'})
                  </p>
                </div>

                <button
                  onClick={onClose}
                  className="btn-icon-square"
                  style={{ width: '32px', height: '32px' }}
                  title="Cerrar"
                >
                  <X size={18} />
                </button>
              </div>

              {/* Unidad actual asignada + Botón Desasignar */}
              <div style={{ padding: '0.75rem 1.5rem', backgroundColor: 'var(--bg-surface-muted)', borderBottom: '1px solid var(--border-subtle)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <span style={{ color: 'var(--text-muted)' }}>Asignación actual:</span>
                  {tieneUnidadAsignada ? (
                    <span style={{ fontWeight: 800, color: 'var(--primary)' }}>
                      TRAC: {driver.tractor || '—'} | SEMI: {driver.semi || '—'} {driver.n_ute ? `(UTE: ${driver.n_ute})` : ''}
                    </span>
                  ) : (
                    <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>Sin unidad asignada</span>
                  )}
                </div>

                {tieneUnidadAsignada && (
                  <button
                    onClick={handleUnassign}
                    disabled={assignMutation.isPending}
                    style={{
                      padding: '0.35rem 0.75rem',
                      borderRadius: 'var(--radius-sm)',
                      fontSize: '0.75rem',
                      fontWeight: 800,
                      backgroundColor: '#fee2e2',
                      color: '#b91c1c',
                      border: '1px solid #fca5a5',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '0.35rem',
                      cursor: 'pointer',
                    }}
                  >
                    <UserMinus size={13} />
                    <span>Desasignar Unidad</span>
                  </button>
                )}
              </div>

              {/* Barra de Filtros */}
              <div style={{ padding: '0.75rem 1.5rem', display: 'flex', gap: '0.75rem', alignItems: 'center', borderBottom: '1px solid var(--border-subtle)' }}>
                <div className="filter-search-box" style={{ flex: 1 }}>
                  <Search size={15} className="filter-search-icon" />
                  <input
                    type="text"
                    placeholder="Filtrar por tractor, semi, UTE o chofer..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="filter-search-input"
                    autoFocus
                  />
                </div>

                <select
                  value={servicio}
                  onChange={(e) => setServicio(e.target.value)}
                  className="filter-search-input"
                  style={{ width: '130px', paddingLeft: '0.65rem' }}
                >
                  {servicios.map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>

              {/* Notificación de Feedback */}
              {feedbackMsg && (
                <div
                  style={{
                    padding: '0.6rem 1.5rem',
                    fontSize: '0.8rem',
                    fontWeight: 700,
                    backgroundColor: feedbackMsg.type === 'error' ? '#fee2e2' : feedbackMsg.type === 'success' ? '#dcfce7' : '#eff6ff',
                    color: feedbackMsg.type === 'error' ? '#991b1b' : feedbackMsg.type === 'success' ? '#166534' : '#1e40af',
                    borderBottom: '1px solid var(--border-subtle)',
                  }}
                >
                  {feedbackMsg.text}
                </div>
              )}

              {/* Lista Scrollable de Unidades */}
              <div style={{ flex: 1, overflowY: 'auto', padding: '1rem 1.5rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {isLoading ? (
                  <div style={{ padding: '3rem', textAlign: 'center' }}>
                    <div className="spinner-pulse" />
                    <p style={{ marginTop: '0.5rem', color: 'var(--text-muted)', fontSize: '0.85rem' }}>Cargando unidades operativas...</p>
                  </div>
                ) : filteredUnits.length === 0 ? (
                  <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                    No se encontraron unidades con los filtros especificados.
                  </div>
                ) : (
                  filteredUnits.map((u) => {
                    const esLaActual = (u.tractor && u.tractor === driver.tractor) || (u.n_ute && String(u.n_ute) === String(driver.n_ute));
                    const tieneAlertaDocs = u.alerta_vtv_tractor === 'VENCIDO' || u.alerta_vtv_semi === 'VENCIDO';
                    const ocupadoPorOtro = u.chofer_nombre && u.chofer_nombre !== driver.nombre;

                    return (
                      <div
                        key={u.unidad_id || u.n_ute}
                        style={{
                          padding: '0.75rem 1rem',
                          borderRadius: 'var(--radius-md)',
                          border: esLaActual ? '2px solid var(--primary)' : '1px solid var(--border-subtle)',
                          backgroundColor: esLaActual ? '#eff6ff' : 'var(--bg-surface)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: '1rem',
                          transition: 'background-color 0.15s ease',
                        }}
                      >
                        {/* Info de la Unidad */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <span style={{ fontSize: '0.85rem', fontWeight: 900, color: 'var(--text-main)', fontFamily: 'var(--font-mono)' }}>
                              UTE: {u.n_ute || '—'}
                            </span>
                            <span style={{ fontSize: '0.72rem', padding: '0.1rem 0.4rem', borderRadius: '4px', backgroundColor: '#e2e8f0', fontWeight: 700 }}>
                              {u.servicio || 'S/A'}
                            </span>
                            {tieneAlertaDocs && (
                              <span style={{ fontSize: '0.7rem', color: '#dc2626', fontWeight: 800, display: 'flex', alignItems: 'center', gap: '0.2rem' }} title="VTV o MAS Vencido">
                                <ShieldAlert size={12} />
                                <span>VTV</span>
                              </span>
                            )}
                          </div>

                          <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', display: 'flex', gap: '0.75rem' }}>
                            <span>TRAC: <strong style={{ color: 'var(--text-main)' }}>{u.tractor || '—'}</strong></span>
                            <span>SEMI: <strong style={{ color: 'var(--text-main)' }}>{u.semi || '—'}</strong></span>
                          </div>

                          {ocupadoPorOtro && (
                            <div style={{ fontSize: '0.72rem', color: '#d97706', fontWeight: 600 }}>
                              Asignado a: {u.chofer_nombre}
                            </div>
                          )}
                        </div>

                        {/* Botón Acción Asignar */}
                        <div>
                          {esLaActual ? (
                            <span style={{ fontSize: '0.75rem', fontWeight: 800, color: 'var(--primary)', padding: '0.35rem 0.75rem', backgroundColor: '#dbeafe', borderRadius: 'var(--radius-sm)' }}>
                              Asignada
                            </span>
                          ) : (
                            <button
                              onClick={() => handleAssign(u)}
                              disabled={assignMutation.isPending}
                              style={{
                                padding: '0.4rem 0.85rem',
                                borderRadius: 'var(--radius-sm)',
                                fontSize: '0.78rem',
                                fontWeight: 800,
                                backgroundColor: 'var(--primary)',
                                color: '#ffffff',
                                border: 'none',
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.3rem',
                              }}
                            >
                              <span>Asignar</span>
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              {/* Footer */}
              <div style={{ padding: '0.85rem 1.5rem', borderTop: '1px solid var(--border-subtle)', backgroundColor: 'var(--bg-surface-muted)', display: 'flex', justifyContent: 'flex-end' }}>
                <button
                  onClick={onClose}
                  style={{
                    padding: '0.45rem 1rem',
                    borderRadius: 'var(--radius-sm)',
                    fontSize: '0.82rem',
                    fontWeight: 700,
                    backgroundColor: 'var(--bg-surface)',
                    border: '1px solid var(--border-strong)',
                    cursor: 'pointer',
                  }}
                >
                  Cerrar
                </button>
              </div>
            </DialogPanel>
          </TransitionChild>
        </div>
      </Dialog>
    </Transition>
  );
};
