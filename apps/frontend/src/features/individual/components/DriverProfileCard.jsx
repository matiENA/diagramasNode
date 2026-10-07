import React, { useState, useRef } from 'react';
import { Camera, Check, Copy, Link as LinkIcon, MessageCircle, User } from 'lucide-react';
import { supabase } from '@/api/supabaseClient';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/api/queryKeys';
import { copyToClipboard } from '@/utils/clipboard';

export const DriverProfileCard = ({ chofer }) => {
  const [copiedField, setCopiedField] = useState(null);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef(null);
  const queryClient = useQueryClient();

  if (!chofer) return null;

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

  const handleCopyLink = async (e) => {
    const url = new URL(window.location.href);
    url.searchParams.set('chofer', chofer.chofer_id || chofer.id);
    await handleCopy(url.toString(), 'link', e);
  };

  const handlePhotoUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file || !chofer) return;

    try {
      setIsUploading(true);
      const ext = file.name.split('.').pop() || 'webp';
      const fileName = `${chofer.dni || chofer.chofer_id || chofer.id}.${ext}`;
      const filePath = `${fileName}`;

      const { error: uploadErr } = await supabase.storage
        .from('choferes-fotos')
        .upload(filePath, file, { upsert: true });

      if (uploadErr) {
        console.warn('Error subiendo imagen al storage:', uploadErr.message);
      }

      const { data: urlData } = supabase.storage
        .from('choferes-fotos')
        .getPublicUrl(filePath);

      const publicUrl = urlData?.publicUrl;

      if (publicUrl) {
        await supabase
          .from('choferes')
          .update({ foto: publicUrl })
          .eq('id', chofer.chofer_id || chofer.id);

        queryClient.invalidateQueries({ queryKey: queryKeys.individual.catalog });
        queryClient.invalidateQueries({ queryKey: queryKeys.individual.detail(chofer.chofer_id || chofer.id) });
        queryClient.invalidateQueries({ queryKey: queryKeys.diaria.all });
      }
    } catch (err) {
      console.error('Error al procesar foto:', err);
    } finally {
      setIsUploading(false);
    }
  };

  // Limpieza de teléfono para WhatsApp
  const rawTel = chofer.telefono || '';
  const numLimpio = rawTel.replace(/\D/g, '');
  const wspNum = numLimpio.startsWith('54') ? numLimpio : `549${numLimpio}`;
  const wspLink = numLimpio.length >= 8 ? `https://wa.me/${wspNum}` : null;

  // Formato de Alta (ej: "3 DEC 2024")
  const formatAltaDate = (dateVal) => {
    if (!dateVal) return 'S/D';
    try {
      const d = new Date(dateVal);
      const months = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];
      return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    } catch {
      return String(dateVal).substring(0, 10);
    }
  };

  return (
    <div className="driver-profile-card-master" style={{
      backgroundColor: 'var(--bg-surface)',
      border: '1px solid var(--border-subtle)',
      borderRadius: 'var(--radius-lg, 16px)',
      overflow: 'hidden',
      boxShadow: 'var(--shadow-sm)'
    }}>
      
      {/* 1. SECCIÓN PRINCIPAL: FOTO + DATOS + METRICAS + UNIDADES */}
      <div style={{
        padding: '1.5rem',
        display: 'flex',
        gap: '1.5rem',
        alignItems: 'start',
        flexWrap: 'wrap'
      }}>
        
        {/* A. AVATAR 3:4 WEBP */}
        <div
          className="driver-avatar-wrapper"
          style={{ width: '135px', maxWidth: '135px', aspectRatio: '3 / 4', flexShrink: 0, borderRadius: '12px' }}
          onClick={() => fileInputRef.current?.click()}
          title="Clic para cambiar foto de perfil"
        >
          {chofer.foto ? (
            <img
              src={chofer.foto}
              alt={chofer.nombre}
              className="driver-avatar-img"
              onError={(e) => {
                e.currentTarget.style.display = 'none';
              }}
            />
          ) : (
            <div style={{ color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.35rem' }}>
              <User size={42} />
              <span style={{ fontSize: '0.68rem', fontWeight: 700 }}>Sin Foto</span>
            </div>
          )}

          {/* Overlay Hover */}
          <div className="driver-avatar-overlay">
            <span className="driver-avatar-btn-label" style={{ fontSize: '0.65rem', padding: '0.25rem 0.5rem' }}>
              <Camera size={13} />
              <span>{isUploading ? 'Subiendo...' : 'Cambiar'}</span>
            </span>
            <span style={{ fontSize: '0.6rem', color: '#ffffff', opacity: 0.9 }}>WebP</span>
          </div>

          <span className="driver-avatar-badge-webp">3:4</span>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={handlePhotoUpload}
          />
        </div>

        {/* B. INFORMACIÓN IDENTIFICATORIA Y OPERATIVA */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '0.75rem', minWidth: '320px' }}>
          
          {/* LÍNEA 1: NOMBRE COMPLETO + ICONO LINK COPIAR */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
            <h1
              className="driver-full-name"
              onClick={(e) => handleCopy(chofer.nombre, 'nombre', e)}
              title="Clic para copiar nombre"
              style={{
                fontSize: '1.45rem',
                fontWeight: 900,
                color: 'var(--text-main)',
                margin: 0,
                letterSpacing: '-0.02em',
                cursor: 'pointer'
              }}
            >
              {chofer.nombre}
            </h1>

            <button
              onClick={handleCopyLink}
              title="Copiar enlace permanente del conductor"
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                color: copiedField === 'link' ? '#059669' : 'var(--text-muted)',
                display: 'inline-flex',
                alignItems: 'center',
                padding: '0.2rem',
                transition: 'color 0.15s ease'
              }}
            >
              {copiedField === 'link' ? <Check size={18} color="#059669" /> : <LinkIcon size={18} />}
            </button>
          </div>

          {/* LÍNEA 2: LEGAJO • ALTA • DNI • EMAIL • TEL • CHAT */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            <span>
              LEGAJO: <strong>{chofer.legajo || 'S/D'}</strong>
            </span>

            <span style={{ opacity: 0.4 }}>•</span>

            <span>
              ALTA: <strong>{formatAltaDate(chofer.fecha_alta)}</strong>
            </span>

            <span style={{ opacity: 0.4 }}>•</span>

            <span
              className={`badge-easycopy ${copiedField === 'dni' ? 'copied' : ''}`}
              onClick={(e) => handleCopy(chofer.dni, 'dni', e)}
              title="Clic para copiar DNI"
              style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}
            >
              <span>DNI: <strong>{chofer.dni || 'S/D'}</strong></span>
              {copiedField === 'dni' ? <Check size={11} color="#059669" /> : <Copy size={11} className="easycopy-icon" />}
            </span>

            {chofer.email && (
              <>
                <span style={{ opacity: 0.4 }}>•</span>
                <span style={{ color: 'var(--text-muted)' }}>{chofer.email}</span>
              </>
            )}

            {chofer.telefono && (
              <>
                <span style={{ opacity: 0.4 }}>•</span>
                <span>TEL: <strong>{chofer.telefono}</strong></span>
              </>
            )}

            {wspLink && (
              <a
                href={wspLink}
                target="_blank"
                rel="noreferrer"
                className="btn-whatsapp-chat"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '0.3rem',
                  backgroundColor: '#ecfdf5',
                  color: '#059669',
                  border: '1px solid #a7f3d0',
                  padding: '0.2rem 0.6rem',
                  borderRadius: 'var(--radius-sm, 6px)',
                  fontWeight: 800,
                  fontSize: '0.74rem',
                  textDecoration: 'none'
                }}
                title={`Abrir WhatsApp con ${chofer.telefono}`}
              >
                <MessageCircle size={14} />
                <span>CHAT</span>
              </a>
            )}
          </div>

          {/* LÍNEA 3: 4 COLUMNAS DE UNIDAD (N° UTE INTERNO, TRACTOR, SEMI, SERVICIO) */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
            gap: '1rem',
            paddingTop: '0.65rem',
            borderTop: '1px solid var(--border-subtle)',
            marginTop: '0.2rem'
          }}>
            
            {/* Columna 1: N° UTE INTERNO (Dashed Badge Copiable) */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
              <span className="driver-unit-prop-label" style={{ fontSize: '0.68rem', fontWeight: 800, textTransform: 'uppercase', color: 'var(--text-muted)' }}>
                N° UTE INTERNO
              </span>
              <span
                className={`driver-unit-prop-val badge-easycopy ${copiedField === 'n_ute' ? 'copied' : ''}`}
                onClick={(e) => handleCopy(chofer.n_ute, 'n_ute', e)}
                title={`Copiar UTE: ${chofer.n_ute || '-'}`}
                style={{ fontSize: '0.88rem', border: '1px dashed #94a3b8', padding: '0.25rem 0.55rem', borderRadius: '4px' }}
              >
                <span>{chofer.n_ute || '-'}</span>
                {copiedField === 'n_ute' ? <Check size={12} color="#059669" /> : <Copy size={11} className="easycopy-icon" />}
              </span>
            </div>

            {/* Columna 2: TRACTOR (Dashed Badge Copiable) */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
              <span className="driver-unit-prop-label" style={{ fontSize: '0.68rem', fontWeight: 800, textTransform: 'uppercase', color: 'var(--text-muted)' }}>
                TRACTOR
              </span>
              <span
                className={`driver-unit-prop-val badge-easycopy ${copiedField === 'tractor' ? 'copied' : ''}`}
                onClick={(e) => handleCopy(chofer.tractor, 'tractor', e)}
                title={`Copiar Tractor: ${chofer.tractor || '-'}`}
                style={{ fontSize: '0.88rem', color: 'var(--primary)', border: '1px dashed #94a3b8', padding: '0.25rem 0.55rem', borderRadius: '4px' }}
              >
                <span>{chofer.tractor || '-'}</span>
                {copiedField === 'tractor' ? <Check size={12} color="#059669" /> : <Copy size={11} className="easycopy-icon" />}
              </span>
              {chofer.marca_tr && (
                <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>{chofer.marca_tr}</span>
              )}
            </div>

            {/* Columna 3: SEMI (Dashed Badge Copiable) */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
              <span className="driver-unit-prop-label" style={{ fontSize: '0.68rem', fontWeight: 800, textTransform: 'uppercase', color: 'var(--text-muted)' }}>
                SEMI
              </span>
              <span
                className={`driver-unit-prop-val badge-easycopy ${copiedField === 'semi' ? 'copied' : ''}`}
                onClick={(e) => handleCopy(chofer.semi, 'semi', e)}
                title={`Copiar Semi: ${chofer.semi || '-'}`}
                style={{ fontSize: '0.88rem', border: '1px dashed #94a3b8', padding: '0.25rem 0.55rem', borderRadius: '4px' }}
              >
                <span>{chofer.semi || '-'}</span>
                {copiedField === 'semi' ? <Check size={12} color="#059669" /> : <Copy size={11} className="easycopy-icon" />}
              </span>
              {chofer.marca_semi && (
                <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)' }}>
                  {chofer.marca_semi} {chofer.cisternado ? `(${chofer.cisternado})` : ''}
                </span>
              )}
            </div>

            {/* Columna 4: SERVICIO (Badge SÓLIDO, NO DASHED, NO COPIABLE) */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
              <span className="driver-unit-prop-label" style={{ fontSize: '0.68rem', fontWeight: 800, textTransform: 'uppercase', color: 'var(--text-muted)' }}>
                SERVICIO
              </span>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  padding: '0.25rem 0.75rem',
                  borderRadius: '4px',
                  backgroundColor: '#fffbeb',
                  border: '1px solid #fde68a',
                  color: '#92400e',
                  fontWeight: 900,
                  fontSize: '0.85rem',
                  textTransform: 'uppercase',
                  width: 'fit-content',
                  cursor: 'default',
                  userSelect: 'none'
                }}
              >
                {chofer.servicio || 'GENERAL'}
              </span>
            </div>

          </div>

        </div>

      </div>

    </div>
  );
};
