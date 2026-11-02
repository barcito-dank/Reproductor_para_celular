import { usePlayer } from '../context/PlayerContext'
import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'

/**
 * Determina si un nodo puede arrastrarse (carpetas y álbumes reales en disco,
 * excluyendo el nodo virtual "Todos" y el sub-nodo sintético "___direct").
 */
function isNodeDraggable(node) {
  if (!node || node.isAllTracks) return false
  if (typeof node.id === 'string' && node.id.endsWith('___direct')) return false
  return Boolean(node.path)
}

/**
 * Comprueba si `draggedNode` puede soltarse dentro de `targetNode`.
 */
function canDropIntoNode(draggedNode, targetNode) {
  if (!draggedNode?.path || !targetNode?.path) return false
  if (targetNode.isAllTracks) return false

  const src = draggedNode.path.replace(/[\\/]+$/, '').toLowerCase()
  const dst = targetNode.path.replace(/[\\/]+$/, '').toLowerCase()

  if (src === dst) return false
  // No permitir mover una carpeta dentro de sí misma o de una subcarpeta hija
  if (dst.startsWith(src + '\\') || dst.startsWith(src + '/')) return false

  // Si ya es hijo directo de dst, no hace falta moverlo ahí
  const lastSep = Math.max(src.lastIndexOf('\\'), src.lastIndexOf('/'))
  const srcParent = lastSep >= 0 ? src.slice(0, lastSep) : ''
  if (srcParent === dst) return false

  return true
}

/**
 * Componente recursivo para renderizar nodos del árbol:
 * - Tipo 'folder': Barra desplegable estilizada sin imagen
 * - Tipo 'album': Tarjeta de álbum con miniatura de carátula
 * Arrastre exclusivo mediante el borde derecho (.node-drag-edge) con manita grab.
 */
const TreeNode = React.memo(function TreeNode({
  node,
  depth = 0,
  selectedAlbumId,
  onSelectAlbum,
  expandedFolders,
  onToggleFolder,
  isSearching,
  draggedNode,
  dropTargetId,
  onDragStartNode,
  onDragEndNode,
  onDragOverNode,
  onDragLeaveNode,
  onDropOnNode,
  onContextMenuNode
}) {
  const draggable = isNodeDraggable(node)
  const isBeingDragged = draggedNode?.id === node.id
  const isDropTarget = dropTargetId === node.id

  const handleDragStartEdge = (e) => {
    if (!draggable) {
      e.preventDefault()
      return
    }
    e.stopPropagation()
    e.dataTransfer.effectAllowed = 'move'
    try {
      e.dataTransfer.setData('text/plain', node.path)
    } catch {
      // Ignorar si dataTransfer está restringido
    }
    onDragStartNode(node, depth)
  }

  const handleDragOver = (e) => {
    e.stopPropagation()
    // El nodo "Todos" sirve como zona para sacar un álbum al nivel principal (raíz)
    if (node.isAllTracks && draggedNode && draggedNode.depth > 0) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      onDragOverNode(node.id)
      return
    }
    if (!canDropIntoNode(draggedNode, node)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    onDragOverNode(node.id)
  }

  const handleDragLeave = (e) => {
    e.stopPropagation()
    if (e.currentTarget.contains(e.relatedTarget)) return
    onDragLeaveNode(node.id)
  }

  const handleDrop = (e) => {
    e.preventDefault()
    e.stopPropagation()
    onDropOnNode(node)
  }

  const handleContextMenu = (e) => {
    if (draggable) {
      e.preventDefault()
      e.stopPropagation()
      onContextMenuNode(node, { x: e.clientX, y: e.clientY })
    }
  }

  if (node.type === 'folder') {
    const isExpanded = isSearching || !!expandedFolders[node.id]

    return (
      <div className={`folder-group depth-${depth}`}>
        {/* Barra desplegable sin imagen */}
        <div
          className={`folder-header-bar ${isBeingDragged ? 'dragging-node' : ''} ${isDropTarget ? 'drag-over-target' : ''}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onContextMenu={handleContextMenu}
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

          {/* Borde derecho exclusivo para agarrar y arrastrar */}
          {draggable && (
            <div
              className="node-drag-edge"
              draggable={true}
              onDragStart={handleDragStartEdge}
              onDragEnd={onDragEndNode}
              onClick={(e) => e.stopPropagation()}
              title="Arrastrar para mover carpeta"
            >
              <span className="drag-edge-dots">⋮⋮</span>
            </div>
          )}
        </div>

        {/* Contenido desplegable (álbumes hijos u otras barras desplegables) */}
        {isExpanded && (
          <div className="folder-children-container">
            {node.children.map((child) => (
              <TreeNode
                key={child.id}
                node={child}
                depth={depth + 1}
                selectedAlbumId={selectedAlbumId}
                onSelectAlbum={onSelectAlbum}
                expandedFolders={expandedFolders}
                onToggleFolder={onToggleFolder}
                isSearching={isSearching}
                draggedNode={draggedNode}
                dropTargetId={dropTargetId}
                onDragStartNode={onDragStartNode}
                onDragEndNode={onDragEndNode}
                onDragOverNode={onDragOverNode}
                onDragLeaveNode={onDragLeaveNode}
                onDropOnNode={onDropOnNode}
                onContextMenuNode={onContextMenuNode}
              />
            ))}
          </div>
        )}
      </div>
    )
  }

  // Nodo Tipo 'album': Álbum convencional con portada
  const isSelected = selectedAlbumId === node.id

  return (
    <div
      className={`album-item ${isSelected ? 'active' : ''} depth-${depth} ${isBeingDragged ? 'dragging-node' : ''} ${isDropTarget ? 'drag-over-target' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onContextMenu={handleContextMenu}
      onClick={() => onSelectAlbum(node)}
      title={`${node.name} (${node.trackCount} pistas)`}
    >
      {node.cover ? (
        <img
          src={node.cover}
          alt={node.name}
          className="album-item-cover"
          loading="lazy"
          decoding="async"
          draggable={false}
        />
      ) : (
        <div className="album-item-cover-placeholder">💿</div>
      )}
      <div className="album-item-info">
        <div className="album-item-name">{node.name}</div>
        <div className="album-item-count">
          {node.trackCount} {node.trackCount === 1 ? 'pista' : 'pistas'}
          {isDropTarget && !node.isAllTracks && (
            <span className="album-drop-hint"> · Soltar dentro</span>
          )}
          {isDropTarget && node.isAllTracks && (
            <span className="album-drop-hint"> · Sacar a raíz</span>
          )}
        </div>
      </div>

      {/* Borde derecho exclusivo para agarrar y arrastrar */}
      {draggable && (
        <div
          className="node-drag-edge"
          draggable={true}
          onDragStart={handleDragStartEdge}
          onDragEnd={onDragEndNode}
          onClick={(e) => e.stopPropagation()}
          title="Arrastrar para mover álbum"
        >
          <span className="drag-edge-dots">⋮⋮</span>
        </div>
      )}
    </div>
  )
})

/**
 * Menú contextual al hacer clic derecho en un álbum o carpeta
 */
function AlbumContextMenu({ node, position, onClose, onRename, onDelete }) {
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

  const menuWidth = 195
  const menuHeight = 110
  const winW = typeof window !== 'undefined' ? window.innerWidth : 1200
  const winH = typeof window !== 'undefined' ? window.innerHeight : 800

  let left = position.x
  if (left + menuWidth > winW - 10) {
    left = Math.max(10, position.x - menuWidth)
  }
  let top = position.y
  if (top + menuHeight > winH - 20) {
    top = Math.max(10, position.y - menuHeight)
  }

  const content = (
    <div
      ref={menuRef}
      className="album-context-menu"
      style={{ left: `${left}px`, top: `${top}px` }}
      role="menu"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="album-context-header">
        <span className="album-context-title" title={node.name}>{node.name}</span>
      </div>

      <button
        type="button"
        className="album-context-item"
        onClick={() => {
          onClose()
          onRename(node)
        }}
      >
        <span className="album-context-icon">✏️</span>
        <span>Renombrar</span>
      </button>

      <button
        type="button"
        className="album-context-item danger"
        onClick={() => {
          onClose()
          onDelete(node)
        }}
      >
        <span className="album-context-icon">🗑️</span>
        <span>Eliminar álbum</span>
      </button>
    </div>
  )

  return typeof document !== 'undefined' ? createPortal(content, document.body) : null
}

/**
 * Modal para renombrar álbum
 */
function RenameAlbumModal({ node, onClose, onConfirm, isRenaming }) {
  const [name, setName] = useState(node.name || '')
  const inputRef = useRef(null)

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && !isRenaming) onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose, isRenaming])

  const handleSubmit = (e) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed || isRenaming) return
    onConfirm(node, trimmed)
  }

  const content = (
    <div className="track-modal-backdrop" onClick={() => !isRenaming && onClose()}>
      <div className="track-modal-card album-rename-card" onClick={(e) => e.stopPropagation()} role="dialog">
        <div className="track-modal-header">
          <div className="track-modal-title-group">
            <div className="track-modal-cover-placeholder">✏️</div>
            <div>
              <h3>Renombrar álbum</h3>
              <p className="track-modal-subtitle">{node.name}</p>
            </div>
          </div>
          <button type="button" className="track-modal-close" onClick={onClose} disabled={isRenaming}>
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="track-modal-body">
            <label className="album-input-label">Nuevo nombre:</label>
            <input
              ref={inputRef}
              type="text"
              className="create-album-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={isRenaming}
            />
          </div>

          <div className="track-modal-footer">
            <button
              type="button"
              className="track-modal-btn secondary"
              onClick={onClose}
              disabled={isRenaming}
            >
              Cancelar
            </button>
            <button
              type="submit"
              className="track-modal-btn primary"
              disabled={!name.trim() || isRenaming}
            >
              {isRenaming ? 'Guardando...' : 'Guardar'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )

  return typeof document !== 'undefined' ? createPortal(content, document.body) : null
}

/**
 * Modal de confirmación para eliminar álbum
 */
function DeleteAlbumModal({ node, onClose, onConfirm, isDeleting }) {
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && !isDeleting) onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose, isDeleting])

  const content = (
    <div className="track-modal-backdrop" onClick={() => !isDeleting && onClose()}>
      <div className="track-modal-card confirm-delete-card" onClick={(e) => e.stopPropagation()} role="alertdialog">
        <div className="track-modal-header">
          <div className="track-modal-title-group">
            <div className="track-delete-icon-badge">🗑️</div>
            <div>
              <h3>¿Eliminar este álbum?</h3>
              <p className="track-modal-subtitle">{node.name}</p>
            </div>
          </div>
        </div>

        <div className="track-modal-body">
          <p className="track-delete-warning">
            Se enviará la carpeta y todas sus canciones a la Papelera de reciclaje:
          </p>
          <div className="track-delete-path-box">{node.path}</div>
        </div>

        <div className="track-modal-footer">
          <button
            type="button"
            className="track-modal-btn secondary"
            onClick={onClose}
            disabled={isDeleting}
          >
            Cancelar
          </button>
          <button
            type="button"
            className="track-modal-btn danger"
            onClick={() => onConfirm(node)}
            disabled={isDeleting}
          >
            {isDeleting ? 'Eliminando...' : 'Sí, eliminar álbum'}
          </button>
        </div>
      </div>
    </div>
  )

  return typeof document !== 'undefined' ? createPortal(content, document.body) : null
}

function Sidebar({ isOpen = true, onToggle }) {
  const {
    library,
    selectedAlbum,
    setSelectedAlbum,
    isLoading,
    createAlbum,
    moveAlbumFolder,
    renameAlbumFolder,
    deleteAlbumFolder
  } = usePlayer()
  const [searchQuery, setSearchQuery] = useState('')
  const [expandedFolders, setExpandedFolders] = useState({})

  // Estado para el bloque superior "Crear álbum"
  const [isCreatingAlbum, setIsCreatingAlbum] = useState(false)
  const [newAlbumName, setNewAlbumName] = useState('')
  const [isSubmittingAlbum, setIsSubmittingAlbum] = useState(false)
  const createInputRef = useRef(null)

  // Estado para Drag & Drop de álbumes
  const [draggedNode, setDraggedNode] = useState(null) // { id, path, name, depth }
  const [dropTargetId, setDropTargetId] = useState(null) // node.id | '__ROOT__'
  const [sidebarNotice, setSidebarNotice] = useState(null)
  const noticeTimerRef = useRef(null)

  // Estados para Clic Derecho en Álbum (Menú Contextual, Renombrar, Eliminar)
  const [albumContextMenu, setAlbumContextMenu] = useState(null) // { node, position }
  const [renameTargetNode, setRenameTargetNode] = useState(null)
  const [isRenamingAlbum, setIsRenamingAlbum] = useState(false)
  const [deleteTargetNode, setDeleteTargetNode] = useState(null)
  const [isDeletingAlbum, setIsDeletingAlbum] = useState(false)

  const showSidebarNotice = useCallback((msg) => {
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
    setSidebarNotice(msg)
    noticeTimerRef.current = setTimeout(() => {
      setSidebarNotice(null)
      noticeTimerRef.current = null
    }, 2800)
  }, [])

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (isCreatingAlbum && createInputRef.current) {
      createInputRef.current.focus()
    }
  }, [isCreatingAlbum])

  // Alternar apertura/cierre de una barra desplegable
  const handleToggleFolder = useCallback((folderId) => {
    setExpandedFolders((prev) => ({
      ...prev,
      [folderId]: !prev[folderId]
    }))
  }, [])

  // Crear nuevo álbum desde el elemento superior
  const handleCreateAlbumSubmit = async (e) => {
    if (e) e.preventDefault()
    const trimmed = newAlbumName.trim()
    if (!trimmed || isSubmittingAlbum) return

    setIsSubmittingAlbum(true)
    try {
      const res = await createAlbum(trimmed)
      if (res && res.success) {
        setNewAlbumName('')
        setIsCreatingAlbum(false)
        showSidebarNotice(`✓ Álbum "${res.albumName || trimmed}" creado`)
      } else {
        showSidebarNotice(`⚠ ${res?.error || 'No se pudo crear el álbum'}`)
      }
    } finally {
      setIsSubmittingAlbum(false)
    }
  }

  // Handlers de Drag & Drop
  const handleDragStartNode = useCallback((node, depth) => {
    setDraggedNode({
      id: node.id,
      path: node.path,
      name: node.name,
      depth
    })
  }, [])

  const handleDragEndNode = useCallback(() => {
    setDraggedNode(null)
    setDropTargetId(null)
  }, [])

  const handleDragOverNode = useCallback((targetId) => {
    setDropTargetId((prev) => (prev === targetId ? prev : targetId))
  }, [])

  const handleDragLeaveNode = useCallback((targetId) => {
    setDropTargetId((prev) => (prev === targetId ? null : prev))
  }, [])

  const handleMoveToRoot = useCallback(async () => {
    if (!draggedNode?.path) return
    const movingName = draggedNode.name
    const sourcePath = draggedNode.path
    setDraggedNode(null)
    setDropTargetId(null)

    const res = await moveAlbumFolder(sourcePath, '__ROOT__')
    if (res && res.success) {
      if (!res.unchanged) {
        showSidebarNotice(`⬆️ "${movingName}" movido al nivel principal`)
      }
    } else if (res?.error) {
      showSidebarNotice(`⚠ ${res.error}`)
    }
  }, [draggedNode, moveAlbumFolder, showSidebarNotice])

  const handleDropOnNode = useCallback(
    async (targetNode) => {
      if (!draggedNode?.path || !targetNode) {
        setDraggedNode(null)
        setDropTargetId(null)
        return
      }

      // Soltar sobre "Todos" saca el álbum a la raíz
      if (targetNode.isAllTracks) {
        await handleMoveToRoot()
        return
      }

      if (!canDropIntoNode(draggedNode, targetNode)) {
        setDraggedNode(null)
        setDropTargetId(null)
        return
      }

      const movingName = draggedNode.name
      const sourcePath = draggedNode.path
      const targetPath = targetNode.path
      const targetName = targetNode.name

      setDraggedNode(null)
      setDropTargetId(null)

      const res = await moveAlbumFolder(sourcePath, targetPath)
      if (res && res.success) {
        // Expandir automáticamente la carpeta destino para ver el álbum recién movido dentro
        setExpandedFolders((prev) => ({
          ...prev,
          [targetPath]: true
        }))
        if (!res.unchanged) {
          showSidebarNotice(`📂 "${movingName}" movido dentro de "${targetName}"`)
        }
      } else if (res?.error) {
        showSidebarNotice(`⚠ ${res.error}`)
      }
    },
    [draggedNode, moveAlbumFolder, handleMoveToRoot, showSidebarNotice]
  )

  // Clic derecho en un nodo de álbum o carpeta
  const handleContextMenuNode = useCallback((node, position) => {
    setAlbumContextMenu({ node, position })
  }, [])

  // Confirmar renombrar álbum
  const handleConfirmRename = useCallback(async (node, newName) => {
    setIsRenamingAlbum(true)
    try {
      const res = await renameAlbumFolder(node.path, newName)
      if (res && res.success) {
        showSidebarNotice(`✏️ Renombrado a "${res.newName || newName}"`)
        setRenameTargetNode(null)
      } else {
        showSidebarNotice(`⚠ ${res?.error || 'No se pudo renombrar el álbum'}`)
      }
    } finally {
      setIsRenamingAlbum(false)
    }
  }, [renameAlbumFolder, showSidebarNotice])

  // Confirmar eliminar álbum
  const handleConfirmDelete = useCallback(async (node) => {
    setIsDeletingAlbum(true)
    try {
      const res = await deleteAlbumFolder(node.path)
      if (res && res.success) {
        showSidebarNotice(`🗑️ Álbum "${node.name}" eliminado`)
        setDeleteTargetNode(null)
      } else {
        showSidebarNotice(`⚠ ${res?.error || 'No se pudo eliminar el álbum'}`)
      }
    } finally {
      setIsDeletingAlbum(false)
    }
  }, [deleteAlbumFolder, showSidebarNotice])

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

      <div
        className={`album-list ${dropTargetId === '__ROOT__' ? 'root-drag-active' : ''}`}
        onDragOver={(e) => {
          if (!draggedNode) return
          if (e.target === e.currentTarget) {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            setDropTargetId('__ROOT__')
          }
        }}
        onDragLeave={(e) => {
          if (e.target === e.currentTarget && dropTargetId === '__ROOT__') {
            setDropTargetId(null)
          }
        }}
        onDrop={(e) => {
          if (!draggedNode) return
          if (e.target === e.currentTarget) {
            e.preventDefault()
            handleMoveToRoot()
          }
        }}
      >
        {/* Elemento especial arriba del todo: Crear álbum */}
        <div className={`create-album-card ${isCreatingAlbum ? 'editing' : ''}`}>
          {!isCreatingAlbum ? (
            <button
              type="button"
              className="create-album-trigger"
              onClick={() => setIsCreatingAlbum(true)}
              title="Crear un nuevo álbum vacío en tu biblioteca"
            >
              <div className="create-album-icon-box">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19" />
                  <line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              </div>
              <div className="create-album-info">
                <div className="create-album-title">Crear álbum</div>
                <div className="create-album-subtitle">Nueva carpeta de canciones</div>
              </div>
              <span className="create-album-pill">+ Nuevo</span>
            </button>
          ) : (
            <form className="create-album-form" onSubmit={handleCreateAlbumSubmit}>
              <div className="create-album-form-header">
                <span className="create-album-form-label">Nuevo álbum</span>
                <button
                  type="button"
                  className="create-album-cancel-icon"
                  onClick={() => {
                    setIsCreatingAlbum(false)
                    setNewAlbumName('')
                  }}
                  title="Cancelar"
                >
                  ✕
                </button>
              </div>
              <input
                ref={createInputRef}
                type="text"
                className="create-album-input"
                placeholder="Nombre del álbum..."
                value={newAlbumName}
                onChange={(e) => setNewAlbumName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    setIsCreatingAlbum(false)
                    setNewAlbumName('')
                  }
                }}
                disabled={isSubmittingAlbum}
              />
              <div className="create-album-form-actions">
                <button
                  type="button"
                  className="create-album-btn cancel"
                  onClick={() => {
                    setIsCreatingAlbum(false)
                    setNewAlbumName('')
                  }}
                  disabled={isSubmittingAlbum}
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="create-album-btn submit"
                  disabled={!newAlbumName.trim() || isSubmittingAlbum}
                >
                  {isSubmittingAlbum ? 'Creando...' : 'Crear álbum'}
                </button>
              </div>
            </form>
          )}
        </div>

        {/* Zona de soltado para sacar un álbum fuera (al nivel raíz) cuando se está arrastrando */}
        {draggedNode && (
          <div
            className={`root-drop-zone ${dropTargetId === '__ROOT__' ? 'active' : ''}`}
            onDragOver={(e) => {
              e.preventDefault()
              e.stopPropagation()
              e.dataTransfer.dropEffect = 'move'
              setDropTargetId('__ROOT__')
            }}
            onDragLeave={(e) => {
              e.stopPropagation()
              if (e.currentTarget.contains(e.relatedTarget)) return
              if (dropTargetId === '__ROOT__') setDropTargetId(null)
            }}
            onDrop={(e) => {
              e.preventDefault()
              e.stopPropagation()
              handleMoveToRoot()
            }}
          >
            <span>⬆️ Soltar aquí para sacar fuera (nivel principal)</span>
          </div>
        )}

        {sidebarNotice && (
          <div className="sidebar-notice-banner" role="status">
            {sidebarNotice}
          </div>
        )}

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
            selectedAlbumId={selectedAlbum?.id}
            onSelectAlbum={setSelectedAlbum}
            expandedFolders={expandedFolders}
            onToggleFolder={handleToggleFolder}
            isSearching={!!searchQuery.trim()}
            draggedNode={draggedNode}
            dropTargetId={dropTargetId}
            onDragStartNode={handleDragStartNode}
            onDragEndNode={handleDragEndNode}
            onDragOverNode={handleDragOverNode}
            onDragLeaveNode={handleDragLeaveNode}
            onDropOnNode={handleDropOnNode}
            onContextMenuNode={handleContextMenuNode}
          />
        ))}
      </div>

      {/* Menú Contextual de Álbum (Clic derecho) */}
      {albumContextMenu && (
        <AlbumContextMenu
          node={albumContextMenu.node}
          position={albumContextMenu.position}
          onClose={() => setAlbumContextMenu(null)}
          onRename={(n) => setRenameTargetNode(n)}
          onDelete={(n) => setDeleteTargetNode(n)}
        />
      )}

      {/* Modal para Renombrar Álbum */}
      {renameTargetNode && (
        <RenameAlbumModal
          node={renameTargetNode}
          onClose={() => setRenameTargetNode(null)}
          onConfirm={handleConfirmRename}
          isRenaming={isRenamingAlbum}
        />
      )}

      {/* Modal para Confirmar Eliminación de Álbum */}
      {deleteTargetNode && (
        <DeleteAlbumModal
          node={deleteTargetNode}
          onClose={() => setDeleteTargetNode(null)}
          onConfirm={handleConfirmDelete}
          isDeleting={isDeletingAlbum}
        />
      )}
    </aside>
  )
}

export default React.memo(Sidebar)
