import React, { useState } from 'react';
import { Disclosure, DisclosureButton, DisclosurePanel, Transition } from '@headlessui/react';
import { ChevronDown, ChevronUp, Copy, Check, MessageCircle, AlertTriangle, Truck, ExternalLink, Calendar, ShieldAlert } from 'lucide-react';
import { getDriverDayStatus, calculateDriverReturn } from '../hooks/useDailyDrivers';
import { UnitAssignModal } from '@/features/flota/components/UnitAssignModal';
import { copyToClipboard } from '@/utils/clipboard';

export const DailyDriverCard = ({ driver, fechaContexto, kmInfo, onSelectDriver }) => {
  const [copiedField, setCopiedField] = useState(null);
  const [isAssignModalOpen, setIsAssignModalOpen] = useState(false);

  // 1. Estado del día y fatiga para la fecha contexto
  const dayStatus = getDriverDayStatus(driver, fechaContexto);
  const displayDate = driver.dia_fecha || fechaContexto || new Date().toISOString().substring(0, 10);
  // Retorno de personal (prioriza cálculo relacional del servidor, fallback a función legacy)
  const returnInfo = driver.retorno_info
    ? {
        date: driver.retorno_info.fecha_retorno,
        diffDays: driver.retorno_info.retorna_cuando === 'HOY' ? 0 : 1,
        returnsToday: driver.retorno_info.retorna_cuando === 'HOY',
      }
    : calculateDriverReturn(driver, fechaContexto);

  // 2. Formato de teléfono para WhatsApp (Argentina: +54 9 ...)
  const formatWhatsApp = (tel) => {
    if (!tel) return null;
    let clean = String(tel).replace(/\D/g, '');
    if (clean.length < 6) return null;
    if (!clean.startsWith('54')) clean = '549' + clean;
    return `https://wa.me/${clean}`;
  };
  const wspLink = formatWhatsApp(driver.telefono);

  // 3. Copiar al portapapeles con feedback
  const handleCopy = async (text, fieldName, e) => {
    if (e) {
      e.stopPropagation();
      e.preventDefault();
    }
    const ok = await copyToClipboard(text, fieldName, e);
    if (ok) {
      setCopiedField(fieldName);
      setTimeout(() => setCopiedField(null), 1800);
    }
  };

  // 4. Semáforo cromático del Badge de Estado
  const getBadgeStyle = () => {
    if (dayStatus.type === 'FRANCO') {
      return { backgroundColor: '#b6d7a8', color: '#14532d', border: '1px solid #86efac' };
    }
    if (dayStatus.type === 'VACACIONES') {
      return { backgroundColor: '#ffe599', color: '#78350f', border: '1px solid #fde047' };
    }
    if (dayStatus.type === 'LICENCIA') {
      return { backgroundColor: '#fee2e2', color: '#991b1b', border: '1px solid #fca5a5' };
    }
    if (dayStatus.type === 'OPERATIVO') {
      const cons = dayStatus.cons;
      if (cons >= 22) {
        return { backgroundColor: '#fef2f2', color: '#dc2626', border: '2.5px solid #ef4444', fontWeight: 900 };
      }
      if (cons >= 18) {
        return { backgroundColor: '#fff7ed', color: '#c2410c', border: '2.5px solid #f97316', fontWeight: 900 };
      }
      return { backgroundColor: '#eff6ff', color: '#1d4ed8', border: '2px solid #3b82f6', fontWeight: 800 };
    }
    return { backgroundColor: 'var(--bg-surface-muted)', color: 'var(--text-muted)', border: '1px solid var(--border-subtle)' };
  };

  // Helper para fechas legibles
  const fmtDate = (d) => {
    if (!d) return 'S/D';
    return String(d).substring(0, 10).split('-').reverse().join('/');
  };

  // 5. Avatar fallback
  const avatarFallback = `https://ui-avatars.com/api/?name=${encodeURIComponent(driver.nombre)}&background=2563eb&color=fff&size=80`;

  return (
    <div className="daily-driver-card">
      <Disclosure>
        {({ open }) => (
          <>
            {/* Cabecera Principal de la Tarjeta */}
            <div className="daily-card-main-row">
              {/* Bloque Izquierdo: Foto + Datos del Chofer */}
              <div className="daily-card-driver-info">
                {/* Foto / Avatar con enlace al módulo individual */}
                <div
                  className="daily-card-avatar-wrap"
                  onClick={() => onSelectDriver && onSelectDriver(driver.chofer_id)}
                  title={`Ver ficha completa de ${driver.nombre}`}
                >
                  <img
                    src={driver.foto || avatarFallback}
                    alt={driver.nombre}
                    className="daily-card-avatar-img"
                    onError={(e) => { e.target.src = avatarFallback; }}
                    loading="lazy"
                  />
                </div>

                <div className="daily-card-meta">
                  {/* Nombre con EasyCopy estilo legacy (badge dashed 0.5px) */}
                  {/* Nombre con EasyCopy estilo legacy (badge dashed 1px) y WhatsApp */}
                  <div className="daily-card-name-row">
                    <div
                      role="button"
                      tabIndex={0}
                      className={`badge-easycopy-name ${copiedField === 'nombre' ? 'copied' : ''}`}
                      onClick={(e) => handleCopy(driver.nombre, 'Nombre', e)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') handleCopy(driver.nombre, 'Nombre', e);
                      }}
                      title={`Clic para copiar Nombre: ${driver.nombre}`}
                      aria-label={`Copiar nombre: ${driver.nombre}`}
                    >
                      <h3 className="daily-card-name" style={{ margin: 0, whiteSpace: 'nowrap' }}>
                        {driver.nombre}
                      </h3>
                      {copiedField === 'nombre' ? (
                        <Check size={13} color="#059669" />
                      ) : (
                        <Copy size={12} className="easycopy-icon" />
                      )}
                    </div>

                    {wspLink && (
                      <a
                        href={wspLink}
                        target="_blank"
                        rel="noreferrer"
                        className="btn-whatsapp-mini"
                        title={`WhatsApp: ${driver.telefono}`}
                        aria-label={`Enviar WhatsApp a ${driver.nombre}`}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <MessageCircle size={12} />
                        <span>Chat</span>
                      </a>
                    )}
                  </div>

                  {/* Chips: Servicio, Legajo, DNI (EasyCopy) */}
                  <div className="daily-card-chips">
                    <span className="chip-badge chip-service">{driver.servicio || 'GENERAL'}</span>
                    <span className="chip-badge chip-legajo">LEG: {driver.legajo || 'S/D'}</span>

                    {/* DNI EasyCopy */}
                    {driver.dni && (
                      <span
                        role="button"
                        tabIndex={0}
                        className={`badge-easycopy ${copiedField === 'dni' ? 'copied' : ''}`}
                        onClick={(e) => handleCopy(driver.dni, 'DNI', e)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') handleCopy(driver.dni, 'DNI', e);
                        }}
                        title={`Clic para copiar DNI: ${driver.dni}`}
                        aria-label={`Copiar DNI: ${driver.dni}`}
                      >
                        <span>DNI: {driver.dni}</span>
                        {copiedField === 'dni' ? (
                          <Check size={11} color="#059669" />
                        ) : (
                          <Copy size={10} className="easycopy-icon" />
                        )}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Bloque Central: Unidad Asignada (Tractor y Semi con EasyCopy + Reasignador + UTE) */}
              <div className="daily-card-unit-box">
                {driver.tractor || driver.semi || driver.n_ute ? (
                  <>
                    <div
                      role="button"
                      tabIndex={0}
                      className={`unit-badge-pill ${copiedField === 'tractor' ? 'copied' : ''}`}
                      onClick={(e) => handleCopy(driver.tractor, 'Tractor', e)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') handleCopy(driver.tractor, 'Tractor', e);
                      }}
                      title={`Clic para copiar Tractor: ${driver.tractor || '—'}`}
                      aria-label={`Copiar Tractor: ${driver.tractor || '—'}`}
                    >
                      <span className="unit-label">TRAC</span>
                      <span className="unit-val font-mono">{driver.tractor || '—'}</span>
                      {copiedField === 'tractor' ? (
                        <Check size={11} color="#059669" />
                      ) : (
                        <Copy size={10} className="easycopy-icon" />
                      )}
                    </div>

                    <div
                      role="button"
                      tabIndex={0}
                      className={`unit-badge-pill ${copiedField === 'semi' ? 'copied' : ''}`}
                      onClick={(e) => handleCopy(driver.semi, 'Semi', e)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') handleCopy(driver.semi, 'Semi', e);
                      }}
                      title={`Clic para copiar Semi: ${driver.semi || '—'}`}
                      aria-label={`Copiar Semi: ${driver.semi || '—'}`}
                    >
                      <span className="unit-label">SEMI</span>
                      <span className="unit-val font-mono">{driver.semi || '—'}</span>
                      {copiedField === 'semi' ? (
                        <Check size={11} color="#059669" />
                      ) : (
                        <Copy size={10} className="easycopy-icon" />
                      )}
                    </div>

                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setIsAssignModalOpen(true);
                      }}
                      className="btn-assign-gear-mini"
                      title="Cambiar o reasignar tractor / semi"
                      aria-label="Cambiar o reasignar tractor o semi"
                    >
                      <Truck size={12} />
                    </button>

                    {driver.n_ute && (
                      <div
                        role="button"
                        tabIndex={0}
                        className={`unit-badge-pill ${copiedField === 'n_ute' ? 'copied' : ''}`}
                        onClick={(e) => handleCopy(driver.n_ute, 'UTE', e)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') handleCopy(driver.n_ute, 'UTE', e);
                        }}
                        title={`Clic para copiar UTE: ${driver.n_ute}`}
                        aria-label={`Copiar UTE: ${driver.n_ute}`}
                      >
                        <span className="unit-label">UTE:</span>
                        <span className="unit-val font-mono">{driver.n_ute}</span>
                        {copiedField === 'n_ute' ? (
                          <Check size={11} color="#059669" />
                        ) : (
                          <Copy size={10} className="easycopy-icon" />
                        )}
                      </div>
                    )}
                  </>
                ) : (
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation();
                      setIsAssignModalOpen(true);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.stopPropagation();
                        setIsAssignModalOpen(true);
                      }
                    }}
                    className="btn-assign-unit-dashed"
                    title="Asignar unidad operativa a este chofer"
                    aria-label="Asignar unidad operativa a este chofer"
                  >
                    <Truck size={13} />
                    <span>+ Asignar</span>
                  </div>
                )}
              </div>

              {/* Bloque Derecho: Alertas + Badge de Estado del Día + Toggle Acordeón */}
              <div className="daily-card-right-box">
                {/* Alertas Minimalistas */}
                <div className="daily-card-alerts">
                  {/* Badge Legacy: Retorna Hoy / Vuelve en Xd */}
                  {returnInfo && (
                    <span
                      className="badge-retorno-legacy"
                      title={returnInfo.returnsToday ? 'El conductor retoma actividades hoy' : `Retoma servicio el ${returnInfo.date.substring(5).replace('-', '/')}`}
                    >
                      {returnInfo.returnsToday ? '🔄 Retorna HOY' : `🔄 Vuelve en ${returnInfo.diffDays}d`}
                    </span>
                  )}
                  {driver.alerta_docs_chofer === 'VENCIDO' && (
                    <span className="alert-mini-pill alert-red" title="Documentación del chofer vencida">
                      🔴 DOCS
                    </span>
                  )}
                  {driver.alerta_docs_chofer === 'POR_VENCER' && (
                    <span className="alert-mini-pill alert-amber" title="Documentación del chofer por vencer (<30d)">
                      🟡 DOCS
                    </span>
                  )}
                  {driver.alerta_docs_unidad === 'VENCIDO' && (
                    <span className="alert-mini-pill alert-red" title="VTV o MASS de la unidad vencido">
                      🚚 UNIDAD
                    </span>
                  )}
                  {driver.alerta_docs_unidad === 'POR_VENCER' && (
                    <span className="alert-mini-pill alert-amber" title="VTV o MASS de la unidad por vencer (<15d)">
                      🚚 UNIDAD
                    </span>
                  )}
                  {kmInfo && kmInfo.km_totales > 0 && (
                    <div
                      className="daily-km-badge"
                      title={`Viaje hoy: ${kmInfo.km_totales} km${kmInfo.hoja_ruta ? ' (HR: ' + kmInfo.hoja_ruta + ')' : ''}`}
                    >
                      <span className="daily-km-icon">⚡</span>
                      <span className="daily-km-val">{kmInfo.km_totales} km</span>
                      {kmInfo.hoja_ruta && (
                        <span className="daily-km-hr">HR {kmInfo.hoja_ruta}</span>
                      )}
                    </div>
                  )}
                </div>

                {/* Badge Principal del Estado del Día (Fatiga / F / V / IND) */}
                <div
                  className={`daily-day-badge day-badge-${dayStatus.type ? dayStatus.type.toLowerCase() : 'default'} ${dayStatus.cons >= 22 ? 'fatiga-crit' : dayStatus.cons >= 18 ? 'fatiga-warn' : ''}`}
                  style={getBadgeStyle()}
                  title={`Estado: ${dayStatus.raw} (${dayStatus.type}) • Fecha: ${displayDate}${driver.diagrama_tipo ? ' • Tipo: ' + driver.diagrama_tipo : ''}`}
                >
                  <span className="daily-day-badge-val">{dayStatus.raw}</span>
                  <span className="daily-day-badge-date">
                    {displayDate.substring(5).replace('-', '/')}
                  </span>
                </div>

                {/* Botón Acordeón Desplegable */}
                <DisclosureButton className="btn-card-accordion-toggle" title="Ver detalle de vencimientos y métricas" aria-label="Desplegar detalle de conductor">
                  {open ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
                </DisclosureButton>
              </div>
            </div>

            {/* Panel Desplegable con Acordeón (Detalle Completo) */}
            <Transition
              enter="transition duration-150 ease-out"
              enterFrom="transform scale-98 opacity-0"
              enterTo="transform scale-100 opacity-100"
              leave="transition duration-100 ease-out"
              leaveFrom="transform scale-100 opacity-100"
              leaveTo="transform scale-98 opacity-0"
            >
              <DisclosurePanel className="daily-card-expanded-body">
                <div className="daily-expanded-grid">
                  {/* Columna 1: Documentación del Conductor */}
                  <div className="expanded-section-box">
                    <h4 className="expanded-box-title">Documentación Conductor</h4>
                    <div className="expanded-doc-rows">
                      <div className="expanded-doc-row">
                        <span>Periódico:</span>
                        <strong className="font-mono">{fmtDate(driver.venc_periodico)}</strong>
                      </div>
                      <div className="expanded-doc-row">
                        <span>Licencia Nac.:</span>
                        <strong className="font-mono">{fmtDate(driver.venc_licencia_nacional)}</strong>
                      </div>
                      <div className="expanded-doc-row">
                        <span>Certificado M.P:</span>
                        <strong className="font-mono">{fmtDate(driver.venc_cargas_peligrosas)}</strong>
                      </div>
                      <div className="expanded-doc-row">
                        <span>Apto Médico:</span>
                        <strong className="font-mono">{fmtDate(driver.apto_medico_venc)}</strong>
                      </div>
                    </div>
                  </div>

                  {/* Columna 2: Vencimientos de la Unidad */}
                  <div className="expanded-section-box">
                    <h4 className="expanded-box-title">Vencimientos Unidad</h4>
                    {driver.tractor || driver.semi || driver.n_ute ? (
                      <div className="expanded-doc-rows">
                        <div className="expanded-doc-row">
                          <span>VTV Tractor:</span>
                          <strong className="font-mono">{fmtDate(driver.vtv_tr)}</strong>
                        </div>
                        <div className="expanded-doc-row">
                          <span>MASS Tractor:</span>
                          <strong className="font-mono">{fmtDate(driver.mas_tr)}</strong>
                        </div>
                        <div className="expanded-doc-row">
                          <span>VTV Semi:</span>
                          <strong className="font-mono">{fmtDate(driver.vtv_semi)}</strong>
                        </div>
                        <div className="expanded-doc-row">
                          <span>MASS Semi:</span>
                          <strong className="font-mono">{fmtDate(driver.mas_semi)}</strong>
                        </div>
                      </div>
                    ) : (
                      <div style={{ color: 'var(--text-muted)', fontSize: '0.8rem', fontStyle: 'italic', padding: '0.75rem 0', display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                        <span>⚪ Conductor sin unidad asignada (disponible)</span>
                      </div>
                    )}
                  </div>

                  {/* Columna 3: Acceso a Ficha Individual */}
                  <div className="expanded-section-box expanded-action-box">
                    <button
                      type="button"
                      onClick={() => onSelectDriver && onSelectDriver(driver.chofer_id)}
                      className="btn-ver-ficha-individual"
                    >
                      <ExternalLink size={14} />
                      <span>Ver Ficha Individual</span>
                    </button>
                  </div>
                </div>
              </DisclosurePanel>
            </Transition>
          </>
        )}
      </Disclosure>

      {/* Modal Headless UI de Asignación / Desasignación con Doble Persistencia */}
      <UnitAssignModal
        isOpen={isAssignModalOpen}
        onClose={() => setIsAssignModalOpen(false)}
        driver={driver}
      />
    </div>
  );
};
