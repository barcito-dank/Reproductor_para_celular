import { app, BrowserWindow, dialog, ipcMain, screen, globalShortcut } from 'electron'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { scanMusicDirectory } from './scanner'
import { registerHotkeys, unregisterHotkeys, HOTKEY_CONFIG } from './hotkeys'

let mainWindow = null
let sidePanel = null
let notificationWindow = null
let sidePanelMode = 'hidden' // 'hidden' | 'marker' | 'expanded'
let isSidePanelExpanded = false
let isMarkerShowing = false
let isSidePanelReady = false
let pendingSidePanelMode = null
let lastIgnoreMouseEvents = null
let currentSidePanelBounds = null
let expandGraceUntil = 0
let collapseCooldownUntil = 0
let lastBlurCollapseAt = 0
let minimizeDeferTimeout = null
let isNotifLoaded = false
let edgeCheckTimeout = null
let hideMarkerTimeout = null
let notifTimeout = null
let notifHideTimeout = null
let lastTrackId = null
let lastPlayerState = null
let lastPlaylist = []
let lastCurrentTime = 0

// Opciones de configuración de la barra lateral (modos estrictamente alternativos: Fija vs Ocultamiento Automático)
let panelSettings = {
  pinned: false,    // "mantenerla siempre visible (fija)"
  autoHide: true    // "ocultar la barra lateral en caso de tocar otra cosa (blur)"
}

function resolveExclusivePanelSettings(incoming, current = panelSettings) {
  if (!incoming || typeof incoming !== 'object') {
    const pinned = Boolean(current.pinned)
    return { pinned, autoHide: !pinned }
  }

  const hasPinned = typeof incoming.pinned === 'boolean'
  const hasAutoHide = typeof incoming.autoHide === 'boolean'

  if (hasPinned && hasAutoHide) {
    if (incoming.pinned !== incoming.autoHide) {
      return { pinned: incoming.pinned, autoHide: incoming.autoHide }
    }
    if (incoming.pinned !== current.pinned) {
      return { pinned: incoming.pinned, autoHide: !incoming.pinned }
    }
    if (incoming.autoHide !== current.autoHide) {
      return { pinned: !incoming.autoHide, autoHide: incoming.autoHide }
    }
    return { pinned: incoming.pinned, autoHide: !incoming.pinned }
  }

  if (hasPinned) {
    return { pinned: incoming.pinned, autoHide: !incoming.pinned }
  }

  if (hasAutoHide) {
    return { pinned: !incoming.autoHide, autoHide: incoming.autoHide }
  }

  const pinned = Boolean(current.pinned)
  return { pinned, autoHide: !pinned }
}

const DRAWER_WIDTH = 340
const MARKER_TAB_WIDTH = 36
const MARKER_TAB_HEIGHT = 74
const GLOW_BUFFER = 12
const TOTAL_EXPANDED_WIDTH = DRAWER_WIDTH + MARKER_TAB_WIDTH + GLOW_BUFFER // 388px (cajón + marcador + margen para sombra)
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
  const { width: workWidth, height: workHeight } = screen.getPrimaryDisplay().workAreaSize
  const initialWidth = Math.max(960, Math.min(1200, Math.round(workWidth * 0.84)))
  const initialHeight = Math.max(680, Math.min(880, Math.round(workHeight * 0.9)))

  mainWindow = new BrowserWindow({
    width: initialWidth,
    height: initialHeight,
    minWidth: 800,
    minHeight: 620,
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
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('main-window-visibility', false)
    }
    expandGraceUntil = Date.now() + 500
    if (!isSidePanelExpanded) {
      setSidePanelBounds('expanded')
    } else if (sidePanel && !sidePanel.isDestroyed()) {
      sidePanel.moveTop()
      sidePanel.focus()
    }
  })

  mainWindow.on('restore', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('main-window-visibility', true)
    }
    if (panelSettings.autoHide && !panelSettings.pinned) {
      setSidePanelBounds('collapsed')
    }
  })

  mainWindow.on('show', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('main-window-visibility', true)
    }
  })

  mainWindow.on('hide', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('main-window-visibility', false)
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

/**
 * Sincroniza la geometría fija de la ventana del panel lateral solo si cambia el monitor o resolución.
 * Evita redimensionar el buffer DirectComposition (setBounds) en cada transición marker <-> expanded,
 * eliminando el salto horizontal del marcador y la latencia de despliegue.
 */
function syncSidePanelDisplayBounds(display) {
  if (!sidePanel || sidePanel.isDestroyed() || !display) return
  const { x: dispX, y: dispY, width: screenWidth, height: screenHeight } = display.bounds
  const nextBounds = {
    x: dispX + screenWidth - TOTAL_EXPANDED_WIDTH,
    y: dispY,
    width: TOTAL_EXPANDED_WIDTH,
    height: screenHeight
  }

  if (
    !currentSidePanelBounds ||
    currentSidePanelBounds.x !== nextBounds.x ||
    currentSidePanelBounds.y !== nextBounds.y ||
    currentSidePanelBounds.width !== nextBounds.width ||
    currentSidePanelBounds.height !== nextBounds.height
  ) {
    sidePanel.setBounds(nextBounds)
    currentSidePanelBounds = nextBounds
  }
}

/**
 * Actualiza el paso de eventos de ratón a través de la ventana transparente únicamente cuando cambia de estado,
 * evitando llamadas redundantes a Win32 SetWindowLongPtr.
 */
function setSidePanelIgnoreMouse(ignore) {
  if (!sidePanel || sidePanel.isDestroyed()) return
  if (lastIgnoreMouseEvents === ignore) return
  lastIgnoreMouseEvents = ignore
  sidePanel.setIgnoreMouseEvents(ignore)
}

function broadcastSidePanelMode(mode) {
  if (sidePanel && !sidePanel.isDestroyed()) {
    sidePanel.webContents.send('side-panel-mode-changed', mode)
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('side-panel-mode-changed', mode)
  }
}

function createSidePanel() {
  const primaryDisplay = screen.getPrimaryDisplay()
  const { x: dispX, y: dispY, width: screenWidth, height: screenHeight } = primaryDisplay.bounds
  const initialBounds = {
    x: dispX + screenWidth - TOTAL_EXPANDED_WIDTH,
    y: dispY,
    width: TOTAL_EXPANDED_WIDTH,
    height: screenHeight
  }

  sidePanel = new BrowserWindow({
    ...initialBounds,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    focusable: true,
    webPreferences: {
      preload: getPreloadPath(),
      sandbox: false,
      webSecurity: false,
      backgroundThrottling: false // Mantener compositor GPU caliente para despliegue instantáneo (0ms)
    }
  })

  currentSidePanelBounds = initialBounds
  isSidePanelReady = false
  lastIgnoreMouseEvents = null

  // Prioridad Z superior (nivel 2 en 'screen-saver') por encima de notificaciones y juegos pantalla completa
  sidePanel.setAlwaysOnTop(true, 'screen-saver', 2)
  sidePanel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  setSidePanelIgnoreMouse(true)

  sidePanel.webContents.once('did-finish-load', () => {
    if (!sidePanel || sidePanel.isDestroyed()) return
    isSidePanelReady = true
    // Pre-calentar superficie DirectComposition transparente sin robar foco (0% uso GPU en reposo)
    sidePanel.setAlwaysOnTop(true, 'screen-saver', 2)
    sidePanel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    sidePanel.showInactive()

    if (pendingSidePanelMode) {
      const targetMode = pendingSidePanelMode
      pendingSidePanelMode = null
      setSidePanelBounds(targetMode)
    } else {
      broadcastSidePanelMode(sidePanelMode)
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    sidePanel.loadURL(process.env['ELECTRON_RENDERER_URL'] + '#/mini')
  } else {
    sidePanel.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: '/mini' })
  }

  // Ocultación automática al tocar otra cosa que no sea la aplicación (blur),
  // respetando la ventana de gracia durante la transición de minimizado de Windows
  sidePanel.on('blur', () => {
    if (Date.now() < expandGraceUntil) return
    if (isSidePanelExpanded && panelSettings.autoHide && !panelSettings.pinned) {
      lastBlurCollapseAt = Date.now()
      setSidePanelBounds('collapsed')
    }
  })

  sidePanel.on('closed', () => {
    sidePanel = null
    sidePanelMode = 'hidden'
    isSidePanelExpanded = false
    isMarkerShowing = false
    isSidePanelReady = false
    currentSidePanelBounds = null
    lastIgnoreMouseEvents = null
  })
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
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    focusable: false,
    webPreferences: {
      preload: getPreloadPath(),
      sandbox: false,
      webSecurity: false,
      backgroundThrottling: false
    }
  })

  notificationWindow.setAlwaysOnTop(true, 'screen-saver', 1)
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
  notificationWindow.setAlwaysOnTop(true, 'screen-saver', 1)
  notificationWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  notificationWindow.setIgnoreMouseEvents(true, { forward: true })
  notificationWindow.showInactive()

  // Mantener el orden Z estricto del panel lateral por encima de las notificaciones
  if (sidePanel && !sidePanel.isDestroyed() && (isSidePanelExpanded || isMarkerShowing)) {
    sidePanel.setAlwaysOnTop(true, 'screen-saver', 2)
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
 * Detector adaptativo de proximidad con corredor de histéresis y hit-testing por píxel:
 * - Evita que el marcador entre y salga erráticamente cuando el usuario mueve el cursor en diagonal hacia él.
 * - Mantiene click-through total (WS_EX_TRANSPARENT) fuera del área exacta del marcador o del cajón.
 */
function scheduleNextEdgeCheck(delay = 32) {
  if (edgeCheckTimeout) clearTimeout(edgeCheckTimeout)
  edgeCheckTimeout = setTimeout(checkEdgeProximity, delay)
}

function checkEdgeProximity() {
  if (!sidePanel || sidePanel.isDestroyed() || !isSidePanelReady) {
    scheduleNextEdgeCheck(120)
    return
  }

  const point = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(point) || screen.getPrimaryDisplay()
  const { x: dispX, y: dispY, width: screenWidth, height: screenHeight } = display.bounds
  const rightEdge = dispX + screenWidth
  const markerTop = dispY + Math.round(screenHeight * 0.20)
  const markerBottom = markerTop + MARKER_TAB_HEIGHT
  const distanceToRight = rightEdge - point.x

  // 1. Si el panel está desplegado: gestionar hit-testing limpio para dejar pasar clics en la franja izquierda vacía
  if (isSidePanelExpanded) {
    const activeBounds = currentSidePanelBounds || {
      x: rightEdge - TOTAL_EXPANDED_WIDTH,
      y: dispY,
      width: TOTAL_EXPANDED_WIDTH,
      height: screenHeight
    }
    const panelRight = activeBounds.x + activeBounds.width
    const drawerLeft = panelRight - DRAWER_WIDTH
    const expMarkerLeft = drawerLeft - MARKER_TAB_WIDTH - 6
    const expMarkerTop = activeBounds.y + Math.round(activeBounds.height * 0.20)
    const expMarkerBottom = expMarkerTop + MARKER_TAB_HEIGHT

    const inDrawer =
      point.x >= drawerLeft &&
      point.x <= panelRight + 4 &&
      point.y >= activeBounds.y &&
      point.y <= activeBounds.y + activeBounds.height

    const inExpandedMarker =
      point.x >= expMarkerLeft &&
      point.x < drawerLeft &&
      point.y >= expMarkerTop - 8 &&
      point.y <= expMarkerBottom + 8

    setSidePanelIgnoreMouse(!(inDrawer || inExpandedMarker))

    const nearPanelSeam = Math.abs(point.x - drawerLeft) <= 70
    scheduleNextEdgeCheck(nearPanelSeam ? 28 : 120)
    return
  }

  // Liberar anticipadamente el cooldown tras plegar si el ratón ya se alejó del borde
  if (collapseCooldownUntil > 0 && distanceToRight > 95) {
    collapseCooldownUntil = 0
  }
  const inCooldown = Date.now() < collapseCooldownUntil

  // Área interactiva exacta del marcador cuando asoma en el borde derecho
  const overCollapsedMarker =
    distanceToRight >= -4 &&
    distanceToRight <= MARKER_TAB_WIDTH + 8 &&
    point.y >= markerTop - 8 &&
    point.y <= markerBottom + 8

  if (!isMarkerShowing) {
    const triggerNearEdge = !inCooldown && distanceToRight >= -4 && distanceToRight <= 14
    const triggerOverMarker = !inCooldown && overCollapsedMarker

    if (triggerNearEdge || triggerOverMarker) {
      if (hideMarkerTimeout) {
        clearTimeout(hideMarkerTimeout)
        hideMarkerTimeout = null
      }
      syncSidePanelDisplayBounds(display)
      setSidePanelIgnoreMouse(!overCollapsedMarker)
      setSidePanelBounds('marker')
      scheduleNextEdgeCheck(28)
      return
    }

    setSidePanelIgnoreMouse(true)
    scheduleNextEdgeCheck(distanceToRight <= 220 ? 32 : 110)
    return
  }

  // 2. El marcador ya está visible: aplicar corredor amplio de histéresis para cero parpadeo/rebote
  setSidePanelIgnoreMouse(!overCollapsedMarker)

  const inRightCorridor = distanceToRight >= -8 && distanceToRight <= 92
  const inMarkerHalo =
    distanceToRight >= -8 &&
    distanceToRight <= 145 &&
    point.y >= markerTop - 55 &&
    point.y <= markerBottom + 55

  if (inRightCorridor || inMarkerHalo) {
    if (hideMarkerTimeout) {
      clearTimeout(hideMarkerTimeout)
      hideMarkerTimeout = null
    }
    scheduleNextEdgeCheck(28)
  } else {
    if (!hideMarkerTimeout) {
      hideMarkerTimeout = setTimeout(() => {
        hideMarkerTimeout = null
        if (!isSidePanelExpanded && isMarkerShowing) {
          setSidePanelBounds('collapsed')
        }
      }, 210)
    }
    scheduleNextEdgeCheck(32)
  }
}

function startEdgeDetection() {
  if (edgeCheckTimeout) clearTimeout(edgeCheckTimeout)
  checkEdgeProximity()
}

function setSidePanelBounds(mode, options = {}) {
  if (!sidePanel || sidePanel.isDestroyed()) return

  const normalizedMode =
    mode === 'expanded' ? 'expanded' : mode === 'marker' ? 'marker' : 'hidden'

  if (!isSidePanelReady) {
    pendingSidePanelMode = normalizedMode
    return
  }

  if (hideMarkerTimeout) {
    clearTimeout(hideMarkerTimeout)
    hideMarkerTimeout = null
  }

  const point = screen.getCursorScreenPoint()
  const display = screen.getDisplayNearestPoint(point) || screen.getPrimaryDisplay()

  if (normalizedMode === 'expanded') {
    syncSidePanelDisplayBounds(display)
    sidePanelMode = 'expanded'
    isSidePanelExpanded = true
    isMarkerShowing = false
    collapseCooldownUntil = 0

    if (!options.preserveGrace) {
      expandGraceUntil = Math.max(expandGraceUntil, Date.now() + 220)
    }

    setSidePanelIgnoreMouse(false)
    sidePanel.setAlwaysOnTop(true, 'screen-saver', 2)
    if (!sidePanel.isVisible()) {
      sidePanel.showInactive()
    }
    sidePanel.moveTop()
    if (!options.skipFocus) {
      sidePanel.focus()
    }

    // Sincronizar tiempo exacto de reproducción antes del frame de apertura para evitar saltos en la barra
    sidePanel.webContents.send('player-time-sync', lastCurrentTime)
    broadcastSidePanelMode('expanded')
    scheduleNextEdgeCheck(40)
  } else if (normalizedMode === 'marker') {
    syncSidePanelDisplayBounds(display)
    const wasMarker = sidePanelMode === 'marker'
    sidePanelMode = 'marker'
    isSidePanelExpanded = false
    isMarkerShowing = true

    sidePanel.setAlwaysOnTop(true, 'screen-saver', 2)
    if (!sidePanel.isVisible()) {
      sidePanel.showInactive()
    }
    sidePanel.moveTop()

    if (!wasMarker) {
      sidePanel.webContents.send('player-time-sync', lastCurrentTime)
      broadcastSidePanelMode('marker')
    }
    scheduleNextEdgeCheck(28)
  } else {
    // 'hidden' / 'collapsed'
    if (options.cooldown) {
      collapseCooldownUntil = Date.now() + 420
    }
    const wasHidden = sidePanelMode === 'hidden'
    sidePanelMode = 'hidden'
    isSidePanelExpanded = false
    isMarkerShowing = false
    setSidePanelIgnoreMouse(true)

    if (!wasHidden) {
      broadcastSidePanelMode('hidden')
    }
    scheduleNextEdgeCheck(60)
  }
}

function toggleSidePanel(fromUIButton = false) {
  if (!sidePanel || sidePanel.isDestroyed()) {
    createSidePanel()
  }

  // Si hacer mousedown en el botón "Panel Rápido" de la ventana principal acaba de disparar blur y cerrarlo,
  // evitar que el click (mouseup) posterior lo vuelva a abrir por accidente
  if (fromUIButton && !isSidePanelExpanded && Date.now() - lastBlurCollapseAt < 320) {
    return
  }

  if (!isSidePanelExpanded) {
    setSidePanelBounds('expanded')
  } else {
    setSidePanelBounds('collapsed', { cooldown: true })
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
  const userDataDir = app.getPath('userData')
  console.log(`[Biblioteca] Escaneando música desde: ${musicDir}`)
  try {
    const library = await scanMusicDirectory(musicDir, userDataDir)
    console.log(`[Biblioteca] ${library.length} álbumes indexados correctamente.`)
    return library
  } catch (err) {
    console.error('Error scanning music directory:', err)
    return []
  }
})

ipcMain.on('window-minimize', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  // Desplegar el panel lateral ANTES de iniciar la animación de minimizado de Windows
  // para que la transición sea instantánea y simultánea sin bloqueo de DWM
  expandGraceUntil = Date.now() + 650
  setSidePanelBounds('expanded', { skipFocus: true, preserveGrace: true })

  if (minimizeDeferTimeout) clearTimeout(minimizeDeferTimeout)
  minimizeDeferTimeout = setTimeout(() => {
    minimizeDeferTimeout = null
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isMinimized()) {
      mainWindow.minimize()
    }
    setTimeout(() => {
      if (isSidePanelExpanded && sidePanel && !sidePanel.isDestroyed()) {
        sidePanel.moveTop()
        sidePanel.focus()
      }
    }, 180)
  }, 16)
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
  toggleSidePanel(true)
})

ipcMain.on('set-side-panel-mode', (_, mode) => {
  const isManualCollapse = mode === 'collapsed' || mode === 'hidden'
  setSidePanelBounds(mode, { cooldown: isManualCollapse })
})

ipcMain.on('update-panel-settings', (_, newSettings) => {
  panelSettings = resolveExclusivePanelSettings(newSettings, panelSettings)
  if (sidePanel && !sidePanel.isDestroyed()) {
    sidePanel.webContents.send('panel-settings-updated', panelSettings)
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('panel-settings-updated', panelSettings)
  }
})

ipcMain.handle('get-panel-settings', () => {
  return panelSettings
})

ipcMain.on('restore-main-window', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore()
    } else {
      mainWindow.show()
    }
    mainWindow.focus()
    if (panelSettings.autoHide && !panelSettings.pinned) {
      setSidePanelBounds('collapsed', { cooldown: true })
    }
  }
})

// Sync player state to side panel (con caché de playlist para evitar payloads masivos)
ipcMain.on('player-state-update', (event, state) => {
  if (state) {
    if (state.playlist !== undefined) {
      lastPlaylist = state.playlist
    }
    if (typeof state.currentTime === 'number') {
      lastCurrentTime = state.currentTime
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
// Siempre guarda lastCurrentTime y solo despacha IPC cuando el panel/marcador está activo
ipcMain.on('player-time-update', (event, time) => {
  if (typeof time === 'number') {
    lastCurrentTime = time
  }
  if (sidePanel && !sidePanel.isDestroyed() && (isSidePanelExpanded || isMarkerShowing)) {
    sidePanel.webContents.send('player-time-sync', time)
  }
  if (mainWindow && !mainWindow.isDestroyed() && event.sender !== mainWindow.webContents) {
    mainWindow.webContents.send('player-time-sync', time)
  }
})

ipcMain.handle('get-initial-player-state', () => {
  if (!lastPlayerState) return null
  return { ...lastPlayerState, currentTime: lastCurrentTime, playlist: lastPlaylist }
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
  if (notificationWindow && !notificationWindow.isDestroyed()) {
    notificationWindow.webContents.send('player-command', command)
  }
})

ipcMain.handle('toggle-main-always-on-top', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false
  const currentState = mainWindow.isAlwaysOnTop()
  const newState = !currentState
  // Nivel 'pop-up-menu' mantiene la ventana sobre apps normales, pero debajo de notificaciones (nivel 1) y panel lateral (nivel 2)
  mainWindow.setAlwaysOnTop(newState, 'pop-up-menu')
  if (sidePanel && !sidePanel.isDestroyed() && (isSidePanelExpanded || isMarkerShowing)) {
    sidePanel.setAlwaysOnTop(true, 'screen-saver', 2)
    sidePanel.moveTop()
  }
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

  const handleDisplayChange = () => {
    if (!sidePanel || sidePanel.isDestroyed()) return
    const point = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(point) || screen.getPrimaryDisplay()
    currentSidePanelBounds = null
    syncSidePanelDisplayBounds(display)
  }
  screen.on('display-metrics-changed', handleDisplayChange)
  screen.on('display-added', handleDisplayChange)
  screen.on('display-removed', handleDisplayChange)

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
  if (minimizeDeferTimeout) clearTimeout(minimizeDeferTimeout)
  if (notifTimeout) clearTimeout(notifTimeout)
  if (notifHideTimeout) clearTimeout(notifHideTimeout)
  edgeCheckTimeout = null
  hideMarkerTimeout = null
  minimizeDeferTimeout = null
  notifTimeout = null
  notifHideTimeout = null
  unregisterHotkeys()
})

app.on('window-all-closed', () => {
  app.quit()
})
