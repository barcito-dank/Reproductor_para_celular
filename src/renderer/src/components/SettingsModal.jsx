import React, { useState, useEffect, useCallback } from 'react'
import { usePlayer, EQ_FREQUENCIES, EQ_PRESETS } from '../context/PlayerContext'
import { triggerHaptic } from './BottomNavBar'

export default function SettingsModal({
  isOpen = true,
  onClose,
  theme,
  onThemeChange,
  inline = false
}) {
  const {
    appSettings,
    updateAppSettings,
    loadLibrary,
    importFilesToVault,
    allTracks = [],
    allAlbums = [],
    eqState,
    setEqBandGain,
    applyEqPreset,
    toggleEqEnabled,
    resetEq
  } = usePlayer()

  const [activeTab, setActiveTab] = useState('appearance') // 'appearance' | 'vault' | 'equalizer' | 'lyrics'

  // Estados de la Bóveda SQLite (checkHardlinksHealth / repairHardlinksIntegrity)
  const [healthData, setHealthData] = useState(null)
  const [isCheckingHealth, setIsCheckingHealth] = useState(false)
  const [isRepairingHealth, setIsRepairingHealth] = useState(false)
  const [repairProgress, setRepairProgress] = useState(null)
  const [healthNotice, setHealthNotice] = useState(null)

  // Estados de descarga masiva de letras (LRCLib)
  const [isBatchDownloadingLyrics, setIsBatchDownloadingLyrics] = useState(false)
  const [batchLyricsProgress, setBatchLyricsProgress] = useState(null)
  const [batchLyricsResult, setBatchLyricsResult] = useState(null)

  const handleRunHealthCheck = useCallback(async () => {
    setIsCheckingHealth(true)
    setHealthNotice(null)
    try {
      const res = await window.electronAPI?.checkHardlinksHealth?.()
      if (res && res.success) {
        setHealthData(res)
      } else {
        setHealthNotice(`⚠ ${res?.error || 'No se pudo completar el diagnóstico de la bóveda.'}`)
      }
    } catch (err) {
      setHealthNotice(`⚠ Error: ${err.message}`)
    } finally {
      setIsCheckingHealth(false)
    }
  }, [])

  // Cargar estadísticas de la bóveda al abrir la pestaña Bóveda
  useEffect(() => {
    if (isOpen && activeTab === 'vault') {
      handleRunHealthCheck()
    }
  }, [isOpen, activeTab, handleRunHealthCheck])

  // Optimizar y limpiar huérfanos en la bóveda SQLite
  const handleOptimizeVault = useCallback(async () => {
    void triggerHaptic()
    setIsRepairingHealth(true)
    setRepairProgress(null)
    setHealthNotice(null)

    const unsubProgress = window.electronAPI?.onRepairHardlinksProgress?.((p) => {
      setRepairProgress(p)
    })

    try {
      const res = await window.electronAPI?.repairHardlinksIntegrity?.()
      if (res && res.success) {
        setHealthData(res)
        setHealthNotice(
          `✓ Bóveda optimizada (${res.repairedCount ?? 0} registros huérfanos o desincronizados limpiados).`
        )
        loadLibrary?.()
      } else {
        setHealthNotice(`⚠ ${res?.error || 'No se pudo optimizar la bóveda.'}`)
      }
    } catch (err) {
      setHealthNotice(`⚠ Error: ${err.message}`)
    } finally {
      unsubProgress?.()
      setIsRepairingHealth(false)
      setRepairProgress(null)
    }
  }, [loadLibrary])

  const handleImportFiles = useCallback(async () => {
    void triggerHaptic()
    const res = await importFilesToVault?.()
    if (res && res.success && res.importedCount > 0) {
      setHealthNotice(`✓ ${res.importedCount} archivo(s) importado(s) a app_vault/tracks/`)
      handleRunHealthCheck()
    }
  }, [importFilesToVault, handleRunHealthCheck])

  // Descarga masiva de letras desde LRCLib
  const handleBatchDownloadLyrics = useCallback(async () => {
    void triggerHaptic()
    setIsBatchDownloadingLyrics(true)
    setBatchLyricsProgress(null)
    setBatchLyricsResult(null)

    const unsubProgress = window.electronAPI?.onBatchLyricsProgress?.((p) => {
      setBatchLyricsProgress(p)
    })

    try {
      const res = await window.electronAPI?.batchDownloadLyrics?.()
      if (res && res.success) {
        setBatchLyricsResult(
          `✓ Escaneo completado: ${res.downloadedCount} letras sincronizadas descargadas de ${res.totalScanned} analizadas.`
        )
        loadLibrary?.()
      } else {
        setBatchLyricsResult(
          `⚠ No se pudieron descargar letras: ${res?.error || 'Error desconocido'}`
        )
      }
    } catch (err) {
      setBatchLyricsResult(`⚠ Error: ${err.message}`)
    } finally {
      unsubProgress?.()
      setIsBatchDownloadingLyrics(false)
      setBatchLyricsProgress(null)
    }
  }, [loadLibrary])

  useEffect(() => {
    if (!isOpen || inline) return
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        onClose?.()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, inline, onClose])

  if (!isOpen) return null

  const formatHz = (freq) => (freq >= 1000 ? `${freq / 1000}k` : `${freq}`)
  const cachedCoversCount = allTracks.filter((t) => Boolean(t.cover)).length
  const batchProgressPercent =
    batchLyricsProgress && batchLyricsProgress.total > 0
      ? Math.round((batchLyricsProgress.current / batchLyricsProgress.total) * 100)
      : 0

  const settingsCard = (
    <div
      className={`settings-modal-box ${inline ? 'settings-inline-box' : ''}`}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="settings-modal-header">
        <div className="settings-modal-header-info">
          <span className="settings-modal-header-icon">⚙️</span>
          <div>
            <h3 className="settings-modal-title">Ajustes Móviles</h3>
            <p className="settings-modal-subtitle">
              Apariencia, Bóveda SQLite, Ecualizador de 10 Bandas y Letras LRCLib
            </p>
          </div>
        </div>
        {!inline && onClose && (
          <button
            type="button"
            className="settings-modal-close-btn"
            onClick={onClose}
            aria-label="Cerrar ajustes"
          >
            ✕
          </button>
        )}
      </div>

      {/* Pestañas de navegación limpias para Móvil */}
      <div className="settings-tabs-bar">
        <button
          type="button"
          className={`settings-tab-btn ${activeTab === 'appearance' ? 'active' : ''}`}
          onClick={() => {
            void triggerHaptic()
            setActiveTab('appearance')
          }}
        >
          🎨 Apariencia
        </button>
        <button
          type="button"
          className={`settings-tab-btn ${activeTab === 'vault' ? 'active' : ''}`}
          onClick={() => {
            void triggerHaptic()
            setActiveTab('vault')
          }}
        >
          🗄️ Bóveda SQLite
        </button>
        <button
          type="button"
          className={`settings-tab-btn ${activeTab === 'equalizer' ? 'active' : ''}`}
          onClick={() => {
            void triggerHaptic()
            setActiveTab('equalizer')
          }}
        >
          🎚️ Ecualizador
        </button>
        <button
          type="button"
          className={`settings-tab-btn ${activeTab === 'lyrics' ? 'active' : ''}`}
          onClick={() => {
            void triggerHaptic()
            setActiveTab('lyrics')
          }}
        >
          🎤 Letras LRCLib
        </button>
      </div>

      <div className="settings-modal-content">
        {/* 1. APARIENCIA Y AUDIO */}
        {activeTab === 'appearance' && (
          <div className="settings-section">
            <div className="settings-item-row">
              <div className="settings-item-info">
                <div className="settings-item-title">Tema Visual</div>
                <div className="settings-item-desc">
                  Alterna entre modo oscuro OLED o modo claro
                </div>
              </div>
              <button
                type="button"
                className="settings-theme-toggle-btn"
                onClick={() => {
                  void triggerHaptic()
                  onThemeChange(theme === 'dark' ? 'light' : 'dark')
                }}
              >
                {theme === 'dark' ? '🌙 Modo Oscuro' : '☀️ Modo Claro'}
              </button>
            </div>

            <div className="settings-item-row">
              <div className="settings-item-info">
                <div className="settings-item-title">
                  Normalización de Volumen (ReplayGain)
                </div>
                <div className="settings-item-desc">
                  Equilibra el volumen entre pistas dinámicamente sin distorsión
                </div>
              </div>
              <button
                type="button"
                className={`settings-switch-control ${appSettings.replayGain ? 'active' : ''}`}
                onClick={() => {
                  void triggerHaptic()
                  updateAppSettings((prev) => ({ replayGain: !prev.replayGain }))
                }}
                aria-pressed={appSettings.replayGain}
              >
                <span className="switch-thumb" />
              </button>
            </div>

            <div className="settings-item-row">
              <div className="settings-item-info">
                <div className="settings-item-title">
                  Transición Suave (Crossfade)
                </div>
                <div className="settings-item-desc">
                  Fundido encadenado suave al cambiar de canción
                </div>
              </div>
              <button
                type="button"
                className={`settings-switch-control ${appSettings.crossfadeEnabled ? 'active' : ''}`}
                onClick={() => {
                  void triggerHaptic()
                  updateAppSettings((prev) => ({ crossfadeEnabled: !prev.crossfadeEnabled }))
                }}
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

        {/* 2. BÓVEDA Y ALMACENAMIENTO (SQLITE VAULT) */}
        {activeTab === 'vault' && (
          <div className="settings-section">
            <div className="settings-hardlinks-header">
              <div>
                <h4 style={{ margin: 0, fontSize: '15px', fontWeight: '700' }}>
                  Bóveda y Almacenamiento (SQLite Vault)
                </h4>
                <p style={{ margin: '4px 0 0', fontSize: '12px', color: 'var(--text-dim)' }}>
                  Tus canciones se guardan una sola vez en <code>app_vault/tracks/</code> y pueden pertenecer a múltiples álbumes sin duplicar espacio.
                </p>
              </div>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className="settings-action-btn primary"
                  onClick={handleImportFiles}
                >
                  📥 + Importar Archivos
                </button>
                <button
                  type="button"
                  className="settings-action-btn"
                  onClick={handleRunHealthCheck}
                  disabled={isCheckingHealth}
                >
                  {isCheckingHealth ? 'Verificando...' : '🔄 Actualizar'}
                </button>
              </div>
            </div>

            <div className="hardlinks-health-results">
              <div className="health-stats-grid">
                <div className="health-stat-box">
                  <div className="health-stat-value">
                    {healthData ? healthData.totalMasterFiles : allTracks.length}
                  </div>
                  <div className="health-stat-label">Pistas Únicas en app_vault</div>
                </div>
                <div className="health-stat-box">
                  <div className="health-stat-value">
                    {healthData ? healthData.totalOrganizedFiles : allAlbums.length}
                  </div>
                  <div className="health-stat-label">Vínculos Virtuales en Álbumes</div>
                </div>
                <div className="health-stat-box">
                  <div className="health-stat-value">{cachedCoversCount}</div>
                  <div className="health-stat-label">Carátulas en Caché</div>
                </div>
                <div className="health-stat-box highlight">
                  <div className="health-stat-value">
                    {healthData?.savedSpaceFormatted || '0 B'}
                  </div>
                  <div className="health-stat-label">Espacio Ahorrado (M:N)</div>
                </div>
              </div>

              {healthData && (
                <div className="health-summary-row">
                  <span>
                    ✓ Salud de la Bóveda: <strong>{healthData.healthPercentage}%</strong>
                  </span>
                  <span>
                    Vínculos activos: <strong>{healthData.healthyCount}</strong>
                  </span>
                  {(healthData.divergentCount > 0 || healthData.unlinkedCount > 0) && (
                    <span className="warning">
                      ⚠ Huérfanos detectados:{' '}
                      <strong>
                        {(healthData.divergentCount || 0) + (healthData.unlinkedCount || 0)}
                      </strong>
                    </span>
                  )}
                </div>
              )}

              <div className="settings-action-card" style={{ marginTop: '12px' }}>
                <div>
                  <strong>Optimizar y Limpiar Huérfanos</strong>
                  <p style={{ margin: '4px 0 0', fontSize: '12px', color: 'var(--text-dim)' }}>
                    Audita las tablas <code>tracks</code> y <code>album_tracks</code>, elimina vínculos rotos y libera archivos sin referencias en <code>app_vault</code>.
                  </p>
                </div>
                <button
                  type="button"
                  className="settings-action-btn primary"
                  onClick={handleOptimizeVault}
                  disabled={isRepairingHealth}
                >
                  {isRepairingHealth
                    ? repairProgress
                      ? `Optimizando (${repairProgress.current}/${repairProgress.total})...`
                      : 'Optimizando...'
                    : '🧹 Optimizar y Limpiar Huérfanos'}
                </button>
              </div>
            </div>

            {healthNotice && (
              <div className="settings-feedback-banner">{healthNotice}</div>
            )}
          </div>
        )}

        {/* 3. ECUALIZADOR DE 10 BANDAS */}
        {activeTab === 'equalizer' && eqState && (
          <div className="settings-section">
            <div className="settings-item-row">
              <div className="settings-item-info">
                <div className="settings-item-title">Ecualizador de 10 Bandas</div>
                <div className="settings-item-desc">
                  Ajusta frecuencias en tiempo real ({eqState.preset || 'Personalizado'})
                </div>
              </div>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <button
                  type="button"
                  className={`eq-power-btn ${eqState.enabled ? 'active' : ''}`}
                  onClick={() => {
                    void triggerHaptic()
                    toggleEqEnabled()
                  }}
                >
                  <span className="eq-power-indicator" />
                  <span>{eqState.enabled ? 'Activado' : 'Desactivado'}</span>
                </button>
                <button
                  type="button"
                  className="eq-reset-btn"
                  onClick={() => {
                    void triggerHaptic()
                    resetEq()
                  }}
                >
                  Restablecer
                </button>
              </div>
            </div>

            <div className="eq-presets-bar">
              <span className="eq-presets-label">Presets:</span>
              <div className="eq-presets-scroll">
                {Object.keys(EQ_PRESETS).map((pName) => (
                  <button
                    key={pName}
                    type="button"
                    className={`eq-preset-pill ${eqState.preset === pName ? 'active' : ''}`}
                    onClick={() => {
                      void triggerHaptic()
                      applyEqPreset(pName)
                    }}
                  >
                    {pName}
                  </button>
                ))}
              </div>
            </div>

            <div className={`eq-sliders-container ${!eqState.enabled ? 'eq-disabled' : ''}`}>
              <div className="eq-scale-labels">
                <span>+12 dB</span>
                <span>0 dB</span>
                <span>-12 dB</span>
              </div>

              <div className="eq-sliders-track-area">
                <div className="eq-center-zero-line" />
                {EQ_FREQUENCIES.map((freq, i) => {
                  const gain = eqState.gains[i] ?? 0
                  return (
                    <div key={freq} className="eq-band-col">
                      <span className="eq-band-db">
                        {gain > 0 ? `+${gain.toFixed(0)}` : gain.toFixed(0)}
                      </span>
                      <div className="eq-slider-wrapper">
                        <input
                          type="range"
                          min="-12"
                          max="12"
                          step="0.5"
                          value={gain}
                          disabled={!eqState.enabled}
                          onChange={(e) => setEqBandGain(i, parseFloat(e.target.value))}
                          className="eq-vertical-slider"
                        />
                      </div>
                      <span className="eq-band-freq">{formatHz(freq)}</span>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        )}

        {/* 4. LETRAS (LRCLIB) */}
        {activeTab === 'lyrics' && (
          <div className="settings-section">
            <div className="settings-item-row">
              <div className="settings-item-info">
                <div className="settings-item-title">
                  Búsqueda Automática de Letras (.lrc)
                </div>
                <div className="settings-item-desc">
                  Consulta LRCLib automáticamente al reproducir pistas sin archivo <code>.lrc</code> local
                </div>
              </div>
              <button
                type="button"
                className={`settings-switch-control ${appSettings.autoLyrics ? 'active' : ''}`}
                onClick={() => {
                  void triggerHaptic()
                  updateAppSettings((prev) => ({ autoLyrics: !prev.autoLyrics }))
                }}
                aria-pressed={appSettings.autoLyrics}
              >
                <span className="switch-thumb" />
              </button>
            </div>

            <div className="settings-sub-options column-mode">
              <span className="settings-sub-label">Modo de letras descargadas:</span>
              <div className="settings-pill-selector full-width">
                <button
                  type="button"
                  className={`pill-btn flex-1 ${(appSettings.lyricsMode || 'temporary') === 'temporary' ? 'selected' : ''}`}
                  onClick={() => updateAppSettings({ lyricsMode: 'temporary' })}
                >
                  ⚡ Temporal en Memoria
                </button>
                <button
                  type="button"
                  className={`pill-btn flex-1 ${appSettings.lyricsMode === 'permanent' ? 'selected' : ''}`}
                  onClick={() => updateAppSettings({ lyricsMode: 'permanent' })}
                >
                  💾 Guardar en app_vault/lyrics
                </button>
              </div>
            </div>

            <div className="settings-action-card">
              <div>
                <strong>Descarga Masiva de Letras (LRCLib)</strong>
                <p style={{ margin: '4px 0 0', fontSize: '12px', color: 'var(--text-dim)' }}>
                  Escanea todas las canciones de la bóveda sin letra y descarga sus archivos <code>.lrc</code> sincronizados automáticamente.
                </p>
              </div>
              <button
                type="button"
                className="settings-action-btn primary"
                onClick={handleBatchDownloadLyrics}
                disabled={isBatchDownloadingLyrics}
              >
                {isBatchDownloadingLyrics
                  ? batchLyricsProgress
                    ? `Descargando (${batchLyricsProgress.current}/${batchLyricsProgress.total})...`
                    : 'Descargando...'
                  : '🔍 Descargar Letras Faltantes'}
              </button>
            </div>

            {batchLyricsProgress && isBatchDownloadingLyrics && (
              <div className="settings-progress-box">
                <div className="settings-progress-bar-track">
                  <div
                    className="settings-progress-bar-fill"
                    style={{ width: `${batchProgressPercent}%` }}
                  />
                </div>
                <div className="settings-progress-text">
                  Analizando {batchLyricsProgress.current} de {batchLyricsProgress.total} pistas ({batchLyricsProgress.downloadedCount} letras guardadas)
                </div>
              </div>
            )}

            {batchLyricsResult && (
              <div className="settings-feedback-banner">{batchLyricsResult}</div>
            )}
          </div>
        )}
      </div>
    </div>
  )

  if (inline) {
    return <div className="settings-inline-container">{settingsCard}</div>
  }

  return (
    <div
      className="track-modal-backdrop settings-modal-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      {settingsCard}
    </div>
  )
}
