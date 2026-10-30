import { usePlayer } from '../context/PlayerContext'
import React, { useState, useMemo, useCallback } from 'react'

/**
 * Componente recursivo para renderizar nodos del árbol:
 * - Tipo 'folder': Barra desplegable estilizada sin imagen
 * - Tipo 'album': Tarjeta de álbum con miniatura de carátula
 */
function TreeNode({
  node,
  depth = 0,
  selectedAlbum,
  onSelectAlbum,
  expandedFolders,
  onToggleFolder,
  isSearching
}) {
  if (node.type === 'folder') {
    const isExpanded = isSearching || !!expandedFolders[node.id]

    return (
      <div className={`folder-group depth-${depth}`}>
        {/* Barra desplegable sin imagen */}
        <div
          className="folder-header-bar"
          onClick={() => onToggleFolder(node.id)}
          title={`Carpeta: ${node.name} (${node.itemCount} elementos, ${node.totalTracks} canciones)`}
        >
          <div className="folder-header-left">
            <span className={`folder-chevron ${isExpanded ? 'expanded' : ''}`}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6-1.41-1.41z" />
              </svg>
            </span>
            <span className="folder-icon">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                <path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" />
              </svg>
            </span>
            <span className="folder-title">{node.name}</span>
          </div>

          <span className="folder-badge" title={`${node.itemCount} álbumes / subcarpetas`}>
            {node.itemCount}
          </span>
        </div>

        {/* Contenido desplegable (álbumes hijos u otras barras desplegables) */}
        {isExpanded && (
          <div className="folder-children-container">
            {node.children.map((child) => (
              <TreeNode
                key={child.id}
                node={child}
                depth={depth + 1}
                selectedAlbum={selectedAlbum}
                onSelectAlbum={onSelectAlbum}
                expandedFolders={expandedFolders}
                onToggleFolder={onToggleFolder}
                isSearching={isSearching}
              />
            ))}
          </div>
        )}
      </div>
    )
  }

  // Nodo Tipo 'album': Álbum convencional con portada
  const isSelected = selectedAlbum?.id === node.id

  return (
    <div
      className={`album-item ${isSelected ? 'active' : ''} depth-${depth}`}
      onClick={() => onSelectAlbum(node)}
      title={`${node.name} (${node.trackCount} pistas)`}
    >
      {node.cover ? (
        <img src={node.cover} alt={node.name} className="album-item-cover" />
      ) : (
        <div className="album-item-cover-placeholder">💿</div>
      )}
      <div className="album-item-info">
        <div className="album-item-name">{node.name}</div>
        <div className="album-item-count">{node.trackCount} pistas</div>
      </div>
    </div>
  )
}

function Sidebar({ isOpen = true, onToggle }) {
  const { library, selectedAlbum, setSelectedAlbum, isLoading } = usePlayer()
  const [searchQuery, setSearchQuery] = useState('')
  const [expandedFolders, setExpandedFolders] = useState({})

  // Alternar apertura/cierre de una barra desplegable
  const handleToggleFolder = useCallback((folderId) => {
    setExpandedFolders((prev) => ({
      ...prev,
      [folderId]: !prev[folderId]
    }))
  }, [])

  // Filtrado recursivo según la búsqueda
  const filteredTree = useMemo(() => {
    if (!searchQuery.trim()) return library

    const q = searchQuery.toLowerCase()

    function filterNode(node) {
      if (node.type === 'album') {
        const matchesName = node.name.toLowerCase().includes(q)
        const matchesTrack = node.tracks && node.tracks.some((t) => t.title.toLowerCase().includes(q))
        return matchesName || matchesTrack ? node : null
      }

      if (node.type === 'folder') {
        const matchesFolder = node.name.toLowerCase().includes(q)
        if (matchesFolder) return node

        // Filtrar recursivamente sus hijos
        const matchingChildren = []
        for (const child of node.children) {
          const filteredChild = filterNode(child)
          if (filteredChild) matchingChildren.push(filteredChild)
        }

        if (matchingChildren.length > 0) {
          return {
            ...node,
            children: matchingChildren
          }
        }
      }

      return null
    }

    const result = []
    for (const rootNode of library) {
      const filtered = filterNode(rootNode)
      if (filtered) result.push(filtered)
    }
    return result
  }, [library, searchQuery])

  // Contar total de álbumes/elementos para el marcador colapsado
  const totalRootItems = library.length

  // ============================================
  // MODO COLAPSADO (Pequeño marcador vertical)
  // ============================================
  if (!isOpen) {
    return (
      <div
        className="sidebar-collapsed-marker"
        onClick={onToggle}
        title="Desplegar barra lateral de álbumes"
      >
        <div className="sidebar-marker-btn">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z" />
          </svg>
        </div>
        <span className="sidebar-marker-text">Biblioteca</span>
        <div className="sidebar-marker-badge">{totalRootItems}</div>
      </div>
    )
  }

  // Loading state
  if (isLoading) {
    return (
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="sidebar-header-top">
            <h2>Biblioteca</h2>
            {onToggle && (
              <button className="sidebar-collapse-btn" onClick={onToggle} title="Ocultar barra">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z" />
                </svg>
              </button>
            )}
          </div>
        </div>
        <div className="loading-view">
          <div className="spinner" />
          <p style={{ color: 'var(--text-dim)', fontSize: '13px' }}>Escaneando música...</p>
        </div>
      </aside>
    )
  }

  // ============================================
  // MODO EXPANDIDO COMPLETO
  // ============================================
  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-header-top">
          <h2>Biblioteca</h2>
          {onToggle && (
            <button className="sidebar-collapse-btn" onClick={onToggle} title="Ocultar barra lateral a un marcador">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z" />
              </svg>
            </button>
          )}
        </div>
        <input
          type="text"
          className="sidebar-search"
          placeholder="Buscar álbum, artista o canción..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>

      <div className="album-list">
        {filteredTree.length === 0 && (
          <p style={{ padding: '20px', textAlign: 'center', color: 'var(--text-dim)', fontSize: '13px' }}>
            {library.length === 0
              ? 'No se encontraron carpetas. Agrega música a "canciones_organizadas".'
              : 'Sin resultados para tu búsqueda.'}
          </p>
        )}

        {filteredTree.map((node) => (
          <TreeNode
            key={node.id}
            node={node}
            depth={0}
            selectedAlbum={selectedAlbum}
            onSelectAlbum={setSelectedAlbum}
            expandedFolders={expandedFolders}
            onToggleFolder={handleToggleFolder}
            isSearching={!!searchQuery.trim()}
          />
        ))}
      </div>
    </aside>
  )
}

export default React.memo(Sidebar)
