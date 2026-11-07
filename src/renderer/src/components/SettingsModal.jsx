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

  // Estados de Atajos de Teclado configurables
  const [hotkeysMap, setHotkeysMap] = useState({})
  const [editingAction, setEditingAction] = useState(null)
  const [hotkeyFeedback, setHotkeyFeedback] = useState(null)

  const refreshHotkeys = useCallback(() => {
    if (window.electronAPI?.getHotkeysConfig) {
      window.electronAPI.getHotkeysConfig().then((cfg) => {
        if (cfg) setHotkeysMap(cfg)
      }).catch(console.error)
    }
  }, [])

  useEffect(() => {
    if (isOpen && activeTab === 'shortcuts') {
      refreshHotkeys()
    }
  }, [isOpen, activeTab, refreshHotkeys])

  useEffect(() => {
    if (!editingAction) return

    const handleCaptureKey = (e) => {
      e.preventDefault()
      e.stopPropagation()

      if (e.key === 'Escape') {
        setEditingAction(null)
        return
      }

      if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) {
        return
      }

      const parts = []
      if (e.ctrlKey) parts.push('Ctrl')
      if (e.altKey) parts.push('Alt')
      if (e.shiftKey) parts.push('Shift')
      if (e.metaKey) parts.push('Super')

      let keyName = e.key
      if (keyName === ' ') keyName = 'Space'
      else if (keyName === 'ArrowUp') keyName = 'Up'
      else if (keyName === 'ArrowDown') keyName = 'Down'
      else if (keyName === 'ArrowLeft') keyName = 'Left'
      else if (keyName === 'ArrowRight') keyName = 'Right'
      else if (keyName.length === 1) keyName = keyName.toUpperCase()

      const isSpecialSingle = /^F\d{1,2}$/i.test(keyName) || /^Media/i.test(keyName)
      if (parts.length === 0 && !isSpecialSingle) {
        setHotkeyFeedback({ error: 'Usa al menos un modificador (Ctrl, Alt o Shift) + tecla' })
        setTimeout(() => setHotkeyFeedback(null), 2500)
        return
      }

      parts.push(keyName)
      const accelerator = parts.join('+')

      window.electronAPI?.updateHotkey?.({ action: editingAction, accelerator })
        .then((res) => {
          if (res?.success) {
            setHotkeysMap(res.hotkeys || {})
            setHotkeyFeedback({ success: `Atajo actualizado: ${accelerator}` })
            setTimeout(() => setHotkeyFeedback(null), 2500)
          } else {
            setHotkeyFeedback({ error: res?.error || 'No se pudo registrar el atajo' })
            setTimeout(() => setHotkeyFeedback(null), 3000)
          }
        })
        .catch((err) => {
          setHotkeyFeedback({ error: err.message })
          setTimeout(() => setHotkeyFeedback(null), 3000)
        })
        .finally(() => {
          setEditingAction(null)
        })
    }

    window.addEventListener('keydown', handleCaptureKey, true)
    return () => window.removeEventListener('keydown', handleCaptureKey, true)
  }, [editingAction])

  const handleResetAllHotkeys = async () => {
    if (!window.electronAPI?.resetHotkeys) return
    const res = await window.electronAPI.resetHotkeys()
    if (res?.success) {
      setHotkeysMap(res.hotkeys || {})
      setHotkeyFeedback({ success: 'Atajos restablecidos a los valores por defecto' })
      setTimeout(() => setHotkeyFeedback(null), 2500)
    }
  }

  const handleResetSingleHotkey = async (action, defaultShortcut) => {
    if (!window.electronAPI?.updateHotkey || !defaultShortcut) return
    const res = await window.electronAPI.updateHotkey({ action, accelerator: defaultShortcut })
    if (res?.success) {
      setHotkeysMap(res.hotkeys || {})
      setHotkeyFeedback({ success: `Atajo restablecido: ${defaultShortcut}` })
      setTimeout(() => setHotkeyFeedback(null), 2500)
    }
  }

  const renderShortcutKeys = (accelerator) => {
    if (!accelerator) return null
    const parts = accelerator.split('+').map((p) => p.trim())
    return (
      <div className="settings-shortcut-keys">
        {parts.map((p, idx) => (
          <React.Fragment key={`${p}-${idx}`}>
            {idx > 0 && <span>+</span>}
            <kbd className="settings-kbd">
              {p === 'Space' ? 'Espacio' : p === 'Up' ? '↑' : p === 'Down' ? '↓' : p === 'Left' ? '←' : p === 'Right' ? '→' : p}
            </kbd>
          </React.Fragment>
        ))}
      </div>
    )
  }

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
        <div
          className="settings-tabs-bar"
          onWheel={(e) => {
            if (e.deltaY !== 0) {
              e.currentTarget.scrollLeft += e.deltaY
            }
          }}
        >
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
              <div className="settings-shortcuts-top-bar">
                <div className="settings-shortcuts-intro">
                  Personaliza los atajos globales de Windows para controlar tu música mientras juegas o trabajas. Haz clic en ✏️ para reasignar cualquier comando.
                </div>
                <button
                  type="button"
                  className="settings-shortcut-reset-all-btn"
                  onClick={handleResetAllHotkeys}
                  title="Restablecer todos los comandos a sus combinaciones por defecto"
                >
                  ↺ Restablecer por defecto
                </button>
              </div>

              {hotkeyFeedback && (
                <div className={`settings-shortcut-feedback ${hotkeyFeedback.success ? 'success' : 'error'}`}>
                  {hotkeyFeedback.success || hotkeyFeedback.error}
                </div>
              )}

              <div className="settings-shortcuts-category">
                <h4 className="settings-shortcuts-category-title">🪟 Ventana & Control del Sistema (Globales)</h4>
                <div className="settings-shortcuts-grid">
                  {[
                    { key: 'restoreMainWindow', defaultTitle: 'Abrir / Restaurar Ventana Principal', defaultDesc: 'Restaura y enfoca la aplicación inmediatamente desde segundo plano o minimizada', defaultKey: 'Ctrl+Shift+R' },
                    { key: 'toggleAlwaysOnTop', defaultTitle: 'Fijar en Primer Plano (Always on Top)', defaultDesc: 'Alterna si el reproductor permanece siempre sobre las demás ventanas abiertas', defaultKey: 'Ctrl+Shift+F' },
                    { key: 'togglePanel', defaultTitle: 'Mini Panel Lateral Rápido', defaultDesc: 'Muestra u oculta la barra vertical del lateral derecho de tu pantalla', defaultKey: 'Ctrl+Shift+M' },
                    { key: 'toggleOverlay', defaultTitle: 'HUD / Widget Flotante de Juego', defaultDesc: 'Activa o esconde la mini cápsula flotante sobre videojuegos a pantalla completa', defaultKey: 'Ctrl+Alt+H' }
                  ].map((item) => {
                    const info = hotkeysMap[item.key] || {}
                    const shortcut = info.shortcut || item.defaultKey
                    const isEditing = editingAction === item.key
                    const isCustom = shortcut !== item.defaultKey
                    return (
                      <div className="settings-shortcut-card" key={item.key}>
                        <div className="settings-shortcut-info">
                          <div className="settings-shortcut-name">{info.title || item.defaultTitle}</div>
                          <div className="settings-shortcut-desc">{info.desc || item.defaultDesc}</div>
                        </div>
                        <div className="settings-shortcut-actions">
                          {isEditing ? (
                            <button
                              type="button"
                              className="settings-shortcut-btn recording"
                              onClick={() => setEditingAction(null)}
                              title="Presiona la nueva combinación de teclas en tu teclado (Esc para cancelar)"
                            >
                              Presiona teclas... (Esc)
                            </button>
                          ) : (
                            <>
                              {renderShortcutKeys(shortcut)}
                              <button
                                type="button"
                                className="settings-shortcut-btn"
                                onClick={() => setEditingAction(item.key)}
                                title="Cambiar combinación de teclas"
                              >
                                ✏️
                              </button>
                              {isCustom && (
                                <button
                                  type="button"
                                  className="settings-shortcut-btn"
                                  onClick={() => handleResetSingleHotkey(item.key, item.defaultKey)}
                                  title="Restablecer a combinación por defecto"
                                >
                                  ↺
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>

              <div className="settings-shortcuts-category">
                <h4 className="settings-shortcuts-category-title">🎵 Reproducción & Audio (Globales)</h4>
                <div className="settings-shortcuts-grid">
                  {[
                    { key: 'playPause', defaultTitle: 'Reproducir / Pausar', defaultDesc: 'Pausa o reanuda la música al instante', defaultKey: 'Ctrl+Space' },
                    { key: 'next', defaultTitle: 'Pista Siguiente', defaultDesc: 'Avanza a la próxima canción en la cola', defaultKey: 'Ctrl+Right' },
                    { key: 'previous', defaultTitle: 'Pista Anterior', defaultDesc: 'Vuelve a la canción anterior del historial', defaultKey: 'Ctrl+Left' },
                    { key: 'volumeUp', defaultTitle: 'Subir Volumen (+5%)', defaultDesc: 'Aumenta el volumen un 5% de forma global', defaultKey: 'Ctrl+Up' },
                    { key: 'volumeDown', defaultTitle: 'Bajar Volumen (-5%)', defaultDesc: 'Disminuye el volumen un 5% de forma global', defaultKey: 'Ctrl+Down' }
                  ].map((item) => {
                    const info = hotkeysMap[item.key] || {}
                    const shortcut = info.shortcut || item.defaultKey
                    const isEditing = editingAction === item.key
                    const isCustom = shortcut !== item.defaultKey
                    return (
                      <div className="settings-shortcut-card" key={item.key}>
                        <div className="settings-shortcut-info">
                          <div className="settings-shortcut-name">{info.title || item.defaultTitle}</div>
                          <div className="settings-shortcut-desc">{info.desc || item.defaultDesc}</div>
                        </div>
                        <div className="settings-shortcut-actions">
                          {isEditing ? (
                            <button
                              type="button"
                              className="settings-shortcut-btn recording"
                              onClick={() => setEditingAction(null)}
                              title="Presiona la nueva combinación de teclas en tu teclado (Esc para cancelar)"
                            >
                              Presiona teclas... (Esc)
                            </button>
                          ) : (
                            <>
                              {renderShortcutKeys(shortcut)}
                              <button
                                type="button"
                                className="settings-shortcut-btn"
                                onClick={() => setEditingAction(item.key)}
                                title="Cambiar combinación de teclas"
                              >
                                ✏️
                              </button>
                              {isCustom && (
                                <button
                                  type="button"
                                  className="settings-shortcut-btn"
                                  onClick={() => handleResetSingleHotkey(item.key, item.defaultKey)}
                                  title="Restablecer a combinación por defecto"
                                >
                                  ↺
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>

              <div className="settings-shortcuts-category">
                <h4 className="settings-shortcuts-category-title">⚡ Navegación & Búsqueda (En Ventana)</h4>
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
