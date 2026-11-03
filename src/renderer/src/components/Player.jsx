import { usePlayer, usePlayerTime, EQ_FREQUENCIES, EQ_PRESETS } from '../context/PlayerContext'
import React, { useState, useRef, useCallback, useEffect } from 'react'
import AudioVisualizer from './AudioVisualizer'
import LyricsDock from './LyricsDock'

function formatTime(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

const Icons = {
  Play: () => (
    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
  ),
  Pause: () => (
    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
  ),
  Next: () => (
    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>
  ),
  Previous: () => (
    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>
  ),
  Shuffle: () => (
    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"/></svg>
  ),
  Loop: () => (
    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg>
  ),
  LoopOne: () => (
    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/><text x="12" y="15" textAnchor="middle" fontSize="7" fill="currentColor" fontWeight="bold">1</text></svg>
  ),
  Volume: () => (
    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/></svg>
  ),
  Mute: () => (
    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>
  )
}

/**
 * Sub-componente aislado para la barra de progreso e indicadores de tiempo.
 * Es el único componente del reproductor que se suscribe a los cambios de alta frecuencia de currentTime,
 * evitando que el resto del reproductor (controles, carátula, ecualizador) se renderice innecesariamente.
 */
function PlayerTimeline({ duration, isPlaying, seekTo }) {
  const { currentTime } = usePlayerTime()
  const progressBarRef = useRef(null)
  const [isScrubbing, setIsScrubbing] = useState(false)
  const [scrubValue, setScrubValue] = useState(0)
  const [hoverPosition, setHoverPosition] = useState(null)
  const [showRemainingTime, setShowRemainingTime] = useState(false)

  const activeTime = isScrubbing ? scrubValue : currentTime
  const progressPercent = duration > 0 ? Math.min(100, Math.max(0, (activeTime / duration) * 100)) : 0

  const getPositionFromEvent = useCallback((e) => {
    if (!progressBarRef.current) return 0
    const rect = progressBarRef.current.getBoundingClientRect()
    const clientX = e.clientX ?? (e.touches ? e.touches[0].clientX : 0)
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    return ratio
  }, [])

  // Inicio de arrastre/clic en barra de progreso
  const handleMouseDown = useCallback((e) => {
    if (!duration || duration <= 0) return
    setIsScrubbing(true)
    const ratio = getPositionFromEvent(e)
    const newTime = ratio * duration
    setScrubValue(newTime)

    const onMouseMove = (moveEvent) => {
      const moveRatio = getPositionFromEvent(moveEvent)
      setScrubValue(moveRatio * duration)
    }

    const onMouseUp = (upEvent) => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      const upRatio = getPositionFromEvent(upEvent)
      const finalTime = upRatio * duration
      seekTo(finalTime)
      setIsScrubbing(false)
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }, [duration, getPositionFromEvent, seekTo])

  // Hover sobre la barra para previsualizar el tiempo
  const handleMouseMoveHover = useCallback((e) => {
    if (!duration || duration <= 0) return
    const ratio = getPositionFromEvent(e)
    setHoverPosition({
      percent: ratio * 100,
      time: ratio * duration
    })
  }, [duration, getPositionFromEvent])

  const handleMouseLeaveHover = useCallback(() => {
    setHoverPosition(null)
  }, [])

  return (
    <div className="player-timeline-wrapper">
      <span className="time-label current-time">
        {formatTime(activeTime)}
      </span>

      <div
        className={`progress-bar-hitbox ${isPlaying ? 'playing' : ''} ${isScrubbing ? 'scrubbing' : ''}`}
        ref={progressBarRef}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMoveHover}
        onMouseLeave={handleMouseLeaveHover}
      >
        {/* Halo de resplandor ambiental inferior acelerado por GPU (scaleX evita re-calcular blur en cada tick) */}
        <div
          className="progress-ambient-glow"
          style={{ transform: `translateY(-50%) scaleX(${progressPercent / 100})` }}
        />

        <div className="progress-bar-track">
          {/* Marcas sutiles de ondas (Audio Ticks) en el fondo del track */}
          <div className="progress-audio-ticks" />

          {/* Relleno con gradiente neón vibrante y onda de luz compuesta en GPU */}
          <div
            className={`progress-bar-fill ${isPlaying ? 'shimmer-active' : ''}`}
            style={{ width: `${progressPercent}%` }}
          >
            <div className="progress-shimmer-clip" />
            {/* Cabeza de luz láser brillante en el extremo */}
            <div className="progress-glow-head" />
            {/* Indicador circular deslizable (Thumb) */}
            <div className={`progress-thumb ${isScrubbing ? 'scrubbing' : ''}`} />
          </div>

          {/* Cursor láser vertical en posición hover */}
          {hoverPosition && (
            <div
              className="progress-hover-line"
              style={{ left: `${hoverPosition.percent}%` }}
            />
          )}

          {/* Tooltip flotante con previsualización de tiempo */}
          {hoverPosition && (
            <div
              className="progress-hover-tooltip"
              style={{ left: `${hoverPosition.percent}%` }}
            >
              <span className="tooltip-time">{formatTime(hoverPosition.time)}</span>
              <div className="tooltip-arrow" />
            </div>
          )}
        </div>
      </div>

      <span
        className="time-label total-time clickable"
        onClick={() => setShowRemainingTime(prev => !prev)}
        title="Clic para alternar duración total o tiempo restante"
      >
        {showRemainingTime && duration > 0
          ? `-${formatTime(Math.max(0, duration - activeTime))}`
          : formatTime(duration)}
      </span>
    </div>
  )
}

/**
 * Modal del Ecualizador Paramétrico de 10 Bandas con Web Audio API en tiempo real
 */
function EqualizerModal({
  isOpen,
  onClose,
  eqState,
  setEqBandGain,
  applyEqPreset,
  toggleEqEnabled,
  resetEq,
  EQ_FREQUENCIES = [],
  EQ_PRESETS = {}
}) {
  const modalRef = useRef(null)

  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose()
    }
    const handlePointerDown = (e) => {
      if (modalRef.current && !modalRef.current.contains(e.target)) {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    document.addEventListener('pointerdown', handlePointerDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('pointerdown', handlePointerDown)
    }
  }, [isOpen, onClose])

  if (!isOpen || !eqState) return null

  const formatHz = (freq) => {
    return freq >= 1000 ? `${freq / 1000}k` : `${freq}`
  }

  return (
    <div className="eq-modal-backdrop">
      <div className="eq-modal-card" ref={modalRef} role="dialog" aria-label="Ecualizador de audio">
        <div className="eq-modal-header">
          <div className="eq-modal-title-group">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" />
              <line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" />
              <line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" />
              <line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" /><line x1="17" y1="16" x2="23" y2="16" />
            </svg>
            <div>
              <h3>Ecualizador de 10 bandas</h3>
              <p className="eq-modal-subtitle">Procesamiento Web Audio API en tiempo real</p>
            </div>
          </div>

          <div className="eq-header-actions">
            <button
              type="button"
              className={`eq-power-btn ${eqState.enabled ? 'active' : ''}`}
              onClick={toggleEqEnabled}
              title={eqState.enabled ? 'Desactivar ecualizador' : 'Activar ecualizador'}
            >
              <span className="eq-power-indicator" />
              <span>{eqState.enabled ? 'Activado' : 'Desactivado'}</span>
            </button>
            <button type="button" className="eq-modal-close" onClick={onClose} title="Cerrar">
              ✕
            </button>
          </div>
        </div>

        {/* Barra de Perfiles / Presets */}
        <div className="eq-presets-bar">
          <span className="eq-presets-label">Perfiles:</span>
          <div className="eq-presets-scroll">
            {Object.keys(EQ_PRESETS).map((pName) => (
              <button
                key={pName}
                type="button"
                className={`eq-preset-pill ${eqState.preset === pName ? 'active' : ''}`}
                onClick={() => applyEqPreset(pName)}
              >
                {pName}
              </button>
            ))}
          </div>
          <button type="button" className="eq-reset-btn" onClick={resetEq} title="Restablecer a plano (0 dB)">
            Restablecer
          </button>
        </div>

        {/* Sliders Verticales */}
        <div className={`eq-sliders-container ${!eqState.enabled ? 'eq-disabled' : ''}`}>
          <div className="eq-scale-labels">
            <span>+12 dB</span>
            <span>0 dB</span>
            <span>-12 dB</span>
          </div>

          <div className="eq-sliders-track-area">
            <div className="eq-center-zero-line" />
            {EQ_FREQUENCIES.map((freq, i) => {
              const gain = eqState.gains[i] ?? 0
              return (
                <div key={freq} className="eq-band-col">
                  <span className="eq-band-db">
                    {gain > 0 ? `+${gain.toFixed(0)}` : gain.toFixed(0)}
                  </span>
                  <div className="eq-slider-wrapper">
                    <input
                      type="range"
                      min="-12"
                      max="12"
                      step="0.5"
                      value={gain}
                      disabled={!eqState.enabled}
                      onChange={(e) => setEqBandGain(i, parseFloat(e.target.value))}
                      className="eq-vertical-slider"
                    />
                  </div>
                  <span className="eq-band-freq">{formatHz(freq)}</span>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

function Player() {
  const {
    currentTrack,
    isPlaying,
    duration,
    volume,
    shuffle,
    loop,
    togglePlay,
    nextTrack,
    previousTrack,
    seekTo,
    setVolumeLevel,
    toggleShuffle,
    toggleLoop,
    eqState,
    setEqBandGain,
    applyEqPreset,
    toggleEqEnabled,
    resetEq
  } = usePlayer()

  const [prevVolume, setPrevVolume] = useState(0.8)
  const [showVisualizer, setShowVisualizer] = useState(() => {
    const saved = localStorage.getItem('rep_show_visualizer')
    return saved === null ? true : saved === 'true'
  })
  const [showEqModal, setShowEqModal] = useState(false)
  const [showLyrics, setShowLyrics] = useState(() => {
    const saved = localStorage.getItem('rep_show_lyrics')
    return saved === 'true'
  })

  const toggleVisualizer = useCallback(() => {
    setShowVisualizer((prev) => {
      const next = !prev
      localStorage.setItem('rep_show_visualizer', String(next))
      return next
    })
  }, [])

  const toggleLyrics = useCallback(() => {
    setShowLyrics((prev) => {
      const next = !prev
      localStorage.setItem('rep_show_lyrics', String(next))
      return next
    })
  }, [])

  const closeLyrics = useCallback(() => {
    setShowLyrics(false)
    localStorage.setItem('rep_show_lyrics', 'false')
  }, [])

  const handleVolumeClick = useCallback((e) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    setVolumeLevel(ratio)
  }, [setVolumeLevel])

  const toggleMute = useCallback(() => {
    if (volume > 0) {
      setPrevVolume(volume)
      setVolumeLevel(0)
    } else {
      setVolumeLevel(prevVolume || 0.8)
    }
  }, [volume, prevVolume, setVolumeLevel])

  const handleVolumeWheel = useCallback((e) => {
    e.preventDefault()
    const step = 0.05
    const delta = e.deltaY < 0 ? step : -step
    const nextVol = Math.max(0, Math.min(1, Math.round((volume + delta) * 100) / 100))
    setVolumeLevel(nextVol)
  }, [volume, setVolumeLevel])

  return (
    <div className="player-wrapper">
      {/* Visualizador de espectro real en tiempo real */}
      {showVisualizer && currentTrack && (
        <div className="player-visualizer-dock">
          <AudioVisualizer height={38} barCount={46} />
        </div>
      )}

      <div className="player">
        {/* 1. Track Info (Carátula grande, título, artista) */}
      <div className="player-track-info">
        {currentTrack?.cover ? (
          <>
            <img
              src={currentTrack.cover}
              alt=""
              className="player-cover"
              decoding="async"
              onError={(e) => {
                e.currentTarget.style.display = 'none'
                const fb = e.currentTarget.parentElement?.querySelector('.player-cover-placeholder')
                if (fb) fb.style.display = 'flex'
              }}
            />
            <div className="player-cover-placeholder" style={{ display: 'none' }}>💿</div>
          </>
        ) : (
          <div className="player-cover-placeholder">💿</div>
        )}
        <div className="player-text">
          <div className="player-title" title={currentTrack?.title || 'Sin reproducción'}>
            {currentTrack?.title || 'Selecciona una canción'}
          </div>
          <div className="player-artist" title={currentTrack?.artist || '—'}>
            {currentTrack?.artist || '—'}
          </div>
        </div>
      </div>

      {/* 2. Controls & Interactive Timeline */}
      <div className="player-controls">
        <div className="player-buttons">
          <button
            className={`player-btn ${shuffle ? 'active' : ''}`}
            onClick={toggleShuffle}
            title={shuffle ? 'Aleatorio activado' : 'Activar aleatorio'}
          >
            <Icons.Shuffle />
          </button>

          <button className="player-btn" onClick={previousTrack} title="Canción anterior (Ctrl+Left)">
            <Icons.Previous />
          </button>

          <button
            className="player-btn play-pause-btn"
            onClick={togglePlay}
            title={isPlaying ? 'Pausar' : 'Reproducir'}
          >
            {isPlaying ? <Icons.Pause /> : <Icons.Play />}
          </button>

          <button className="player-btn" onClick={nextTrack} title="Siguiente canción (Ctrl+Right)">
            <Icons.Next />
          </button>

          <button
            className={`player-btn ${loop !== 'none' ? 'active' : ''}`}
            onClick={toggleLoop}
            title={
              loop === 'none'
                ? 'Bucle desactivado'
                : loop === 'all'
                ? 'Repetir álbum completo'
                : 'Repetir canción actual'
            }
          >
            {loop === 'one' ? <Icons.LoopOne /> : <Icons.Loop />}
          </button>
        </div>

        {/* BARRA DE MÚSICA CON DISEÑO PREMIUM ULTRA VISTOSA */}
        <PlayerTimeline duration={duration} isPlaying={isPlaying} seekTo={seekTo} />
      </div>

      {/* 3. Volume slider with mouse wheel support & Visualizer Toggle */}
      <div
        className="player-extra"
        onWheel={handleVolumeWheel}
        title="Usa la rueda del ratón para ajustar el volumen"
      >
        {/* Botón Ecualizador de 10 Bandas */}
        <button
          className={`player-btn eq-btn ${showEqModal ? 'active' : ''} ${eqState?.enabled ? 'eq-powered' : ''}`}
          onClick={() => setShowEqModal(prev => !prev)}
          title={eqState?.enabled ? `Ecualizador: Activado (${eqState.preset})` : 'Ecualizador de audio de 10 bandas'}
        >
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" />
            <line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" />
            <line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" />
            <line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" /><line x1="17" y1="16" x2="23" y2="16" />
          </svg>
        </button>

        {/* Columna vertical compacta: Visualizador (arriba) y Letras (abajo) */}
        <div className="player-twin-stack">
          <button
            className={`player-btn visualizer-btn mini-btn ${showVisualizer ? 'active' : ''}`}
            onClick={toggleVisualizer}
            title={showVisualizer ? 'Ocultar visualizador de espectro' : 'Mostrar visualizador de espectro'}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M4 19h2V5H4v14zm4 0h2V9H8v10zm4 0h2V3h-2v16zm4 0h2v-8h-2v8zm4 0h2v-4h-2v4z"/>
            </svg>
          </button>

          <button
            className={`player-btn lyrics-btn mini-btn ${showLyrics ? 'active' : ''}`}
            onClick={toggleLyrics}
            title={showLyrics ? 'Ocultar letras (LRC / ID3)' : 'Mostrar letras sincronizadas (LRC / ID3)'}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
              <line x1="12" y1="19" x2="12" y2="22" />
            </svg>
          </button>
        </div>

        <button className="player-btn volume-btn" onClick={toggleMute} title={volume === 0 ? 'Activar sonido' : 'Silenciar'}>
          {volume === 0 ? <Icons.Mute /> : <Icons.Volume />}
        </button>
        <div className="volume-slider-hitbox" onClick={handleVolumeClick} title={`Volumen: ${Math.round(volume * 100)}% (o rueda del ratón)`}>
          <div className="volume-slider-track">
            <div className="volume-fill" style={{ width: `${volume * 100}%` }}>
              <div className="volume-thumb" />
            </div>
          </div>
        </div>
      </div>

      {/* Modal del Ecualizador */}
      <EqualizerModal
        isOpen={showEqModal}
        onClose={() => setShowEqModal(false)}
        eqState={eqState}
        setEqBandGain={setEqBandGain}
        applyEqPreset={applyEqPreset}
        toggleEqEnabled={toggleEqEnabled}
        resetEq={resetEq}
        EQ_FREQUENCIES={EQ_FREQUENCIES}
        EQ_PRESETS={EQ_PRESETS}
      />

      {/* Dock Flotante de Letras (3 Líneas / Modo Expandido) */}
      <LyricsDock
        isOpen={showLyrics}
        onClose={closeLyrics}
        currentTrack={currentTrack}
        seekTo={seekTo}
      />
    </div>
  </div>
  )
}

export default React.memo(Player)
