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
 * Arrastre de alta precisión basado en Pointer Events desde el borde derecho (.node-drag-edge).
 */
const TreeNode = React.memo(function TreeNode({
  node,
  depth = 0,
  selectedAlbumId,
  onSelectAlbum,
  expandedFolders,
  onToggleFolder,
  isSearching,
  dragState,
  onStartDrag,
  onContextMenuNode,
  isDraggingOrJustFinished
}) {
  const draggable = isNodeDraggable(node)
  const isBeingDragged = dragState?.node?.id === node.id
  const isDropTarget = dragState?.targetId === node.id
  const isAllTracks = Boolean(node.isAllTracks || node.id === '__all_tracks__')

  const handleContextMenu = (e) => {
    if (draggable) {
      e.preventDefault()
      e.stopPropagation()
      onContextMenuNode(node, { x: e.clientX, y: e.clientY }, depth)
    }
  }

  if (node.type === 'folder') {
    const isExpanded = isSearching || !!expandedFolders[node.id]

    return (
      <div className={`folder-group depth-${depth}`}>
        {/* Barra desplegable sin imagen */}
        <div
          data-album-id={node.id}
          data-album-path={node.path || ''}
          data-album-name={node.name}
          data-is-all-tracks="false"
          className={`folder-header-bar ${isBeingDragged ? 'dragging-node' : ''} ${isDropTarget ? 'drag-over-target' : ''}`}
          onContextMenu={handleContextMenu}
          onPointerDown={(e) => draggable && onStartDrag(e, node, depth, false)}
          onClick={() => {
            if (isDraggingOrJustFinished?.()) return
            onToggleFolder(node.id)
          }}
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
              className={`node-drag-edge ${isBeingDragged ? 'active-dragging' : ''}`}
              onPointerDown={(e) => onStartDrag(e, node, depth, true)}
              onClick={(e) => e.stopPropagation()}
              title="Mantén presionado y arrastra para mover carpeta"
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
                dragState={dragState}
                onStartDrag={onStartDrag}
                onContextMenuNode={onContextMenuNode}
                isDraggingOrJustFinished={isDraggingOrJustFinished}
              />
            ))}
          </div>
        )}
      </div>
    )
  }

  // Nodo Tipo 'album': Álbum convencional con portada o virtual "Todos"
  const isSelected = selectedAlbumId === node.id

  return (
    <div
      data-album-id={node.id}
      data-album-path={node.path || ''}
      data-album-name={node.name}
      data-is-all-tracks={isAllTracks ? 'true' : 'false'}
      className={`album-item ${isSelected ? 'active' : ''} ${isAllTracks ? 'album-item-all-tracks' : ''} depth-${depth} ${isBeingDragged ? 'dragging-node' : ''} ${isDropTarget ? 'drag-over-target' : ''}`}
      onContextMenu={handleContextMenu}
      onPointerDown={(e) => draggable && onStartDrag(e, node, depth, false)}
      onClick={() => {
        if (isDraggingOrJustFinished?.()) return
        onSelectAlbum(node)
      }}
      title={isAllTracks ? 'Colección completa de todas las canciones' : `${node.name} (${node.trackCount} pistas)`}
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
        <div className="album-item-cover-placeholder">{isAllTracks ? '✨' : '💿'}</div>
      )}
      <div className="album-item-info">
        <div className="album-item-name">
          {node.name}
          {isAllTracks && <span className="album-virtual-pill">Colección Automática</span>}
        </div>
        <div className="album-item-count">
          {isAllTracks
            ? `Todas las canciones (${node.trackCount} pistas)`
            : `${node.trackCount} ${node.trackCount === 1 ? 'pista' : 'pistas'}`}
          {isDropTarget && !isAllTracks && (
            <span className="album-drop-hint"> · Soltar para mover dentro</span>
          )}
          {isDropTarget && isAllTracks && (
            <span className="album-drop-hint"> · Soltar para sacar al nivel principal</span>
          )}
        </div>
      </div>

      {/* Borde derecho exclusivo para agarrar y arrastrar (solo en álbumes reales de disco) */}
      {draggable && (
        <div
          className={`node-drag-edge ${isBeingDragged ? 'active-dragging' : ''}`}
          onPointerDown={(e) => onStartDrag(e, node, depth, true)}
          onClick={(e) => e.stopPropagation()}
          title="Mantén presionado y arrastra para mover el álbum"
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
function AlbumContextMenu({
  node,
  position,
  depth = 0,
  onClose,
  onRename,
  onDelete,
  onOpenMove,
  onMoveToRoot
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

  const menuWidth = 205
  const isInsideFolder = depth > 0
  const menuHeight = isInsideFolder ? 180 : 145
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
          onOpenMove(node, depth)
        }}
      >
        <span className="album-context-icon">📁</span>
        <span>Mover a...</span>
      </button>

      {isInsideFolder && (
        <button
          type="button"
          className="album-context-item"
          onClick={() => {
            onClose()
            onMoveToRoot(node)
          }}
        >
          <span className="album-context-icon">⬆️</span>
          <span>Sacar a nivel raíz</span>
        </button>
      )}

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

/**
 * Modal para mover álbum o carpeta a otro destino sin arrastrar
 */
function MoveAlbumModal({ node, library, depth = 0, onClose, onConfirm, isMoving }) {
  const [selectedDestination, setSelectedDestination] = useState(null)
  const [searchFilter, setSearchFilter] = useState('')
  const inputRef = useRef(null)

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape' && !isMoving) onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose, isMoving])

  // Destinos válidos (raíz si depth > 0, más álbumes/carpetas elegibles)
  const availableDestinations = useMemo(() => {
    const targets = []
    if (depth > 0) {
      targets.push({
        id: '__ROOT__',
        path: '__ROOT__',
        name: 'Nivel principal (raíz)',
        type: 'root',
        depth: 0
      })
    }

    function traverse(nodes, d = 0) {
      if (!nodes || !Array.isArray(nodes)) return
      for (const item of nodes) {
        if (canDropIntoNode(node, item)) {
          targets.push({
            id: item.id,
            path: item.path,
            name: item.name,
            type: item.type,
            cover: item.cover,
            depth: d
          })
        }
        if (item.children && Array.isArray(item.children)) {
          traverse(item.children, d + 1)
        }
      }
    }

    traverse(library, 0)
    return targets
  }, [library, node, depth])

  const filtered = useMemo(() => {
    const q = searchFilter.trim().toLowerCase()
    if (!q) return availableDestinations
    return availableDestinations.filter(
      (d) => d.id === '__ROOT__' || d.name.toLowerCase().includes(q)
    )
  }, [availableDestinations, searchFilter])

  const handleSubmit = (e) => {
    e.preventDefault()
    if (!selectedDestination || isMoving) return
    onConfirm(node, selectedDestination)
  }

  const content = (
    <div className="track-modal-backdrop" onClick={() => !isMoving && onClose()}>
      <div className="track-modal-card album-move-card" onClick={(e) => e.stopPropagation()} role="dialog">
        <div className="track-modal-header">
          <div className="track-modal-title-group">
            <div className="track-modal-cover-placeholder">📁</div>
            <div>
              <h3>Mover álbum o carpeta</h3>
              <p className="track-modal-subtitle">Destino para "{node.name}"</p>
            </div>
          </div>
          <button type="button" className="track-modal-close" onClick={onClose} disabled={isMoving}>
            ✕
          </button>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="track-modal-body" style={{ maxHeight: '340px', overflowY: 'auto' }}>
            {availableDestinations.length > 5 && (
              <input
                ref={inputRef}
                type="text"
                className="create-album-input"
                style={{ marginBottom: '10px' }}
                placeholder="Filtrar destinos..."
                value={searchFilter}
                onChange={(e) => setSearchFilter(e.target.value)}
                disabled={isMoving}
              />
            )}

            {filtered.length === 0 ? (
              <div style={{ padding: '24px 16px', textAlign: 'center', color: 'var(--text-dim)', fontSize: '13px' }}>
                No hay otras carpetas o álbumes válidos disponibles para mover este elemento.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {filtered.map((dest) => {
                  const isSelected = selectedDestination?.path === dest.path
                  return (
                    <div
                      key={dest.id}
                      onClick={() => setSelectedDestination(dest)}
                      style={{
                        padding: '8px 12px',
                        borderRadius: '8px',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '10px',
                        paddingLeft: `${12 + dest.depth * 14}px`,
                        background: isSelected ? 'rgba(124, 92, 252, 0.22)' : 'var(--bg-tertiary, rgba(255,255,255,0.03))',
                        border: isSelected ? '1px solid var(--accent)' : '1px solid transparent',
                        transition: 'all 0.12s ease'
                      }}
                    >
                      <span style={{ fontSize: '16px' }}>
                        {dest.type === 'root' ? '🏠' : dest.type === 'folder' ? '📁' : '💿'}
                      </span>
                      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                        <span style={{
                          fontSize: '13px',
                          fontWeight: isSelected ? '700' : '500',
                          color: isSelected ? 'var(--accent)' : 'var(--text-primary)',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis'
                        }}>
                          {dest.name}
                        </span>
                        {dest.type === 'root' && (
                          <span style={{ fontSize: '11px', color: 'var(--text-dim)' }}>
                            Sacar fuera de subcarpetas al nivel superior
                          </span>
                        )}
                      </div>
                      {isSelected && (
                        <span style={{ marginLeft: 'auto', color: 'var(--accent)', fontWeight: 'bold' }}>✓</span>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          <div className="track-modal-footer">
            <button
              type="button"
              className="track-modal-btn secondary"
              onClick={onClose}
              disabled={isMoving}
            >
              Cancelar
            </button>
            <button
              type="submit"
              className="track-modal-btn primary"
              disabled={!selectedDestination || isMoving}
            >
              {isMoving ? 'Moviendo...' : 'Mover aquí'}
            </button>
          </div>
        </form>
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

  // Estado para Drag & Drop basado en Pointer Events (100% fiable y fluido)
  const [dragState, setDragState] = useState(null) // { node, depth, x, y, targetId, targetName, targetPath }
  const dragStateRef = useRef(null)
  const isDraggingOrJustFinishedRef = useRef(false)
  const isDraggingOrJustFinished = useCallback(() => isDraggingOrJustFinishedRef.current, [])
  const [sidebarNotice, setSidebarNotice] = useState(null)
  const noticeTimerRef = useRef(null)

  // Forzar cursor 'grabbing' global y evitar selección de texto mientras se arrastra
  useEffect(() => {
    if (dragState) {
      document.body.classList.add('is-dragging-album')
      return () => {
        document.body.classList.remove('is-dragging-album')
      }
    }
  }, [Boolean(dragState)])

  // Estados para Clic Derecho en Álbum (Menú Contextual, Mover, Renombrar, Eliminar)
  const [albumContextMenu, setAlbumContextMenu] = useState(null) // { node, position, depth }
  const [moveTargetNode, setMoveTargetNode] = useState(null) // { node, depth }
  const [isMovingAlbum, setIsMovingAlbum] = useState(false)
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

  const handleMoveToRoot = useCallback(async (nodeToMove) => {
    if (!nodeToMove?.path) return
    const movingName = nodeToMove.name
    const sourcePath = nodeToMove.path

    const res = await moveAlbumFolder(sourcePath, '__ROOT__')
    if (res && res.success) {
      if (!res.unchanged) {
        showSidebarNotice(`⬆️ "${movingName}" movido al nivel principal`)
      }
    } else if (res?.error) {
      showSidebarNotice(`⚠ ${res.error}`)
    }
  }, [moveAlbumFolder, showSidebarNotice])

  // Confirmar movimiento mediante modal selector
  const handleConfirmMoveModal = useCallback(async (nodeToMove, dest) => {
    setIsMovingAlbum(true)
    try {
      if (dest.id === '__ROOT__' || dest.path === '__ROOT__') {
        await handleMoveToRoot(nodeToMove)
        setMoveTargetNode(null)
      } else if (dest.path) {
        const res = await moveAlbumFolder(nodeToMove.path, dest.path)
        if (res && res.success) {
          setExpandedFolders((prev) => ({
            ...prev,
            [dest.path]: true
          }))
          if (!res.unchanged) {
            showSidebarNotice(`📂 "${nodeToMove.name}" movido dentro de "${dest.name}"`)
          }
          setMoveTargetNode(null)
        } else if (res?.error) {
          showSidebarNotice(`⚠ ${res.error}`)
        }
      }
    } finally {
      setIsMovingAlbum(false)
    }
  }, [handleMoveToRoot, moveAlbumFolder, showSidebarNotice])

  // Iniciar Drag & Drop: desde el tirador (.node-drag-edge) o presionando y arrastrando la fila
  const handleStartDrag = useCallback((e, node, depth, fromHandle = false) => {
    if (e.button !== 0) return // Solo botón izquierdo
    if (!isNodeDraggable(node)) return

    if (fromHandle) {
      e.preventDefault()
      e.stopPropagation()
    }

    const startX = e.clientX
    const startY = e.clientY
    let hasStarted = false
    let hoverExpandTimer = null
    let lastHoveredFolderId = null
    const threshold = fromHandle ? 3 : 6

    const handlePointerMove = (moveEvt) => {
      const dist = Math.hypot(moveEvt.clientX - startX, moveEvt.clientY - startY)
      if (!hasStarted && dist > threshold) {
        hasStarted = true
        isDraggingOrJustFinishedRef.current = true
      }

      if (hasStarted) {
        moveEvt.preventDefault()

        // Encontrar elemento bajo el cursor
        const el = document.elementFromPoint(moveEvt.clientX, moveEvt.clientY)
        const rootZone = el?.closest('.root-drop-zone')
        const albumRow = el?.closest('[data-album-id]')

        let targetId = null
        let targetName = null
        let targetPath = null

        if (rootZone) {
          targetId = '__ROOT__'
          targetName = 'Nivel principal'
          targetPath = '__ROOT__'
        } else if (albumRow) {
          const aId = albumRow.getAttribute('data-album-id')
          const aName = albumRow.getAttribute('data-album-name')
          const aPath = albumRow.getAttribute('data-album-path')
          const aIsAll = albumRow.getAttribute('data-is-all-tracks') === 'true'

          if (aIsAll) {
            targetId = '__ROOT__'
            targetName = 'Nivel principal'
            targetPath = '__ROOT__'
          } else if (aPath && canDropIntoNode(node, { path: aPath, isAllTracks: false })) {
            targetId = aId
            targetName = aName
            targetPath = aPath
          }
        }

        // Auto-desplegar carpeta al mantener cursor encima durante el arrastre
        if (targetId && targetId !== '__ROOT__' && albumRow?.classList.contains('folder-header-bar')) {
          if (lastHoveredFolderId !== targetId) {
            clearTimeout(hoverExpandTimer)
            lastHoveredFolderId = targetId
            hoverExpandTimer = setTimeout(() => {
              setExpandedFolders((prev) => ({ ...prev, [targetId]: true }))
            }, 550)
          }
        } else {
          clearTimeout(hoverExpandTimer)
          lastHoveredFolderId = null
        }

        const stateObj = {
          node,
          depth,
          x: moveEvt.clientX,
          y: moveEvt.clientY,
          targetId,
          targetName,
          targetPath
        }
        dragStateRef.current = stateObj
        setDragState(stateObj)
      }
    }

    const handlePointerUp = async (upEvt) => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
      clearTimeout(hoverExpandTimer)

      const active = dragStateRef.current
      dragStateRef.current = null
      setDragState(null)

      if (!hasStarted || !active) {
        isDraggingOrJustFinishedRef.current = false
        return
      }

      // Si hubo arrastre real, evitar que el evento click posterior dispare la selección de álbum
      setTimeout(() => {
        isDraggingOrJustFinishedRef.current = false
      }, 150)

      let finalTargetId = active.targetId
      let finalTargetPath = active.targetPath
      let finalTargetName = active.targetName

      if (!finalTargetId) {
        const el = document.elementFromPoint(upEvt.clientX, upEvt.clientY)
        const rootZone = el?.closest('.root-drop-zone')
        const albumRow = el?.closest('[data-album-id]')

        if (rootZone) {
          finalTargetId = '__ROOT__'
          finalTargetPath = '__ROOT__'
          finalTargetName = 'Nivel principal'
        } else if (albumRow) {
          const aIsAll = albumRow.getAttribute('data-is-all-tracks') === 'true'
          if (aIsAll) {
            finalTargetId = '__ROOT__'
            finalTargetPath = '__ROOT__'
            finalTargetName = 'Nivel principal'
          } else {
            const aPath = albumRow.getAttribute('data-album-path')
            if (aPath && canDropIntoNode(node, { path: aPath, isAllTracks: false })) {
              finalTargetId = albumRow.getAttribute('data-album-id')
              finalTargetPath = aPath
              finalTargetName = albumRow.getAttribute('data-album-name')
            }
          }
        }
      }

      if (finalTargetId === '__ROOT__' || finalTargetPath === '__ROOT__') {
        await handleMoveToRoot(node)
      } else if (finalTargetPath && canDropIntoNode(node, { path: finalTargetPath, isAllTracks: false })) {
        const res = await moveAlbumFolder(node.path, finalTargetPath)
        if (res && res.success) {
          setExpandedFolders((prev) => ({
            ...prev,
            [finalTargetPath]: true
          }))
          if (!res.unchanged) {
            showSidebarNotice(`📂 "${node.name}" movido dentro de "${finalTargetName || 'álbum'}"`)
          }
        } else if (res?.error) {
          showSidebarNotice(`⚠ ${res.error}`)
        }
      }
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)
  }, [moveAlbumFolder, handleMoveToRoot, showSidebarNotice])

  // Clic derecho en un nodo de álbum o carpeta
  const handleContextMenuNode = useCallback((node, position, depth = 0) => {
    setAlbumContextMenu({ node, position, depth })
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
        className={`album-list ${dragState ? 'is-dragging-active' : ''} ${dragState?.targetId === '__ROOT__' ? 'root-drag-active' : ''}`}
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
        {dragState && (
          <div
            className={`root-drop-zone ${dragState.targetId === '__ROOT__' ? 'active' : ''}`}
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
            dragState={dragState}
            onStartDrag={handleStartDrag}
            onContextMenuNode={handleContextMenuNode}
            isDraggingOrJustFinished={isDraggingOrJustFinished}
          />
        ))}
      </div>

      {/* Insignia flotante visible que sigue al cursor mientras se arrastra */}
      {dragState && typeof document !== 'undefined' && createPortal(
        <div
          className="album-drag-floating-ghost"
          style={{
            left: `${dragState.x + 16}px`,
            top: `${dragState.y + 16}px`,
            pointerEvents: 'none'
          }}
        >
          <span className="drag-ghost-icon">📂</span>
          <span className="drag-ghost-name">{dragState.node.name}</span>
          <span className={`drag-ghost-action ${dragState.targetId ? 'ready' : ''}`}>
            {dragState.targetId === '__ROOT__'
              ? '⬆️ Mover al nivel principal'
              : dragState.targetName
              ? `➜ Mover dentro de "${dragState.targetName}"`
              : 'Arrastra sobre un álbum o arriba'}
          </span>
        </div>,
        document.body
      )}

      {/* Menú Contextual de Álbum (Clic derecho) */}
      {albumContextMenu && (
        <AlbumContextMenu
          node={albumContextMenu.node}
          position={albumContextMenu.position}
          depth={albumContextMenu.depth || 0}
          onClose={() => setAlbumContextMenu(null)}
          onOpenMove={(n, d) => setMoveTargetNode({ node: n, depth: d })}
          onMoveToRoot={(n) => handleMoveToRoot(n)}
          onRename={(n) => setRenameTargetNode(n)}
          onDelete={(n) => setDeleteTargetNode(n)}
        />
      )}

      {/* Modal para Mover Álbum o Carpeta (Alternativa sin arrastrar) */}
      {moveTargetNode && (
        <MoveAlbumModal
          node={moveTargetNode.node}
          depth={moveTargetNode.depth}
          library={library}
          onClose={() => setMoveTargetNode(null)}
          onConfirm={handleConfirmMoveModal}
          isMoving={isMovingAlbum}
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
