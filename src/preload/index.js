import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  // Escaneo de biblioteca
  scanMusic: (directory) => ipcRenderer.invoke('scan-music', directory),
  selectMusicDirectory: () => ipcRenderer.invoke('select-music-directory'),

  // Controles de ventana
  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  maximizeWindow: () => ipcRenderer.send('window-maximize'),
  closeWindow: () => ipcRenderer.send('window-close'),
  toggleSidePanel: () => ipcRenderer.send('toggle-side-panel'),
  restoreMainWindow: () => ipcRenderer.send('restore-main-window'),
  toggleMainAlwaysOnTop: () => ipcRenderer.invoke('toggle-main-always-on-top'),
  getMainAlwaysOnTop: () => ipcRenderer.invoke('get-main-always-on-top'),

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
