import React, { useState, useEffect, useRef } from 'react'
import { usePlayback, usePlayerTime } from '../context/PlayerContext'

function formatSeconds(sec) {
  if (sec === undefined || sec === null || isNaN(sec)) return ''
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

/**
 * Dock interactivo de letras sincronizadas (LRC / ID3 / Online Temporal).
 * Soporta modo compacto de 3 líneas con efecto de profundidad (pasada, actual y siguiente),
 * modo expandido con scroll automático y estado en tiempo real de búsqueda online.
 */
export default function LyricsDock({ isOpen, onClose, currentTrack, seekTo }) {
  const {
    currentLyrics,
    saveCurrentLyricsToDisk,
    deleteCurrentLyricsFromDisk,
    retryOnlineLyrics
  } = usePlayback()
  const { currentTime } = usePlayerTime()
  const [isExpanded, setIsExpanded] = useState(false)
  const [actionFeedback, setActionFeedback] = useState(null)
  const activeLineRef = useRef(null)
  const expandedListRef = useRef(null)

  const status = currentLyrics?.status || 'idle'
  const isLoadingLyrics = status === 'loading' || status === 'searching-online'
  const lines = currentLyrics?.lines || []
  const hasLines = lines.length > 0
  const isSynced = Boolean(currentLyrics?.synced && hasLines)
  const isTemporary = hasLines && !currentLyrics?.savedToDisk
  const isSavedOnDisk = hasLines && Boolean(currentLyrics?.savedToDisk)

  // Calcular índice de la línea activa en base al tiempo actual
  let activeIndex = -1
  if (isOpen && isSynced) {
    for (let i = 0; i < lines.length; i++) {
      if (currentTime >= lines[i].time) {
        activeIndex = i
      } else {
        break
      }
    }
  }

  useEffect(() => {
    setActionFeedback(null)
  }, [currentTrack?.path])

  // Cerrar con Escape
  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  // Desplazamiento automático en modo expandido únicamente cuando cambia la línea activa
  useEffect(() => {
    if (isOpen && isExpanded && activeLineRef.current && expandedListRef.current) {
      activeLineRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'center'
      })
    }
  }, [activeIndex, isExpanded, isOpen])

  if (!isOpen) return null

  const pastLine = activeIndex > 0 ? lines[activeIndex - 1] : null
  const currentLine =
    activeIndex >= 0
      ? lines[activeIndex]
      : hasLines
      ? { text: '♪ ... ♪', time: 0, isIntro: true }
      : null
  const nextLine =
    activeIndex + 1 < lines.length
      ? lines[activeIndex + 1]
      : activeIndex === -1 && hasLines
      ? lines[0]
      : null

  const handleLineClick = (line) => {
    if (line && line.time !== undefined && !line.isIntro) {
      seekTo(line.time)
    }
  }

  const handleSaveLrc = async () => {
    const res = await saveCurrentLyricsToDisk()
    if (res?.success) {
      setActionFeedback('Guardada e incrustada')
      setTimeout(() => setActionFeedback(null), 2500)
    } else if (res?.error) {
      setActionFeedback(res.error)
      setTimeout(() => setActionFeedback(null), 2500)
    }
  }

  const handleDeleteLrc = async () => {
    const res = await deleteCurrentLyricsFromDisk()
    if (res?.success) {
      setActionFeedback('Letra y tags eliminados')
      setTimeout(() => setActionFeedback(null), 2500)
    }
  }

  return (
    <aside
      className={`lyrics-dock ${isExpanded ? 'expanded' : ''}`}
      role="complementary"
      aria-label="Panel de letras"
      onClick={(e) => e.stopPropagation()}
    >
      {/* Barra superior con título, estado y controles */}
      <div className="lyrics-dock-header">
        <div className="lyrics-dock-title-group">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <line x1="12" y1="19" x2="12" y2="22" />
          </svg>
          <span className="lyrics-dock-track-title">
            {currentTrack?.title || 'Letras'}
          </span>
          {isLoadingLyrics && (
            <span className="lyrics-synced-badge searching">
              {status === 'searching-online' ? 'Buscando letra...' : 'Cargando...'}
            </span>
          )}
          {!isLoadingLyrics && isTemporary && (
            <span className="lyrics-synced-badge temp" title="Letra temporal en memoria (no modifica tus archivos)">
              Temporal
            </span>
          )}
          {!isLoadingLyrics && isSavedOnDisk && (
            <span className="lyrics-synced-badge" title="Letra guardada en archivo .lrc local">
              {isSynced ? 'Sincronizada (.lrc)' : 'Local'}
            </span>
          )}
          {actionFeedback && (
            <span className="lyrics-synced-badge feedback">{actionFeedback}</span>
          )}
        </div>

        <div className="lyrics-dock-controls">
          {!isLoadingLyrics && (hasLines || Boolean(currentLyrics?.rawLyrics)) && (
            <button
              type="button"
              className="lyrics-dock-action-pill"
              onClick={handleSaveLrc}
              title="Guardar e incrustar letra en archivo original y todos sus enlaces duros (actualiza símbolo de letras)"
            >
              💾 Guardar .lrc
            </button>
          )}

          {!isLoadingLyrics && (hasLines || isSavedOnDisk || Boolean(currentTrack?.hasLyrics)) && (
            <button
              type="button"
              className="lyrics-dock-action-pill danger"
              onClick={handleDeleteLrc}
              title="Eliminar archivo .lrc y quitar letra del archivo original y todos sus enlaces duros (elimina símbolo de letras)"
            >
              🗑️ Quitar .lrc
            </button>
          )}

          {!isLoadingLyrics && currentTrack?.path && (
            <button
              type="button"
              className="lyrics-dock-btn"
              onClick={retryOnlineLyrics}
              title="Volver a buscar letra en línea (LRCLIB)"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
                <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
                <path d="M16 16h5v5" />
              </svg>
            </button>
          )}

          {hasLines && (
            <button
              type="button"
              className="lyrics-dock-btn"
              onClick={() => setIsExpanded((prev) => !prev)}
              title={isExpanded ? 'Modo compacto (3 líneas)' : 'Ver letra completa'}
            >
              {isExpanded ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="4 14 10 14 10 20" />
                  <polyline points="20 10 14 10 14 4" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="15 3 21 3 21 9" />
                  <polyline points="9 21 3 21 3 15" />
                  <line x1="21" y1="3" x2="14" y2="10" />
                  <line x1="3" y1="21" x2="10" y2="14" />
                </svg>
              )}
            </button>
          )}

          <button
            type="button"
            className="lyrics-dock-btn close-btn"
            onClick={onClose}
            title="Cerrar panel de letras"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Cuerpo del dock */}
      <div className="lyrics-dock-body">
        {isLoadingLyrics ? (
          <div className="lyrics-loading">
            <div className="lyrics-spinner" />
            <span>
              {status === 'searching-online'
                ? 'Cargando contenido · Buscando letra sincronizada en línea...'
                : 'Cargando contenido de letra...'}
            </span>
          </div>
        ) : !hasLines ? (
          <div className="lyrics-empty-notice">
            <span>Sin letra disponible para esta versión</span>
            {currentTrack?.path && (
              <button
                type="button"
                className="lyrics-retry-inline-btn"
                onClick={retryOnlineLyrics}
              >
                🔍 Buscar en línea ahora
              </button>
            )}
          </div>
        ) : isExpanded ? (
          /* Modo expandido: Scroll de todas las líneas */
          <div className="lyrics-expanded-scroll" ref={expandedListRef}>
            {lines.map((line, idx) => {
              const isCurrent = isSynced && idx === activeIndex
              return (
                <div
                  key={`${line.time}-${idx}`}
                  ref={isCurrent ? activeLineRef : null}
                  className={`lyrics-expanded-line ${isCurrent ? 'active' : ''}`}
                  onClick={() => handleLineClick(line)}
                  title={isSynced ? `Saltar a ${formatSeconds(line.time)}` : ''}
                >
                  {isSynced && (
                    <span className="lyrics-line-time">
                      {formatSeconds(line.time)}
                    </span>
                  )}
                  <span className="lyrics-line-text">{line.text}</span>
                </div>
              )
            })}
          </div>
        ) : (
          /* Modo compacto: 3 líneas dinámicas con profundidad */
          <div className="lyrics-3lines-container">
            {/* 1. Línea Anterior (Pasada) */}
            <div
              className={`lyrics-line past ${pastLine ? 'clickable' : 'empty'}`}
              onClick={() => pastLine && handleLineClick(pastLine)}
              title={pastLine && isSynced ? `Repetir: ${formatSeconds(pastLine.time)}` : ''}
            >
              <span className="lyrics-text-content">{pastLine ? pastLine.text : ''}</span>
            </div>

            {/* 2. Línea Actual (Cantándose en medio) */}
            <div
              className={`lyrics-line current ${currentLine ? 'active' : ''}`}
              onClick={() => currentLine && handleLineClick(currentLine)}
              title={currentLine && isSynced ? `Actual: ${formatSeconds(currentLine.time)}` : ''}
            >
              <span className="lyrics-text-content lyrics-current-glow">
                {currentLine ? currentLine.text : '♪'}
              </span>
            </div>

            {/* 3. Línea Siguiente (Futura) */}
            <div
              className={`lyrics-line next ${nextLine ? 'clickable' : 'empty'}`}
              onClick={() => nextLine && handleLineClick(nextLine)}
              title={nextLine && isSynced ? `Adelantar: ${formatSeconds(nextLine.time)}` : ''}
            >
              <span className="lyrics-text-content">{nextLine ? nextLine.text : ''}</span>
            </div>
          </div>
        )}
      </div>
    </aside>
  )
}
