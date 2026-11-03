import { useState, useMemo, useEffect, useRef, useDeferredValue } from 'react'
import { usePlayer } from '../context/PlayerContext'
import { areSameTrack } from '../utils/trackUtils'

function formatTime(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

function SpotlightSearch({ isOpen, onClose }) {
  const { allTracks = [], allAlbums = [], playTrack, setSelectedAlbum, currentTrack, isPlaying } = usePlayer()
  const [query, setQuery] = useState('')
  const deferredQuery = useDeferredValue(query)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef(null)
  const listRef = useRef(null)

  // Filtrado reactivo ultra rápido (<2ms) sobre el listado canónico ya provisto por el contexto
  const filteredResults = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase()
    if (!q) {
      // Sugerencias iniciales si no hay texto
      return allTracks.slice(0, 15)
    }

    return allTracks
      .filter((t) => {
        return (
          t.title.toLowerCase().includes(q) ||
          (t.artist && t.artist.toLowerCase().includes(q)) ||
          (t.albumName && t.albumName.toLowerCase().includes(q))
        )
      })
      .slice(0, 50) // Máximo 50 resultados para rendimiento óptimo
  }, [allTracks, deferredQuery])

  // Resetear selección al cambiar de búsqueda
  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  // Enfocar input al abrir
  useEffect(() => {
    if (isOpen) {
      setQuery('')
      setSelectedIndex(0)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [isOpen])

  // Scroll automático hacia el elemento seleccionado
  useEffect(() => {
    if (listRef.current && listRef.current.children[selectedIndex]) {
      listRef.current.children[selectedIndex].scrollIntoView({
        block: 'nearest',
        behavior: 'smooth'
      })
    }
  }, [selectedIndex])

  // Manejo de atajos de teclado dentro del modal
  const handleKeyDown = (e) => {
    if (e.key === 'Escape') {
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
    const album = item.albumObj || (allAlbums && allAlbums.find((a) => a.id === item.albumId))
    const playlist = album?.tracks || [item]
    const indexInAlbum = playlist.findIndex((t) => t.id === item.id)

    if (album) setSelectedAlbum(album)
    playTrack(item, album, playlist, indexInAlbum >= 0 ? indexInAlbum : 0)
    onClose()
  }

  const handleGoToAlbum = (e, item) => {
    e.stopPropagation()
    const album = item.albumObj || (allAlbums && allAlbums.find((a) => a.id === item.albumId))
    if (album) {
      setSelectedAlbum(album)
    }
    onClose()
  }

  if (!isOpen) return null

  return (
    <div className="spotlight-backdrop" onClick={onClose} onKeyDown={handleKeyDown}>
      <div className="spotlight-modal" onClick={(e) => e.stopPropagation()}>
        {/* Cabecera del Buscador */}
        <div className="spotlight-header">
          <svg className="spotlight-search-icon" width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
          </svg>

          <input
            ref={inputRef}
            type="text"
            className="spotlight-input"
            placeholder="Buscar por canción, artista o álbum en toda la biblioteca..."
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

        {/* Lista de Resultados */}
        <div className="spotlight-results-list" ref={listRef}>
          {filteredResults.length === 0 ? (
            <div className="spotlight-empty-state">
              <span className="empty-icon">🔍</span>
              <p>No se encontraron canciones que coincidan con <strong>"{query}"</strong></p>
              <span className="empty-sub">Intenta con otra palabra clave o nombre de artista</span>
            </div>
          ) : (
            filteredResults.map((item, idx) => {
              const isSelected = idx === selectedIndex
              const isCurrentPlaying = areSameTrack(currentTrack, item, true)

              return (
                <div
                  key={item.id + '-' + idx}
                  className={`spotlight-item ${isSelected ? 'selected' : ''} ${isCurrentPlaying ? 'now-playing' : ''}`}
                  onClick={() => handlePlayItem(item)}
                  onMouseEnter={() => setSelectedIndex(idx)}
                >
                  {/* Thumbnail de carátula */}
                  <div className="spotlight-item-cover">
                    {item.cover ? (
                      <img src={item.cover} alt="" />
                    ) : (
                      <div className="spotlight-cover-placeholder">💿</div>
                    )}
                    {isCurrentPlaying && (
                      <div className="spotlight-playing-badge">
                        {isPlaying ? '▶' : '⏸'}
                      </div>
                    )}
                  </div>

                  {/* Info */}
                  <div className="spotlight-item-info">
                    <div className="spotlight-item-title">
                      {item.title}
                    </div>
                    <div className="spotlight-item-meta">
                      <span className="spotlight-item-artist">{item.artist || 'Artista desconocido'}</span>
                      <span className="spotlight-dot">•</span>
                      <span className="spotlight-item-album">{item.albumName}</span>
                    </div>
                  </div>

                  {/* Duración y Acciones */}
                  <div className="spotlight-item-actions">
                    <span className="spotlight-item-duration">{formatTime(item.duration)}</span>
                    <button
                      className="spotlight-album-btn"
                      onClick={(e) => handleGoToAlbum(e, item)}
                      title="Ir al álbum"
                    >
                      📁 Ver álbum
                    </button>
                  </div>
                </div>
              )
            })
          )}
        </div>

        {/* Pie con atajos */}
        <div className="spotlight-footer">
          <div className="spotlight-hints">
            <span><kbd>↑</kbd> <kbd>↓</kbd> Navegar</span>
            <span><kbd>↵ Enter</kbd> Reproducir</span>
            <span><kbd>ESC</kbd> Cerrar</span>
          </div>
          <span className="spotlight-brand">Buscador Global Spotlight</span>
        </div>
      </div>
    </div>
  )
}

export default SpotlightSearch
