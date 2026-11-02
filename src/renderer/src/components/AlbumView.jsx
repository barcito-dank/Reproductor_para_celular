import { usePlayer } from '../context/PlayerContext'
import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { areSameTrack } from '../utils/trackUtils'

const ALBUM_ROW_HEIGHT = 63 // 60px alto de fila + 3px margen inferior
const ALBUM_OVERSCAN = 8

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

const TrackRow = React.memo(function TrackRow({
  track,
  index,
  isActive,
  isPlaying,
  onSelectTrack
}) {
  return (
    <li
      className={`track-item ${isActive ? 'active' : ''}`}
      onClick={() => onSelectTrack(track, index)}
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
        <div className="track-title" title={track.title}>{track.title}</div>
        <div className="track-artist" title={track.artist}>{track.artist}</div>
      </div>

      {/* Duración */}
      <span className="track-duration">{formatTime(track.duration)}</span>
    </li>
  )
})

function AlbumView() {
  const { selectedAlbum, playAlbum, playTrack, currentTrack, isPlaying, isLoading, library } = usePlayer()
  const [filterText, setFilterText] = useState('')
  const [sortBy, setSortBy] = useState('default') // 'default' | 'title-asc' | 'title-desc' | 'artist-asc' | 'artist-desc'
  const listRef = useRef(null)
  const [startIndex, setStartIndex] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(680)
  const prevAlbumIdRef = useRef(null)

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

          return (
            <TrackRow
              key={track.id}
              track={track}
              index={realIndex}
              isActive={isThisTrackActive}
              isPlaying={isThisTrackActive ? isPlaying : false}
              onSelectTrack={handleSelectTrack}
            />
          )
        })}

        {displayTracks.length === 0 && filterText && (
          <div className="track-filter-empty">
            <p>No se encontraron canciones que coincidan con "{filterText}"</p>
          </div>
        )}
      </ul>
    </div>
  )
}

export default React.memo(AlbumView)
