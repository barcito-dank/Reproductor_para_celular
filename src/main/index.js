import { app, BrowserWindow, dialog, ipcMain, screen, globalShortcut } from 'electron'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { scanMusicDirectory } from './scanner'
import { registerHotkeys, unregisterHotkeys, HOTKEY_CONFIG } from './hotkeys'

let mainWindow = null
let sidePanel = null
let notificationWindow = null
let isSidePanelExpanded = false
let isMarkerShowing = false
let isNotifLoaded = false
let edgeCheckTimeout = null
let hideMarkerTimeout = null
let markerAnimationTimeout = null
let notifTimeout = null
let notifHideTimeout = null
let lastTrackId = null
let lastPlayerState = null
let lastPlaylist = []

// Opciones de configuración de la barra lateral
let panelSettings = {
  pinned: false,    // "mantenerla siempre visible"
  autoHide: true    // "ocultar la barra lateral en caso de tocar otra cosa (blur)"
}

const DRAWER_WIDTH = 340
const MARKER_TAB_WIDTH = 36
const GLOW_BUFFER = 12
const TOTAL_EXPANDED_WIDTH = DRAWER_WIDTH + MARKER_TAB_WIDTH + GLOW_BUFFER // 388px (cajón + marcador + margen para resplandor)
const SMALL_MARKER_WIN_WIDTH = MARKER_TAB_WIDTH + GLOW_BUFFER // 48px
const SMALL_MARKER_WIN_HEIGHT = 86
const NOTIF_WIDTH = 380
const NOTIF_HEIGHT = 74

function getPreloadPath() {
  const mjs = path.join(__dirname, '../preload/index.mjs')
  if (fs.existsSync(mjs)) return mjs
  return path.join(__dirname, '../preload/index.js')
}

function getAppIconPath() {
  const p1 = path.join(__dirname, '../../resources/icon.png')
  if (fs.existsSync(p1)) return p1
  const p2 = path.join(process.resourcesPath, 'icon.png')
  if (fs.existsSync(p2)) return p2
  return undefined
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    backgroundColor: '#0f0f13',
    titleBarStyle: 'hidden',
    icon: getAppIconPath(),
    webPreferences: {
      preload: getPreloadPath(),
      sandbox: false,
      webSecurity: false,
      backgroundThrottling: false // No pausar ni reducir rendimiento cuando se juega (ej. LoL)
    }
  })

  mainWindow.webContents.on('console-message', (_, level, message) => {
    console.log(`[Renderer] ${message}`)
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('minimize', () => {
    setSidePanelBounds('expanded')
  })

  mainWindow.on('restore', () => {
    if (panelSettings.autoHide && !panelSettings.pinned) {
      setSidePanelBounds('collapsed')
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
    if (sidePanel) {
      sidePanel.close()
      sidePanel = null
    }
    if (notificationWindow) {
      notificationWindow.close()
      notificationWindow = null
    }
  })
}

function createSidePanel() {
  const primaryDisplay = screen.getPrimaryDisplay()
  const { x: dispX, y: dispY, width: screenWidth, height: screenHeight } = primaryDisplay.bounds
  const markerY = dispY + Math.floor(screenHeight * 0.20)

  sidePanel = new BrowserWindow({
    width: SMALL_MARKER_WIN_WIDTH,
    height: SMALL_MARKER_WIN_HEIGHT,
    x: dispX + screenWidth - SMALL_MARKER_WIN_WIDTH,
    y: markerY,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    focusable: true,
    webPreferences: {
      preload: getPreloadPath(),
      sandbox: false,
      webSecurity: false,
      backgroundThrottling: true
    }
  })

  // Prioridad máxima sobre juegos a pantalla completa o sin bordes (League of Legends)
  sidePanel.setAlwaysOnTop(true, 'screen-saver', 1)
  sidePanel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  if (process.env['ELECTRON_RENDERER_URL']) {
    sidePanel.loadURL(process.env['ELECTRON_RENDERER_URL'] + '#/mini')
  } else {
    sidePanel.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: '/mini' })
  }

  // Ocultación automática al tocar otra cosa que no sea la aplicación (blur)
  sidePanel.on('blur', () => {
    if (isSidePanelExpanded && panelSettings.autoHide && !panelSettings.pinned) {
      sidePanel.webContents.send('side-panel-request-collapse')
    }
  })

  sidePanel.on('closed', () => {
    sidePanel = null
    isSidePanelExpanded = false
    isMarkerShowing = false
  })
}

/**
 * Muestra el marcador chico situado en la parte superior derecha (~20% del alto)
 * con prioridad máxima por encima de cualquier juego a pantalla completa sin quitarle el foco
 */
function showMarkerWindow(dispX, screenWidth, markerY) {
  if (!sidePanel || sidePanel.isDestroyed() || isSidePanelExpanded) return

  sidePanel.setBounds({
    x: dispX + screenWidth - SMALL_MARKER_WIN_WIDTH,
    y: markerY,
    width: SMALL_MARKER_WIN_WIDTH,
    height: SMALL_MARKER_WIN_HEIGHT
  })

  // Reforzar prioridad 'screen-saver' para superponerse a juegos como LoL
  sidePanel.setAlwaysOnTop(true, 'screen-saver', 1)
  sidePanel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  sidePanel.showInactive()
  sidePanel.moveTop()

  if (!isMarkerShowing) {
    sidePanel.webContents.send('side-panel-mode-changed', 'marker')
    isMarkerShowing = true
  }
}

/**
 * Oculta el marcador chico cuando el cursor se aleja con animación rápida de salida
 */
function hideMarkerWindow() {
  if (!sidePanel || sidePanel.isDestroyed() || isSidePanelExpanded) return

  if (isMarkerShowing) {
    sidePanel.webContents.send('side-panel-mode-changed', 'hiding-marker')
    if (markerAnimationTimeout) clearTimeout(markerAnimationTimeout)
    markerAnimationTimeout = setTimeout(() => {
      if (!isSidePanelExpanded && !isMarkerShowing && sidePanel && !sidePanel.isDestroyed()) {
        sidePanel.hide()
      }
      markerAnimationTimeout = null
    }, 180)
    isMarkerShowing = false
  }
}

function createNotificationWindow() {
  const { x: dispX, y: dispY, width: screenWidth } = screen.getPrimaryDisplay().bounds
  const notifX = Math.round(dispX + (screenWidth - NOTIF_WIDTH) / 2)

  notificationWindow = new BrowserWindow({
    width: NOTIF_WIDTH,
    height: NOTIF_HEIGHT,
    x: notifX,
    y: dispY + 16,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    focusable: false,
    webPreferences: {
      preload: getPreloadPath(),
      sandbox: false,
      webSecurity: false,
      backgroundThrottling: true
    }
  })

  notificationWindow.setAlwaysOnTop(true, 'screen-saver', 0)
  notificationWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  notificationWindow.setIgnoreMouseEvents(true, { forward: true })
  notificationWindow.webContents.on('did-finish-load', () => {
    isNotifLoaded = true
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    notificationWindow.loadURL(process.env['ELECTRON_RENDERER_URL'] + '#/notification')
  } else {
    notificationWindow.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: '/notification' })
  }

  notificationWindow.on('closed', () => {
    notificationWindow = null
    isNotifLoaded = false
  })
}

function showTrackNotification(track) {
  if (!track || !track.title) return

  if (!notificationWindow || notificationWindow.isDestroyed()) {
    createNotificationWindow()
  }

  if (notifTimeout) clearTimeout(notifTimeout)
  if (notifHideTimeout) {
    clearTimeout(notifHideTimeout)
    notifHideTimeout = null
  }

  const point = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(point) || screen.getPrimaryDisplay()
  const { x: dispX, y: dispY, width: screenWidth } = display.bounds
  const notifX = Math.round(dispX + (screenWidth - NOTIF_WIDTH) / 2)

  notificationWindow.setBounds({
    x: notifX,
    y: dispY + 16,
    width: NOTIF_WIDTH,
    height: NOTIF_HEIGHT
  })
  notificationWindow.setAlwaysOnTop(true, 'screen-saver', 0)
  notificationWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  notificationWindow.setIgnoreMouseEvents(true, { forward: true })
  notificationWindow.showInactive()

  // Mantener el orden Z del marcador tras mostrar el globo en Windows.
  if (sidePanel && !sidePanel.isDestroyed() && (isSidePanelExpanded || isMarkerShowing)) {
  sidePanel.setAlwaysOnTop(true, 'screen-saver', 1)
  sidePanel.moveTop()
  }

  const emitToast = () => {
    if (notificationWindow && !notificationWindow.isDestroyed()) {
      notificationWindow.webContents.send('show-toast-notification', track)
    }
  }

  if (isNotifLoaded) {
    emitToast()
  } else {
    notificationWindow.webContents.once('did-finish-load', () => {
      isNotifLoaded = true
      emitToast()
    })
  }

  notifTimeout = setTimeout(() => {
    if (notificationWindow && !notificationWindow.isDestroyed()) {
      notificationWindow.webContents.send('hide-toast-notification')
      notifHideTimeout = setTimeout(() => {
        if (notificationWindow && !notificationWindow.isDestroyed()) {
          notificationWindow.hide()
        }
        notifHideTimeout = null
      }, 450)
    }
    notifTimeout = null
  }, 3200)
}

/**
 * Detector adaptativo de proximidad del ratón al borde derecho de la pantalla.
 * En reposo/lejos sondea a baja frecuencia (350ms) para no consumir CPU ni despertar
 * innecesariamente al procesador. Al acercarse el cursor al área lateral derecha,
 * acelera a alta reactividad (75ms).
 */
function scheduleNextEdgeCheck(delay = 75) {
  if (edgeCheckTimeout) clearTimeout(edgeCheckTimeout)
  edgeCheckTimeout = setTimeout(checkEdgeProximity, delay)
}

function checkEdgeProximity() {
  if (!sidePanel || sidePanel.isDestroyed()) {
    scheduleNextEdgeCheck(400)
    return
  }

  // Si la barra ya está desplegada, comprobamos a baja frecuencia
  if (isSidePanelExpanded) {
    scheduleNextEdgeCheck(350)
    return
  }

  const point = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(point) || screen.getPrimaryDisplay()
  const { x: dispX, y: dispY, width: screenWidth, height: screenHeight } = display.bounds
  const markerY = dispY + Math.floor(screenHeight * 0.20)
  const distanceToRight = (dispX + screenWidth) - point.x

  // Ratón cerca de cualquier parte del borde derecho de la pantalla actual (<= 14px)
  const isNearRightEdge = point.x >= dispX + screenWidth - 14
  // O ratón sobrevolando el área donde está el marcador
  const isOverMarker = point.x >= dispX + screenWidth - (SMALL_MARKER_WIN_WIDTH + 14) &&
                       point.y >= markerY - 14 &&
                       point.y <= markerY + SMALL_MARKER_WIN_HEIGHT + 14

  if (isNearRightEdge || isOverMarker) {
    if (hideMarkerTimeout) {
      clearTimeout(hideMarkerTimeout)
      hideMarkerTimeout = null
    }
    showMarkerWindow(dispX, screenWidth, markerY)
    scheduleNextEdgeCheck(75)
  } else if (isMarkerShowing) {
    if (!hideMarkerTimeout) {
      hideMarkerTimeout = setTimeout(() => {
        hideMarkerWindow()
        hideMarkerTimeout = null
      }, 280) // Desaparece ágilmente tras 280ms de gracia
    }
    scheduleNextEdgeCheck(75)
  } else {
    // Adaptativo: si el cursor está lejos (> 160px del borde), chequear cada 350ms.
    // Si se acerca a la zona derecha (<= 160px), acelerar a 80ms.
    const nextDelay = distanceToRight <= 160 ? 80 : 350
    scheduleNextEdgeCheck(nextDelay)
  }
}

function startEdgeDetection() {
  if (edgeCheckTimeout) clearTimeout(edgeCheckTimeout)
  checkEdgeProximity()
}

function setSidePanelBounds(mode) {
  if (!sidePanel || sidePanel.isDestroyed()) return
  const point = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(point) || screen.getPrimaryDisplay()
  const { x: dispX, y: dispY, width: screenWidth, height: screenHeight } = display.bounds
  const markerY = dispY + Math.floor(screenHeight * 0.20)

  if (mode === 'expanded') {
    isSidePanelExpanded = true
    isMarkerShowing = false
    sidePanel.setBounds({
      x: dispX + screenWidth - TOTAL_EXPANDED_WIDTH,
      y: dispY,
      width: TOTAL_EXPANDED_WIDTH,
      height: screenHeight
    })
    sidePanel.setAlwaysOnTop(true, 'screen-saver', 1)
    sidePanel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    sidePanel.show()
    sidePanel.moveTop()
    sidePanel.focus()
    sidePanel.webContents.send('side-panel-mode-changed', 'expanded')
  } else if (mode === 'marker') {
    isSidePanelExpanded = false
    showMarkerWindow(dispX, screenWidth, markerY)
    scheduleNextEdgeCheck(75)
  } else {
    // 'collapsed'
    isSidePanelExpanded = false
    isMarkerShowing = false
    sidePanel.webContents.send('side-panel-mode-changed', 'hidden')
    sidePanel.hide()
    scheduleNextEdgeCheck(150)
  }
}

function toggleSidePanel() {
  if (!sidePanel || sidePanel.isDestroyed()) {
    createSidePanel()
  }

  if (!isSidePanelExpanded) {
    setSidePanelBounds('expanded')
  } else {
    sidePanel.webContents.send('side-panel-request-collapse')
  }
}

// Configuración del directorio de música
const CONFIGURED_MUSIC_DIR = 'C:\\Users\\barre\\Music\\canciones_organizadas'

async function getMusicDirectory() {
  try {
    await fs.promises.access(CONFIGURED_MUSIC_DIR)
    return CONFIGURED_MUSIC_DIR
  } catch (_) {}

  const defaultMusic = path.join(app.getPath('music'), 'canciones_organizadas')
  try {
    await fs.promises.access(defaultMusic)
    return defaultMusic
  } catch (_) {}

  return path.join(app.getAppPath(), 'canciones_organizadas')
}

// ---- IPC Handlers ----
ipcMain.handle('select-music-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  })
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('scan-music', async (_, selectedDirectory) => {
  const musicDir = selectedDirectory || await getMusicDirectory()
  console.log(`[Biblioteca] Escaneando música desde: ${musicDir}`)
  try {
    const library = await scanMusicDirectory(musicDir)
    console.log(`[Biblioteca] ${library.length} álbumes indexados correctamente.`)
    return library
  } catch (err) {
    console.error('Error scanning music directory:', err)
    return []
  }
})

ipcMain.on('window-minimize', () => {
  if (mainWindow) mainWindow.minimize()
})

ipcMain.on('window-maximize', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize()
    } else {
      mainWindow.maximize()
    }
  }
})

ipcMain.on('window-close', () => {
  if (mainWindow) mainWindow.close()
})

ipcMain.on('toggle-side-panel', () => {
  toggleSidePanel()
})

ipcMain.on('set-side-panel-mode', (_, mode) => {
  setSidePanelBounds(mode)
})

ipcMain.on('update-panel-settings', (_, newSettings) => {
  panelSettings = { ...panelSettings, ...newSettings }
  if (sidePanel && !sidePanel.isDestroyed()) {
    sidePanel.webContents.send('panel-settings-updated', panelSettings)
  }
})

ipcMain.handle('get-panel-settings', () => {
  return panelSettings
})

ipcMain.on('restore-main-window', () => {
  if (mainWindow) {
    mainWindow.restore()
    mainWindow.focus()
  }
})

// Sync player state to side panel (con caché de playlist para evitar payloads masivos)
ipcMain.on('player-state-update', (event, state) => {
  if (state) {
    if (state.playlist !== undefined) {
      lastPlaylist = state.playlist
    }
    lastPlayerState = { ...lastPlayerState, ...state }
  }

  if (sidePanel && !sidePanel.isDestroyed()) {
    sidePanel.webContents.send('player-state-sync', state)
  }
  if (mainWindow && !mainWindow.isDestroyed() && event.sender !== mainWindow.webContents) {
    mainWindow.webContents.send('player-state-sync', state)
  }

  if (state && state.currentTrack && state.isPlaying) {
    if (state.currentTrack.id !== lastTrackId) {
      lastTrackId = state.currentTrack.id
      if (!isSidePanelExpanded) {
        showTrackNotification(state.currentTrack)
      }
    }
  } else if (state && state.currentTrack && !state.isPlaying && lastTrackId === null) {
    lastTrackId = state.currentTrack.id
  }
})

// Sincronización ligera de alta frecuencia de tiempo:
// Solo se envía al sidePanel si está desplegado o mostrando el marcador para ahorrar ciclos de CPU
ipcMain.on('player-time-update', (event, time) => {
  if (sidePanel && !sidePanel.isDestroyed() && (isSidePanelExpanded || isMarkerShowing)) {
    sidePanel.webContents.send('player-time-sync', time)
  }
  if (mainWindow && !mainWindow.isDestroyed() && event.sender !== mainWindow.webContents) {
    mainWindow.webContents.send('player-time-sync', time)
  }
})

ipcMain.handle('get-initial-player-state', () => {
  if (!lastPlayerState) return null
  return { ...lastPlayerState, playlist: lastPlaylist }
})

ipcMain.on('show-track-notification', (_, track) => {
  if (track) showTrackNotification(track)
})

ipcMain.on('player-command', (event, command) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('player-command', command)
  }
  if (sidePanel && !sidePanel.isDestroyed()) {
    sidePanel.webContents.send('player-command', command)
  }
})

ipcMain.handle('toggle-main-always-on-top', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false
  const currentState = mainWindow.isAlwaysOnTop()
  const newState = !currentState
  mainWindow.setAlwaysOnTop(newState, 'screen-saver')
  return newState
})

ipcMain.handle('get-main-always-on-top', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false
  return mainWindow.isAlwaysOnTop()
})

app.whenReady().then(() => {
  // Elevar prioridad del proceso a nivel Superior (Above Normal)
  // para que nunca sufra stutter o congelamientos mientras se juega (ej. League of Legends)
  try {
    os.setPriority(os.constants.priority.PRIORITY_ABOVE_NORMAL)
    console.log('[Gaming] Prioridad de proceso elevada a PRIORITY_ABOVE_NORMAL')
  } catch (err) {
    console.warn('[Gaming] No se pudo elevar la prioridad del proceso:', err.message)
  }

  createMainWindow()
  createSidePanel()
  // createNotificationWindow() se carga bajo demanda al sonar la primera pista (ahorra ~90MB RAM al inicio)
  startEdgeDetection()

  const sendCommand = (cmd) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('player-command', cmd)
    }
    if (sidePanel && !sidePanel.isDestroyed()) {
      sidePanel.webContents.send('player-command', cmd)
    }
  }

  const hotkeyActions = {
    next: () => sendCommand('next'),
    previous: () => sendCommand('previous'),
    playPause: () => sendCommand('toggle-play'),
    volumeUp: () => sendCommand('volume-up'),
    volumeDown: () => sendCommand('volume-down'),
    togglePanel: () => toggleSidePanel()
  }

  registerHotkeys(hotkeyActions)
})

app.on('will-quit', () => {
  if (edgeCheckTimeout) clearTimeout(edgeCheckTimeout)
  if (hideMarkerTimeout) clearTimeout(hideMarkerTimeout)
  if (markerAnimationTimeout) clearTimeout(markerAnimationTimeout)
  if (notifTimeout) clearTimeout(notifTimeout)
  if (notifHideTimeout) clearTimeout(notifHideTimeout)
  edgeCheckTimeout = null
  hideMarkerTimeout = null
  markerAnimationTimeout = null
  notifTimeout = null
  notifHideTimeout = null
  unregisterHotkeys()
})

app.on('window-all-closed', () => {
  app.quit()
})
