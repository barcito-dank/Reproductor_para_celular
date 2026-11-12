import React, { useState, useMemo, useEffect, useRef, useDeferredValue } from 'react'
import { usePlayer } from '../context/PlayerContext'
import { areSameTrack } from '../utils/trackUtils'
import { triggerHaptic } from './BottomNavBar'

function formatTime(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

function SpotlightSearch({ isOpen = true, onClose, inline = false, onNavigateToHome }) {
  const {
    allTracks = [],
    allAlbums = [],
    playTrack,
    setSelectedAlbum,
    currentTrack,
    isPlaying,
    importFilesToVault
  } = usePlayer()
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef(null)
  const listRef = useRef(null)

  // Filtrado reactivo ultra rápido (<2ms) de álbumes y pistas
  const { matchingAlbums, filteredResults } = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase()
    if (!q) {
      return {
        matchingAlbums: allAlbums.slice(0, 8),
        filteredResults: allTracks.slice(0, 30)
      }
    }

    const albums = allAlbums
      .filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          (a.categoryPath && a.categoryPath.toLowerCase().includes(q))
      )
      .slice(0, 12)

    const tracks = allTracks
      .filter((t) => {
        return (
          t.title.toLowerCase().includes(q) ||
          (t.artist && t.artist.toLowerCase().includes(q)) ||
          (t.albumName && t.albumName.toLowerCase().includes(q))
        )
      })
      .slice(0, 60)

    return { matchingAlbums: albums, filteredResults: tracks }
  }, [allTracks, allAlbums, deferredQuery])

  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  useEffect(() => {
    if (isOpen) {
      if (!inline) {
        setQuery('')
      }
      setSelectedIndex(0)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [isOpen, inline])

  useEffect(() => {
    if (!inline && listRef.current && listRef.current.children[selectedIndex]) {
      listRef.current.children[selectedIndex].scrollIntoView({
        block: 'nearest',
        behavior: 'smooth'
      })
    }
  }, [selectedIndex, inline])

  const handleKeyDown = (e) => {
    if (e.key === 'Escape' && onClose) {
      e.preventDefault()
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (filteredResults.length > 0) {
        setSelectedIndex((prev) => (prev + 1) % filteredResults.length)
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (filteredResults.length > 0) {
        setSelectedIndex((prev) => (prev - 1 + filteredResults.length) % filteredResults.length)
      }
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (filteredResults[selectedIndex]) {
        handlePlayItem(filteredResults[selectedIndex])
      }
    }
  }

  const handlePlayItem = (item) => {
    void triggerHaptic()
    const album = item.albumObj || (allAlbums && allAlbums.find((a) => a.id === item.albumId))
    const playlist = album?.tracks || [item]
    const indexInAlbum = playlist.findIndex((t) => t.id === item.id)

    if (album) setSelectedAlbum(album)
    playTrack(item, album, playlist, indexInAlbum >= 0 ? indexInAlbum : 0)
    if (!inline) {
      onClose?.()
    }
  }

  const handleSelectAlbumCard = (album) => {
    void triggerHaptic()
    setSelectedAlbum(album)
    onNavigateToHome?.()
    onClose?.()
  }

  const handleGoToAlbum = (e, item) => {
    e.stopPropagation()
    void triggerHaptic()
    const album = item.albumObj || (allAlbums && allAlbums.find((a) => a.id === item.albumId))
    if (album) {
      setSelectedAlbum(album)
    }
    onNavigateToHome?.()
    onClose?.()
  }

  if (!isOpen) return null

  const searchBody = (
    <div
      className={`spotlight-modal ${inline ? 'spotlight-inline-view' : ''}`}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Cabecera del Buscador */}
      <div className="spotlight-header">
        <svg className="spotlight-search-icon" width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
          <path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
        </svg>

        <input
          ref={inputRef}
          type="text"
          className="spotlight-input"
          placeholder="Buscar canción, artista o álbum..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        {query && (
          <button className="spotlight-clear-btn" onClick={() => setQuery('')} title="Limpiar">
            ✕
          </button>
        )}

        <div className="spotlight-count-badge">
          {allTracks.length} pistas
        </div>
      </div>

      {/* Carrusel rápido de álbumes coincidentes */}
      {matchingAlbums.length > 0 && (
        <div className="spotlight-albums-strip">
          <div className="spotlight-section-label">
            {query.trim() ? `Álbumes encontrados (${matchingAlbums.length})` : 'Álbumes recientes'}
          </div>
          <div className="spotlight-albums-scroll">
            {matchingAlbums.map((alb) => (
              <button
                key={alb.id}
                type="button"
                className="spotlight-album-chip-card"
                onClick={() => handleSelectAlbumCard(alb)}
              >
                {alb.cover ? (
                  <img src={alb.cover} alt="" className="spotlight-album-chip-img" />
                ) : (
                  <span className="spotlight-album-chip-fallback">💿</span>
                )}
                <div className="spotlight-album-chip-text">
                  <span className="spotlight-album-chip-name">{alb.name}</span>
                  <span className="spotlight-album-chip-count">{alb.trackCount || 0} pistas</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Lista de Resultados de Canciones */}
      <div className="spotlight-results-list" ref={listRef}>
        {filteredResults.length === 0 ? (
          <div className="spotlight-empty-state">
            <span className="empty-icon">🔍</span>
            {allTracks.length === 0 ? (
              <>
                <p>No hay canciones importadas en tu bóveda aún</p>
                <span className="empty-sub">Importa música o videos desde tu teléfono para buscar al instante</span>
                <button
                  type="button"
                  className="play-album-btn"
                  style={{ marginTop: '14px' }}
                  onClick={() => importFilesToVault?.()}
                >
                  + Importar Música / Video
                </button>
              </>
            ) : (
              <>
                <p>No se encontraron canciones que coincidan con <strong>&ldquo;{query}&rdquo;</strong></p>
                <span className="empty-sub">Intenta con otra palabra clave o nombre de artista</span>
              </>
            )}
          </div>
        ) : (
          filteredResults.map((item, idx) => {
            const isSelected = !inline && idx === selectedIndex
            const isCurrentPlaying = areSameTrack(currentTrack, item, true)
            const isVideo = item.mediaType === 'video'

            return (
              <div
                key={item.id + '-' + idx}
                className={`spotlight-item ${isSelected ? 'selected' : ''} ${isCurrentPlaying ? 'now-playing' : ''}`}
                onClick={() => handlePlayItem(item)}
                onMouseEnter={() => setSelectedIndex(idx)}
              >
                <div className="spotlight-item-cover">
                  {item.cover ? (
                    <>
                      <img
                        src={item.cover}
                        alt=""
                        onError={(e) => {
                          e.currentTarget.style.display = 'none'
                          const fb = e.currentTarget.parentElement?.querySelector('.spotlight-cover-placeholder')
                          if (fb) fb.style.display = 'flex'
                        }}
                      />
                      <div className="spotlight-cover-placeholder" style={{ display: 'none' }}>
                        {isVideo ? '🎬' : '💿'}
                      </div>
                    </>
                  ) : (
                    <div className="spotlight-cover-placeholder">{isVideo ? '🎬' : '💿'}</div>
                  )}
                  {isCurrentPlaying && (
                    <div className="spotlight-playing-badge">
                      {isPlaying ? '▶' : '⏸'}
                    </div>
                  )}
                </div>

                <div className="spotlight-item-info">
                  <div className="spotlight-item-title">
                    {item.title}
                    {isVideo && <span className="track-video-pill">🎬 Video</span>}
                  </div>
                  <div className="spotlight-item-meta">
                    <span className="spotlight-item-artist">{item.artist || 'Artista desconocido'}</span>
                    <span className="spotlight-dot">•</span>
                    <span className="spotlight-item-album">{item.albumName}</span>
                  </div>
                </div>

                <div className="spotlight-item-actions">
                  <span className="spotlight-item-duration">{formatTime(item.duration)}</span>
                  <button
                    type="button"
                    className="spotlight-album-btn"
                    onClick={(e) => handleGoToAlbum(e, item)}
                    title="Ir al álbum"
                  >
                    📁 Álbum
                  </button>
                </div>
              </div>
            )
          })
        )}
      </div>

      {!inline && (
        <div className="spotlight-footer">
          <span className="spotlight-brand">Buscador Instantáneo</span>
          {onClose && (
            <button type="button" className="spotlight-album-btn" onClick={onClose}>
              Cerrar
            </button>
          )}
        </div>
      )}
    </div>
  )

  if (inline) {
    return (
      <div className="spotlight-inline-container" onKeyDown={handleKeyDown}>
        {searchBody}
      </div>
    )
  }

  return (
    <div className="spotlight-backdrop" onClick={onClose} onKeyDown={handleKeyDown}>
      {searchBody}
    </div>
  )
}

export default SpotlightSearch
