import React, { useState, useEffect, useRef } from 'react'
import { usePlayerTime } from '../context/PlayerContext'

function formatSeconds(sec) {
  if (sec === undefined || sec === null || isNaN(sec)) return ''
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

/**
 * Dock interactivo de letras sincronizadas (LRC / ID3).
 * Soporta modo compacto de 3 líneas con efecto de profundidad (pasada, actual y siguiente)
 * y modo expandido con scroll automático y salto a estrofa con un clic (seek on click).
 */
export default function LyricsDock({ isOpen, onClose, currentTrack, seekTo }) {
  const { currentTime } = usePlayerTime()
  const [lyricsData, setLyricsData] = useState({ synced: false, lines: [] })
  const [loading, setLoading] = useState(false)
  const [isExpanded, setIsExpanded] = useState(false)
  const activeLineRef = useRef(null)
  const expandedListRef = useRef(null)

  // Cargar letras cuando cambia la pista actual
  useEffect(() => {
    let active = true
    if (!currentTrack?.path || !window.electronAPI?.getTrackLyrics) {
      setLyricsData({ synced: false, lines: [] })
      return
    }

    setLoading(true)
    window.electronAPI
      .getTrackLyrics(currentTrack.path)
      .then((res) => {
        if (active) {
          setLyricsData(res || { synced: false, lines: [] })
          setLoading(false)
        }
      })
      .catch(() => {
        if (active) {
          setLyricsData({ synced: false, lines: [] })
          setLoading(false)
        }
      })

    return () => {
      active = false
    }
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

  // Desplazamiento automático en modo expandido
  useEffect(() => {
    if (isExpanded && activeLineRef.current && expandedListRef.current) {
      activeLineRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'center'
      })
    }
  }, [currentTime, isExpanded])

  if (!isOpen) return null

  const hasLines = lyricsData.lines && lyricsData.lines.length > 0
  const isSynced = lyricsData.synced && hasLines

  // Calcular índice de la línea activa en base al tiempo actual
  let activeIndex = -1
  if (isSynced) {
    for (let i = 0; i < lyricsData.lines.length; i++) {
      if (currentTime >= lyricsData.lines[i].time) {
        activeIndex = i
      } else {
        break
      }
    }
  }

  const pastLine = activeIndex > 0 ? lyricsData.lines[activeIndex - 1] : null
  const currentLine =
    activeIndex >= 0
      ? lyricsData.lines[activeIndex]
      : hasLines
      ? { text: '♪ ... ♪', time: 0, isIntro: true }
      : null
  const nextLine =
    activeIndex + 1 < lyricsData.lines.length
      ? lyricsData.lines[activeIndex + 1]
      : activeIndex === -1 && hasLines
      ? lyricsData.lines[0]
      : null

  const handleLineClick = (line) => {
    if (line && line.time !== undefined && !line.isIntro) {
      seekTo(line.time)
    }
  }

  return (
    <aside
      className={`lyrics-dock ${isExpanded ? 'expanded' : ''}`}
      role="complementary"
      aria-label="Panel de letras"
      onClick={(e) => e.stopPropagation()}
    >
      {/* Barra superior con título y controles */}
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
          {isSynced && <span className="lyrics-synced-badge">Sincronizada</span>}
        </div>

        <div className="lyrics-dock-controls">
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
        {loading ? (
          <div className="lyrics-loading">
            <div className="lyrics-spinner" />
            <span>Cargando letras...</span>
          </div>
        ) : !hasLines ? (
          /* En caso que no se encuentren letras no se muestra nada adicional */
          <div className="lyrics-empty-notice">
            <span>Sin letra disponible</span>
          </div>
        ) : isExpanded ? (
          /* Modo expandido: Scroll de todas las líneas */
          <div className="lyrics-expanded-scroll" ref={expandedListRef}>
            {lyricsData.lines.map((line, idx) => {
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
