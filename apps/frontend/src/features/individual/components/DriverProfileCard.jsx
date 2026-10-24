import React, { useState, useRef, useEffect } from 'react';
import { Camera, Check, Copy, Link as LinkIcon, MessageCircle, User } from 'lucide-react';
import { supabase } from '@/api/supabaseClient';
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/api/queryKeys';
import { copyToClipboard } from '@/utils/clipboard';
import { convertImageToWebP } from '@/utils/imageToWebp';

export const DriverProfileCard = ({ chofer }) => {
  const [copiedField, setCopiedField] = useState(null);
  const [isUploading, setIsUploading] = useState(false);
  const [optimisticPhotoUrl, setOptimisticPhotoUrl] = useState(null);
  const fileInputRef = useRef(null);
  const queryClient = useQueryClient();

  useEffect(() => {
    setOptimisticPhotoUrl(null);
  }, [chofer?.chofer_id, chofer?.id]);

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
    const choferId = chofer.chofer_id || chofer.id;
    const url = new URL('/individual', window.location.origin);
    url.searchParams.set('chofer', choferId);
    await handleCopy(url.toString(), 'link', e);
  };

  const handlePhotoUpload = async (e) => {
    const file = e.target.files?.[0];
    if (e.target) e.target.value = '';
    if (!file || !chofer) return;

    try {
      setIsUploading(true);

      // 1. Convertir cualquier formato a WebP 3:4 (384x512)
      const { blob, previewUrl } = await convertImageToWebP(file, {
        maxWidth: 384,
        maxHeight: 512,
        quality: 0.82
      });

      // Reflejo optimista inmediato en la UI
      setOptimisticPhotoUrl(previewUrl);

      // 2. Definir nombre canónico: <DNI>.webp (o <chofer_id>.webp si no tiene DNI)
      const rawDni = chofer.dni ? String(chofer.dni).replace(/\D/g, '') : '';
      const choferId = chofer.chofer_id || chofer.id;
      const fileName = rawDni ? `${rawDni}.webp` : `${choferId}.webp`;

      // 3. Subir a Supabase Storage (Bucket: choferes-fotos)
      const { error: uploadErr } = await supabase.storage
        .from('choferes-fotos')
        .upload(fileName, blob, {
          contentType: 'image/webp',
          upsert: true,
          cacheControl: '3600'
        });

      if (uploadErr) {
        throw new Error(`Error en Storage: ${uploadErr.message}`);
      }

      // 4. Obtener URL pública canónica con timestamp anti-caché
      const { data: urlData } = supabase.storage
        .from('choferes-fotos')
        .getPublicUrl(fileName);

      const publicUrl = urlData?.publicUrl ? `${urlData.publicUrl}?t=${Date.now()}` : null;

      if (!publicUrl) {
        throw new Error('No se pudo generar la URL pública de la imagen.');
      }

      // 5. Persistir en la tabla choferes de Supabase
      const { error: dbErr } = await supabase
        .from('choferes')
        .update({
          foto: publicUrl,
          actualizado_el: new Date().toISOString()
        })
        .eq('id', choferId);

      if (dbErr) {
        throw new Error(`Error al actualizar tabla choferes: ${dbErr.message}`);
      }

      // 6. Notificar al backend de forma asíncrona para actualizar caché RAM y respaldo en Sheets
      try {
        fetch('/api/subir-foto', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            dni: rawDni || chofer.dni,
            chofer_id: choferId,
            fotoUrl: publicUrl
          })
        }).catch(() => {});
      } catch (_) {}

      // 7. Invalidar queries para refrescar estado en React Query
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.individual.catalog }),
        queryClient.invalidateQueries({ queryKey: queryKeys.individual.detail(choferId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.diaria.all })
      ]);
    } catch (err) {
      console.error('❌ Error al procesar o subir foto:', err);
      alert(`No se pudo actualizar la foto: ${err.message || err}`);
      setOptimisticPhotoUrl(null);
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
          {optimisticPhotoUrl || chofer.foto ? (
            <img
              src={optimisticPhotoUrl || chofer.foto}
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
                color: copiedField === 'link' ? 'var(--novedad-v-text)' : 'var(--text-muted)',
                display: 'inline-flex',
                alignItems: 'center',
                padding: '0.2rem',
                transition: 'color 0.15s ease'
              }}
            >
              {copiedField === 'link' ? <Check size={18} color="currentColor" /> : <LinkIcon size={18} />}
            </button>
          </div>

          {/* LÍNEA 2: ALTA • DNI • EMAIL • TEL • CHAT */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
            <span>
              ALTA: <strong>{formatAltaDate(chofer.fecha_alta)}</strong>
            </span>

            <span style={{ opacity: 0.4 }}>•</span>

            <span
              role="button"
              tabIndex={0}
              className={`badge-easycopy ${copiedField === 'dni' ? 'copied' : ''}`}
              onClick={(e) => handleCopy(chofer.dni, 'dni', e)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') handleCopy(chofer.dni, 'dni', e);
              }}
              title="Clic para copiar DNI"
              aria-label={`Copiar DNI: ${chofer.dni || 'S/D'}`}
              style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '0.25rem' }}
            >
              <span>DNI: <strong>{chofer.dni || 'S/D'}</strong></span>
              {copiedField === 'dni' ? <Check size={11} color="currentColor" /> : <Copy size={11} className="easycopy-icon" />}
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
                title={`Abrir WhatsApp con ${chofer.telefono}`}
                aria-label={`Abrir WhatsApp con ${chofer.telefono}`}
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
                role="button"
                tabIndex={0}
                className={`driver-unit-prop-val badge-easycopy ${copiedField === 'n_ute' ? 'copied' : ''}`}
                onClick={(e) => handleCopy(chofer.n_ute, 'n_ute', e)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') handleCopy(chofer.n_ute, 'n_ute', e);
                }}
                title={`Copiar UTE: ${chofer.n_ute || '-'}`}
                aria-label={`Copiar UTE: ${chofer.n_ute || '-'}`}
              >
                <span>{chofer.n_ute || '-'}</span>
                {copiedField === 'n_ute' ? <Check size={12} color="currentColor" /> : <Copy size={11} className="easycopy-icon" />}
              </span>
            </div>

            {/* Columna 2: TRACTOR (Dashed Badge Copiable) */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
              <span className="driver-unit-prop-label" style={{ fontSize: '0.68rem', fontWeight: 800, textTransform: 'uppercase', color: 'var(--text-muted)' }}>
                TRACTOR
              </span>
              <span
                role="button"
                tabIndex={0}
                className={`driver-unit-prop-val badge-easycopy ${copiedField === 'tractor' ? 'copied' : ''}`}
                onClick={(e) => handleCopy(chofer.tractor, 'tractor', e)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') handleCopy(chofer.tractor, 'tractor', e);
                }}
                title={`Copiar Tractor: ${chofer.tractor || '-'}`}
                aria-label={`Copiar Tractor: ${chofer.tractor || '-'}`}
              >
                <span>{chofer.tractor || '-'}</span>
                {copiedField === 'tractor' ? <Check size={12} color="currentColor" /> : <Copy size={11} className="easycopy-icon" />}
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
                role="button"
                tabIndex={0}
                className={`driver-unit-prop-val badge-easycopy ${copiedField === 'semi' ? 'copied' : ''}`}
                onClick={(e) => handleCopy(chofer.semi, 'semi', e)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') handleCopy(chofer.semi, 'semi', e);
                }}
                title={`Copiar Semi: ${chofer.semi || '-'}`}
                aria-label={`Copiar Semi: ${chofer.semi || '-'}`}
              >
                <span>{chofer.semi || '-'}</span>
                {copiedField === 'semi' ? <Check size={12} color="currentColor" /> : <Copy size={11} className="easycopy-icon" />}
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
              <span className="driver-unit-service-badge">
                {chofer.servicio || 'GENERAL'}
              </span>
            </div>

          </div>

        </div>

      </div>

    </div>
  );
};
