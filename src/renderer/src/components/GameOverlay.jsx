import React, { useState, useEffect, useCallback } from 'react'
import { usePlayer, usePlayerTime } from '../context/PlayerContext'

function formatTime(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

export default function GameOverlay() {
  const { currentTrack, currentAlbum, isPlaying, duration } = usePlayer()
  const { currentTime } = usePlayerTime()
  const [isHovered, setIsHovered] = useState(false)
  const [coverError, setCoverError] = useState(false)

  const coverSrc = currentTrack?.cover || currentAlbum?.cover || null

  useEffect(() => {
    setCoverError(false)
  }, [coverSrc, currentTrack?.path])

  // Controlar volumen con la rueda del ratón sobre el HUD enviando comando IPC a la ventana principal
  const handleWheel = useCallback((e) => {
    e.preventDefault()
    const cmd = e.deltaY < 0 ? 'volume-up' : 'volume-down'
    window.electronAPI?.sendPlayerCommand?.(cmd)
  }, [])

  const handlePrevious = useCallback((e) => {
    e.stopPropagation()
    window.electronAPI?.sendPlayerCommand?.('previous')
  }, [])

  const handleTogglePlay = useCallback((e) => {
    e.stopPropagation()
    window.electronAPI?.sendPlayerCommand?.('toggle-play')
  }, [])

  const handleNext = useCallback((e) => {
    e.stopPropagation()
    window.electronAPI?.sendPlayerCommand?.('next')
  }, [])

  const handleClose = useCallback((e) => {
    e.stopPropagation()
    window.electronAPI?.toggleGameOverlay?.(false)
  }, [])

  const progressPercent = duration > 0 ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) : 0

  return (
    <div
      className={`game-overlay-hud ${isHovered ? 'hovered' : ''}`}
      onWheel={handleWheel}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      title="HUD de Juego Flotante (Usa la rueda del ratón para volumen · Arrastra para mover)"
    >
      <div className="game-overlay-drag-region">
        {/* Carátula */}
        <div className="game-overlay-cover">
          {coverSrc && !coverError ? (
            <img
              src={coverSrc}
              alt=""
              draggable={false}
              onError={() => setCoverError(true)}
            />
          ) : (
            <span>🎵</span>
          )}
          {isPlaying && <span className="game-overlay-pulse-dot" />}
        </div>

        {/* Info de la pista */}
        <div className="game-overlay-info">
          <div className="game-overlay-title" title={currentTrack?.title || 'Sin reproducción activa'}>
            {currentTrack?.title || 'Sin reproducción'}
          </div>
          <div className="game-overlay-artist" title={currentTrack?.artist || currentAlbum?.name || 'Reproductor de Música'}>
            {currentTrack?.artist || currentAlbum?.name || 'Reproductor de Música'}
          </div>
        </div>
      </div>

      {/* Controles de reproducción */}
      <div className="game-overlay-controls">
        <button
          type="button"
          className="game-overlay-btn"
          onClick={handlePrevious}
          title="Anterior (Ctrl+Left)"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
            <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" />
          </svg>
        </button>

        <button
          type="button"
          className="game-overlay-btn play-btn"
          onClick={handleTogglePlay}
          title={isPlaying ? 'Pausa (Espacio)' : 'Reproducir (Espacio)'}
        >
          {isPlaying ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>

        <button
          type="button"
          className="game-overlay-btn"
          onClick={handleNext}
          title="Siguiente (Ctrl+Right)"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
            <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
          </svg>
        </button>

        <button
          type="button"
          className="game-overlay-btn close-btn"
          onClick={handleClose}
          title="Ocultar HUD (Atajo: Ctrl+Alt+H)"
        >
          ✕
        </button>
      </div>

      {/* Barra de progreso sutil en la base */}
      <div className="game-overlay-progress-bar">
        <div className="game-overlay-progress-fill" style={{ width: `${progressPercent}%` }} />
      </div>
    </div>
  )
}
