import React, { useState, useEffect } from 'react';
import { Disclosure, DisclosureButton, DisclosurePanel, Transition } from '@headlessui/react';
import { ChevronUp, ChevronDown, Check, Save, ShieldCheck, AlertCircle, FileText } from 'lucide-react';
import { useDriverDocs, useDriverObservations, useUpdateDocField, useSaveAllDocs } from '../hooks/useDriverDocs';

export const DriverDocAccordion = ({ choferId, chofer }) => {
  const choferObj = chofer || { id: choferId };
  const [hasOpenedObs, setHasOpenedObs] = useState(false);
  const { data: docData } = useDriverDocs(choferId);
  const { data: observations, isLoading: isLoadingObs } = useDriverObservations(choferId, hasOpenedObs);
  const updateField = useUpdateDocField(choferObj);
  const saveAll = useSaveAllDocs(choferObj);

  // Estados locales para los inputs de fechas
  const [dates, setDates] = useState({
    venc_periodico: '',
    venc_licencia_nacional: '',
    venc_cargas_peligrosas: '',
    venc_psicofisico: '',
    apto_medico_venc: '',
    apto_medico_estado: 'Activo',
  });

  const [savedField, setSavedField] = useState(null);
  const [globalSaved, setGlobalSaved] = useState(false);

  // Sincronizar con datos unificados (view_individual_chofer o chofer_documentacion)
  useEffect(() => {
    const src = docData || chofer;
    if (src) {
      setDates({
        venc_periodico: src.venc_periodico ? String(src.venc_periodico).substring(0, 10) : '',
        venc_licencia_nacional: src.venc_licencia_nacional ? String(src.venc_licencia_nacional).substring(0, 10) : '',
        venc_cargas_peligrosas: src.venc_cargas_peligrosas ? String(src.venc_cargas_peligrosas).substring(0, 10) : '',
        venc_psicofisico: src.venc_psicofisico ? String(src.venc_psicofisico).substring(0, 10) : '',
        apto_medico_venc: src.apto_medico_venc ? String(src.apto_medico_venc).substring(0, 10) : '',
        apto_medico_estado: src.apto_medico_estado || 'Activo',
      });
    }
  }, [docData, chofer]);

  const docId = docData?.id || chofer?.doc_id;

  // Cálculo dinámico de vigencia
  const getBadgeState = (dateStr) => {
    if (!dateStr) return { label: 'SIN REGISTRO', type: 'S_D' };
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const target = new Date(dateStr + 'T00:00:00');
    const diffDays = Math.ceil((target - today) / (1000 * 60 * 60 * 24));

    if (diffDays < 0) return { label: 'VENCIDO', type: 'VENCIDO' };
    if (diffDays <= 30) return { label: 'POR VENCER', type: 'POR_VENCER' };
    return { label: 'VIGENTE', type: 'VIGENTE' };
  };

  // Guardado individual por cada input
  const handleSaveIndividual = (field) => {
    const val = dates[field];
    updateField.mutate(
      { field, value: val, docId, currentDates: dates },
      {
        onSuccess: () => {
          setSavedField(field);
          setTimeout(() => setSavedField(null), 2200);
        },
      }
    );
  };

  // Guardado global
  const handleSaveAll = () => {
    saveAll.mutate(
      { docId, fields: dates },
      {
        onSuccess: () => {
          setGlobalSaved(true);
          setTimeout(() => setGlobalSaved(false), 2200);
        },
      }
    );
  };

  const isAptoAvalado = dates.apto_medico_estado?.toLowerCase().includes('activo') ||
                        dates.apto_medico_estado?.toLowerCase().includes('avalado');

  const totalObs = observations?.length ?? chofer?.total_observaciones ?? 0;

  // Extraer contratos avalados si existen en texto
  const avaladosContratosStr = chofer?.avalado_contratos || docData?.avalado_contratos || '';
  const avaladosList = avaladosContratosStr
    ? avaladosContratosStr.split(/[-–;,]/).map(s => s.trim()).filter(s => s.length > 1)
    : [];

  return (
    <div key={choferId} className="driver-accordions-wrapper" style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
      
      {/* ==============================================================
         1. 📄 VENCIMIENTOS (VENC.) — ESTADO INICIAL NO COLAPSADO
         ============================================================== */}
      <Disclosure as="div" defaultOpen={true} className="doc-disclosure-card">
        {({ open }) => (
          <>
            <DisclosureButton className="doc-disclosure-header" style={{ padding: '0.65rem 1rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span style={{ fontSize: '1rem' }}>📄</span>
                <span className="doc-disclosure-title" style={{ fontSize: '0.85rem', fontWeight: 900 }}>
                  VENCIMIENTOS CHOFER (VENC.)
                </span>
                <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                  (Periódico, Licencia, Cargas Peligrosas, Psicofísico)
                </span>
              </div>
              <span className="doc-chevron-icon">
                {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              </span>
            </DisclosureButton>

            <Transition
              enter="transition duration-150 ease-out"
              enterFrom="transform scale-95 opacity-0"
              enterTo="transform scale-100 opacity-100"
              leave="transition duration-100 ease-out"
              leaveFrom="transform scale-100 opacity-100"
              leaveTo="transform scale-95 opacity-0"
            >
              <DisclosurePanel className="doc-disclosure-body" style={{ padding: '1rem' }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: '0.75rem' }}>
                  
                  {/* Tarjeta: PERIÓDICO */}
                  <div className="doc-item-box" style={{ padding: '0.5rem' }}>
                    <div className="doc-item-header" style={{ marginBottom: '0.25rem' }}>
                      <span className="doc-item-name" style={{ fontSize: '0.7rem' }}>PERIÓDICO</span>
                      <span className={`doc-status-badge badge-${getBadgeState(dates.venc_periodico).type}`}>
                        {getBadgeState(dates.venc_periodico).label}
                      </span>
                    </div>
                    <div className="doc-input-row">
                      <input
                        type="date"
                        value={dates.venc_periodico}
                        onChange={(e) => setDates({ ...dates, venc_periodico: e.target.value })}
                        className="doc-date-input"
                        style={{ fontSize: '0.75rem', padding: '0.25rem 0.4rem' }}
                      />
                      <button
                        onClick={() => handleSaveIndividual('venc_periodico')}
                        className={`btn-save-individual ${savedField === 'venc_periodico' ? 'saved' : ''}`}
                        title="Guardar Periódico"
                        disabled={updateField.isPending}
                        style={{ width: '28px', height: '28px' }}
                      >
                        {savedField === 'venc_periodico' ? <Check size={13} /> : <Save size={13} />}
                      </button>
                    </div>
                  </div>

                  {/* Tarjeta: LICENCIA */}
                  <div className="doc-item-box" style={{ padding: '0.5rem' }}>
                    <div className="doc-item-header" style={{ marginBottom: '0.25rem' }}>
                      <span className="doc-item-name" style={{ fontSize: '0.7rem' }}>LICENCIA</span>
                      <span className={`doc-status-badge badge-${getBadgeState(dates.venc_licencia_nacional).type}`}>
                        {getBadgeState(dates.venc_licencia_nacional).label}
                      </span>
                    </div>
                    <div className="doc-input-row">
                      <input
                        type="date"
                        value={dates.venc_licencia_nacional}
                        onChange={(e) => setDates({ ...dates, venc_licencia_nacional: e.target.value })}
                        className="doc-date-input"
                        style={{ fontSize: '0.75rem', padding: '0.25rem 0.4rem' }}
                      />
                      <button
                        onClick={() => handleSaveIndividual('venc_licencia_nacional')}
                        className={`btn-save-individual ${savedField === 'venc_licencia_nacional' ? 'saved' : ''}`}
                        title="Guardar Licencia"
                        disabled={updateField.isPending}
                        style={{ width: '28px', height: '28px' }}
                      >
                        {savedField === 'venc_licencia_nacional' ? <Check size={13} /> : <Save size={13} />}
                      </button>
                    </div>
                  </div>

                  {/* Tarjeta: CARGAS PELIGROSAS */}
                  <div className="doc-item-box" style={{ padding: '0.5rem' }}>
                    <div className="doc-item-header" style={{ marginBottom: '0.25rem' }}>
                      <span className="doc-item-name" style={{ fontSize: '0.7rem' }}>CARGAS PEL.</span>
                      <span className={`doc-status-badge badge-${getBadgeState(dates.venc_cargas_peligrosas).type}`}>
                        {getBadgeState(dates.venc_cargas_peligrosas).label}
                      </span>
                    </div>
                    <div className="doc-input-row">
                      <input
                        type="date"
                        value={dates.venc_cargas_peligrosas}
                        onChange={(e) => setDates({ ...dates, venc_cargas_peligrosas: e.target.value })}
                        className="doc-date-input"
                        style={{ fontSize: '0.75rem', padding: '0.25rem 0.4rem' }}
                      />
                      <button
                        onClick={() => handleSaveIndividual('venc_cargas_peligrosas')}
                        className={`btn-save-individual ${savedField === 'venc_cargas_peligrosas' ? 'saved' : ''}`}
                        title="Guardar Cargas Peligrosas"
                        disabled={updateField.isPending}
                        style={{ width: '28px', height: '28px' }}
                      >
                        {savedField === 'venc_cargas_peligrosas' ? <Check size={13} /> : <Save size={13} />}
                      </button>
                    </div>
                  </div>

                  {/* Tarjeta: PSICOFÍSICO */}
                  <div className="doc-item-box" style={{ padding: '0.5rem' }}>
                    <div className="doc-item-header" style={{ marginBottom: '0.25rem' }}>
                      <span className="doc-item-name" style={{ fontSize: '0.7rem' }}>PSICOFÍSICO</span>
                      <span className={`doc-status-badge badge-${getBadgeState(dates.venc_psicofisico).type}`}>
                        {getBadgeState(dates.venc_psicofisico).label}
                      </span>
                    </div>
                    <div className="doc-input-row">
                      <input
                        type="date"
                        value={dates.venc_psicofisico}
                        onChange={(e) => setDates({ ...dates, venc_psicofisico: e.target.value })}
                        className="doc-date-input"
                        style={{ fontSize: '0.75rem', padding: '0.25rem 0.4rem' }}
                      />
                      <button
                        onClick={() => handleSaveIndividual('venc_psicofisico')}
                        className={`btn-save-individual ${savedField === 'venc_psicofisico' ? 'saved' : ''}`}
                        title="Guardar Psicofísico"
                        disabled={updateField.isPending}
                        style={{ width: '28px', height: '28px' }}
                      >
                        {savedField === 'venc_psicofisico' ? <Check size={13} /> : <Save size={13} />}
                      </button>
                    </div>
                  </div>

                </div>

                {/* Botón Guardar Todos */}
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '0.65rem' }}>
                  <button
                    onClick={handleSaveAll}
                    disabled={saveAll.isPending}
                    className="btn-guardar-vencimientos-global"
                    style={{ fontSize: '0.75rem', padding: '0.35rem 0.75rem' }}
                  >
                    {globalSaved ? (
                      <>
                        <Check size={14} />
                        <span>¡Guardado!</span>
                      </>
                    ) : (
                      <>
                        <Save size={14} />
                        <span>{saveAll.isPending ? 'Guardando...' : 'Guardar Todos'}</span>
                      </>
                    )}
                  </button>
                </div>
              </DisclosurePanel>
            </Transition>
          </>
        )}
      </Disclosure>

      {/* ==============================================================
         2. 📝 OBSERVACIONES
         ============================================================== */}
      <Disclosure as="div" className="doc-disclosure-card">
        {({ open }) => (
          <>
            <DisclosureButton
              className="doc-disclosure-header"
              style={{ padding: '0.6rem 0.85rem' }}
              onClick={() => {
                if (!hasOpenedObs) setHasOpenedObs(true);
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                <span style={{ fontSize: '0.95rem' }}>📝</span>
                <span className="doc-disclosure-title" style={{ fontSize: '0.8rem', fontWeight: 900 }}>OBSERVACIONES</span>
                <span className="doc-count-pill" style={{ fontSize: '0.65rem' }}>
                  {totalObs} registradas
                </span>
              </div>
              <span className="doc-chevron-icon">
                {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              </span>
            </DisclosureButton>

            <Transition
              enter="transition duration-150 ease-out"
              enterFrom="transform scale-95 opacity-0"
              enterTo="transform scale-100 opacity-100"
              leave="transition duration-100 ease-out"
              leaveFrom="transform scale-100 opacity-100"
              leaveTo="transform scale-95 opacity-0"
            >
              <DisclosurePanel className="doc-disclosure-body" style={{ padding: '0.75rem' }}>
                {isLoadingObs ? (
                  <div style={{ padding: '1.5rem', textAlign: 'center' }}>
                    <span className="spinner-pulse" style={{ width: '18px', height: '18px' }} />
                  </div>
                ) : (observations || []).length === 0 ? (
                  <div className="doc-empty-box" style={{ padding: '1rem' }}>
                    <span style={{ fontSize: '1.2rem', opacity: 0.8 }}>📝</span>
                    <span className="doc-empty-text" style={{ fontSize: '0.75rem' }}>Sin observaciones registradas.</span>
                  </div>
                ) : (
                  <div className="data-table-wrapper" style={{ boxShadow: 'none', maxHeight: '200px', overflowY: 'auto' }}>
                    <table className="data-table" style={{ fontSize: '0.75rem' }}>
                      <thead>
                        <tr>
                          <th>Fecha</th>
                          <th>Unidad</th>
                          <th>Evento</th>
                          <th>Detalle</th>
                        </tr>
                      </thead>
                      <tbody>
                        {observations.map((obs) => (
                          <tr key={obs.id}>
                            <td style={{ fontWeight: 800 }}>{obs.fecha || '-'}</td>
                            <td style={{ fontFamily: 'var(--font-mono)' }}>{obs.unidad_dominio || '-'}</td>
                            <td style={{ fontWeight: 700 }}>{obs.evento || '-'}</td>
                            <td>{obs.obs_evento || obs.obs_estado || '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </DisclosurePanel>
            </Transition>
          </>
        )}
      </Disclosure>

      {/* ==============================================================
         3. 🩺 AVALADOS Y APTOS MÉDICOS
         ============================================================== */}
      <Disclosure as="div" className="doc-disclosure-card">
        {({ open }) => (
          <>
            <DisclosureButton className="doc-disclosure-header" style={{ padding: '0.6rem 0.85rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.45rem' }}>
                <span style={{ fontSize: '0.95rem' }}>🩺</span>
                <span className="doc-disclosure-title" style={{ fontSize: '0.8rem', fontWeight: 900 }}>AVALADOS Y APTOS</span>
                <span className={`doc-status-badge ${isAptoAvalado ? 'badge-VIGENTE' : 'badge-VENCIDO'}`}>
                  {isAptoAvalado ? 'AVALADO' : 'NO AVALADO'}
                </span>
              </div>
              <span className="doc-chevron-icon">
                {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              </span>
            </DisclosureButton>

            <Transition
              enter="transition duration-150 ease-out"
              enterFrom="transform scale-95 opacity-0"
              enterTo="transform scale-100 opacity-100"
              leave="transition duration-100 ease-out"
              leaveFrom="transform scale-100 opacity-100"
              leaveTo="transform scale-95 opacity-0"
            >
              <DisclosurePanel className="doc-disclosure-body" style={{ padding: '0.75rem', display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
                
                {/* Contratos Avalados (Chips visuales) */}
                <div>
                  <span style={{ fontSize: '0.68rem', fontWeight: 800, textTransform: 'uppercase', color: 'var(--text-muted)', display: 'block', marginBottom: '0.25rem' }}>
                    Contratos Habilitados (Avalados):
                  </span>
                  {avaladosList.length > 0 ? (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
                      {avaladosList.map((av, idx) => (
                        <span
                          key={idx}
                          style={{
                            fontSize: '0.72rem',
                            fontWeight: 700,
                            backgroundColor: '#ecfdf5',
                            color: '#065f46',
                            border: '1px solid #a7f3d0',
                            padding: '0 0.5rem',
                            height: '22px',
                            borderRadius: '4px',
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: '0.25rem',
                            boxSizing: 'border-box',
                            lineHeight: 1
                          }}
                        >
                          <ShieldCheck size={12} color="#059669" />
                          <span>{av}</span>
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Sin restricciones de contrato especificadas.</span>
                  )}
                </div>

                {/* Inputs de Estado y Vencimiento de Apto */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.5rem', marginTop: '0.25rem' }}>
                  <div className="doc-item-box" style={{ padding: '0.5rem' }}>
                    <span className="doc-field-label" style={{ fontSize: '0.65rem' }}>ESTADO APTO</span>
                    <select
                      value={dates.apto_medico_estado}
                      onChange={(e) => {
                        const val = e.target.value;
                        setDates({ ...dates, apto_medico_estado: val });
                        updateField.mutate({ field: 'apto_medico_estado', value: val, docId });
                      }}
                      className="filter-search-input"
                      style={{ padding: '0.25rem 0.5rem', fontSize: '0.75rem', marginTop: '0.2rem' }}
                    >
                      <option value="Activo">Activo (Avalado)</option>
                      <option value="Vencido">Vencido (No Avalado)</option>
                      <option value="Observado">Observado</option>
                      <option value="Pendiente">Pendiente</option>
                    </select>
                  </div>

                  <div className="doc-item-box" style={{ padding: '0.5rem' }}>
                    <div className="doc-item-header" style={{ marginBottom: '0.2rem' }}>
                      <span className="doc-field-label" style={{ fontSize: '0.65rem' }}>VENC. APTO</span>
                      <span className={`doc-status-badge badge-${getBadgeState(dates.apto_medico_venc).type}`}>
                        {getBadgeState(dates.apto_medico_venc).label}
                      </span>
                    </div>
                    <div className="doc-input-row">
                      <input
                        type="date"
                        value={dates.apto_medico_venc}
                        onChange={(e) => setDates({ ...dates, apto_medico_venc: e.target.value })}
                        className="doc-date-input"
                        style={{ fontSize: '0.75rem', padding: '0.25rem 0.4rem' }}
                      />
                      <button
                        onClick={() => handleSaveIndividual('apto_medico_venc')}
                        className={`btn-save-individual ${savedField === 'apto_medico_venc' ? 'saved' : ''}`}
                        title="Guardar vencimiento de apto"
                        style={{ width: '28px', height: '28px' }}
                      >
                        {savedField === 'apto_medico_venc' ? <Check size={13} /> : <Save size={13} />}
                      </button>
                    </div>
                  </div>
                </div>

                {/* Nota de Documentación */}
                {(chofer?.obs_documentacion || docData?.obs_documentacion) && (
                  <div style={{ backgroundColor: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: '4px', padding: '0.4rem 0.6rem', fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
                    <strong>Nota:</strong> {chofer?.obs_documentacion || docData?.obs_documentacion}
                  </div>
                )}

              </DisclosurePanel>
            </Transition>
          </>
        )}
      </Disclosure>

    </div>
  );
};
