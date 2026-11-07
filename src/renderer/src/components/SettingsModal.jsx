import React, { useState, useEffect, useCallback } from 'react'
import { usePlayer } from '../context/PlayerContext'

export default function SettingsModal({ isOpen, onClose, theme, onThemeChange, onBrowseDirectory }) {
  const { appSettings, updateAppSettings, musicDirectory, loadLibrary } = usePlayer()

  const [activeTab, setActiveTab] = useState('general') // 'general' | 'audio' | 'gaming' | 'lyrics' | 'hardlinks' | 'shortcuts'
  const [discordStatus, setDiscordStatus] = useState({ connected: false, enabled: false })
  const [overlayStatus, setOverlayStatus] = useState(false)

  // Estados del comprobador de Hard Links
  const [healthData, setHealthData] = useState(null)
  const [isCheckingHealth, setIsCheckingHealth] = useState(false)
  const [isRepairingHealth, setIsRepairingHealth] = useState(false)
  const [healthNotice, setHealthNotice] = useState(null)

  // Estados de descarga masiva de letras
  const [isBatchDownloadingLyrics, setIsBatchDownloadingLyrics] = useState(false)
  const [batchLyricsResult, setBatchLyricsResult] = useState(null)

  // Comprobar estado de Discord y Overlay al abrir
  useEffect(() => {
    if (isOpen) {
      if (window.electronAPI?.getDiscordRpcStatus) {
        window.electronAPI.getDiscordRpcStatus().then((st) => {
          if (st) setDiscordStatus(st)
        }).catch(() => {})
      }
      if (window.electronAPI?.getGameOverlayStatus) {
        window.electronAPI.getGameOverlayStatus().then((st) => {
          setOverlayStatus(Boolean(st))
        }).catch(() => {})
      }
    }
  }, [isOpen])

  // Ejecutar diagnóstico de Hard Links
  const handleRunHealthCheck = useCallback(async () => {
    setIsCheckingHealth(true)
    setHealthNotice(null)
    try {
      const res = await window.electronAPI?.checkHardlinksHealth?.()
      if (res && res.success) {
        setHealthData(res)
      } else {
        setHealthNotice(`⚠ ${res?.error || 'No se pudo completar el diagnóstico.'}`)
      }
    } catch (err) {
      setHealthNotice(`⚠ Error: ${err.message}`)
    } finally {
      setIsCheckingHealth(false)
    }
  }, [])

  // Auto-reparar inodos y enlaces
  const handleRepairHardlinks = useCallback(async () => {
    setIsRepairingHealth(true)
    setHealthNotice(null)
    try {
      const res = await window.electronAPI?.repairHardlinksIntegrity?.()
      if (res && res.success) {
        setHealthNotice(`✓ ¡Reparación completada! ${res.repairedCount} enlaces restaurados y sincronizados.`)
        // Actualizar diagnóstico y biblioteca
        handleRunHealthCheck()
        loadLibrary?.()
      } else {
        setHealthNotice(`⚠ ${res?.error || 'No se pudo reparar la biblioteca.'}`)
      }
    } catch (err) {
      setHealthNotice(`⚠ Error: ${err.message}`)
    } finally {
      setIsRepairingHealth(false)
    }
  }, [handleRunHealthCheck])

  // Escaneo y descarga masiva de letras
  const handleBatchDownloadLyrics = useCallback(async () => {
    setIsBatchDownloadingLyrics(true)
    setBatchLyricsResult(null)
    try {
      const res = await window.electronAPI?.batchDownloadLyrics?.()
      if (res && res.success) {
        setBatchLyricsResult(`✓ Escaneo completado: ${res.downloadedCount} letras sincronizadas de ${res.totalScanned} analizadas.`)
      } else {
        setBatchLyricsResult(`⚠ No se pudieron descargar letras: ${res?.error || 'Error desconocido'}`)
      }
    } catch (err) {
      setBatchLyricsResult(`⚠ Error: ${err.message}`)
    } finally {
      setIsBatchDownloadingLyrics(false)
    }
  }, [])

  // Cerrar ventana con la tecla Escape
  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        onClose?.()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  if (!isOpen) return null

  return (
    <div className="track-modal-backdrop settings-modal-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div
        className="settings-modal-box"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="settings-modal-header">
          <div className="settings-modal-header-info">
            <span className="settings-modal-header-icon">⚙️</span>
            <div>
              <h3 className="settings-modal-title">Ajustes y Configuración</h3>
              <p className="settings-modal-subtitle">
                Personalización de audio, integraciones y salud del sistema
              </p>
            </div>
          </div>
          <button
            type="button"
            className="settings-modal-close-btn"
            onClick={onClose}
            aria-label="Cerrar ajustes"
            title="Cerrar (Esc)"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M1 1l12 12M13 1L1 13" />
            </svg>
          </button>
        </div>

        {/* Pestañas de navegación */}
        <div className="settings-tabs-bar">
          <button
            type="button"
            className={`settings-tab-btn ${activeTab === 'general' ? 'active' : ''}`}
            onClick={() => setActiveTab('general')}
          >
            🎨 Interfaz
          </button>
          <button
            type="button"
            className={`settings-tab-btn ${activeTab === 'audio' ? 'active' : ''}`}
            onClick={() => setActiveTab('audio')}
          >
            🔊 Audio & EQ
          </button>
          <button
            type="button"
            className={`settings-tab-btn ${activeTab === 'gaming' ? 'active' : ''}`}
            onClick={() => setActiveTab('gaming')}
          >
            🎮 Gaming (RPC & HUD)
          </button>
          <button
            type="button"
            className={`settings-tab-btn ${activeTab === 'lyrics' ? 'active' : ''}`}
            onClick={() => setActiveTab('lyrics')}
          >
            🎤 Letras & Tags
          </button>
          <button
            type="button"
            className={`settings-tab-btn ${activeTab === 'hardlinks' ? 'active' : ''}`}
            onClick={() => setActiveTab('hardlinks')}
          >
            🛡️ Hard Links NTFS
          </button>
          <button
            type="button"
            className={`settings-tab-btn ${activeTab === 'shortcuts' ? 'active' : ''}`}
            onClick={() => setActiveTab('shortcuts')}
          >
            ⌨️ Atajos & Comandos
          </button>
        </div>

        <div className="settings-modal-content">
          {/* TAB 1: GENERAL E INTERFAZ */}
          {activeTab === 'general' && (
            <div className="settings-section">
              <div className="settings-item-row">
                <div className="settings-item-info">
                  <div className="settings-item-title">Tema Visual</div>
                  <div className="settings-item-desc">Alterna entre modo oscuro profundo o claro</div>
                </div>
                <button
                  type="button"
                  className="settings-theme-toggle-btn"
                  onClick={() => onThemeChange(theme === 'dark' ? 'light' : 'dark')}
                >
                  {theme === 'dark' ? '🌙 Modo Oscuro' : '☀️ Modo Claro'}
                </button>
              </div>

              {/* Botón Fijar (Always on Top) reubicado dentro de Ajustes */}
              <div className="settings-item-row">
                <div className="settings-item-info">
                  <div className="settings-item-title">Fijar Ventana en Primer Plano (Always on Top)</div>
                  <div className="settings-item-desc">
                    Mantiene el reproductor siempre visible sobre otras aplicaciones y ventanas
                  </div>
                </div>
                <button
                  type="button"
                  className={`settings-switch-control ${appSettings.alwaysOnTop ? 'active' : ''}`}
                  onClick={() => updateAppSettings((prev) => ({ alwaysOnTop: !prev.alwaysOnTop }))}
                  aria-pressed={appSettings.alwaysOnTop}
                >
                  <span className="switch-thumb" />
                </button>
              </div>

              <div className="settings-item-row column">
                <div className="settings-item-title">Carpeta Raíz de Música</div>
                <div className="settings-item-desc">
                  Directorio sincronizado mediante enlaces duros NTFS (<code>canciones_organizadas</code>)
                </div>
                <div className="settings-directory-box">
                  <span className="settings-directory-path" title={musicDirectory || 'Automática'}>
                    {musicDirectory || 'Ubicación predeterminada'}
                  </span>
                  <button
                    type="button"
                    className="settings-action-btn"
                    onClick={onBrowseDirectory}
                  >
                    Examinar...
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: AUDIO Y FIDELIDAD */}
          {activeTab === 'audio' && (
            <div className="settings-section">
              {/* Normalización Automática de Volumen (ReplayGain) */}
              <div className="settings-item-row">
                <div className="settings-item-info">
                  <div className="settings-item-title">Normalización Automática de Volumen (ReplayGain)</div>
                  <div className="settings-item-desc">
                    Compresión acústica dinámica transparente (Web Audio API) que equilibra el volumen entre canciones sin saturar ni distorsionar.
                  </div>
                </div>
                <button
                  type="button"
                  className={`settings-switch-control ${appSettings.replayGain ? 'active' : ''}`}
                  onClick={() => updateAppSettings((prev) => ({ replayGain: !prev.replayGain }))}
                  aria-pressed={appSettings.replayGain}
                >
                  <span className="switch-thumb" />
                </button>
              </div>

              {/* Fundido Encadenado (Crossfade) y Transición Suave */}
              <div className="settings-item-row">
                <div className="settings-item-info">
                  <div className="settings-item-title">Fundido Encadenado (Crossfade) y Transición Suave</div>
                  <div className="settings-item-desc">
                    Rampa de ganancia suave al cambiar de pista o al finalizar, eliminando silencios abruptos y clics.
                  </div>
                </div>
                <button
                  type="button"
                  className={`settings-switch-control ${appSettings.crossfadeEnabled ? 'active' : ''}`}
                  onClick={() => updateAppSettings((prev) => ({ crossfadeEnabled: !prev.crossfadeEnabled }))}
                  aria-pressed={appSettings.crossfadeEnabled}
                >
                  <span className="switch-thumb" />
                </button>
              </div>

              {appSettings.crossfadeEnabled && (
                <div className="settings-sub-options">
                  <span className="settings-sub-label">Duración del fundido:</span>
                  <div className="settings-pill-selector">
                    {[1, 2, 3, 4, 5].map((sec) => (
                      <button
                        key={sec}
                        type="button"
                        className={`pill-btn ${appSettings.crossfadeDuration === sec ? 'selected' : ''}`}
                        onClick={() => updateAppSettings({ crossfadeDuration: sec })}
                      >
                        {sec}s
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* TAB 3: GAMING (DISCORD RPC & HUD OVERLAY) */}
          {activeTab === 'gaming' && (
            <div className="settings-section">
              {/* Discord Rich Presence (RPC) */}
              <div className="settings-item-row">
                <div className="settings-item-info">
                  <div className="settings-item-title">Discord Rich Presence (RPC)</div>
                  <div className="settings-item-desc">
                    Muestra tu música en tiempo real en tu perfil de Discord (canción, artista, carátula y barra de tiempo) mientras juegas.
                  </div>
                </div>
                <button
                  type="button"
                  className={`settings-switch-control ${appSettings.discordRpc ? 'active' : ''}`}
                  onClick={() => updateAppSettings((prev) => ({ discordRpc: !prev.discordRpc }))}
                  aria-pressed={appSettings.discordRpc}
                >
                  <span className="switch-thumb" />
                </button>
              </div>

              {/* HUD / Widget Flotante de Juego (Game Overlay) */}
              <div className="settings-item-row">
                <div className="settings-item-info">
                  <div className="settings-item-title">HUD / Widget Flotante de Juego (Game Overlay)</div>
                  <div className="settings-item-desc">
                    Mini cápsula translúcida siempre visible sobre juegos (Atajo global: <strong>Ctrl+Alt+H</strong>). Permite cambiar de tema y regular volumen con la rueda del ratón.
                  </div>
                </div>
                <button
                  type="button"
                  className={`settings-switch-control ${appSettings.gameOverlay ? 'active' : ''}`}
                  onClick={() => updateAppSettings((prev) => ({ gameOverlay: !prev.gameOverlay }))}
                  aria-pressed={appSettings.gameOverlay}
                >
                  <span className="switch-thumb" />
                </button>
              </div>

              <div className="settings-tip-card">
                <span style={{ fontSize: '18px' }}>💡</span>
                <div>
                  <strong>Optimización para Videojuegos:</strong> El proceso del reproductor se ejecuta con prioridad <code>PRIORITY_ABOVE_NORMAL</code> para garantizar cero micro-tirones (stutter) en juegos competitivos pesados como <em>League of Legends</em>.
                </div>
              </div>
            </div>
          )}

          {/* TAB 4: LETRAS Y METADATOS */}
          {activeTab === 'lyrics' && (
            <div className="settings-section">
              <div className="settings-item-row">
                <div className="settings-item-info">
                  <div className="settings-item-title">Descarga Automática de Letras (.lrc)</div>
                  <div className="settings-item-desc">
                    Busca automáticamente letras sincronizadas en LRCLIB al reproducir canciones que no tengan letra local. Como las versiones o remixes pueden diferir del original, puedes elegir usarlas en modo temporal (sin incrustar ni crear archivos).
                  </div>
                </div>
                <button
                  type="button"
                  className={`settings-switch-control ${appSettings.autoLyrics ? 'active' : ''}`}
                  onClick={() => updateAppSettings((prev) => ({ autoLyrics: !prev.autoLyrics }))}
                  aria-pressed={appSettings.autoLyrics}
                >
                  <span className="switch-thumb" />
                </button>
              </div>

              {/* Selector de modo: Temporal en memoria vs Guardar .lrc en disco */}
              <div className="settings-sub-options column-mode">
                <span className="settings-sub-label">
                  Modo de letra descargada (Evita incrustar letras de versiones distintas en tus archivos):
                </span>
                <div className="settings-pill-selector full-width">
                  <button
                    type="button"
                    className={`pill-btn flex-1 ${(appSettings.lyricsMode || 'temporary') === 'temporary' ? 'selected' : ''}`}
                    onClick={() => updateAppSettings({ lyricsMode: 'temporary' })}
                  >
                    ⚡ Temporal en Memoria (No incrustar)
                  </button>
                  <button
                    type="button"
                    className={`pill-btn flex-1 ${appSettings.lyricsMode === 'permanent' ? 'selected' : ''}`}
                    onClick={() => updateAppSettings({ lyricsMode: 'permanent' })}
                  >
                    💾 Guardar archivo .lrc externo
                  </button>
                </div>
                <p style={{ margin: '6px 0 0', fontSize: '11.5px', color: 'var(--text-dim)', lineHeight: 1.4 }}>
                  {(appSettings.lyricsMode || 'temporary') === 'temporary'
                    ? '✓ Modo Temporal activo: La letra se carga al vuelo en el panel de letras sin modificar el archivo .mp3 ni crear archivos .lrc. Si una letra coincide exactamente con tu versión, podrás guardarla con el botón "💾 Guardar .lrc" desde el panel de letras.'
                    : '✓ Modo Archivo .lrc activo: Crea un archivo .lrc junto a la canción sin alterar ni incrustar etiquetas dentro del archivo de audio original. Puedes borrarlo desde el panel de letras si difiere de tu versión.'}
                </p>
              </div>

              <div className="settings-action-card">
                <div>
                  <strong>Escanear Biblioteca y Descargar Letras Faltantes (.lrc)</strong>
                  <p style={{ margin: '4px 0 0', fontSize: '12px', color: 'var(--text-dim)' }}>
                    Analiza las canciones de la biblioteca sin letras y consulta LRCLIB para guardar archivos <code>.lrc</code> externos.
                  </p>
                </div>
                <button
                  type="button"
                  className="settings-action-btn primary"
                  onClick={handleBatchDownloadLyrics}
                  disabled={isBatchDownloadingLyrics}
                >
                  {isBatchDownloadingLyrics ? 'Descargando...' : '🔍 Descargar Faltantes'}
                </button>
              </div>

              {batchLyricsResult && (
                <div className="settings-feedback-banner">
                  {batchLyricsResult}
                </div>
              )}
            </div>
          )}

          {/* TAB 5: COMPROBADOR DE SALUD E INTEGRIDAD DE HARD LINKS */}
          {activeTab === 'hardlinks' && (
            <div className="settings-section">
              <div className="settings-hardlinks-header">
                <div>
                  <h4 style={{ margin: 0, fontSize: '14px', fontWeight: '700' }}>
                    Comprobador de Salud e Integridad de Hard Links NTFS
                  </h4>
                  <p style={{ margin: '3px 0 0', fontSize: '12px', color: 'var(--text-dim)' }}>
                    Verifica que todos los archivos en <code>canciones_organizadas</code> compartan el inodo físico exacto con <code>Canciones_reales</code>.
                  </p>
                </div>
                <button
                  type="button"
                  className="settings-action-btn primary"
                  onClick={handleRunHealthCheck}
                  disabled={isCheckingHealth}
                >
                  {isCheckingHealth ? 'Analizando...' : '🛡️ Ejecutar Diagnóstico'}
                </button>
              </div>

              {healthData && (
                <div className="hardlinks-health-results">
                  <div className="health-stats-grid">
                    <div className="health-stat-box">
                      <div className="health-stat-value">{healthData.healthPercentage}%</div>
                      <div className="health-stat-label">Integridad de Inodos</div>
                    </div>
                    <div className="health-stat-box">
                      <div className="health-stat-value">{healthData.totalOrganizedFiles}</div>
                      <div className="health-stat-label">Enlaces en Álbumes</div>
                    </div>
                    <div className="health-stat-box">
                      <div className="health-stat-value">{healthData.totalMasterFiles}</div>
                      <div className="health-stat-label">Archivos Maestros</div>
                    </div>
                    <div className="health-stat-box highlight">
                      <div className="health-stat-value">{healthData.savedSpaceFormatted}</div>
                      <div className="health-stat-label">Espacio Ahorrado en Disco</div>
                    </div>
                  </div>

                  <div className="health-summary-row">
                    <span>✓ Saludables: <strong>{healthData.healthyCount}</strong></span>
                    {healthData.divergentCount > 0 && (
                      <span className="warning">⚠ Divergentes: <strong>{healthData.divergentCount}</strong></span>
                    )}
                    {healthData.unlinkedCount > 0 && (
                      <span className="warning">⚠ Sin Maestro: <strong>{healthData.unlinkedCount}</strong></span>
                    )}
                  </div>

                  {(healthData.divergentCount > 0 || healthData.unlinkedCount > 0) && (
                    <div className="health-repair-box">
                      <div style={{ fontSize: '12px' }}>
                        Se detectaron inodos desincronizados o sin respaldo maestro en <code>Canciones_reales</code>.
                      </div>
                      <button
                        type="button"
                        className="settings-action-btn repair"
                        onClick={handleRepairHardlinks}
                        disabled={isRepairingHealth}
                      >
                        {isRepairingHealth ? 'Reparando...' : '🔧 Auto-reparar y Sincronizar'}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {healthNotice && (
                <div className="settings-feedback-banner">
                  {healthNotice}
                </div>
              )}
            </div>
          )}

          {/* TAB 6: ATAJOS DE TECLADO Y COMANDOS RÁPIDOS */}
          {activeTab === 'shortcuts' && (
            <div className="settings-section">
              <div className="settings-shortcuts-category">
                <h4 className="settings-shortcuts-category-title">🪟 Ventana & Control del Sistema (Globales)</h4>
                <div className="settings-shortcuts-grid">
                  <div className="settings-shortcut-card">
                    <div className="settings-shortcut-info">
                      <div className="settings-shortcut-name">Abrir / Restaurar Ventana Principal</div>
                      <div className="settings-shortcut-desc">Restaura y enfoca la aplicación inmediatamente desde segundo plano o minimizada</div>
                    </div>
                    <div className="settings-shortcut-keys">
                      <kbd className="settings-kbd">Ctrl</kbd>
                      <span>+</span>
                      <kbd className="settings-kbd">Shift</kbd>
                      <span>+</span>
                      <kbd className="settings-kbd">R</kbd>
                    </div>
                  </div>

                  <div className="settings-shortcut-card">
                    <div className="settings-shortcut-info">
                      <div className="settings-shortcut-name">Fijar en Primer Plano (Always on Top)</div>
                      <div className="settings-shortcut-desc">Alterna si el reproductor permanece siempre sobre las demás ventanas abiertas</div>
                    </div>
                    <div className="settings-shortcut-keys">
                      <kbd className="settings-kbd">Ctrl</kbd>
                      <span>+</span>
                      <kbd className="settings-kbd">Shift</kbd>
                      <span>+</span>
                      <kbd className="settings-kbd">F</kbd>
                    </div>
                  </div>

                  <div className="settings-shortcut-card">
                    <div className="settings-shortcut-info">
                      <div className="settings-shortcut-name">Mini Panel Lateral Rápido</div>
                      <div className="settings-shortcut-desc">Muestra u oculta la barra vertical del lateral derecho de tu pantalla</div>
                    </div>
                    <div className="settings-shortcut-keys">
                      <kbd className="settings-kbd">Ctrl</kbd>
                      <span>+</span>
                      <kbd className="settings-kbd">Shift</kbd>
                      <span>+</span>
                      <kbd className="settings-kbd">M</kbd>
                    </div>
                  </div>

                  <div className="settings-shortcut-card">
                    <div className="settings-shortcut-info">
                      <div className="settings-shortcut-name">HUD / Widget Flotante de Juego</div>
                      <div className="settings-shortcut-desc">Activa o esconde la mini cápsula flotante sobre videojuegos a pantalla completa</div>
                    </div>
                    <div className="settings-shortcut-keys">
                      <kbd className="settings-kbd">Ctrl</kbd>
                      <span>+</span>
                      <kbd className="settings-kbd">Alt</kbd>
                      <span>+</span>
                      <kbd className="settings-kbd">H</kbd>
                    </div>
                  </div>
                </div>
              </div>

              <div className="settings-shortcuts-category">
                <h4 className="settings-shortcuts-category-title">🎵 Reproducción & Audio</h4>
                <div className="settings-shortcuts-grid">
                  <div className="settings-shortcut-card">
                    <div className="settings-shortcut-info">
                      <div className="settings-shortcut-name">Reproducir / Pausar</div>
                      <div className="settings-shortcut-desc">Pausa o reanuda la música al instante</div>
                    </div>
                    <div className="settings-shortcut-keys">
                      <kbd className="settings-kbd">Ctrl</kbd>
                      <span>+</span>
                      <kbd className="settings-kbd">Espacio</kbd>
                    </div>
                  </div>

                  <div className="settings-shortcut-card">
                    <div className="settings-shortcut-info">
                      <div className="settings-shortcut-name">Pista Siguiente</div>
                      <div className="settings-shortcut-desc">Avanza a la próxima canción en la cola</div>
                    </div>
                    <div className="settings-shortcut-keys">
                      <kbd className="settings-kbd">Ctrl</kbd>
                      <span>+</span>
                      <kbd className="settings-kbd">→</kbd>
                    </div>
                  </div>

                  <div className="settings-shortcut-card">
                    <div className="settings-shortcut-info">
                      <div className="settings-shortcut-name">Pista Anterior</div>
                      <div className="settings-shortcut-desc">Vuelve a la canción anterior del historial</div>
                    </div>
                    <div className="settings-shortcut-keys">
                      <kbd className="settings-kbd">Ctrl</kbd>
                      <span>+</span>
                      <kbd className="settings-kbd">←</kbd>
                    </div>
                  </div>

                  <div className="settings-shortcut-card">
                    <div className="settings-shortcut-info">
                      <div className="settings-shortcut-name">Subir / Bajar Volumen</div>
                      <div className="settings-shortcut-desc">Ajusta el volumen en pasos de ±5% (o usa la rueda del ratón en el HUD)</div>
                    </div>
                    <div className="settings-shortcut-keys">
                      <kbd className="settings-kbd">Ctrl</kbd>
                      <span>+</span>
                      <kbd className="settings-kbd">↑ / ↓</kbd>
                    </div>
                  </div>
                </div>
              </div>

              <div className="settings-shortcuts-category">
                <h4 className="settings-shortcuts-category-title">⚡ Navegación & Búsqueda</h4>
                <div className="settings-shortcuts-grid">
                  <div className="settings-shortcut-card">
                    <div className="settings-shortcut-info">
                      <div className="settings-shortcut-name">Buscador Global Spotlight</div>
                      <div className="settings-shortcut-desc">Busca cualquier canción, artista o álbum al instante</div>
                    </div>
                    <div className="settings-shortcut-keys">
                      <kbd className="settings-kbd">Ctrl</kbd>
                      <span>+</span>
                      <kbd className="settings-kbd">K</kbd>
                    </div>
                  </div>

                  <div className="settings-shortcut-card">
                    <div className="settings-shortcut-info">
                      <div className="settings-shortcut-name">Descargar / Pegar Enlace (Extractor)</div>
                      <div className="settings-shortcut-desc">Abre el diálogo de descarga rápida con detección de portapapeles</div>
                    </div>
                    <div className="settings-shortcut-keys">
                      <kbd className="settings-kbd">Ctrl</kbd>
                      <span>+</span>
                      <kbd className="settings-kbd">D</kbd>
                    </div>
                  </div>

                  <div className="settings-shortcut-card">
                    <div className="settings-shortcut-info">
                      <div className="settings-shortcut-name">Cerrar Modales / Docks Activos</div>
                      <div className="settings-shortcut-desc">Cierra rápidamente paneles flotantes, dock de letras o ventanas emergentes</div>
                    </div>
                    <div className="settings-shortcut-keys">
                      <kbd className="settings-kbd">Esc</kbd>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="settings-modal-footer">
          <button
            type="button"
            className="track-modal-btn secondary"
            onClick={onClose}
          >
            Cerrar
          </button>
        </div>
      </div>
    </div>
  )
}
