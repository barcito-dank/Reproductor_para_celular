import { usePlayer, usePlayerTime } from '../context/PlayerContext'
import React, { useState, useEffect, useCallback } from 'react'

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
 * Barra de progreso aislada para el Mini Panel.
 * Al suscribirse únicamente a usePlayerTime, evita que la lista completa de canciones
 * y el resto del panel lateral se re-rendericen en cada frame de reproducción.
 */
function MiniProgressBar({ duration, isPlaying }) {
  const { currentTime } = usePlayerTime()
  const progressPercent = duration > 0 ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) : 0

  const handleMiniProgressClick = useCallback((e) => {
    if (!duration || duration <= 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    window.electronAPI.sendPlayerCommand('seek-' + (ratio * duration))
  }, [duration])

  return (
    <div className="mini-progress-section">
      <div className="mini-progress-times">
        <span>{formatTime(currentTime)}</span>
        <span>{formatTime(duration)}</span>
      </div>
      <div
        className={`mini-progress-bar-hitbox ${isPlaying ? 'playing' : ''}`}
        onClick={handleMiniProgressClick}
        title="Clic para avanzar o retroceder"
      >
        <div className="mini-progress-track">
          <div
            className={`mini-progress-fill ${isPlaying ? 'shimmer-active' : ''}`}
            style={{ width: `${progressPercent}%` }}
          >
            <div className="mini-progress-thumb" />
          </div>
        </div>
      </div>
    </div>
  )
}

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

  const [mode, setMode] = useState('hidden') // 'marker' | 'hiding-marker' | 'expanded' | 'hidden'
  const [panelAnim, setPanelAnim] = useState('slide-in') // 'slide-in' | 'slide-out'
  const [settings, setSettings] = useState({ pinned: false, autoHide: true })

  // Ajuste de volumen con la rueda del ratón exclusivo sobre el control de volumen
  const handleVolumeWheel = useCallback((e) => {
    e.preventDefault()
    e.stopPropagation()
    const step = 0.05
    const delta = e.deltaY < 0 ? step : -step
    const nextVol = Math.max(0, Math.min(1, Math.round(((volume ?? 0.8) + delta) * 100) / 100))
    window.electronAPI.sendPlayerCommand('volume-' + nextVol)
  }, [volume])

  const handleToggleMute = useCallback((e) => {
    e?.stopPropagation()
    if (volume > 0) {
      window.electronAPI.sendPlayerCommand('volume-0')
    } else {
      window.electronAPI.sendPlayerCommand('volume-0.8')
    }
  }, [volume])

  // Despliegue y retracción fluidos con animación rápida de deslizamiento
  const handleCollapseToMarker = useCallback((e) => {
    e?.stopPropagation()
    setPanelAnim('slide-out')
    setTimeout(() => {
      setMode('hidden')
      window.electronAPI.setSidePanelMode('collapsed')
    }, 180)
  }, [])

  useEffect(() => {
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'

    let unsubMode = null
    let unsubCollapse = null

    if (window.electronAPI.onSidePanelMode) {
      unsubMode = window.electronAPI.onSidePanelMode((newMode) => {
        if (newMode === 'expanded') {
          setPanelAnim('slide-in')
        }
        setMode(newMode)
      })
    }

    if (window.electronAPI.onRequestCollapse) {
      unsubCollapse = window.electronAPI.onRequestCollapse(() => {
        handleCollapseToMarker()
      })
    }

    return () => {
      if (unsubMode) unsubMode()
      if (unsubCollapse) unsubCollapse()
    }
  }, [handleCollapseToMarker])

  useEffect(() => {
    if (window.electronAPI.getPanelSettings) {
      window.electronAPI.getPanelSettings().then((s) => {
        if (s) setSettings(s)
      }).catch(console.error)
    }
  }, [])

  const handleTogglePinned = (e) => {
    e?.stopPropagation()
    const updated = { ...settings, pinned: !settings.pinned }
    setSettings(updated)
    window.electronAPI.updatePanelSettings(updated)
  }

  const handleToggleAutoHide = (e) => {
    e?.stopPropagation()
    const updated = { ...settings, autoHide: !settings.autoHide }
    setSettings(updated)
    window.electronAPI.updatePanelSettings(updated)
  }

  const handlePrevious = (e) => {
    e?.stopPropagation()
    window.electronAPI.sendPlayerCommand('previous')
  }

  const handleNext = (e) => {
    e?.stopPropagation()
    window.electronAPI.sendPlayerCommand('next')
  }

  const handleTogglePlay = (e) => {
    e?.stopPropagation()
    window.electronAPI.sendPlayerCommand('toggle-play')
  }

  const handleToggleShuffle = (e) => {
    e?.stopPropagation()
    window.electronAPI.sendPlayerCommand('toggle-shuffle')
  }

  const handleToggleLoop = (e) => {
    e?.stopPropagation()
    window.electronAPI.sendPlayerCommand('toggle-loop')
  }

  const handleExpand = () => {
    // Solicitar a Electron que ajuste la ventana a tamaño completo primero para evitar saltos de frames
    window.electronAPI.setSidePanelMode('expanded')
  }

  const handleClose = (e) => {
    handleCollapseToMarker(e)
  }

  const handleRestoreMain = (e) => {
    e?.stopPropagation()
    window.electronAPI.restoreMainWindow()
  }

  const handleSelectTrack = (index) => {
    window.electronAPI.sendPlayerCommand('select-' + index)
  }

  // ============================================
  // MODO MARCADOR CHICO (Aparece al acercar el ratón al borde)
  // ============================================
  if (mode === 'marker' || mode === 'hiding-marker') {
    return (
      <div className="mini-small-marker-wrapper">
        <div
          className={`mini-small-marker ${mode === 'hiding-marker' ? 'slide-out' : 'slide-in'}`}
          onClick={handleExpand}
          title="Desplegar reproductor lateral"
        >
          <div className="small-marker-chevron">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z" />
            </svg>
          </div>
          <div className={`small-marker-icon ${isPlaying ? 'pulse' : ''}`}>
            🎵
          </div>
        </div>
      </div>
    )
  }

  if (mode === 'hidden') {
    return null
  }

  // ============================================
  // MODO DESPLEGADO COMPLETO (Con marcador integrado estéticamente en su lateral)
  // ============================================
  return (
    <div className={`mini-side-wrapper ${panelAnim}`}>
      {/* Marcador integrado en el flanco exterior izquierdo de la barra */}
      <div
        className="mini-integrated-marker"
        onClick={handleCollapseToMarker}
        title="Ocultar barra lateral"
      >
        <div className="integrated-marker-chevron">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6-1.41-1.41z" />
          </svg>
        </div>
        <div className={`integrated-marker-icon ${isPlaying ? 'pulse' : ''}`}>
          🎵
        </div>
      </div>

      {/* Cajón lateral principal */}
      <div className="mini-panel-full">
      {/* Header */}
      <div className="mini-panel-header">
        <div className="mini-header-title">
          <span className="mini-app-badge">🎵</span>
          <h3>Reproductor Rápido</h3>
        </div>

        <div className="mini-header-actions">
          {/* Opción 1: Mantener siempre visible (Pin) */}
          <button
            className={`mini-action-btn ${settings.pinned ? 'active-pin' : ''}`}
            onClick={handleTogglePinned}
            title={settings.pinned ? 'Siempre visible: ACTIVADO (no se oculta)' : 'Mantener siempre visible (Fijar)'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/>
            </svg>
          </button>

          {/* Opción 2: Ocultación automática al tocar otra cosa */}
          <button
            className={`mini-action-btn ${settings.autoHide && !settings.pinned ? 'active-autohide' : ''}`}
            onClick={handleToggleAutoHide}
            title={settings.autoHide ? 'Ocultación automática: ACTIVADA (se oculta al hacer clic fuera)' : 'Ocultación automática: DESACTIVADA'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm4.2 14.2L11 13V7h1.5v5.2l4.5 2.7-.8 1.3z"/>
            </svg>
          </button>

          {/* Botón para ocultar/retraer */}
          <button
            className="mini-action-btn"
            onClick={handleCollapseToMarker}
            title="Ocultar barra lateral"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" />
            </svg>
          </button>

          {/* Botón Cerrar */}
          <button
            className="mini-action-btn close"
            onClick={handleClose}
            title="Cerrar panel"
          >
            <svg width="12" height="12" viewBox="0 0 14 14">
              <path d="M1 1L13 13M13 1L1 13" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>

      {/* Barra de estado de configuración activa y control de volumen */}
      <div className="mini-settings-badges">
        <span className={`badge-pill ${settings.pinned ? 'on' : ''}`}>
          {settings.pinned ? '📌 Fijada' : '📌 Sin fijar'}
        </span>
        <span className={`badge-pill ${settings.autoHide ? 'on' : ''}`}>
          {settings.autoHide ? '⚡ Auto ON' : '⚡ Auto OFF'}
        </span>

        {/* Píldora de volumen con rueda del ratón y clic para mutear */}
        <div
          className="badge-pill volume-pill"
          onWheel={handleVolumeWheel}
          onClick={handleToggleMute}
          title="Usa la rueda del ratón aquí para regular el volumen o haz clic para silenciar"
        >
          {volume === 0 ? '🔇 Mute' : `🔊 ${Math.round((volume ?? 0.8) * 100)}%`}
        </div>
      </div>

      {/* Now Playing Card con resplandor suave */}
      <div className="mini-now-playing">
        {currentTrack?.cover ? (
          <img src={currentTrack.cover} alt="" className="mini-now-cover" />
        ) : (
          <div className="mini-now-cover-placeholder">💿</div>
        )}
        <div className="mini-now-info">
          <div className="mini-now-title">{currentTrack?.title || 'Sin reproducción activa'}</div>
          <div className="mini-now-artist">{currentTrack?.artist || 'Selecciona una canción'}</div>
        </div>
        {currentTrack && (
          <div className="mini-now-equalizer">
            <AnimatedEqualizer isPaused={!isPlaying} />
          </div>
        )}
      </div>

      {/* Barra de progreso de la canción ultra vistosa (aislada para evitar renders de la lista) */}
      <MiniProgressBar duration={duration} isPlaying={isPlaying} />

      {/* Mini Controls (Shuffle, Anterior, Play/Pause, Siguiente, Bucle) */}
      <div className="mini-controls">
        <button
          className={`mini-btn ${shuffle ? 'active-control' : ''}`}
          onClick={handleToggleShuffle}
          title={shuffle ? 'Modo aleatorio: Activado' : 'Activar modo aleatorio'}
        >
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/>
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
              <path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/>
              <text x="12" y="15" textAnchor="middle" fontSize="7" fill="currentColor" fontWeight="bold">1</text>
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/>
            </svg>
          )}
        </button>
      </div>

      {/* Track List - Vertical full height (Scrollable libremente con la rueda del ratón) */}
      <div className="mini-track-section-label">
        <span>Cola de Pistas ({playlist.length})</span>
      </div>

      <div className="mini-track-list">
        {playlist.map((track, idx) => (
          <div
            key={track.id || idx}
            className={`mini-track-item ${idx === playlistIndex ? 'active' : ''}`}
            onClick={() => handleSelectTrack(idx)}
          >
            {track.cover ? (
              <img src={track.cover} alt="" className="mini-track-cover" loading="lazy" decoding="async" />
            ) : (
              <div className="mini-track-cover-placeholder">🎵</div>
            )}
            <div className="mini-track-info">
              <div className="mini-track-title">{track.title}</div>
              <div className="mini-track-artist">{track.artist}</div>
            </div>
            {idx === playlistIndex && (
              <div className="mini-track-playing-badge">
                <AnimatedEqualizer isPaused={!isPlaying} />
              </div>
            )}
          </div>
        ))}

        {playlist.length === 0 && (
          <div className="mini-empty-state">
            <p>No hay canciones en la lista.</p>
            <p className="mini-empty-sub">Abre un álbum en la aplicación para cargarlas.</p>
          </div>
        )}
      </div>

      {/* Footer / Expand to Main Window */}
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
