import { useState, useEffect, useRef } from 'react'
import { PlayerProvider, usePlayer } from './context/PlayerContext'
import Sidebar from './components/Sidebar'
import AlbumView from './components/AlbumView'
import Player from './components/Player'
import MiniPanel from './components/MiniPanel'
import SpotlightSearch from './components/SpotlightSearch'
import ToastNotification from './components/ToastNotification'

function MainPlayerApp({ theme, onThemeChange }) {
  const [isSidebarOpen, setIsSidebarOpen] = useState(true)
  const [isAlwaysOnTop, setIsAlwaysOnTop] = useState(false)
  const [isSpotlightOpen, setIsSpotlightOpen] = useState(false)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const settingsMenuRef = useRef(null)
  const { currentTrack, togglePlay, volume, setVolumeLevel, musicDirectory, updateMusicDirectory } = usePlayer()

  useEffect(() => {
    if (!isSettingsOpen) return undefined

    const handlePointerDown = (event) => {
      if (!settingsMenuRef.current?.contains(event.target)) {
        setIsSettingsOpen(false)
      }
    }
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setIsSettingsOpen(false)
    }

    document.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [isSettingsOpen])

  // Sincronizar estado inicial de Always on Top
  useEffect(() => {
    if (window.electronAPI.getMainAlwaysOnTop) {
      window.electronAPI.getMainAlwaysOnTop().then(setIsAlwaysOnTop).catch(console.error)
    }
  }, [])

  const handleToggleAlwaysOnTop = async () => {
    if (window.electronAPI.toggleMainAlwaysOnTop) {
      const state = await window.electronAPI.toggleMainAlwaysOnTop()
      setIsAlwaysOnTop(state)
    }
  }

  const handleBrowseMusicDirectory = async () => {
    try {
      const directory = await window.electronAPI.selectMusicDirectory()
      if (directory) {
        await updateMusicDirectory(directory)
      }
    } catch (err) {
      console.error('Error seleccionando el directorio de música:', err)
    }
  }

  // Atajos de teclado en la ventana principal
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Atajo global para Buscador Spotlight (Ctrl+K o Ctrl+F)
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K' || e.key === 'f' || e.key === 'F')) {
        e.preventDefault()
        setIsSpotlightOpen(prev => !prev)
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
        setVolumeLevel(Math.min(1, Math.round(((volume ?? 0.8) + 0.05) * 100) / 100))
      } else if (e.code === 'ArrowDown') {
        e.preventDefault()
        setVolumeLevel(Math.max(0, Math.round(((volume ?? 0.8) - 0.05) * 100) / 100))
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [togglePlay, volume, setVolumeLevel])

  return (
    <div className="app">
      {/* Barra de título personalizada */}
      <div className="titlebar">
        <div className="titlebar-drag">
          <span className="titlebar-title">🎵 Reproductor de Música</span>
        </div>

        <div className="titlebar-actions">
          {/* Botón Buscador Global Spotlight */}
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

          {/* Botón para Fijar ventana principal en primer plano */}
          <button
            className={`titlebar-pin-btn ${isAlwaysOnTop ? 'active-pin' : ''}`}
            onClick={handleToggleAlwaysOnTop}
            title={isAlwaysOnTop ? 'Ventana siempre visible: ACTIVADA (Prioridad sobre otras apps)' : 'Fijar ventana siempre encima'}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
              <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z"/>
            </svg>
            <span>{isAlwaysOnTop ? 'Fijada' : 'Fijar'}</span>
          </button>

          {/* Botón para desplegar/ocultar el Panel Lateral Rápido */}
          <button
            className="titlebar-side-btn"
            onClick={() => window.electronAPI.toggleSidePanel()}
            title="Panel lateral de navegación rápida (Ctrl+Shift+M / Ctrl+Alt+M)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M4 18h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v8c0 1.1.9 2 2 2zm12-10h4v8h-4V8z"/>
            </svg>
            <span>Panel Rápido</span>
          </button>

          <div className="settings-menu" ref={settingsMenuRef}>
            <button
              className={`titlebar-settings-btn ${isSettingsOpen ? 'active' : ''}`}
              onClick={() => setIsSettingsOpen((open) => !open)}
              title="Ajustes"
              aria-label="Ajustes"
              aria-expanded={isSettingsOpen}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z" />
                <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-1.7 2.94-.08-.02a1.7 1.7 0 0 0-1.77.49l-.06.06h-3.4l-.03-.08a1.7 1.7 0 0 0-1.43-1.14h-.08l-1.7-2.94.05-.06a1.7 1.7 0 0 0 .1-1.8l-.04-.07 1.7-2.94h.08a1.7 1.7 0 0 0 1.48-.98l.04-.08h3.4l.04.08a1.7 1.7 0 0 0 1.48.98h.08l1.7 2.94-.05.07A1.7 1.7 0 0 0 19.4 15Z" />
              </svg>
            </button>

            {isSettingsOpen && (
              <div className="settings-popover" role="dialog" aria-label="Ajustes de la aplicación">
                <div className="settings-popover-title">Ajustes</div>
                <button
                  className="settings-option"
                  onClick={() => onThemeChange(theme === 'dark' ? 'light' : 'dark')}
                  aria-pressed={theme === 'light'}
                >
                  <span className="settings-option-icon" aria-hidden="true">
                    {theme === 'dark' ? '☀' : '☾'}
                  </span>
                  <span className="settings-option-label">
                    <span>Tema</span>
                    <span className="settings-option-description">{theme === 'dark' ? 'Oscuro' : 'Claro'}</span>
                  </span>
                  <span className={`settings-switch ${theme === 'light' ? 'enabled' : ''}`} aria-hidden="true">
                    <span />
                  </span>
                </button>
                <div className="settings-directory">
                  <span className="settings-directory-label">Carpeta de música</span>
                  <span className="settings-directory-value" title={musicDirectory || 'Ubicación automática'}>
                    {musicDirectory || 'Ubicación automática'}
                  </span>
                  <button className="settings-browse-btn" onClick={handleBrowseMusicDirectory}>
                    Examinar directorio
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="titlebar-controls">
          <button className="titlebar-btn" onClick={() => window.electronAPI.minimizeWindow()} title="Minimizar (Activa Panel Lateral)">
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

      {/* Contenido principal con Fondo Ambiental Dinámico */}
      <div className="app-content">
        <Sidebar isOpen={isSidebarOpen} onToggle={() => setIsSidebarOpen(prev => !prev)} />
        <main className="main-view">
          {/* Resplandor ambiental reactivo suave */}
          <div
            className="ambient-backdrop-glow"
            style={{
              opacity: currentTrack?.cover ? 0.85 : 0.4
            }}
          />
          <AlbumView />
        </main>
      </div>

      {/* Barra del reproductor */}
      <Player />

      {/* Buscador Global Spotlight (Ctrl+K) */}
      <SpotlightSearch
        isOpen={isSpotlightOpen}
        onClose={() => setIsSpotlightOpen(false)}
      />
    </div>
  )
}

function App() {
  const isMini = window.location.hash === '#/mini'
  const isNotification = window.location.hash === '#/notification'
  const [theme, setTheme] = useState(() => {
    const savedTheme = window.localStorage.getItem('musicPlayerTheme')
    return savedTheme === 'light' ? 'light' : 'dark'
  })

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    if (!isMini && !isNotification) {
      window.localStorage.setItem('musicPlayerTheme', theme)
      window.electronAPI?.sendPlayerCommand?.(`theme-${theme}`)
    }
  }, [theme, isMini, isNotification])

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
    if (isMini || isNotification) {
      document.documentElement.style.background = 'transparent'
      document.body.style.background = 'transparent'
    }
  }, [isMini, isNotification])

  if (isNotification) {
    return <ToastNotification />
  }

  if (isMini) {
    return (
      <PlayerProvider isMiniPanel={true}>
        <MiniPanel />
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
