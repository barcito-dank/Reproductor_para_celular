import {
  usePlayback,
  useLibrary,
  usePlayerTime,
  EQ_FREQUENCIES,
  EQ_PRESETS
} from '../context/PlayerContext'
import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import AudioVisualizer from './AudioVisualizer'
import { triggerHaptic } from './BottomNavBar'

function formatTime(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

const Icons = {
  Play: () => (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M8 5v14l11-7z" />
    </svg>
  ),
  Pause: () => (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
    </svg>
  ),
  Next: () => (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
    </svg>
  ),
  Previous: () => (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M6 6h2v12H6zm3.5 6l8.5 6V6z" />
    </svg>
  ),
  Shuffle: () => (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z" />
    </svg>
  ),
  Loop: () => (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z" />
    </svg>
  ),
  LoopOne: () => (
    <svg viewBox="0 0 24 24" fill="currentColor">
      <path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z" />
      <text x="12" y="15" textAnchor="middle" fontSize="7" fill="currentColor" fontWeight="bold">
        1
      </text>
    </svg>
  ),
  Bookmark: ({ filled = false }) => (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
    </svg>
  )
}

/**
 * Barra fina de progreso aislada para el MiniPlayer acoplado.
 * Solo este subcomponente se re-renderiza con currentTime.
 */
function MiniPlayerProgressBar({ duration }) {
  const { currentTime } = usePlayerTime()
  const percent = duration > 0 ? Math.min(100, Math.max(0, (currentTime / duration) * 100)) : 0
  return (
    <div className="mini-player-progress-track">
      <div className="mini-player-progress-fill" style={{ width: `${percent}%` }} />
    </div>
  )
}

/**
 * Barra de progreso táctil e interactiva (Scrubber) compatible con Touch Events y Mouse Events.
 */
function PlayerTimeline({ duration, isPlaying, seekTo }) {
  const { currentTime } = usePlayerTime()
  const progressBarRef = useRef(null)
  const [isScrubbing, setIsScrubbing] = useState(false)
  const [scrubValue, setScrubValue] = useState(0)
  const [showRemainingTime, setShowRemainingTime] = useState(false)
  const scrubValueRef = useRef(0)

  const activeTime = isScrubbing ? scrubValue : currentTime
  const progressPercent =
    duration > 0 ? Math.min(100, Math.max(0, (activeTime / duration) * 100)) : 0

  const getRatioFromClientX = useCallback((clientX) => {
    if (!progressBarRef.current) return 0
    const rect = progressBarRef.current.getBoundingClientRect()
    if (rect.width <= 0) return 0
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
  }, [])

  // Soporte de ratón
  const handleMouseDown = useCallback(
    (e) => {
      if (!duration || duration <= 0) return
      e.stopPropagation()
      setIsScrubbing(true)
      const ratio = getRatioFromClientX(e.clientX)
      const newTime = ratio * duration
      scrubValueRef.current = newTime
      setScrubValue(newTime)

      const onMouseMove = (moveEvent) => {
        const moveRatio = getRatioFromClientX(moveEvent.clientX)
        const nextTime = moveRatio * duration
        scrubValueRef.current = nextTime
        setScrubValue(nextTime)
      }

      const onMouseUp = (upEvent) => {
        window.removeEventListener('mousemove', onMouseMove)
        window.removeEventListener('mouseup', onMouseUp)
        const upRatio = getRatioFromClientX(upEvent.clientX)
        const finalTime = upRatio * duration
        seekTo(finalTime)
        setIsScrubbing(false)
      }

      window.addEventListener('mousemove', onMouseMove)
      window.addEventListener('mouseup', onMouseUp)
    },
    [duration, getRatioFromClientX, seekTo]
  )

  // Soporte táctil nativo sin saltos (Android / Motorola)
  const handleTouchStart = useCallback(
    (e) => {
      if (!duration || duration <= 0) return
      e.stopPropagation()
      const touch = e.touches[0]
      if (!touch) return
      setIsScrubbing(true)
      const ratio = getRatioFromClientX(touch.clientX)
      const newTime = ratio * duration
      scrubValueRef.current = newTime
      setScrubValue(newTime)
    },
    [duration, getRatioFromClientX]
  )

  const handleTouchMove = useCallback(
    (e) => {
      if (!isScrubbing || !duration || duration <= 0) return
      e.stopPropagation()
      const touch = e.touches[0]
      if (!touch) return
      const ratio = getRatioFromClientX(touch.clientX)
      const nextTime = ratio * duration
      scrubValueRef.current = nextTime
      setScrubValue(nextTime)
    },
    [isScrubbing, duration, getRatioFromClientX]
  )

  const handleTouchEnd = useCallback(
    (e) => {
      if (!isScrubbing) return
      e.stopPropagation()
      const changedTouch = e.changedTouches?.[0]
      const finalTime = changedTouch
        ? getRatioFromClientX(changedTouch.clientX) * duration
        : scrubValueRef.current
      seekTo(finalTime)
      setIsScrubbing(false)
    },
    [isScrubbing, duration, getRatioFromClientX, seekTo]
  )

  return (
    <div className="player-timeline-wrapper">
      <span className="time-label current-time">{formatTime(activeTime)}</span>

      <div
        className={`progress-bar-hitbox ${isPlaying ? 'playing' : ''} ${isScrubbing ? 'scrubbing' : ''}`}
        ref={progressBarRef}
        onMouseDown={handleMouseDown}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
      >
        <div
          className="progress-ambient-glow"
          style={{ transform: `translateY(-50%) scaleX(${progressPercent / 100})` }}
        />

        <div className="progress-bar-track">
          <div className="progress-audio-ticks" />
          <div
            className={`progress-bar-fill ${isPlaying ? 'shimmer-active' : ''}`}
            style={{ width: `${progressPercent}%` }}
          >
            <div className="progress-shimmer-clip" />
            <div className="progress-glow-head" />
            <div className={`progress-thumb ${isScrubbing ? 'scrubbing' : ''}`} />
          </div>
        </div>
      </div>

      <span
        className="time-label total-time clickable"
        onClick={() => setShowRemainingTime((prev) => !prev)}
        title="Toca para alternar duración total o tiempo restante"
      >
        {showRemainingTime && duration > 0
          ? `-${formatTime(Math.max(0, duration - activeTime))}`
          : formatTime(duration)}
      </span>
    </div>
  )
}

/**
 * Vista integrada de Letras Karaoke dentro del NowPlayingSheet
 */
function NowPlayingLyricsView({ currentTrack, seekTo }) {
  const {
    currentLyrics,
    saveCurrentLyricsToDisk,
    deleteCurrentLyricsFromDisk,
    retryOnlineLyrics
  } = usePlayback()
  const { currentTime } = usePlayerTime()
  const [feedback, setFeedback] = useState(null)
  const activeLineRef = useRef(null)
  const listContainerRef = useRef(null)

  const status = currentLyrics?.status || 'idle'
  const isLoadingLyrics = status === 'loading' || status === 'searching-online'
  const lines = currentLyrics?.lines || []
  const hasLines = lines.length > 0
  const isSynced = Boolean(currentLyrics?.synced && hasLines)
  const isSavedOnDisk = hasLines && Boolean(currentLyrics?.savedToDisk)

  let activeIndex = -1
  if (isSynced) {
    for (let i = 0; i < lines.length; i++) {
      if (currentTime >= lines[i].time) {
        activeIndex = i
      } else {
        break
      }
    }
  }

  useEffect(() => {
    if (activeLineRef.current && listContainerRef.current) {
      activeLineRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'center'
      })
    }
  }, [activeIndex])

  const handleSave = async () => {
    void triggerHaptic()
    const res = await saveCurrentLyricsToDisk()
    if (res?.success) {
      setFeedback('✓ Letra .lrc guardada en la bóveda')
      setTimeout(() => setFeedback(null), 2500)
    }
  }

  const handleDelete = async () => {
    void triggerHaptic()
    const res = await deleteCurrentLyricsFromDisk()
    if (res?.success) {
      setFeedback('🗑️ Archivo .lrc eliminado')
      setTimeout(() => setFeedback(null), 2500)
    }
  }

  return (
    <div className="np-stage-card np-lyrics-card">
      <div className="np-stage-card-header">
        <div className="np-stage-card-title">
          <span>🎤 Letras Sincronizadas</span>
          {isSavedOnDisk && <span className="np-badge synced">.LRC Local</span>}
          {!isSavedOnDisk && hasLines && <span className="np-badge temp">Online</span>}
        </div>
        <div className="np-stage-card-actions">
          {!isLoadingLyrics && (hasLines || Boolean(currentLyrics?.rawLyrics)) && (
            <button type="button" className="np-mini-pill-btn" onClick={handleSave}>
              💾 Guardar .lrc
            </button>
          )}
          {!isLoadingLyrics && (hasLines || isSavedOnDisk) && (
            <button type="button" className="np-mini-pill-btn danger" onClick={handleDelete}>
              🗑️ Borrar
            </button>
          )}
          {!isLoadingLyrics && currentTrack?.path && (
            <button
              type="button"
              className="np-mini-pill-btn"
              onClick={() => {
                void triggerHaptic()
                retryOnlineLyrics()
              }}
            >
              🔄 Buscar
            </button>
          )}
        </div>
      </div>

      {feedback && <div className="np-inline-feedback">{feedback}</div>}

      <div className="np-lyrics-scroll-area" ref={listContainerRef}>
        {isLoadingLyrics ? (
          <div className="np-empty-center">
            <div className="lyrics-spinner" />
            <p>Buscando letra sincronizada en LRCLIB...</p>
          </div>
        ) : !hasLines ? (
          <div className="np-empty-center">
            <span style={{ fontSize: '32px' }}>🎤</span>
            <p>No se encontró letra sincronizada para esta pista.</p>
            {currentTrack?.path && (
              <button
                type="button"
                className="play-album-btn"
                onClick={() => {
                  void triggerHaptic()
                  retryOnlineLyrics()
                }}
              >
                🔍 Buscar en LRCLIB ahora
              </button>
            )}
          </div>
        ) : (
          lines.map((line, idx) => {
            const isCurrent = isSynced && idx === activeIndex
            const isPast = isSynced && idx < activeIndex
            return (
              <div
                key={`${line.time}-${idx}`}
                ref={isCurrent ? activeLineRef : null}
                className={`np-lyric-line ${isCurrent ? 'active' : ''} ${isPast ? 'past' : ''}`}
                onClick={() => {
                  if (line.time !== undefined) {
                    void triggerHaptic()
                    seekTo(line.time)
                  }
                }}
              >
                {isSynced && <span className="np-lyric-time">{formatTime(line.time)}</span>}
                <span className="np-lyric-text">{line.text || '♪'}</span>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

/**
 * Vista integrada de Ecualizador de 10 Bandas dentro del NowPlayingSheet
 */
function NowPlayingEqualizerView() {
  const {
    eqState,
    setEqBandGain,
    applyEqPreset,
    toggleEqEnabled,
    resetEq
  } = usePlayback()

  if (!eqState) return null

  const formatHz = (freq) => (freq >= 1000 ? `${freq / 1000}k` : `${freq}`)

  return (
    <div className="np-stage-card np-eq-card">
      <div className="np-stage-card-header">
        <div className="np-stage-card-title">
          <span>🎚️ Ecualizador de 10 Bandas</span>
        </div>
        <div className="np-stage-card-actions">
          <button
            type="button"
            className={`eq-power-btn ${eqState.enabled ? 'active' : ''}`}
            onClick={() => {
              void triggerHaptic()
              toggleEqEnabled()
            }}
          >
            <span className="eq-power-indicator" />
            <span>{eqState.enabled ? 'Activo' : 'Inactivo'}</span>
          </button>
          <button
            type="button"
            className="np-mini-pill-btn"
            onClick={() => {
              void triggerHaptic()
              resetEq()
            }}
          >
            Plano (0 dB)
          </button>
        </div>
      </div>

      <div className="eq-presets-scroll np-eq-presets">
        {Object.keys(EQ_PRESETS).map((pName) => (
          <button
            key={pName}
            type="button"
            className={`eq-preset-pill ${eqState.preset === pName ? 'active' : ''}`}
            onClick={() => {
              void triggerHaptic()
              applyEqPreset(pName)
            }}
          >
            {pName}
          </button>
        ))}
      </div>

      <div className={`eq-sliders-container np-eq-sliders ${!eqState.enabled ? 'eq-disabled' : ''}`}>
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
  )
}

/**
 * Vista integrada de Marcadores de Álbumes (M:N) dentro del NowPlayingSheet
 */
function NowPlayingAlbumsBookmarkView({ track }) {
  const {
    allAlbums = [],
    getTrackAlbumInfo,
    addTrackToAlbums,
    removeTrackFromAlbum,
    createAlbum
  } = useLibrary()
  const [filter, setFilter] = useState('')
  const [busyId, setBusyId] = useState(null)
  const [newAlbumName, setNewAlbumName] = useState('')
  const [feedback, setFeedback] = useState(null)

  const albumInfo = getTrackAlbumInfo(track)
  const presentSet = albumInfo?.albumIdsSet || new Set()
  const presentCount = albumInfo?.albumCount || presentSet.size || 1

  const sortedAlbums = useMemo(() => {
    const q = filter.trim().toLowerCase()
    const base = q
      ? allAlbums.filter((a) => a.name.toLowerCase().includes(q))
      : allAlbums
    return [...base].sort((a, b) => {
      const aIn = presentSet.has(a.id) ? 1 : 0
      const bIn = presentSet.has(b.id) ? 1 : 0
      if (aIn !== bIn) return bIn - aIn
      return (a.name || '').localeCompare(b.name || '')
    })
  }, [allAlbums, filter, presentSet])

  const handleToggleAlbum = async (albumItem) => {
    if (!track || busyId) return
    void triggerHaptic()
    const isPresent = presentSet.has(albumItem.id)
    if (isPresent && presentCount <= 1) {
      setFeedback('⚠️ La pista debe pertenecer al menos a 1 álbum en la bóveda')
      setTimeout(() => setFeedback(null), 2600)
      return
    }
    setBusyId(albumItem.id)
    try {
      if (isPresent) {
        await removeTrackFromAlbum(track, albumItem)
      } else {
        await addTrackToAlbums(track, [albumItem])
      }
    } finally {
      setBusyId(null)
    }
  }

  const handleQuickCreateAlbum = async (e) => {
    e.preventDefault()
    const trimmed = newAlbumName.trim()
    if (!trimmed || !track) return
    void triggerHaptic()
    const res = await createAlbum(trimmed)
    if (res?.success && res.albumId) {
      await addTrackToAlbums(track, [{ id: res.albumId, name: trimmed, path: res.albumPath }])
      setNewAlbumName('')
      setFeedback(`✓ Álbum "${trimmed}" creado y vinculado`)
      setTimeout(() => setFeedback(null), 2500)
    }
  }

  return (
    <div className="np-stage-card np-bookmarks-card">
      <div className="np-stage-card-header">
        <div className="np-stage-card-title">
          <span>🔖 Asignar a Álbumes ({presentCount})</span>
        </div>
      </div>

      {feedback && <div className="np-inline-feedback">{feedback}</div>}

      <form className="np-quick-create-album-row" onSubmit={handleQuickCreateAlbum}>
        <input
          type="text"
          className="album-picker-search"
          placeholder="Buscar o crear nuevo álbum..."
          value={filter || newAlbumName}
          onChange={(e) => {
            setFilter(e.target.value)
            setNewAlbumName(e.target.value)
          }}
        />
        {newAlbumName.trim() && (
          <button type="submit" className="np-mini-pill-btn primary">
            + Crear y asignar
          </button>
        )}
      </form>

      <div className="np-bookmarks-list">
        {sortedAlbums.map((alb) => {
          const isPresent = presentSet.has(alb.id)
          const isBusy = busyId === alb.id
          return (
            <button
              key={alb.id}
              type="button"
              className={`np-bookmark-row ${isPresent ? 'present' : ''}`}
              onClick={() => handleToggleAlbum(alb)}
              disabled={isBusy}
            >
              <span className={`album-picker-check-box ${isPresent ? 'checked' : ''}`}>
                {isBusy ? '…' : isPresent ? '✓' : ''}
              </span>
              {alb.cover ? (
                <img src={alb.cover} alt="" className="album-picker-thumb" />
              ) : (
                <div className="album-picker-thumb-fallback">💿</div>
              )}
              <div className="album-picker-meta">
                <span className="album-picker-name">{alb.name}</span>
                <span className="album-picker-cat">{alb.trackCount || 0} pistas</span>
              </div>
              <span className={`album-picker-status ${isPresent ? 'in-album' : 'add-hint'}`}>
                {isPresent ? 'Asignado' : '+ Asignar'}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function Player() {
  const {
    currentTrack,
    currentAlbum,
    isPlaying,
    isVideoTrack,
    bindVideoElement,
    duration,
    shuffle,
    loop,
    togglePlay,
    nextTrack,
    previousTrack,
    seekTo,
    toggleShuffle,
    toggleLoop,
    eqState
  } = usePlayback()

  const { getTrackAlbumInfo } = useLibrary()

  const [isExpanded, setIsExpanded] = useState(false)
  const [activeStageTab, setActiveStageTab] = useState('cover') // 'cover' | 'lyrics' | 'eq' | 'albums'
  const [preferCoverOverVideo, setPreferCoverOverVideo] = useState(false)
  const [showVisualizer, setShowVisualizer] = useState(() => {
    const saved = localStorage.getItem('rep_show_visualizer')
    return saved === null ? true : saved === 'true'
  })

  const videoContainerRef = useRef(null)
  const touchStartYRef = useRef(null)

  const trackIsVideo = Boolean(isVideoTrack || currentTrack?.mediaType === 'video')

  // Resetear preferencia de video al cambiar de pista
  useEffect(() => {
    setPreferCoverOverVideo(false)
  }, [currentTrack?.id])

  // Permitir que otros componentes (como AlbumView) abran el NowPlayingSheet en una pestaña específica
  useEffect(() => {
    const handleOpenNowPlaying = (e) => {
      const requestedTab = e.detail?.tab
      if (requestedTab) {
        setActiveStageTab(requestedTab)
      }
      setIsExpanded(true)
    }
    window.addEventListener('open-now-playing', handleOpenNowPlaying)
    return () => window.removeEventListener('open-now-playing', handleOpenNowPlaying)
  }, [])

  const toggleVisualizer = useCallback(() => {
    void triggerHaptic()
    setShowVisualizer((prev) => {
      const next = !prev
      localStorage.setItem('rep_show_visualizer', String(next))
      return next
    })
  }, [])

  // Gestos táctiles para abrir el MiniPlayer deslizando hacia arriba
  const handleMiniTouchStart = useCallback((e) => {
    const touch = e.touches?.[0]
    if (touch) touchStartYRef.current = touch.clientY
  }, [])

  const handleMiniTouchEnd = useCallback((e) => {
    if (touchStartYRef.current === null) return
    const touch = e.changedTouches?.[0]
    if (touch) {
      const deltaY = touch.clientY - touchStartYRef.current
      if (deltaY < -28) {
        void triggerHaptic()
        setIsExpanded(true)
      }
    }
    touchStartYRef.current = null
  }, [])

  // Gestos táctiles para contraer el NowPlayingSheet deslizando hacia abajo desde la cabecera
  const handleSheetHeaderTouchStart = useCallback((e) => {
    const touch = e.touches?.[0]
    if (touch) touchStartYRef.current = touch.clientY
  }, [])

  const handleSheetHeaderTouchEnd = useCallback((e) => {
    if (touchStartYRef.current === null) return
    const touch = e.changedTouches?.[0]
    if (touch) {
      const deltaY = touch.clientY - touchStartYRef.current
      if (deltaY > 45) {
        void triggerHaptic()
        setIsExpanded(false)
      }
    }
    touchStartYRef.current = null
  }, [])

  const handleFullscreenVideo = useCallback(() => {
    const el = videoContainerRef.current?.querySelector('video') || videoContainerRef.current
    if (!el) return
    if (document.fullscreenElement) {
      document.exitFullscreen?.().catch(() => {})
    } else {
      el.requestFullscreen?.().catch(() => {})
    }
  }, [])

  const albumInfo = currentTrack ? getTrackAlbumInfo(currentTrack) : null
  const albumCount = albumInfo?.albumCount || currentTrack?.albumCount || 1

  if (!currentTrack) {
    return null
  }

  return (
    <>
      {/* 1. MINIPLAYER ACOPLADO ENCIMA DE BOTTOMNAVBAR (~64px) */}
      <div
        className={`mobile-mini-player ${isExpanded ? 'sheet-open' : ''}`}
        onTouchStart={handleMiniTouchStart}
        onTouchEnd={handleMiniTouchEnd}
        onClick={() => {
          void triggerHaptic()
          setIsExpanded(true)
        }}
        role="region"
        aria-label="Mini reproductor"
      >
        <MiniPlayerProgressBar duration={duration} />

        <div className="mini-player-content">
          <div className="mini-player-thumb-wrap">
            {currentTrack.cover ? (
              <img
                src={currentTrack.cover}
                alt=""
                className="mini-player-thumb"
                decoding="async"
                onError={(e) => {
                  e.currentTarget.style.display = 'none'
                }}
              />
            ) : (
              <div className="mini-player-thumb-placeholder">
                {trackIsVideo ? '🎬' : '💿'}
              </div>
            )}
            {trackIsVideo && <span className="mini-player-video-badge">🎬</span>}
          </div>

          <div className="mini-player-meta">
            <div className="mini-player-title">{currentTrack.title || 'Sin título'}</div>
            <div className="mini-player-artist">
              <span>{currentTrack.artist || 'Artista desconocido'}</span>
              {albumCount > 1 && (
                <span className="mini-player-album-pill">🔖 {albumCount}</span>
              )}
            </div>
          </div>

          <div className="mini-player-actions" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="mini-player-touch-btn play-btn"
              onClick={() => {
                void triggerHaptic()
                togglePlay()
              }}
              aria-label={isPlaying ? 'Pausar' : 'Reproducir'}
            >
              {isPlaying ? <Icons.Pause /> : <Icons.Play />}
            </button>

            <button
              type="button"
              className="mini-player-touch-btn next-btn"
              onClick={() => {
                void triggerHaptic()
                nextTrack()
              }}
              aria-label="Siguiente canción"
            >
              <Icons.Next />
            </button>
          </div>
        </div>
      </div>

      {/* 2. BOTTOMSHEET DESLIZABLE "NOW PLAYING" A PANTALLA COMPLETA */}
      {isExpanded && (
        <div className="now-playing-sheet-backdrop" onClick={() => setIsExpanded(false)}>
          <div
            className="now-playing-sheet"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Reproduciendo ahora"
          >
            {/* Resplandor ambiental dinámico basado en la carátula */}
            {currentTrack.cover && (
              <div
                className="now-playing-ambient-bg"
                style={{ backgroundImage: `url("${currentTrack.cover}")` }}
              />
            )}

            {/* Cabecera con Pill Handle, álbum actual y botón de Marcadores */}
            <div
              className="now-playing-sheet-header"
              onTouchStart={handleSheetHeaderTouchStart}
              onTouchEnd={handleSheetHeaderTouchEnd}
            >
              <div className="now-playing-pill-handle" />

              <div className="now-playing-top-bar">
                <button
                  type="button"
                  className="np-icon-touch-btn"
                  onClick={() => {
                    void triggerHaptic()
                    setIsExpanded(false)
                  }}
                  aria-label="Contraer reproductor"
                  title="Contraer"
                >
                  <span style={{ fontSize: '22px', lineHeight: 1 }}>⌄</span>
                </button>

                <div className="now-playing-header-center">
                  <span className="np-playing-from-label">
                    {trackIsVideo ? '🎬 VIDEO EN REPRODUCCIÓN' : 'REPRODUCIENDO DESDE'}
                  </span>
                  <span className="np-playing-album-name">
                    {currentAlbum?.name || currentTrack.albumName || 'Biblioteca'}
                  </span>
                </div>

                <button
                  type="button"
                  className={`np-icon-touch-btn np-bookmark-top-btn ${activeStageTab === 'albums' ? 'active' : ''}`}
                  onClick={() => {
                    void triggerHaptic()
                    setActiveStageTab((prev) => (prev === 'albums' ? 'cover' : 'albums'))
                  }}
                  aria-label="Gestionar álbumes de esta canción"
                  title="Asignar o quitar de álbumes (M:N)"
                >
                  <Icons.Bookmark filled={albumCount > 1 || activeStageTab === 'albums'} />
                  {albumCount > 1 && <span className="np-bookmark-count">{albumCount}</span>}
                </button>
              </div>
            </div>

            {/* Zona Central Multimedia (Carátula / Video / Letras / EQ / Álbumes) */}
            <div className="now-playing-stage">
              {activeStageTab === 'cover' && (
                <div className="np-cover-video-stage">
                  {trackIsVideo && (
                    <div className="np-media-mode-switch">
                      <button
                        type="button"
                        className={`np-mode-pill ${!preferCoverOverVideo ? 'active' : ''}`}
                        onClick={() => setPreferCoverOverVideo(false)}
                      >
                        🎬 Video
                      </button>
                      <button
                        type="button"
                        className={`np-mode-pill ${preferCoverOverVideo ? 'active' : ''}`}
                        onClick={() => setPreferCoverOverVideo(true)}
                      >
                        💿 Carátula
                      </button>
                      {!preferCoverOverVideo && (
                        <button
                          type="button"
                          className="np-mode-pill"
                          onClick={handleFullscreenVideo}
                          title="Pantalla completa"
                        >
                          ⛶ Pantalla completa
                        </button>
                      )}
                    </div>
                  )}

                  {trackIsVideo && !preferCoverOverVideo ? (
                    <div className="np-video-wrapper" ref={videoContainerRef}>
                      <video
                        ref={bindVideoElement}
                        className="np-video-player"
                        playsInline
                        muted
                        onClick={togglePlay}
                      />
                    </div>
                  ) : (
                    <div className="np-artwork-showcase">
                      {currentTrack.cover ? (
                        <img
                          src={currentTrack.cover}
                          alt={currentTrack.title}
                          className="np-artwork-img"
                          decoding="async"
                        />
                      ) : (
                        <div className="np-artwork-placeholder">
                          {trackIsVideo ? '🎬' : '💿'}
                        </div>
                      )}

                      {showVisualizer && (
                        <div className="np-visualizer-overlay">
                          <AudioVisualizer height={44} barCount={40} />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {activeStageTab === 'lyrics' && (
                <NowPlayingLyricsView currentTrack={currentTrack} seekTo={seekTo} />
              )}

              {activeStageTab === 'eq' && <NowPlayingEqualizerView />}

              {activeStageTab === 'albums' && (
                <NowPlayingAlbumsBookmarkView track={currentTrack} />
              )}
            </div>

            {/* Información de la pista actual */}
            <div className="now-playing-track-meta">
              <div className="np-track-text">
                <h2 className="np-track-title">{currentTrack.title || 'Sin título'}</h2>
                <p className="np-track-artist">{currentTrack.artist || 'Artista desconocido'}</p>
              </div>

              <button
                type="button"
                className={`np-visualizer-toggle-btn ${showVisualizer ? 'active' : ''}`}
                onClick={toggleVisualizer}
                title="Alternar visualizador de espectro"
                aria-label="Alternar visualizador de espectro"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M4 19h2V5H4v14zm4 0h2V9H8v10zm4 0h2V3h-2v16zm4 0h2v-8h-2v8zm4 0h2v-4h-2v4z" />
                </svg>
              </button>
            </div>

            {/* Scrubber táctil */}
            <div className="now-playing-scrubber-box">
              <PlayerTimeline duration={duration} isPlaying={isPlaying} seekTo={seekTo} />
            </div>

            {/* Controles Principales Grandes (Shuffle, Prev, Play/Pause 64px, Next, Repeat) */}
            <div className="now-playing-main-controls">
              <button
                type="button"
                className={`np-control-btn secondary ${shuffle ? 'active' : ''}`}
                onClick={() => {
                  void triggerHaptic()
                  toggleShuffle()
                }}
                aria-label="Aleatorio"
              >
                <Icons.Shuffle />
              </button>

              <button
                type="button"
                className="np-control-btn transport"
                onClick={() => {
                  void triggerHaptic()
                  previousTrack()
                }}
                aria-label="Anterior"
              >
                <Icons.Previous />
              </button>

              <button
                type="button"
                className="np-control-btn primary-play"
                onClick={() => {
                  void triggerHaptic()
                  togglePlay()
                }}
                aria-label={isPlaying ? 'Pausar' : 'Reproducir'}
              >
                {isPlaying ? <Icons.Pause /> : <Icons.Play />}
              </button>

              <button
                type="button"
                className="np-control-btn transport"
                onClick={() => {
                  void triggerHaptic()
                  nextTrack()
                }}
                aria-label="Siguiente"
              >
                <Icons.Next />
              </button>

              <button
                type="button"
                className={`np-control-btn secondary ${loop !== 'none' ? 'active' : ''}`}
                onClick={() => {
                  void triggerHaptic()
                  toggleLoop()
                }}
                aria-label="Repetir"
              >
                {loop === 'one' ? <Icons.LoopOne /> : <Icons.Loop />}
              </button>
            </div>

            {/* Pestañas inferiores del reproductor: Carátula | Letras 🎤 | EQ 🎚️ | Álbumes 🔖 */}
            <div className="now-playing-bottom-tabs">
              <button
                type="button"
                className={`np-tab-pill ${activeStageTab === 'cover' ? 'active' : ''}`}
                onClick={() => {
                  void triggerHaptic()
                  setActiveStageTab('cover')
                }}
              >
                <span>{trackIsVideo ? '🎬 Video / Arte' : '💿 Carátula'}</span>
              </button>

              <button
                type="button"
                className={`np-tab-pill ${activeStageTab === 'lyrics' ? 'active' : ''}`}
                onClick={() => {
                  void triggerHaptic()
                  setActiveStageTab('lyrics')
                }}
              >
                <span>Letras 🎤</span>
              </button>

              <button
                type="button"
                className={`np-tab-pill ${activeStageTab === 'eq' ? 'active' : ''} ${eqState?.enabled ? 'eq-on' : ''}`}
                onClick={() => {
                  void triggerHaptic()
                  setActiveStageTab('eq')
                }}
              >
                <span>EQ 🎚️</span>
              </button>

              <button
                type="button"
                className={`np-tab-pill ${activeStageTab === 'albums' ? 'active' : ''}`}
                onClick={() => {
                  void triggerHaptic()
                  setActiveStageTab('albums')
                }}
              >
                <span>Álbumes 🔖 {albumCount > 1 ? `(${albumCount})` : ''}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

export default React.memo(Player)
