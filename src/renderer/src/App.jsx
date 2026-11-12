import React, { useState, useEffect, useCallback, Suspense, lazy, memo } from 'react'
import { PlayerProvider, useLibrary, usePlayback } from './context/PlayerContext'
import BottomNavBar, { triggerHaptic } from './components/BottomNavBar'

const sidebarPromise = import('./components/Sidebar')
const albumViewPromise = import('./components/AlbumView')
const playerPromise = import('./components/Player')

const Sidebar = lazy(() => sidebarPromise)
const AlbumView = lazy(() => albumViewPromise)
const Player = lazy(() => playerPromise)
const SpotlightSearch = lazy(() => import('./components/SpotlightSearch'))
const SettingsModal = lazy(() => import('./components/SettingsModal'))

/**
 * Subcomponente aislado para el resplandor ambiental de fondo.
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
  const [activeNavTab, setActiveNavTab] = useState('home') // 'home' | 'albums' | 'search' | 'settings'
  const [isSidebarOpen, setIsSidebarOpen] = useState(true)
  const [importToast, setImportToast] = useState(null)

  const { selectedAlbum, allAlbums = [], importFilesToVault } = useLibrary()
  const { togglePlay, adjustVolume, currentTrack } = usePlayback()

  const handleToggleSidebar = useCallback(() => {
    setIsSidebarOpen((prev) => !prev)
  }, [])

  const handleQuickImport = useCallback(async () => {
    void triggerHaptic()
    const targetId =
      selectedAlbum && !selectedAlbum.isAllTracks ? selectedAlbum.id : undefined
    const res = await importFilesToVault?.(targetId)
    if (res && res.success && res.importedCount > 0) {
      setImportToast(
        `✓ ${res.importedCount} ${res.importedCount === 1 ? 'pista importada' : 'pistas importadas'}`
      )
      setTimeout(() => setImportToast(null), 2600)
    }
  }, [selectedAlbum, importFilesToVault])

  // Atajos opcionales si se conecta teclado externo o en vista previa web
  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K' || e.key === 'f' || e.key === 'F')) {
        e.preventDefault()
        setActiveNavTab((prev) => (prev === 'search' ? 'home' : 'search'))
        return
      }

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

  const headerTitle =
    activeNavTab === 'home'
      ? selectedAlbum?.name || 'Mis Pistas'
      : activeNavTab === 'albums'
        ? 'Álbumes y Carpetas'
        : activeNavTab === 'search'
          ? 'Buscar Música'
          : 'Ajustes'

  const headerSub =
    activeNavTab === 'home'
      ? selectedAlbum?.trackCount !== undefined
        ? `${selectedAlbum.trackCount} pistas en álbum`
        : 'Bóveda Musical'
      : activeNavTab === 'albums'
        ? `${allAlbums.length} álbumes en la bóveda`
        : activeNavTab === 'search'
          ? 'Búsqueda instantánea'
          : 'Configuración de la app'

  return (
    <div className={`app ${currentTrack ? 'has-active-track' : ''}`}>
      {/* Header Móvil Limpio con soporte para safe-area-inset-top */}
      <header className="mobile-app-header">
        <div className="mobile-header-left">
          <div className="mobile-header-logo" onClick={() => setActiveNavTab('home')}>
            🎵
          </div>
          <div className="mobile-header-titles">
            <h1 className="mobile-header-title">{headerTitle}</h1>
            <span className="mobile-header-subtitle">{headerSub}</span>
          </div>
        </div>

        <div className="mobile-header-actions">
          <button
            type="button"
            className="mobile-header-import-btn"
            onClick={handleQuickImport}
            title="Importar música o video a la bóveda"
          >
            <span>+ Importar</span>
          </button>

          <button
            type="button"
            className={`mobile-header-icon-btn ${activeNavTab === 'search' ? 'active' : ''}`}
            onClick={() => {
              void triggerHaptic()
              setActiveNavTab((prev) => (prev === 'search' ? 'home' : 'search'))
            }}
            aria-label="Buscar"
            title="Buscar"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </button>

          <button
            type="button"
            className="mobile-header-icon-btn"
            onClick={() => {
              void triggerHaptic()
              onThemeChange(theme === 'dark' ? 'light' : 'dark')
            }}
            aria-label="Cambiar tema"
            title={theme === 'dark' ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'}
          >
            {theme === 'dark' ? '🌙' : '☀️'}
          </button>
        </div>
      </header>

      {importToast && (
        <div className="track-action-feedback-toast" role="status">
          {importToast}
        </div>
      )}

      {/* Escenario Principal según pestaña activa */}
      <Suspense fallback={null}>
        <div className="app-content">
          {activeNavTab === 'home' && (
            <>
              <div className="desktop-only-sidebar">
                <Sidebar isOpen={isSidebarOpen} onToggle={handleToggleSidebar} />
              </div>
              <div className="main-stage">
                <AmbientBackdrop />
                <main className="main-view">
                  <AlbumView />
                </main>
              </div>
            </>
          )}

          {activeNavTab === 'albums' && (
            <div className="main-stage">
              <AmbientBackdrop />
              <main className="main-view mobile-albums-full-stage">
                <Sidebar
                  isOpen={true}
                  isMobileFullView={true}
                  onAlbumSelected={() => setActiveNavTab('home')}
                />
              </main>
            </div>
          )}

          {activeNavTab === 'search' && (
            <div className="main-stage">
              <AmbientBackdrop />
              <main className="main-view">
                <SpotlightSearch
                  isOpen={true}
                  inline={true}
                  onNavigateToHome={() => setActiveNavTab('home')}
                />
              </main>
            </div>
          )}

          {activeNavTab === 'settings' && (
            <div className="main-stage">
              <AmbientBackdrop />
              <main className="main-view">
                <SettingsModal
                  isOpen={true}
                  inline={true}
                  theme={theme}
                  onThemeChange={onThemeChange}
                />
              </main>
            </div>
          )}
        </div>

        {/* MiniPlayer acoplado + BottomSheet NowPlaying */}
        <Player />
      </Suspense>

      {/* Barra de Navegación Inferior Móvil Fija */}
      <BottomNavBar
        activeTab={activeNavTab}
        onSelectTab={setActiveNavTab}
        albumCount={allAlbums.length}
      />
    </div>
  )
}

function App() {
  const [theme, setTheme] = useState(() => {
    const savedTheme = window.localStorage.getItem('musicPlayerTheme')
    return savedTheme === 'light' ? 'light' : 'dark'
  })

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    window.localStorage.setItem('musicPlayerTheme', theme)
  }, [theme])

  return (
    <PlayerProvider>
      <MainPlayerApp theme={theme} onThemeChange={setTheme} />
    </PlayerProvider>
  )
}

export default App
