import React, { useState, useEffect, useCallback, Suspense, lazy, memo } from 'react'
import { PlayerProvider, useLibrary, usePlayback } from './context/PlayerContext'

const initialHash = window.location.hash
const isSecondaryWindow =
  initialHash === '#/mini' ||
  initialHash === '#/notification' ||
  initialHash === '#/overlay'

// En la ventana principal, iniciar precarga paralela inmediata en t=0ms (cero cascada de carga).
// En ventanas secundarias (MiniPanel, Toast, Overlay), jamás se descargan ni compilan en V8.
const sidebarPromise = !isSecondaryWindow ? import('./components/Sidebar') : null
const albumViewPromise = !isSecondaryWindow ? import('./components/AlbumView') : null
const playerPromise = !isSecondaryWindow ? import('./components/Player') : null

const Sidebar = lazy(() => sidebarPromise || import('./components/Sidebar'))
const AlbumView = lazy(() => albumViewPromise || import('./components/AlbumView'))
const Player = lazy(() => playerPromise || import('./components/Player'))
const MiniPanel = lazy(() => import('./components/MiniPanel'))
const ToastNotification = lazy(() => import('./components/ToastNotification'))
const GameOverlay = lazy(() => import('./components/GameOverlay'))
const SpotlightSearch = lazy(() => import('./components/SpotlightSearch'))
const SettingsModal = lazy(() => import('./components/SettingsModal'))
const ExtractorModal = lazy(() => import('./components/ExtractorModal'))

/**
 * Subcomponente aislado para el resplandor ambiental de fondo.
 * Evita que MainPlayerApp re-renderice toda la estructura al cambiar de canción o de álbum.
 */
const AmbientBackdrop = memo(function AmbientBackdrop() {
  const { selectedAlbum } = useLibrary()
  const { currentTrack } = usePlayback()
  const hasCover = Boolean(currentTrack?.cover || selectedAlbum?.cover)

  return (
    <div
      className="ambient-backdrop-glow"
      style={{
        opacity: hasCover ? 0.85 : 0.4
      }}
    />
  )
})

function MainPlayerApp({ theme, onThemeChange }) {
  const [isSidebarOpen, setIsSidebarOpen] = useState(true)
  const [isSidePanelOpen, setIsSidePanelOpen] = useState(false)
  const [isSpotlightOpen, setIsSpotlightOpen] = useState(false)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [isExtractorOpen, setIsExtractorOpen] = useState(false)
  const { updateMusicDirectory } = useLibrary()
  const { togglePlay, adjustVolume } = usePlayback()

  const handleToggleSidebar = useCallback(() => {
    setIsSidebarOpen((prev) => !prev)
  }, [])

  const handleCloseSpotlight = useCallback(() => {
    setIsSpotlightOpen(false)
  }, [])

  const handleCloseSettings = useCallback(() => {
    setIsSettingsOpen(false)
  }, [])

  const handleCloseExtractor = useCallback(() => {
    setIsExtractorOpen(false)
  }, [])

  // Sincronizar visibilidad del Panel Lateral
  useEffect(() => {
    let unsubPanelMode = null
    if (window.electronAPI?.onSidePanelMode) {
      unsubPanelMode = window.electronAPI.onSidePanelMode((mode) => {
        setIsSidePanelOpen(mode === 'expanded')
      })
    }
    return () => {
      if (unsubPanelMode) unsubPanelMode()
    }
  }, [])

  const handleBrowseMusicDirectory = useCallback(async () => {
    try {
      const directory = await window.electronAPI?.selectMusicDirectory?.()
      if (directory) {
        await updateMusicDirectory(directory)
      }
    } catch (err) {
      console.error('Error seleccionando el directorio de música:', err)
    }
  }, [updateMusicDirectory])

  // Atajos de teclado en la ventana principal
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Atajo global para Buscador Spotlight (Ctrl+K o Ctrl+F)
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K' || e.key === 'f' || e.key === 'F')) {
        e.preventDefault()
        setIsSpotlightOpen((prev) => !prev)
        return
      }

      // Atajo Ctrl+D para Descargar / Pegar Enlace (Extractor)
      if ((e.ctrlKey || e.metaKey) && (e.key === 'd' || e.key === 'D')) {
        e.preventDefault()
        setIsExtractorOpen((prev) => !prev)
        return
      }

      // Atajo Ctrl+Space (o Cmd+Space) para pausar / despausar en cualquier momento
      if ((e.ctrlKey || e.metaKey) && e.code === 'Space') {
        e.preventDefault()
        togglePlay()
        return
      }

      // Ignorar controles de reproducción si el usuario está escribiendo en un input o campo de búsqueda
      const activeTag = document.activeElement?.tagName?.toLowerCase()
      if (activeTag === 'input' || activeTag === 'textarea') return

      if (e.code === 'Space') {
        e.preventDefault()
        togglePlay()
      } else if (e.code === 'ArrowUp') {
        e.preventDefault()
        adjustVolume(0.05)
      } else if (e.code === 'ArrowDown') {
        e.preventDefault()
        adjustVolume(-0.05)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [togglePlay, adjustVolume])

  return (
    <div className="app">
      {/* Barra de título personalizada con jerarquía visual equilibrada */}
      <header className="titlebar">
        <div className="titlebar-drag">
          <span className="titlebar-title">🎵 Reproductor de Música</span>
        </div>

        {/* Centro: Buscador Global Spotlight */}
        <div className="titlebar-center">
          <button
            className="titlebar-spotlight-btn"
            onClick={() => setIsSpotlightOpen(true)}
            title="Buscador global en toda la biblioteca (Ctrl+K)"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
              <path d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z" />
            </svg>
            <span>Buscar música...</span>
            <kbd className="titlebar-kbd">Ctrl+K</kbd>
          </button>
        </div>

        <div className="titlebar-right">
          <div className="titlebar-actions">
            {/* Botón para desplegar/ocultar el Panel Lateral Rápido (sincronizado en tiempo real) */}
            <button
              className={`titlebar-side-btn ${isSidePanelOpen ? 'active-panel' : ''}`}
              onClick={() => window.electronAPI.toggleSidePanel()}
              title="Panel lateral de navegación rápida (Ctrl+Shift+M / Ctrl+Alt+M)"
              aria-pressed={isSidePanelOpen}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M4 18h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v8c0 1.1.9 2 2 2zm12-10h4v8h-4V8z"/>
              </svg>
              <span>Panel Rápido</span>
            </button>

            {/* Botón para invocar Extractor de Música (Descargar / Pegar Enlace) */}
            <button
              className="titlebar-extractor-btn"
              onClick={() => setIsExtractorOpen(true)}
              title="Descargar o pegar enlace para extraer música con metadatos oficiales (YouTube, Spotify, TikTok)"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
                <path d="M19.35 10.04C18.67 6.59 15.64 4 12 4 9.11 4 6.6 5.64 5.35 8.04 2.34 8.36 0 10.91 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96zM17 13l-5 5-5-5h3V9h4v4h3z"/>
              </svg>
              <span>Descargar</span>
            </button>

            {/* Botón de Ajustes */}
            <button
              className={`titlebar-settings-btn ${isSettingsOpen ? 'active' : ''}`}
              onClick={() => setIsSettingsOpen(true)}
              title="Ajustes y configuración avanzada"
              aria-label="Ajustes"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z" />
                <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-1.7 2.94-.08-.02a1.7 1.7 0 0 0-1.77.49l-.06.06h-3.4l-.03-.08a1.7 1.7 0 0 0-1.43-1.14h-.08l-1.7-2.94.05-.06a1.7 1.7 0 0 0 .1-1.8l-.04-.07 1.7-2.94h.08a1.7 1.7 0 0 0 1.48-.98l.04-.08h3.4l.04.08a1.7 1.7 0 0 0 1.48.98h.08l1.7 2.94-.05.07A1.7 1.7 0 0 0 19.4 15Z" />
              </svg>
            </button>
          </div>

          <div className="titlebar-divider" aria-hidden="true" />

          <div className="titlebar-controls">
            <button className="titlebar-btn" onClick={() => window.electronAPI.minimizeWindow()} title="Minimizar (Despliega Panel Lateral)">
              <svg width="12" height="12" viewBox="0 0 12 12"><rect y="5" width="12" height="2" fill="currentColor"/></svg>
            </button>
            <button className="titlebar-btn" onClick={() => window.electronAPI.maximizeWindow()} title="Maximizar">
              <svg width="12" height="12" viewBox="0 0 12 12"><rect x="1" y="1" width="10" height="10" stroke="currentColor" strokeWidth="1.5" fill="none"/></svg>
            </button>
            <button className="titlebar-btn close-btn" onClick={() => window.electronAPI.closeWindow()} title="Cerrar">
              <svg width="12" height="12" viewBox="0 0 12 12"><path d="M1 1L11 11M11 1L1 11" stroke="currentColor" strokeWidth="1.5"/></svg>
            </button>
          </div>
        </div>
      </header>

      {/* Contenido principal con Fondo Ambiental Dinámico fijo (no repinta al hacer scroll) */}
      <Suspense fallback={null}>
        <div className="app-content">
          <Sidebar isOpen={isSidebarOpen} onToggle={handleToggleSidebar} />
          <div className="main-stage">
            <AmbientBackdrop />
            <main className="main-view">
              <AlbumView />
            </main>
          </div>
        </div>

        {/* Barra del reproductor */}
        <Player />
      </Suspense>

      {/* Modales bajo demanda: solo se montan y suscriben a contexto cuando están abiertos */}
      <Suspense fallback={null}>
        {isSpotlightOpen && (
          <SpotlightSearch
            isOpen={isSpotlightOpen}
            onClose={handleCloseSpotlight}
          />
        )}

        {isSettingsOpen && (
          <SettingsModal
            isOpen={isSettingsOpen}
            onClose={handleCloseSettings}
            theme={theme}
            onThemeChange={onThemeChange}
            onBrowseDirectory={handleBrowseMusicDirectory}
          />
        )}

        {isExtractorOpen && (
          <ExtractorModal
            isOpen={isExtractorOpen}
            onClose={handleCloseExtractor}
          />
        )}
      </Suspense>
    </div>
  )
}

function App() {
  const isMini = window.location.hash === '#/mini'
  const isNotification = window.location.hash === '#/notification'
  const isOverlay = window.location.hash === '#/overlay'
  const [theme, setTheme] = useState(() => {
    const savedTheme = window.localStorage.getItem('musicPlayerTheme')
    return savedTheme === 'light' ? 'light' : 'dark'
  })

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    if (!isMini && !isNotification && !isOverlay) {
      window.localStorage.setItem('musicPlayerTheme', theme)
      window.electronAPI?.sendPlayerCommand?.(`theme-${theme}`)
    }
  }, [theme, isMini, isNotification, isOverlay])

  // Sincronizar cambios de tema en tiempo real hacia la barra lateral (MiniPanel) y notificaciones
  useEffect(() => {
    const handleStorage = (e) => {
      if (e.key === 'musicPlayerTheme' && e.newValue) {
        setTheme(e.newValue === 'light' ? 'light' : 'dark')
      }
    }
    window.addEventListener('storage', handleStorage)

    let unsubCmd = null
    if (window.electronAPI?.onPlayerCommand) {
      unsubCmd = window.electronAPI.onPlayerCommand((cmd) => {
        if (typeof cmd === 'string' && cmd.startsWith('theme-')) {
          const nextTheme = cmd.replace('theme-', '') === 'light' ? 'light' : 'dark'
          setTheme(nextTheme)
        }
      })
    }

    return () => {
      window.removeEventListener('storage', handleStorage)
      if (unsubCmd) unsubCmd()
    }
  }, [])

  useEffect(() => {
    if (isMini || isNotification || isOverlay) {
      document.documentElement.style.background = 'transparent'
      document.body.style.background = 'transparent'
    }
  }, [isMini, isNotification, isOverlay])

  if (isNotification) {
    return (
      <Suspense fallback={null}>
        <ToastNotification />
      </Suspense>
    )
  }

  if (isOverlay) {
    return (
      <PlayerProvider isMiniPanel={true}>
        <Suspense fallback={null}>
          <GameOverlay />
        </Suspense>
      </PlayerProvider>
    )
  }

  if (isMini) {
    return (
      <PlayerProvider isMiniPanel={true}>
        <Suspense fallback={null}>
          <MiniPanel />
        </Suspense>
      </PlayerProvider>
    )
  }

  return (
    <PlayerProvider>
      <MainPlayerApp theme={theme} onThemeChange={setTheme} />
    </PlayerProvider>
  )
}

export default App
