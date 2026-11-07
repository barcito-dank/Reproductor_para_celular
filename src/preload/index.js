import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  // Escaneo y gestión de archivos de biblioteca
  scanMusic: (directory) => ipcRenderer.invoke('scan-music', directory),
  selectMusicDirectory: () => ipcRenderer.invoke('select-music-directory'),
  showItemInFolder: (filePath) => ipcRenderer.send('show-item-in-folder', filePath),
  addTrackToAlbums: (payload) => ipcRenderer.invoke('add-track-to-albums', payload),
  deleteTrackFile: (payload) => ipcRenderer.invoke('delete-track-file', payload),
  getTrackProperties: (filePath) => ipcRenderer.invoke('get-track-properties', filePath),
  updateTrackTags: (payload) => ipcRenderer.invoke('update-track-tags', payload),
  getTrackLyrics: (filePath) => ipcRenderer.invoke('get-track-lyrics', filePath),
  onLibraryUpdated: (callback) => {
    const handler = (_, library) => callback(library)
    ipcRenderer.on('library-updated', handler)
    return () => ipcRenderer.removeListener('library-updated', handler)
  },
  createAlbum: (payload) => ipcRenderer.invoke('create-album', payload),
  createFolder: (payload) => ipcRenderer.invoke('create-folder', payload),
  moveAlbumFolder: (payload) => ipcRenderer.invoke('move-album-folder', payload),
  renameAlbumFolder: (payload) => ipcRenderer.invoke('rename-album-folder', payload),
  deleteAlbumFolder: (payload) => ipcRenderer.invoke('delete-album-folder', payload),

  // Controles de ventana
  notifyRendererReady: () => ipcRenderer.send('renderer-ready'),
  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  maximizeWindow: () => ipcRenderer.send('window-maximize'),
  closeWindow: () => ipcRenderer.send('window-close'),
  toggleSidePanel: () => ipcRenderer.send('toggle-side-panel'),
  restoreMainWindow: () => ipcRenderer.send('restore-main-window'),
  toggleMainAlwaysOnTop: () => ipcRenderer.invoke('toggle-main-always-on-top'),
  getMainAlwaysOnTop: () => ipcRenderer.invoke('get-main-always-on-top'),
  setMainAlwaysOnTop: (enabled) => ipcRenderer.invoke('set-main-always-on-top', enabled),

  // Ajustes avanzados, Extractor e Integraciones
  launchExtractor: (payload) => ipcRenderer.invoke('launch-extractor', payload),
  checkHardlinksHealth: () => ipcRenderer.invoke('check-hardlinks-health'),
  repairHardlinksIntegrity: () => ipcRenderer.invoke('repair-hardlinks-integrity'),
  fetchTrackLyricsOnline: (payload) => ipcRenderer.invoke('fetch-track-lyrics-online', payload),
  saveTrackLrc: (payload) => ipcRenderer.invoke('save-track-lrc', payload),
  deleteTrackLrc: (payload) => ipcRenderer.invoke('delete-track-lrc', payload),
  batchDownloadLyrics: () => ipcRenderer.invoke('batch-download-lyrics'),
  getHotkeysConfig: () => ipcRenderer.invoke('get-hotkeys-config'),
  updateHotkey: (payload) => ipcRenderer.invoke('update-hotkey', payload),
  resetHotkeys: () => ipcRenderer.invoke('reset-hotkeys'),
  setDiscordRpc: (enabled) => ipcRenderer.invoke('set-discord-rpc', enabled),
  getDiscordRpcStatus: () => ipcRenderer.invoke('get-discord-rpc-status'),
  toggleGameOverlay: (enabled) => ipcRenderer.invoke('toggle-game-overlay', enabled),
  getGameOverlayStatus: () => ipcRenderer.invoke('get-game-overlay-status'),
  onGameOverlayStatusChanged: (callback) => {
    const handler = (_, active) => callback(Boolean(active))
    ipcRenderer.on('game-overlay-status-changed', handler)
    return () => ipcRenderer.removeListener('game-overlay-status-changed', handler)
  },
  onMainWindowVisibility: (callback) => {
    const handler = (_, visible) => callback(visible)
    ipcRenderer.on('main-window-visibility', handler)
    return () => ipcRenderer.removeListener('main-window-visibility', handler)
  },

  // Estado del reproductor (sync entre ventanas)
  sendPlayerState: (state) => ipcRenderer.send('player-state-update', state),
  sendPlayerTime: (time) => ipcRenderer.send('player-time-update', time),
  sendPlayerCommand: (command) => ipcRenderer.send('player-command', command),
  onPlayerTimeSync: (callback) => {
    const handler = (_, time) => callback(time)
    ipcRenderer.on('player-time-sync', handler)
    return () => ipcRenderer.removeListener('player-time-sync', handler)
  },

  // Panel lateral & Configuraciones
  setSidePanelMode: (mode) => ipcRenderer.send('set-side-panel-mode', mode),
  updatePanelSettings: (settings) => ipcRenderer.send('update-panel-settings', settings),
  getPanelSettings: () => ipcRenderer.invoke('get-panel-settings'),
  onPanelSettingsUpdated: (callback) => {
    const handler = (_, settings) => callback(settings)
    ipcRenderer.on('panel-settings-updated', handler)
    return () => ipcRenderer.removeListener('panel-settings-updated', handler)
  },

  onSidePanelMode: (callback) => {
    const handler = (_, mode) => callback(mode)
    ipcRenderer.on('side-panel-mode-changed', handler)
    return () => ipcRenderer.removeListener('side-panel-mode-changed', handler)
  },
  onRequestCollapse: (callback) => {
    const handler = () => callback()
    ipcRenderer.on('side-panel-request-collapse', handler)
    return () => ipcRenderer.removeListener('side-panel-request-collapse', handler)
  },
  onMarkerVisibility: (callback) => {
    const handler = (_, visible) => callback(visible)
    ipcRenderer.on('marker-visibility', handler)
    return () => ipcRenderer.removeListener('marker-visibility', handler)
  },

  onAlwaysOnTopStatusChanged: (callback) => {
    const handler = (_, status) => callback(status)
    ipcRenderer.on('always-on-top-status-changed', handler)
    return () => ipcRenderer.removeListener('always-on-top-status-changed', handler)
  },

  // Listeners & State
  getInitialPlayerState: () => ipcRenderer.invoke('get-initial-player-state'),
  onPlayerStateSync: (callback) => {
    const handler = (_, state) => callback(state)
    ipcRenderer.on('player-state-sync', handler)
    return () => ipcRenderer.removeListener('player-state-sync', handler)
  },
  onPlayerCommand: (callback) => {
    const handler = (_, command) => callback(command)
    ipcRenderer.on('player-command', handler)
    return () => ipcRenderer.removeListener('player-command', handler)
  },

  showTrackNotification: (track) => ipcRenderer.send('show-track-notification', track),
  onToastNotification: (callback) => {
    const handler = (_, track) => callback(track)
    ipcRenderer.on('show-toast-notification', handler)
    return () => ipcRenderer.removeListener('show-toast-notification', handler)
  },
  onHideToastNotification: (callback) => {
    const handler = () => callback()
    ipcRenderer.on('hide-toast-notification', handler)
    return () => ipcRenderer.removeListener('hide-toast-notification', handler)
  }
})
