import { usePlayer, usePlayerTime } from '../context/PlayerContext'
import React, { useState, useEffect, useCallback, useRef } from 'react'

const MINI_ROW_HEIGHT = 52
const MINI_OVERSCAN = 6

function formatTime(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

function AnimatedEqualizer({ isPaused = false }) {
  return (
    <div className={`equalizer-bars ${isPaused ? 'paused' : ''}`} title={isPaused ? 'En pausa' : 'Reproduciendo'}>
      <span className="eq-bar eq-bar-1" />
      <span className="eq-bar eq-bar-2" />
      <span className="eq-bar eq-bar-3" />
      <span className="eq-bar eq-bar-4" />
    </div>
  )
}

/**
 * Barra de progreso aislada e interactiva (clic + arrastre) sincronizada con PlayerTimeline.
 * Solo este subcomponente escucha usePlayerTime, evitando re-renderizar el resto del MiniPanel.
 */
function MiniProgressBar({ duration, isPlaying, isExpanded }) {
  const { currentTime } = usePlayerTime()
  const barRef = useRef(null)
  const [isScrubbing, setIsScrubbing] = useState(false)
  const [scrubTime, setScrubTime] = useState(0)
  const [showRemaining, setShowRemaining] = useState(false)

  const activeTime = isScrubbing ? scrubTime : currentTime
  const progressPercent = duration > 0 ? Math.min(100, Math.max(0, (activeTime / duration) * 100)) : 0
  const shimmerActive = isPlaying && isExpanded

  const getRatio = useCallback((e) => {
    if (!barRef.current) return 0
    const rect = barRef.current.getBoundingClientRect()
    if (rect.width <= 0) return 0
    const clientX = e.clientX ?? 0
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
  }, [])

  const handleMouseDown = useCallback((e) => {
    if (!duration || duration <= 0) return
    e.stopPropagation()
    setIsScrubbing(true)
    const initialTime = getRatio(e) * duration
    setScrubTime(initialTime)

    const onMouseMove = (moveEvt) => {
      setScrubTime(getRatio(moveEvt) * duration)
    }

    const onMouseUp = (upEvt) => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      const finalTime = getRatio(upEvt) * duration
      window.electronAPI.sendPlayerCommand('seek-' + finalTime)
      setIsScrubbing(false)
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }, [duration, getRatio])

  return (
    <div className="mini-progress-section">
      <div
        ref={barRef}
        className={`mini-progress-bar-hitbox ${shimmerActive ? 'playing' : ''} ${isScrubbing ? 'scrubbing' : ''}`}
        onMouseDown={handleMouseDown}
        title="Clic o arrastra para ajustar posición"
      >
        <div className="mini-progress-track">
          <div
            className={`mini-progress-fill ${shimmerActive ? 'shimmer-active' : ''}`}
            style={{ width: `${progressPercent}%` }}
          >
            <div className="mini-progress-shimmer-clip" />
            <div className="mini-progress-thumb" />
          </div>
        </div>
      </div>
      <div className="mini-progress-times">
        <span className="mini-time-current">{formatTime(activeTime)}</span>
        <span
          className="mini-time-total"
          onClick={() => setShowRemaining((prev) => !prev)}
          title="Clic para alternar duración total o tiempo restante"
        >
          {showRemaining && duration > 0
            ? `-${formatTime(Math.max(0, duration - activeTime))}`
            : formatTime(duration)}
        </span>
      </div>
    </div>
  )
}

/**
 * Fila individual memoizada para que cambios de pista o reproducción solo actualicen la fila afectada.
 */
const MiniTrackRow = React.memo(function MiniTrackRow({
  track,
  index,
  isActive,
  isPlaying,
  isExpanded,
  onSelect
}) {
  return (
    <div
      className={`mini-track-item ${isActive ? 'active' : ''}`}
      onClick={() => onSelect(index)}
    >
      {track.cover ? (
        <>
          <img
            src={track.cover}
            alt=""
            className="mini-track-cover"
            loading="lazy"
            decoding="async"
            onError={(e) => {
              e.currentTarget.style.display = 'none'
              const fb = e.currentTarget.parentElement?.querySelector('.mini-track-cover-placeholder')
              if (fb) fb.style.display = 'flex'
            }}
          />
          <div className="mini-track-cover-placeholder" style={{ display: 'none' }}>🎵</div>
        </>
      ) : (
        <div className="mini-track-cover-placeholder">🎵</div>
      )}
      <div className="mini-track-info">
        <div className="mini-track-title" title={track.title}>{track.title}</div>
        <div className="mini-track-artist-row">
          <span className="mini-track-artist" title={track.artist}>{track.artist}</span>
          {track.hasLyrics && (
            <span
              className={`track-lyrics-indicator ${track.syncedLyrics ? 'synced' : 'plain'}`}
              title={track.syncedLyrics ? 'Letras sincronizadas disponibles' : 'Letras disponibles'}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" y1="19" x2="12" y2="22" />
              </svg>
            </span>
          )}
        </div>
      </div>
      {isActive && (
        <div className="mini-track-playing-badge">
          <AnimatedEqualizer isPaused={!isPlaying || !isExpanded} />
        </div>
      )}
    </div>
  )
})

function MiniPanel() {
  const {
    currentTrack,
    playlist,
    playlistIndex,
    isPlaying,
    duration,
    shuffle,
    loop,
    volume
  } = usePlayer()

  // 'hidden' | 'marker' | 'expanded'
  const [mode, setMode] = useState('hidden')
  const [settings, setSettings] = useState({ pinned: false, autoHide: true })
  const [prevVolume, setPrevVolume] = useState(0.8)

  // Virtualización de la cola de pistas (~18 nodos DOM constantes aunque haya >1.500 canciones)
  const listRef = useRef(null)
  const [viewportHeight, setViewportHeight] = useState(520)
  const [startIndex, setStartIndex] = useState(0)
  const wasExpandedRef = useRef(false)

  const isExpanded = mode === 'expanded'
  const isMarker = mode === 'marker'

  const updateVisibleWindow = useCallback((scrollTop, clientHeight) => {
    const h = clientHeight > 0 ? clientHeight : 520
    const nextStart = Math.max(0, Math.floor(scrollTop / MINI_ROW_HEIGHT) - MINI_OVERSCAN)
    setStartIndex((prev) => (prev === nextStart ? prev : nextStart))
    setViewportHeight((prev) => (Math.abs(prev - h) > 4 ? h : prev))
  }, [])

  const handleListScroll = useCallback((e) => {
    const el = e.currentTarget
    updateVisibleWindow(el.scrollTop, el.clientHeight)
  }, [updateVisibleWindow])

  // Observar altura real del contenedor de lista una sola vez
  useEffect(() => {
    const el = listRef.current
    if (!el) return undefined
    const ro = new ResizeObserver(() => {
      updateVisibleWindow(el.scrollTop, el.clientHeight)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [updateVisibleWindow])

  // Sincronizar scroll automáticamente hacia la canción activa al desplegar el panel o cambiar de pista
  useEffect(() => {
    const justExpanded = isExpanded && !wasExpandedRef.current
    wasExpandedRef.current = isExpanded

    if (!isExpanded || playlistIndex < 0 || !listRef.current) return
    const el = listRef.current
    const viewH = el.clientHeight || viewportHeight
    const targetTop = playlistIndex * MINI_ROW_HEIGHT
    const targetBottom = targetTop + MINI_ROW_HEIGHT
    const visibleTop = el.scrollTop
    const visibleBottom = visibleTop + viewH

    if (justExpanded || targetTop < visibleTop + MINI_ROW_HEIGHT || targetBottom > visibleBottom - MINI_ROW_HEIGHT) {
      const centeredScroll = Math.max(0, targetTop - Math.floor(viewH * 0.35))
      el.scrollTop = centeredScroll
      updateVisibleWindow(centeredScroll, viewH)
    }
  }, [isExpanded, playlistIndex, viewportHeight, updateVisibleWindow])

  // Mantener índice virtual dentro de rango cuando cambia la playlist
  useEffect(() => {
    if (!listRef.current) return
    const maxScroll = Math.max(0, playlist.length * MINI_ROW_HEIGHT - (listRef.current.clientHeight || viewportHeight))
    if (listRef.current.scrollTop > maxScroll) {
      listRef.current.scrollTop = maxScroll
    }
    updateVisibleWindow(listRef.current.scrollTop, listRef.current.clientHeight || viewportHeight)
  }, [playlist.length, viewportHeight, updateVisibleWindow])

  // Ajuste de volumen con la rueda del ratón y restauración inteligente al desmutear
  const handleVolumeWheel = useCallback((e) => {
    e.preventDefault()
    e.stopPropagation()
    const step = 0.05
    const delta = e.deltaY < 0 ? step : -step
    const currentVol = volume ?? 0.8
    const nextVol = Math.max(0, Math.min(1, Math.round((currentVol + delta) * 100) / 100))
    if (nextVol > 0) setPrevVolume(nextVol)
    window.electronAPI.sendPlayerCommand('volume-' + nextVol)
  }, [volume])

  const handleToggleMute = useCallback((e) => {
    e?.stopPropagation()
    if ((volume ?? 0.8) > 0) {
      setPrevVolume(volume)
      window.electronAPI.sendPlayerCommand('volume-0')
    } else {
      window.electronAPI.sendPlayerCommand('volume-' + (prevVolume > 0 ? prevVolume : 0.8))
    }
  }, [volume, prevVolume])

  // Despliegue y retracción con respuesta inmediata (0ms) en el hilo del compositor GPU
  const handleExpand = useCallback((e) => {
    e?.stopPropagation()
    setMode('expanded')
    window.electronAPI.setSidePanelMode('expanded')
  }, [])

  const handleCollapse = useCallback((e) => {
    e?.stopPropagation()
    setMode('hidden')
    window.electronAPI.setSidePanelMode('collapsed')
  }, [])

  const handleMarkerClick = useCallback((e) => {
    e?.stopPropagation()
    if (mode === 'expanded') {
      handleCollapse(e)
    } else {
      handleExpand(e)
    }
  }, [mode, handleCollapse, handleExpand])

  useEffect(() => {
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'

    let unsubMode = null
    let unsubCollapse = null
    let unsubSettings = null

    if (window.electronAPI.onSidePanelMode) {
      unsubMode = window.electronAPI.onSidePanelMode((incomingMode) => {
        if (incomingMode === 'expanded') {
          setMode('expanded')
        } else if (incomingMode === 'marker') {
          setMode('marker')
        } else {
          setMode('hidden')
        }
      })
    }

    if (window.electronAPI.onRequestCollapse) {
      unsubCollapse = window.electronAPI.onRequestCollapse(() => {
        setMode('hidden')
        window.electronAPI.setSidePanelMode('collapsed')
      })
    }

    if (window.electronAPI.onPanelSettingsUpdated) {
      unsubSettings = window.electronAPI.onPanelSettingsUpdated((nextSettings) => {
        if (nextSettings) {
          const pinned = Boolean(nextSettings.pinned)
          setSettings({ pinned, autoHide: !pinned })
        }
      })
    }

    return () => {
      if (unsubMode) unsubMode()
      if (unsubCollapse) unsubCollapse()
      if (unsubSettings) unsubSettings()
    }
  }, [])

  useEffect(() => {
    if (window.electronAPI.getPanelSettings) {
      window.electronAPI.getPanelSettings().then((s) => {
        if (s) {
          const pinned = Boolean(s.pinned)
          setSettings({ pinned, autoHide: !pinned })
        }
      }).catch(console.error)
    }
  }, [])

  const handleTogglePinned = useCallback((e) => {
    e?.stopPropagation()
    setSettings((prev) => {
      const nextPinned = !prev.pinned
      const updated = { pinned: nextPinned, autoHide: !nextPinned }
      window.electronAPI.updatePanelSettings(updated)
      return updated
    })
  }, [])

  const handleToggleAutoHide = useCallback((e) => {
    e?.stopPropagation()
    setSettings((prev) => {
      const nextAutoHide = !prev.autoHide
      const updated = { pinned: !nextAutoHide, autoHide: nextAutoHide }
      window.electronAPI.updatePanelSettings(updated)
      return updated
    })
  }, [])

  const handlePrevious = useCallback((e) => {
    e?.stopPropagation()
    window.electronAPI.sendPlayerCommand('previous')
  }, [])

  const handleNext = useCallback((e) => {
    e?.stopPropagation()
    window.electronAPI.sendPlayerCommand('next')
  }, [])

  const handleTogglePlay = useCallback((e) => {
    e?.stopPropagation()
    window.electronAPI.sendPlayerCommand('toggle-play')
  }, [])

  const handleToggleShuffle = useCallback((e) => {
    e?.stopPropagation()
    window.electronAPI.sendPlayerCommand('toggle-shuffle')
  }, [])

  const handleToggleLoop = useCallback((e) => {
    e?.stopPropagation()
    window.electronAPI.sendPlayerCommand('toggle-loop')
  }, [])

  const handleRestoreMain = useCallback((e) => {
    e?.stopPropagation()
    window.electronAPI.restoreMainWindow()
  }, [])

  const handleSelectTrack = useCallback((index) => {
    window.electronAPI.sendPlayerCommand('select-' + index)
  }, [])

  const visibleCount = Math.ceil(viewportHeight / MINI_ROW_HEIGHT) + MINI_OVERSCAN * 2
  const endIndex = Math.min(playlist.length, startIndex + visibleCount)
  const visibleTracks = playlist.slice(startIndex, endIndex)
  const totalListHeight = playlist.length * MINI_ROW_HEIGHT
  const offsetY = startIndex * MINI_ROW_HEIGHT

  return (
    <div className={`mini-side-wrapper state-${mode}`}>
      {/* Marcador lateral unificado: una sola pieza continua junto al cajón para evitar saltos laterales */}
      <button
        type="button"
        className={`mini-marker-tab ${isExpanded ? 'is-expanded' : ''}`}
        onClick={handleMarkerClick}
        title={isExpanded ? 'Ocultar barra lateral' : 'Desplegar reproductor lateral'}
        aria-label={isExpanded ? 'Ocultar barra lateral' : 'Desplegar reproductor lateral'}
      >
        <span className="mini-marker-chevron">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
            <path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z" />
          </svg>
        </span>
        <span className={`mini-marker-icon ${isPlaying && (isExpanded || isMarker) ? 'pulse' : ''}`}>
          🎵
        </span>
      </button>

      {/* Cajón lateral principal */}
      <div className="mini-panel-full">
        {/* 1. Cabecera con controles rápidos de fijación y retracción */}
        <div className="mini-panel-header">
          <div className="mini-header-title">
            <span className="mini-app-badge">🎵</span>
            <h3>Reproductor Rápido</h3>
          </div>

          <div className="mini-header-actions">
            <button
              className={`mini-action-btn ${settings.pinned ? 'active-pin' : ''}`}
              onClick={handleTogglePinned}
              aria-pressed={settings.pinned}
              title={
                settings.pinned
                  ? 'Ventana fija: ACTIVADA (ocultamiento automático desactivado)'
                  : 'Activar modo ventana fija (desactiva ocultamiento automático)'
              }
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z" />
              </svg>
            </button>

            <button
              className={`mini-action-btn ${settings.autoHide ? 'active-autohide' : ''}`}
              onClick={handleToggleAutoHide}
              aria-pressed={settings.autoHide}
              title={
                settings.autoHide
                  ? 'Ocultamiento automático: ACTIVADO (ventana fija desactivada)'
                  : 'Activar ocultamiento automático (desactiva ventana fija)'
              }
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm4.2 14.2L11 13V7h1.5v5.2l4.5 2.7-.8 1.3z" />
              </svg>
            </button>

            <button
              className="mini-action-btn"
              onClick={handleCollapse}
              title="Retraer barra lateral"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" />
              </svg>
            </button>
          </div>
        </div>

        {/* 2. Tarjeta Protagonista "Sonando Ahora" */}
        <div className="mini-now-playing">
          <div className={`mini-now-cover-wrap ${isPlaying && isExpanded ? 'playing' : ''}`}>
            {currentTrack?.cover ? (
              <>
                <img
                  src={currentTrack.cover}
                  alt=""
                  className="mini-now-cover"
                  decoding="async"
                  onError={(e) => {
                    e.currentTarget.style.display = 'none'
                    const fb = e.currentTarget.parentElement?.querySelector('.mini-now-cover-placeholder')
                    if (fb) fb.style.display = 'flex'
                  }}
                />
                <div className="mini-now-cover-placeholder" style={{ display: 'none' }}>💿</div>
              </>
            ) : (
              <div className="mini-now-cover-placeholder">💿</div>
            )}
          </div>
          <div className="mini-now-info">
            <div className="mini-now-title" title={currentTrack?.title || 'Sin reproducción activa'}>
              {currentTrack?.title || 'Listo para reproducir'}
            </div>
            <div className="mini-now-artist" title={currentTrack?.artist || ''}>
              {currentTrack?.artist || (playlist.length > 0 ? `${playlist.length} pistas listas en cola` : 'Selecciona una canción')}
            </div>
          </div>
          {currentTrack && (
            <div className="mini-now-equalizer">
              <AnimatedEqualizer isPaused={!isPlaying || !isExpanded} />
            </div>
          )}
        </div>

        {/* 3. Línea de tiempo interactiva (clic y arrastre) */}
        <MiniProgressBar duration={duration} isPlaying={isPlaying} isExpanded={isExpanded} />

        {/* 4. Controles de transporte y barra rápida de estado / volumen */}
        <div className="mini-controls">
          <button
            className={`mini-btn ${shuffle ? 'active-control' : ''}`}
            onClick={handleToggleShuffle}
            title={shuffle ? 'Modo aleatorio: Activado' : 'Activar modo aleatorio'}
          >
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z" />
            </svg>
          </button>

          <button className="mini-btn" onClick={handlePrevious} title="Anterior">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" /></svg>
          </button>

          <button className="mini-btn mini-play-btn" onClick={handleTogglePlay} title={isPlaying ? 'Pausar' : 'Reproducir'}>
            {isPlaying ? (
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" /></svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z" /></svg>
            )}
          </button>

          <button className="mini-btn" onClick={handleNext} title="Siguiente">
            <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" /></svg>
          </button>

          <button
            className={`mini-btn ${loop !== 'none' ? 'active-control' : ''}`}
            onClick={handleToggleLoop}
            title={
              loop === 'none'
                ? 'Bucle desactivado'
                : loop === 'all'
                ? 'Repetir lista completa'
                : 'Repetir canción actual'
            }
          >
            {loop === 'one' ? (
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z" />
                <text x="12" y="15" textAnchor="middle" fontSize="7" fill="currentColor" fontWeight="bold">1</text>
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z" />
              </svg>
            )}
          </button>
        </div>

        {/* Píldoras interactivas de modos alternativos (Fija vs Auto-ocultar) y volumen */}
        <div className="mini-settings-badges">
          <div className="mini-mode-switch" role="group" aria-label="Modo del panel lateral">
            <button
              type="button"
              className={`badge-pill interactive-pill pin-mode-pill ${settings.pinned ? 'on' : ''}`}
              onClick={handleTogglePinned}
              aria-pressed={settings.pinned}
              title={
                settings.pinned
                  ? 'Modo ventana fija activo · Clic para cambiar a ocultamiento automático'
                  : 'Cambiar a modo ventana fija (desactiva ocultamiento automático)'
              }
            >
              {settings.pinned ? '📌 Fijada' : '📌 Sin fijar'}
            </button>
            <button
              type="button"
              className={`badge-pill interactive-pill autohide-mode-pill ${settings.autoHide ? 'on' : ''}`}
              onClick={handleToggleAutoHide}
              aria-pressed={settings.autoHide}
              title={
                settings.autoHide
                  ? 'Modo ocultamiento automático activo · Clic para fijar ventana'
                  : 'Cambiar a ocultamiento automático (desactiva ventana fija)'
              }
            >
              {settings.autoHide ? '⚡ Auto ON' : '⚡ Auto OFF'}
            </button>
          </div>

          <div
            className="badge-pill volume-pill"
            onWheel={handleVolumeWheel}
            onClick={handleToggleMute}
            title="Rueda del ratón para regular volumen · Clic para silenciar"
          >
            {volume === 0 ? '🔇 Mute' : `🔊 ${Math.round((volume ?? 0.8) * 100)}%`}
          </div>
        </div>

        {/* 5. Cola de Pistas Virtualizada */}
        <div className="mini-track-section-label">
          <span>Cola de Pistas ({playlist.length})</span>
          {playlistIndex >= 0 && playlist.length > 0 && (
            <span className="mini-queue-pos">#{playlistIndex + 1}</span>
          )}
        </div>

        <div className="mini-track-list" ref={listRef} onScroll={handleListScroll}>
          {playlist.length > 0 ? (
            <div
              className="mini-track-virtual-spacer"
              style={{ height: `${totalListHeight}px` }}
            >
              <div
                className="mini-track-virtual-slice"
                style={{ transform: `translate3d(0, ${offsetY}px, 0)` }}
              >
                {visibleTracks.map((track, sliceIdx) => {
                  const realIdx = startIndex + sliceIdx
                  return (
                    <MiniTrackRow
                      key={track.id || realIdx}
                      track={track}
                      index={realIdx}
                      isActive={realIdx === playlistIndex}
                      isPlaying={isPlaying}
                      isExpanded={isExpanded}
                      onSelect={handleSelectTrack}
                    />
                  )
                })}
              </div>
            </div>
          ) : (
            <div className="mini-empty-state">
              <p>No hay canciones en la lista.</p>
              <p className="mini-empty-sub">Abre un álbum en la aplicación para cargarlas.</p>
            </div>
          )}
        </div>

        {/* 6. Pie: Restaurar ventana principal */}
        <div className="mini-footer">
          <button className="mini-expand-btn" onClick={handleRestoreMain}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z" />
            </svg>
            Abrir interfaz completa
          </button>
        </div>
      </div>
    </div>
  )
}

export default React.memo(MiniPanel)
