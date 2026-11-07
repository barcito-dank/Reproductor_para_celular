import React, { useState, useEffect, useCallback, useRef } from 'react'

export default function ExtractorModal({ isOpen, onClose }) {
  const [url, setUrl] = useState('')
  const [statusMsg, setStatusMsg] = useState(null)
  const [isLaunching, setIsLaunching] = useState(false)
  const inputRef = useRef(null)

  // Al abrir el modal, auto-detectar si el portapapeles contiene un enlace musical válido
  useEffect(() => {
    if (isOpen) {
      setStatusMsg(null)
      setIsLaunching(false)
      setTimeout(() => inputRef.current?.focus(), 60)

      if (navigator.clipboard?.readText) {
        navigator.clipboard.readText()
          .then((text) => {
            if (text && typeof text === 'string') {
              const trimmed = text.trim()
              if (/^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be|music\.youtube\.com|spotify\.com|open\.spotify\.com|tiktok\.com)/i.test(trimmed)) {
                setUrl(trimmed)
                setStatusMsg('📋 Enlace detectado en el portapapeles y preparado automáticamente.')
              }
            }
          })
          .catch(() => {})
      }
    }
  }, [isOpen])

  const handlePasteClipboard = useCallback(async () => {
    try {
      const text = await navigator.clipboard?.readText?.()
      if (text) {
        setUrl(text.trim())
        setStatusMsg('✓ Enlace pegado desde el portapapeles.')
      }
    } catch (_) {
      setStatusMsg('⚠ No se pudo acceder al portapapeles automáticamente.')
    }
  }, [])

  const handleLaunchExtractor = useCallback(async (e) => {
    if (e) e.preventDefault()
    setIsLaunching(true)
    setStatusMsg('🚀 Lanzando Extractor & Organizador de Audio...')

    try {
      const res = await window.electronAPI?.launchExtractor?.({ url: url.trim() })
      if (res && res.success) {
        setStatusMsg('✓ ¡Extractor de Música iniciado! El enlace ha sido copiado al portapapeles.')
        setTimeout(() => {
          onClose()
        }, 1800)
      } else {
        setStatusMsg(`⚠ ${res?.error || 'No se pudo iniciar el extractor. Verifica que esté instalado.'}`)
      }
    } catch (err) {
      setStatusMsg(`⚠ Error: ${err.message}`)
    } finally {
      setIsLaunching(false)
    }
  }, [url, onClose])

  if (!isOpen) return null

  return (
    <div className="track-modal-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div
        className="track-modal-box extractor-modal-box"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: '540px' }}
      >
        <div className="track-modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '20px' }}>⚡</span>
            <div>
              <h3 style={{ margin: 0, fontSize: '16px', fontWeight: '700' }}>Descargar / Pegar Enlace</h3>
              <p style={{ margin: 0, fontSize: '12px', color: 'var(--text-dim)' }}>
                Extracción con metadatos oficiales y Hard Links hacia <code>Canciones_reales</code>
              </p>
            </div>
          </div>
          <button type="button" className="track-modal-close" onClick={onClose}>✕</button>
        </div>

        <form onSubmit={handleLaunchExtractor} className="extractor-modal-body">
          <div className="extractor-platforms-badge">
            <span className="platform-tag youtube">YouTube</span>
            <span className="platform-tag ytmusic">YouTube Music</span>
            <span className="platform-tag spotify">Spotify</span>
            <span className="platform-tag tiktok">TikTok</span>
          </div>

          <label className="extractor-input-label" htmlFor="extractor-url-input">
            Enlace de canción, álbum o playlist:
          </label>
          <div className="extractor-input-wrapper">
            <input
              id="extractor-url-input"
              ref={inputRef}
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://open.spotify.com/track/... o https://youtu.be/..."
              className="extractor-url-field"
              autoComplete="off"
              spellCheck="false"
            />
            <button
              type="button"
              className="extractor-paste-btn"
              onClick={handlePasteClipboard}
              title="Pegar enlace del portapapeles"
            >
              📋 Pegar
            </button>
          </div>

          {statusMsg && (
            <div className={`extractor-status-notice ${statusMsg.startsWith('✓') ? 'success' : statusMsg.startsWith('⚠') ? 'warning' : 'info'}`}>
              {statusMsg}
            </div>
          )}

          <div className="extractor-info-card">
            <div className="extractor-info-item">
              <span className="extractor-info-icon">💎</span>
              <div>
                <strong>Audio de Estudio + ID3v2.3:</strong> Resuelve versiones oficiales en YouTube Music / Topic y enriquece con carátulas HD y letras sincronizadas (LRCLIB).
              </div>
            </div>
            <div className="extractor-info-item">
              <span className="extractor-info-icon">🔗</span>
              <div>
                <strong>Integración NTFS Automática:</strong> El archivo se descarga en <code>Canciones_reales</code> y se enlaza a <code>canciones_organizadas</code> sin ocupar espacio adicional.
              </div>
            </div>
          </div>

          <div className="extractor-modal-actions">
            <button
              type="button"
              className="extractor-btn-cancel"
              onClick={onClose}
              disabled={isLaunching}
            >
              Cancelar
            </button>
            <button
              type="submit"
              className="extractor-btn-submit"
              disabled={isLaunching}
            >
              {isLaunching ? 'Lanzando...' : '🚀 Abrir en Extractor'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
