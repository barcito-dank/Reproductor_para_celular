import { usePlayer } from '../context/PlayerContext'
import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { areSameTrack } from '../utils/trackUtils'

const ALBUM_ROW_HEIGHT = 63 // 60px alto de fila + 3px margen inferior
const ALBUM_OVERSCAN = 8

function formatTime(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

function formatFileSize(bytes) {
  if (!bytes || isNaN(bytes) || bytes <= 0) return 'Desconocido'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB (${bytes.toLocaleString()} bytes)`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB (${bytes.toLocaleString()} bytes)`
}

function formatDateTime(ms) {
  if (!ms || isNaN(ms) || ms <= 0) return 'Desconocida'
  try {
    return new Date(ms).toLocaleString('es-AR', {
      dateStyle: 'medium',
      timeStyle: 'short'
    })
  } catch (_) {
    return new Date(ms).toLocaleString()
  }
}

/**
 * Icono de marcador (Bookmark) fiel al diseño de la imagen proporcionada por el usuario
 */
function BookmarkIcon({ filled = false }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="track-bookmark-svg"
    >
      <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
    </svg>
  )
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

const TrackRow = React.memo(function TrackRow({
  track,
  index,
  isActive,
  isPlaying,
  albumCount,
  albumNamesText,
  isAlbumPickerOpen,
  onSelectTrack,
  onOpenAlbumPicker,
  onContextMenuTrack
}) {
  const handleBookmarkClick = (e) => {
    e.stopPropagation()
    const rect = e.currentTarget.getBoundingClientRect()
    onOpenAlbumPicker(track, {
      x: rect.right,
      anchorRight: rect.right,
      y: rect.bottom + 6,
      anchorTop: rect.top
    })
  }

  const handleRowContextMenu = (e) => {
    e.preventDefault()
    e.stopPropagation()
    onContextMenuTrack(track, { x: e.clientX, y: e.clientY })
  }

  const bookmarkTooltip =
    albumCount > 1
      ? `Presente en ${albumCount} álbumes (${albumNamesText}) · Clic para agregar a otros álbumes`
      : `Presente en 1 álbum (${albumNamesText || track.albumName || 'Actual'}) · Clic para agregar a otros álbumes`

  return (
    <li
      className={`track-item ${isActive ? 'active' : ''}`}
      onClick={() => onSelectTrack(track, index)}
      onContextMenu={handleRowContextMenu}
    >
      {/* Número o Indicador de Ecualizador Animado */}
      <div className="track-number">
        {isActive ? (
          <AnimatedEqualizer isPaused={!isPlaying} />
        ) : (
          <span className="track-index-num">{index + 1}</span>
        )}
      </div>

      {/* Miniatura de la Imagen de la Canción con Hover Play */}
      <div className="track-cover-container">
        {track.cover ? (
          <img
            src={track.cover}
            alt=""
            className="track-thumb-img"
            loading="lazy"
            decoding="async"
          />
        ) : (
          <div className="track-thumb-fallback">🎵</div>
        )}
        <div className="track-thumb-hover-overlay">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5v14l11-7z" />
          </svg>
        </div>
      </div>

      {/* Título y Artista */}
      <div className="track-info">
        <div className="track-title-row">
          <div className="track-title" title={track.title}>{track.title}</div>
        </div>
        <div className="track-artist" title={track.artist}>{track.artist}</div>
      </div>

      {/* Botón de Marcador / Álbumes con casillas */}
      <button
        type="button"
        className={`track-bookmark-btn ${albumCount > 1 ? 'in-multiple' : ''} ${isAlbumPickerOpen ? 'open' : ''}`}
        onClick={handleBookmarkClick}
        title={bookmarkTooltip}
        aria-label="Gestionar álbumes de esta canción"
      >
        <BookmarkIcon filled={albumCount > 1 || isAlbumPickerOpen} />
        {albumCount > 1 && <span className="track-bookmark-count">{albumCount}</span>}
      </button>

      {/* Duración */}
      <span className="track-duration">{formatTime(track.duration)}</span>
    </li>
  )
})

function AlbumMembershipPopover({
  track,
  position,
  allAlbums,
  albumInfo,
  onAddTrackToAlbum,
  onClose
}) {
  const popoverRef = useRef(null)
  const [albumFilter, setAlbumFilter] = useState('')
  const [busyAlbumId, setBusyAlbumId] = useState(null)

  useEffect(() => {
    const handlePointerDown = (e) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target)) {
        onClose()
      }
    }
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

  const filteredAlbums = useMemo(() => {
    const q = albumFilter.trim().toLowerCase()
    if (!q) return allAlbums
    return allAlbums.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        (a.categoryPath && a.categoryPath.toLowerCase().includes(q))
    )
  }, [allAlbums, albumFilter])

  const popWidth = 320
  const popMaxHeight = 410
  const winW = typeof window !== 'undefined' ? window.innerWidth : 1200
  const winH = typeof window !== 'undefined' ? window.innerHeight : 800

  const anchorRight = position?.anchorRight ?? position?.x ?? (winW - 220)
  let left = anchorRight - popWidth
  if (left < 16) left = 16
  if (left + popWidth > winW - 16) left = winW - popWidth - 16

  let top = position?.y ?? 120
  if (top + popMaxHeight > winH - 70) {
    top = Math.max(16, (position?.anchorTop ?? top) - popMaxHeight - 6)
  }

  const presentSet = albumInfo?.albumIdsSet || new Set()
  const presentCount = albumInfo?.albumCount || 1

  const handleToggleAlbum = async (albumItem) => {
    if (presentSet.has(albumItem.id) || busyAlbumId) return
    setBusyAlbumId(albumItem.id)
    try {
      await onAddTrackToAlbum(track, albumItem)
    } finally {
      setBusyAlbumId(null)
    }
  }

  const popoverContent = (
    <div
      ref={popoverRef}
      className="album-picker-popover"
      style={{ left: `${left}px`, top: `${top}px` }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="album-picker-header">
        <div className="album-picker-header-top">
          <div className="album-picker-song">
            <span className="album-picker-song-title" title={track.title}>{track.title}</span>
            <span className="album-picker-song-sub">
              En <strong>{presentCount}</strong> de {allAlbums.length} álbumes
            </span>
          </div>
          <button type="button" className="album-picker-close" onClick={onClose} title="Cerrar">
            ✕
          </button>
        </div>

        {allAlbums.length > 4 && (
          <input
            type="text"
            className="album-picker-search"
            placeholder="Filtrar álbumes..."
            value={albumFilter}
            onChange={(e) => setAlbumFilter(e.target.value)}
            autoFocus
          />
        )}
      </div>

      <div className="album-picker-list">
        {filteredAlbums.map((alb) => {
          const isPresent = presentSet.has(alb.id)
          const isBusy = busyAlbumId === alb.id

          return (
            <label
              key={alb.id}
              className={`album-picker-item ${isPresent ? 'present' : ''} ${isBusy ? 'busy' : ''}`}
              onClick={(e) => {
                e.preventDefault()
                handleToggleAlbum(alb)
              }}
              title={
                isPresent
                  ? `Esta canción ya se encuentra en "${alb.name}"`
                  : `Marcar para agregar copia a "${alb.name}"`
              }
            >
              <input
                type="checkbox"
                className="album-picker-checkbox"
                checked={isPresent}
                readOnly
              />
              <span className={`album-picker-check-box ${isPresent ? 'checked' : ''}`}>
                {isPresent ? '✓' : isBusy ? '…' : ''}
              </span>

              {alb.cover ? (
                <img src={alb.cover} alt="" className="album-picker-thumb" loading="lazy" />
              ) : (
                <div className="album-picker-thumb-fallback">💿</div>
              )}

              <div className="album-picker-meta">
                <span className="album-picker-name">{alb.name}</span>
                {alb.categoryPath && alb.categoryPath !== alb.name && (
                  <span className="album-picker-cat">{alb.categoryPath}</span>
                )}
              </div>

              <span className={`album-picker-status ${isPresent ? 'in-album' : 'add-hint'}`}>
                {isBusy ? 'Copiando...' : isPresent ? 'En álbum' : '+ Agregar'}
              </span>
            </label>
          )
        })}

        {filteredAlbums.length === 0 && (
          <div className="album-picker-empty">No se encontraron álbumes</div>
        )}
      </div>

      <div className="album-picker-footer">
        <span className="album-picker-footer-hint">
          Marca cualquier casilla para copiar la canción a ese álbum
        </span>
        <button type="button" className="album-picker-done-btn" onClick={onClose}>
          Listo
        </button>
      </div>
    </div>
  )

  return typeof document !== 'undefined' ? createPortal(popoverContent, document.body) : null
}

function TrackContextMenu({
  track,
  position,
  onClose,
  onOpenFolder,
  onOpenAlbumPicker,
  onCopyTitle,
  onCopyArtist,
  onOpenProperties,
  onRequestDelete
}) {
  const menuRef = useRef(null)

  useEffect(() => {
    const handlePointerDown = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        onClose()
      }
    }
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [onClose])

  const menuWidth = 215
  const menuHeight = 185
  const winW = typeof window !== 'undefined' ? window.innerWidth : 1200
  const winH = typeof window !== 'undefined' ? window.innerHeight : 800

  let left = position.x
  if (left + menuWidth > winW - 12) {
    left = Math.max(12, position.x - menuWidth)
  }
  let top = position.y
  if (top + menuHeight > winH - 65) {
    top = Math.max(12, position.y - menuHeight)
  }

  const content = (
    <div
      ref={menuRef}
      className="track-context-menu"
      style={{ left: `${left}px`, top: `${top}px` }}
      role="menu"
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="track-context-item"
        onClick={() => {
          onOpenFolder(track)
          onClose()
        }}
      >
        <span className="track-context-icon">📂</span>
        <span>Abrir</span>
        <span className="track-context-sub">Ubicación</span>
      </button>

      <button
        type="button"
        className="track-context-item"
        onClick={() => {
          onClose()
          onOpenAlbumPicker(track, {
            x: left + menuWidth,
            anchorRight: left + menuWidth,
            y: top,
            anchorTop: top
          })
        }}
      >
        <span className="track-context-icon">🔖</span>
        <span>Agregar</span>
        <span className="track-context-sub">A álbumes</span>
      </button>

      <div className="track-context-sep" />

      {/* Fila compacta: Copiar: Título / Artista */}
      <div className="track-context-copy-row">
        <span className="track-context-copy-label">Copiar:</span>
        <div className="track-context-copy-buttons">
          <button
            type="button"
            className="track-copy-pill-btn"
            onClick={() => {
              onCopyTitle(track)
              onClose()
            }}
            title="Copiar título"
          >
            Título
          </button>
          <span className="track-copy-slash">/</span>
          <button
            type="button"
            className="track-copy-pill-btn"
            onClick={() => {
              onCopyArtist(track)
              onClose()
            }}
            title="Copiar artista"
          >
            Artista
          </button>
        </div>
      </div>

      <div className="track-context-sep" />

      <button
        type="button"
        className="track-context-item"
        onClick={() => {
          onOpenProperties(track)
          onClose()
        }}
      >
        <span className="track-context-icon">ℹ️</span>
        <span>Propiedades</span>
      </button>

      <button
        type="button"
        className="track-context-item danger"
        onClick={() => {
          onRequestDelete(track)
          onClose()
        }}
      >
        <span className="track-context-icon">🗑️</span>
        <span>Eliminar</span>
      </button>
    </div>
  )

  return typeof document !== 'undefined' ? createPortal(content, document.body) : null
}

function TrackPropertiesModal({ track, albumInfo, onClose, onOpenFolder }) {
  const [details, setDetails] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    setLoading(true)
    if (window.electronAPI?.getTrackProperties && track?.path) {
      window.electronAPI
        .getTrackProperties(track.path)
        .then((res) => {
          if (active) {
            setDetails(res)
            setLoading(false)
          }
        })
        .catch(() => {
          if (active) setLoading(false)
        })
    } else {
      setLoading(false)
    }

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      active = false
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [track, onClose])

  if (!track) return null

  const sizeBytes = details?.size ?? track.size ?? 0
  const durationSec = details?.duration || track.duration || 0
  const bitrate = details?.bitrate ?? track.bitrate
  const sampleRate = details?.sampleRate ?? track.sampleRate
  const codec = details?.codec ?? track.codec ?? 'Audio'
  const channels = details?.numberOfChannels
  const albumNames = albumInfo?.albumNames?.length
    ? albumInfo.albumNames
    : [track.albumName || 'Álbum actual']

  const modalContent = (
    <div className="track-modal-backdrop" onClick={onClose}>
      <div className="track-modal-card" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Propiedades de la canción">
        <div className="track-modal-header">
          <div className="track-modal-title-group">
            {track.cover ? (
              <img src={track.cover} alt="" className="track-modal-cover" />
            ) : (
              <div className="track-modal-cover-placeholder">🎵</div>
            )}
            <div>
              <h3>Propiedades de la canción</h3>
              <p className="track-modal-subtitle">{track.title}</p>
            </div>
          </div>
          <button type="button" className="track-modal-close" onClick={onClose} title="Cerrar">
            ✕
          </button>
        </div>

        <div className="track-modal-body">
          <div className="track-props-grid">
            <div className="track-prop-row">
              <span className="track-prop-label">Título</span>
              <span className="track-prop-value">{details?.title || track.title}</span>
            </div>
            <div className="track-prop-row">
              <span className="track-prop-label">Artista</span>
              <span className="track-prop-value">{details?.artist || track.artist || 'Artista Desconocido'}</span>
            </div>
            <div className="track-prop-row">
              <span className="track-prop-label">Álbumes ({albumNames.length})</span>
              <div className="track-prop-value track-prop-badges">
                {albumNames.map((name) => (
                  <span key={name} className="track-prop-album-chip">{name}</span>
                ))}
              </div>
            </div>
            <div className="track-prop-row">
              <span className="track-prop-label">Duración</span>
              <span className="track-prop-value">
                {formatTime(durationSec)} ({Math.round(durationSec)} segundos)
              </span>
            </div>
            <div className="track-prop-row">
              <span className="track-prop-label">Tamaño</span>
              <span className="track-prop-value">
                {loading && !sizeBytes ? 'Calculando...' : formatFileSize(sizeBytes)}
              </span>
            </div>
            <div className="track-prop-row">
              <span className="track-prop-label">Formato / Códec</span>
              <span className="track-prop-value">
                {codec}
                {bitrate ? ` · ${bitrate} kbps` : ''}
                {sampleRate ? ` · ${sampleRate} Hz` : ''}
                {channels ? ` · ${channels === 2 ? 'Estéreo' : `${channels} canales`}` : ''}
              </span>
            </div>
            {details?.modifiedAt > 0 && (
              <div className="track-prop-row">
                <span className="track-prop-label">Modificado</span>
                <span className="track-prop-value">{formatDateTime(details.modifiedAt)}</span>
              </div>
            )}
            <div className="track-prop-row">
              <span className="track-prop-label">Ubicación</span>
              <span className="track-prop-value track-prop-path">{track.path}</span>
            </div>
          </div>
        </div>

        <div className="track-modal-footer">
          <button
            type="button"
            className="track-modal-btn secondary"
            onClick={() => onOpenFolder(track)}
          >
            📂 Abrir ubicación
          </button>
          <button type="button" className="track-modal-btn primary" onClick={onClose}>
            Cerrar
          </button>
        </div>
      </div>
    </div>
  )

  return typeof document !== 'undefined' ? createPortal(modalContent, document.body) : null
}

function DeleteTrackConfirmModal({ track, onCancel, onConfirm, isDeleting }) {
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && !isDeleting) onCancel()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onCancel, isDeleting])

  if (!track) return null

  const modalContent = (
    <div className="track-modal-backdrop" onClick={() => !isDeleting && onCancel()}>
      <div className="track-modal-card confirm-delete-card" onClick={(e) => e.stopPropagation()} role="alertdialog" aria-label="Confirmar eliminación">
        <div className="track-modal-header">
          <div className="track-modal-title-group">
            <div className="track-delete-icon-badge">🗑️</div>
            <div>
              <h3>¿Eliminar esta canción?</h3>
              <p className="track-modal-subtitle">{track.title} — {track.artist}</p>
            </div>
          </div>
        </div>

        <div className="track-modal-body">
          <p className="track-delete-warning">
            Se eliminará el archivo de audio del disco (se enviará a la Papelera de reciclaje):
          </p>
          <div className="track-delete-path-box">{track.path}</div>
        </div>

        <div className="track-modal-footer">
          <button
            type="button"
            className="track-modal-btn secondary"
            onClick={onCancel}
            disabled={isDeleting}
          >
            Cancelar
          </button>
          <button
            type="button"
            className="track-modal-btn danger"
            onClick={() => onConfirm(track)}
            disabled={isDeleting}
          >
            {isDeleting ? 'Eliminando...' : 'Sí, eliminar archivo'}
          </button>
        </div>
      </div>
    </div>
  )

  return typeof document !== 'undefined' ? createPortal(modalContent, document.body) : null
}

function AlbumView() {
  const {
    selectedAlbum,
    allAlbums,
    getTrackAlbumInfo,
    addTrackToAlbums,
    deleteTrackFromDisk,
    playAlbum,
    playTrack,
    currentTrack,
    isPlaying,
    isLoading,
    library
  } = usePlayer()
  const [filterText, setFilterText] = useState('')
  const [sortBy, setSortBy] = useState('default') // 'default' | 'title-asc' | 'title-desc' | 'artist-asc' | 'artist-desc'
  const listRef = useRef(null)
  const [startIndex, setStartIndex] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(680)
  const prevAlbumIdRef = useRef(null)

  // Estados para desplegable de álbumes (marcador), menú contextual, propiedades y confirmación de borrado
  const [albumPickerState, setAlbumPickerState] = useState(null) // { track, position }
  const [contextMenuState, setContextMenuState] = useState(null) // { track, position }
  const [propertiesTrack, setPropertiesTrack] = useState(null)
  const [deleteTargetTrack, setDeleteTargetTrack] = useState(null)
  const [isDeletingTrack, setIsDeletingTrack] = useState(false)
  const [feedbackBanner, setFeedbackBanner] = useState(null)
  const feedbackTimeoutRef = useRef(null)

  const showFeedback = useCallback((message) => {
    if (feedbackTimeoutRef.current) clearTimeout(feedbackTimeoutRef.current)
    setFeedbackBanner(message)
    feedbackTimeoutRef.current = setTimeout(() => {
      setFeedbackBanner(null)
      feedbackTimeoutRef.current = null
    }, 2600)
  }, [])

  useEffect(() => {
    return () => {
      if (feedbackTimeoutRef.current) clearTimeout(feedbackTimeoutRef.current)
    }
  }, [])

  const handleOpenAlbumPicker = useCallback((track, position) => {
    setContextMenuState(null)
    setAlbumPickerState((prev) =>
      prev && prev.track.id === track.id ? null : { track, position }
    )
  }, [])

  const handleOpenContextMenu = useCallback((track, position) => {
    setAlbumPickerState(null)
    setContextMenuState({ track, position })
  }, [])

  const handleOpenInFolder = useCallback((track) => {
    if (track?.path && window.electronAPI?.showItemInFolder) {
      window.electronAPI.showItemInFolder(track.path)
    }
  }, [])

  const handleCopyTitle = useCallback((track) => {
    if (!track?.title) return
    navigator.clipboard?.writeText(track.title).catch(() => {})
    showFeedback(`✓ Título copiado: "${track.title}"`)
  }, [showFeedback])

  const handleCopyArtist = useCallback((track) => {
    const artist = track?.artist || 'Artista Desconocido'
    navigator.clipboard?.writeText(artist).catch(() => {})
    showFeedback(`✓ Artista copiado: "${artist}"`)
  }, [showFeedback])

  const handleAddTrackToSingleAlbum = useCallback(async (track, targetAlbum) => {
    const res = await addTrackToAlbums(track, [targetAlbum])
    if (res && res.success) {
      showFeedback(`✓ "${track.title}" agregada al álbum "${targetAlbum.name}"`)
    } else {
      showFeedback(`⚠ No se pudo agregar a "${targetAlbum.name}"`)
    }
  }, [addTrackToAlbums, showFeedback])

  const handleConfirmDeleteTrack = useCallback(async (track) => {
    if (!track) return
    setIsDeletingTrack(true)
    try {
      const res = await deleteTrackFromDisk(track)
      if (res && res.success) {
        showFeedback(`🗑️ Eliminada: "${track.title}"`)
        setDeleteTargetTrack(null)
      } else {
        showFeedback(`⚠ Error al eliminar: ${res?.error || 'No se pudo borrar el archivo'}`)
      }
    } finally {
      setIsDeletingTrack(false)
    }
  }, [deleteTrackFromDisk, showFeedback])

  // Alternar orden por título: default -> A-Z -> Z-A -> default
  const handleToggleTitleSort = useCallback(() => {
    setSortBy((prev) => {
      if (prev === 'title-asc') return 'title-desc'
      if (prev === 'title-desc') return 'default'
      return 'title-asc'
    })
  }, [])

  // Alternar orden por artista: default -> A-Z -> Z-A -> default
  const handleToggleArtistSort = useCallback(() => {
    setSortBy((prev) => {
      if (prev === 'artist-asc') return 'artist-desc'
      if (prev === 'artist-desc') return 'default'
      return 'artist-asc'
    })
  }, [])

  // Filtrado y ordenamiento de canciones
  const displayTracks = useMemo(() => {
    if (!selectedAlbum || !selectedAlbum.tracks) return []
    let list = selectedAlbum.tracks

    // 1. Filtrado por texto (título o artista)
    if (filterText.trim()) {
      const q = filterText.toLowerCase()
      list = list.filter((t) =>
        t.title.toLowerCase().includes(q) ||
        (t.artist && t.artist.toLowerCase().includes(q))
      )
    }

    // 2. Ordenamiento
    if (sortBy === 'default') {
      return list
    }

    const copy = [...list]
    switch (sortBy) {
      case 'title-asc':
        return copy.sort((a, b) =>
          a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' })
        )
      case 'title-desc':
        return copy.sort((a, b) =>
          b.title.localeCompare(a.title, undefined, { numeric: true, sensitivity: 'base' })
        )
      case 'artist-asc':
        return copy.sort((a, b) => {
          const comp = (a.artist || '').localeCompare(b.artist || '', undefined, { numeric: true, sensitivity: 'base' })
          return comp !== 0 ? comp : a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' })
        })
      case 'artist-desc':
        return copy.sort((a, b) => {
          const comp = (b.artist || '').localeCompare(a.artist || '', undefined, { numeric: true, sensitivity: 'base' })
          return comp !== 0 ? comp : b.title.localeCompare(a.title, undefined, { numeric: true, sensitivity: 'base' })
        })
      default:
        return copy
    }
  }, [selectedAlbum, filterText, sortBy])

  const updateVisibleWindow = useCallback(() => {
    const listEl = listRef.current
    if (!listEl) return
    const scrollContainer = listEl.closest('.main-view')
    if (!scrollContainer) return

    const viewH = scrollContainer.clientHeight > 0 ? scrollContainer.clientHeight : 680
    const listOffsetTop = listEl.offsetTop
    const relativeScroll = Math.max(0, scrollContainer.scrollTop - listOffsetTop)
    const nextStart = Math.max(0, Math.floor(relativeScroll / ALBUM_ROW_HEIGHT) - ALBUM_OVERSCAN)

    setStartIndex((prev) => (prev === nextStart ? prev : nextStart))
    setViewportHeight((prev) => (Math.abs(prev - viewH) > 4 ? viewH : prev))
  }, [])

  // Suscribir al scroll y resize del contenedor .main-view
  useEffect(() => {
    if (isLoading || !selectedAlbum) return undefined
    const listEl = listRef.current
    if (!listEl) return undefined
    const scrollContainer = listEl.closest('.main-view')
    if (!scrollContainer) return undefined

    const onScroll = () => updateVisibleWindow()
    scrollContainer.addEventListener('scroll', onScroll, { passive: true })

    const ro = new ResizeObserver(() => updateVisibleWindow())
    ro.observe(scrollContainer)

    updateVisibleWindow()

    return () => {
      scrollContainer.removeEventListener('scroll', onScroll)
      ro.disconnect()
    }
  }, [isLoading, selectedAlbum, updateVisibleWindow])

  // Reiniciar scroll al cambiar de álbum y recalcular ventana al filtrar/ordenar
  useEffect(() => {
    const listEl = listRef.current
    const scrollContainer = listEl?.closest('.main-view')
    const currentAlbumId = selectedAlbum?.id ?? null

    if (prevAlbumIdRef.current !== currentAlbumId) {
      prevAlbumIdRef.current = currentAlbumId
      if (scrollContainer) {
        scrollContainer.scrollTop = 0
      }
      setStartIndex(0)
      return
    }

    updateVisibleWindow()
  }, [selectedAlbum?.id, displayTracks.length, filterText, sortBy, updateVisibleWindow])

  const totalDuration = useMemo(() => {
    if (!selectedAlbum?.tracks) return 0
    return selectedAlbum.tracks.reduce((acc, t) => acc + (t.duration || 0), 0)
  }, [selectedAlbum])

  const handleSelectTrack = useCallback((track, idx) => {
    if (!selectedAlbum) return
    playTrack(track, selectedAlbum, displayTracks, idx)
  }, [playTrack, selectedAlbum, displayTracks])

  if (isLoading) {
    return (
      <div className="loading-view">
        <div className="spinner" />
        <p style={{ color: 'var(--text-dim)' }}>Cargando biblioteca y carátulas...</p>
      </div>
    )
  }

  if (!selectedAlbum) {
    return (
      <div className="welcome-view">
        <div className="welcome-icon">🎵</div>
        <h2>Bienvenido a tu Música</h2>
        <p>
          {library.length === 0
            ? 'No se encontraron canciones en "C:\\Users\\barre\\Music\\canciones_organizadas".'
            : 'Selecciona una categoría o álbum de la barra lateral para ver todas sus canciones con sus respectivas carátulas.'}
        </p>
      </div>
    )
  }

  const album = selectedAlbum
  const totalRows = displayTracks.length
  const visibleCount = Math.ceil(viewportHeight / ALBUM_ROW_HEIGHT) + ALBUM_OVERSCAN * 2
  const clampedStart = totalRows > 0 ? Math.min(startIndex, Math.max(0, totalRows - 1)) : 0
  const endIndex = Math.min(totalRows, clampedStart + visibleCount)
  const topSpacer = clampedStart * ALBUM_ROW_HEIGHT
  const bottomSpacer = Math.max(0, (totalRows - endIndex) * ALBUM_ROW_HEIGHT)
  const visibleTracks = displayTracks.slice(clampedStart, endIndex)

  return (
    <div className="album-view">
      {/* Cabecera del Álbum */}
      <div className="album-header">
        <div className="album-cover-wrapper">
          <div className="album-cover-glow" style={{ backgroundImage: album.cover ? `url("${album.cover}")` : undefined }} />
          {album.cover ? (
            <img src={album.cover} alt={album.name} className="album-cover-large" decoding="async" />
          ) : (
            <div className="album-cover-large-placeholder">💿</div>
          )}
        </div>

        <div className="album-info">
          <div className="album-info-label">
            {album.categoryPath ? `Álbum · ${album.categoryPath}` : 'Álbum'}
          </div>
          <h1>{album.name}</h1>
          <div className="album-info-meta">
            <span>{album.trackCount} canciones</span>
            <span className="dot-sep">•</span>
            <span>{formatTime(totalDuration)} duración total</span>
          </div>

          <div className="album-actions">
            <button className="play-album-btn" onClick={() => playAlbum(album)}>
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
              Reproducir Álbum
            </button>
          </div>
        </div>
      </div>

      {/* Barra de Filtro y Ordenamiento */}
      <div className="album-controls-bar">
        {/* Caja de Filtro Rápido */}
        <div className="album-filter-box">
          <svg className="album-filter-icon" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
          </svg>
          <input
            type="text"
            className="album-filter-input"
            placeholder={`Filtrar entre ${album.tracks.length} canciones...`}
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
          />
          {filterText && (
            <button className="album-filter-clear" onClick={() => setFilterText('')} title="Limpiar filtro">
              ✕
            </button>
          )}
        </div>

        {/* Botones de Ordenamiento */}
        <div className="album-sort-actions">
          <span className="sort-hint-label">Ordenar:</span>

          {/* Ordenar por Título (A-Z / Z-A) */}
          <button
            className={`sort-pill-btn ${sortBy.startsWith('title') ? 'active' : ''}`}
            onClick={handleToggleTitleSort}
            title="Ordenar por título (A-Z / Z-A)"
          >
            <span>Título</span>
            {sortBy === 'title-asc' && <span className="sort-arrow">↑ (A - Z)</span>}
            {sortBy === 'title-desc' && <span className="sort-arrow">↓ (Z - A)</span>}
          </button>

          {/* Ordenar por Artista (A-Z / Z-A) */}
          <button
            className={`sort-pill-btn ${sortBy.startsWith('artist') ? 'active' : ''}`}
            onClick={handleToggleArtistSort}
            title="Ordenar por artista (A-Z / Z-A)"
          >
            <span>Artista</span>
            {sortBy === 'artist-asc' && <span className="sort-arrow">↑ (A - Z)</span>}
            {sortBy === 'artist-desc' && <span className="sort-arrow">↓ (Z - A)</span>}
          </button>

          {/* Restablecer orden */}
          {sortBy !== 'default' && (
            <button
              className="sort-reset-btn"
              onClick={() => setSortBy('default')}
              title="Restablecer al orden original"
            >
              ✕ Restablecer
            </button>
          )}

          {filterText && (
            <span className="filter-count-badge">
              {displayTracks.length} de {album.tracks.length} pistas
            </span>
          )}
        </div>
      </div>

      {/* Cabecera de Lista de Canciones */}
      <div className="track-list-header">
        <span
          className="col-num clickable-header"
          onClick={() => setSortBy('default')}
          title="Restablecer al orden original (#)"
        >
          #
        </span>
        <span
          className={`col-title clickable-header ${sortBy.startsWith('title') ? 'header-sorted' : ''}`}
          onClick={handleToggleTitleSort}
          title="Clic para ordenar por Título (A-Z / Z-A)"
        >
          Título
          {sortBy === 'title-asc' && ' ▴ (A-Z)'}
          {sortBy === 'title-desc' && ' ▾ (Z-A)'}
        </span>
        <span className="col-albums-action" title="Gestionar álbumes donde está cada canción">
          Álbumes
        </span>
        <span className="col-duration">Duración</span>
      </div>

      {/* Lista de Canciones (Virtualizada para máximo rendimiento en álbumes grandes) */}
      <ul
        className="track-list"
        ref={listRef}
        style={
          totalRows > 0
            ? { paddingTop: `${topSpacer}px`, paddingBottom: `${bottomSpacer}px` }
            : undefined
        }
      >
        {visibleTracks.map((track, offsetIdx) => {
          const realIndex = clampedStart + offsetIdx
          const isThisTrackActive = areSameTrack(currentTrack, track, Boolean(album.isAllTracks))
          const info = getTrackAlbumInfo(track)
          const albumCount = info?.albumCount || track.albumCount || 1
          const albumNamesText = info?.albumNames?.length
            ? info.albumNames.join(', ')
            : track.albumName || album.name

          return (
            <TrackRow
              key={track.id}
              track={track}
              index={realIndex}
              isActive={isThisTrackActive}
              isPlaying={isThisTrackActive ? isPlaying : false}
              albumCount={albumCount}
              albumNamesText={albumNamesText}
              isAlbumPickerOpen={albumPickerState?.track?.id === track.id}
              onSelectTrack={handleSelectTrack}
              onOpenAlbumPicker={handleOpenAlbumPicker}
              onContextMenuTrack={handleOpenContextMenu}
            />
          )
        })}

        {displayTracks.length === 0 && filterText && (
          <div className="track-filter-empty">
            <p>No se encontraron canciones que coincidan con "{filterText}"</p>
          </div>
        )}

        {displayTracks.length === 0 && !filterText && (
          <div className="album-empty-state">
            <div className="album-empty-icon">📁</div>
            <h3>Este álbum está vacío</h3>
            <p>
              Puedes agregar canciones desde cualquier otro álbum haciendo clic en el botón de marcador <strong>🔖</strong> o haciendo clic derecho en una canción y seleccionando <strong>Agregar</strong>.
            </p>
          </div>
        )}
      </ul>

      {/* Popover de casillas de álbumes (Botón Marcador / Opción Agregar) */}
      {albumPickerState && (
        <AlbumMembershipPopover
          track={albumPickerState.track}
          position={albumPickerState.position}
          allAlbums={allAlbums}
          albumInfo={getTrackAlbumInfo(albumPickerState.track)}
          onAddTrackToAlbum={handleAddTrackToSingleAlbum}
          onClose={() => setAlbumPickerState(null)}
        />
      )}

      {/* Menú Contextual (Clic Derecho en cualquier canción) */}
      {contextMenuState && (
        <TrackContextMenu
          track={contextMenuState.track}
          position={contextMenuState.position}
          onClose={() => setContextMenuState(null)}
          onOpenFolder={handleOpenInFolder}
          onOpenAlbumPicker={handleOpenAlbumPicker}
          onCopyTitle={handleCopyTitle}
          onCopyArtist={handleCopyArtist}
          onOpenProperties={(t) => setPropertiesTrack(t)}
          onRequestDelete={(t) => setDeleteTargetTrack(t)}
        />
      )}

      {/* Modal de Propiedades Detalladas */}
      {propertiesTrack && (
        <TrackPropertiesModal
          track={propertiesTrack}
          albumInfo={getTrackAlbumInfo(propertiesTrack)}
          onClose={() => setPropertiesTrack(null)}
          onOpenFolder={handleOpenInFolder}
        />
      )}

      {/* Modal de Confirmación de Eliminación */}
      {deleteTargetTrack && (
        <DeleteTrackConfirmModal
          track={deleteTargetTrack}
          onCancel={() => setDeleteTargetTrack(null)}
          onConfirm={handleConfirmDeleteTrack}
          isDeleting={isDeletingTrack}
        />
      )}

      {/* Banner flotante de confirmación de acciones */}
      {feedbackBanner && (
        <div className="track-action-feedback-toast" role="status">
          {feedbackBanner}
        </div>
      )}
    </div>
  )
}

export default React.memo(AlbumView)
