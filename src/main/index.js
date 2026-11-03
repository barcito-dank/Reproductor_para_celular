import { app, BrowserWindow, dialog, ipcMain, screen, globalShortcut, shell, Tray, Menu } from 'electron'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { parseFile } from 'music-metadata'
import NodeID3 from 'node-id3'
import { scanMusicDirectory, removeFromMetadataCache } from './scanner'
import { registerHotkeys, unregisterHotkeys, HOTKEY_CONFIG } from './hotkeys'

let mainWindow = null
let sidePanel = null
let notificationWindow = null
let tray = null
let dirWatcher = null
let watcherDebounceTimer = null
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

function createTray() {
  if (tray) return
  const iconPath = getAppIconPath() || path.join(__dirname, '../../resources/icon.ico')
  if (!iconPath || !fs.existsSync(iconPath)) return

  try {
    tray = new Tray(iconPath)
    updateTrayMenu()
    tray.setToolTip('Reproductor de Música')

    tray.on('click', () => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      if (mainWindow.isVisible()) {
        if (mainWindow.isMinimized()) {
          mainWindow.restore()
        }
        mainWindow.focus()
      } else {
        mainWindow.show()
        mainWindow.focus()
      }
    })
  } catch (err) {
    console.warn('No se pudo inicializar la bandeja del sistema (Tray):', err.message)
  }
}

function updateTrayMenu() {
  if (!tray || tray.isDestroyed()) return
  const isPlaying = lastPlayerState?.isPlaying ?? false
  const trackTitle = lastPlayerState?.currentTrack?.title
    ? `${lastPlayerState.currentTrack.title} — ${lastPlayerState.currentTrack.artist || 'Artista'}`
    : 'Reproductor de Música'

  const contextMenu = Menu.buildFromTemplate([
    {
      label: trackTitle.length > 36 ? trackTitle.slice(0, 36) + '…' : trackTitle,
      enabled: false
    },
    { type: 'separator' },
    {
      label: isPlaying ? '⏸ Pausar' : '▶ Reproducir',
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('player-command', 'toggle-play')
        }
      }
    },
    {
      label: '⏭ Siguiente',
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('player-command', 'next')
        }
      }
    },
    {
      label: '⏮ Anterior',
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('player-command', 'previous')
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Mostrar reproductor',
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          if (mainWindow.isMinimized()) mainWindow.restore()
          mainWindow.show()
          mainWindow.focus()
        }
      }
    },
    {
      label: 'Salir',
      click: () => {
        app.isQuitting = true
        app.quit()
      }
    }
  ])

  tray.setContextMenu(contextMenu)
}

function setupMusicDirectoryWatcher(dir) {
  if (dirWatcher) {
    try { dirWatcher.close() } catch (_) {}
    dirWatcher = null
  }
  if (!dir || !fs.existsSync(dir)) return

  try {
    dirWatcher = fs.watch(dir, { recursive: true }, (eventType, filename) => {
      if (!filename) return
      const base = path.basename(filename)
      if (base.startsWith('.') || base.endsWith('.tmp') || base.endsWith('.crdownload')) return

      if (watcherDebounceTimer) clearTimeout(watcherDebounceTimer)
      watcherDebounceTimer = setTimeout(async () => {
        watcherDebounceTimer = null
        if (!mainWindow || mainWindow.isDestroyed()) return
        try {
          const userDataDir = app.getPath('userData')
          const updatedTree = await scanMusicDirectory(dir, userDataDir)
          mainWindow.webContents.send('library-updated', updatedTree)
          console.log('[Watcher] Biblioteca sincronizada automáticamente tras cambios en disco.')
        } catch (err) {
          console.warn('[Watcher] Error al actualizar tras cambios en disco:', err.message)
        }
      }, 1500)
    })
  } catch (err) {
    console.warn('[Watcher] No se pudo iniciar el observador de la carpeta:', err.message)
  }
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
    scheduleNextEdgeCheck(200)
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
    scheduleNextEdgeCheck(nearPanelSeam ? 28 : 160)
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
    // Polling adaptable: conserva máxima fluidez cerca del borde, pero ahorra CPU cuando el cursor está lejos
    let adaptiveDelay = 32
    if (distanceToRight > 500) {
      adaptiveDelay = 400
    } else if (distanceToRight > 250) {
      adaptiveDelay = 200
    } else if (distanceToRight > 80) {
      adaptiveDelay = 90
    } else {
      adaptiveDelay = 32
    }
    scheduleNextEdgeCheck(adaptiveDelay)
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
  setupMusicDirectoryWatcher(musicDir)
  try {
    const library = await scanMusicDirectory(musicDir, userDataDir)
    console.log(`[Biblioteca] ${library.length} álbumes indexados correctamente.`)
    return library
  } catch (err) {
    console.error('Error scanning music directory:', err)
    return []
  }
})

ipcMain.on('show-item-in-folder', (_, filePath) => {
  if (filePath && typeof filePath === 'string') {
    try {
      shell.showItemInFolder(path.normalize(filePath))
    } catch (err) {
      console.error('Error abriendo ubicación del archivo:', err.message)
    }
  }
})

ipcMain.handle('add-track-to-albums', async (_, { sourceTrackPath, targetAlbums, selectedDirectory }) => {
  if (!sourceTrackPath || !Array.isArray(targetAlbums) || targetAlbums.length === 0) {
    return { success: false, error: 'Parámetros inválidos' }
  }

  try {
    await fs.promises.access(sourceTrackPath)
  } catch (_) {
    return { success: false, error: 'No se encontró el archivo de audio original' }
  }

  const fileName = path.basename(sourceTrackPath)
  const copiedAlbums = []

  for (const album of targetAlbums) {
    if (!album || !album.path) continue
    try {
      await fs.promises.mkdir(album.path, { recursive: true })
      const destPath = path.join(album.path, fileName)
      if (path.resolve(sourceTrackPath).toLowerCase() !== path.resolve(destPath).toLowerCase()) {
        await fs.promises.copyFile(sourceTrackPath, destPath)
        copiedAlbums.push({ id: album.id, name: album.name, destPath })
      }
    } catch (err) {
      console.error(`Error copiando pista a ${album.path}:`, err.message)
    }
  }

  const musicDir = selectedDirectory || await getMusicDirectory()
  const userDataDir = app.getPath('userData')
  const library = await scanMusicDirectory(musicDir, userDataDir)
  return { success: true, copiedAlbums, library }
})

ipcMain.handle('delete-track-file', async (_, { filePath, selectedDirectory }) => {
  if (!filePath || typeof filePath !== 'string') {
    return { success: false, error: 'Ruta de archivo inválida' }
  }

  const normalizedPath = path.normalize(filePath)
  try {
    await fs.promises.access(normalizedPath)
  } catch (_) {
    return { success: false, error: 'El archivo ya no existe en el disco' }
  }

  try {
    await shell.trashItem(normalizedPath)
  } catch (_) {
    try {
      await fs.promises.unlink(normalizedPath)
    } catch (unlinkErr) {
      return { success: false, error: unlinkErr.message || 'No se pudo eliminar el archivo' }
    }
  }

  removeFromMetadataCache(normalizedPath)
  removeFromMetadataCache(filePath)

  const musicDir = selectedDirectory || await getMusicDirectory()
  const userDataDir = app.getPath('userData')
  const library = await scanMusicDirectory(musicDir, userDataDir)
  return { success: true, library }
})

ipcMain.handle('get-track-properties', async (_, filePath) => {
  if (!filePath || typeof filePath !== 'string') return null
  try {
    const normalizedPath = path.normalize(filePath)
    const stats = await fs.promises.stat(normalizedPath)
    let metaCommon = {}
    let metaFormat = {}
    try {
      const parsed = await parseFile(normalizedPath, { skipCovers: true })
      metaCommon = parsed.common || {}
      metaFormat = parsed.format || {}
    } catch (_) {}

    return {
      fileName: path.basename(normalizedPath),
      directory: path.dirname(normalizedPath),
      path: normalizedPath,
      extension: path.extname(normalizedPath).replace('.', '').toUpperCase(),
      size: stats.size,
      createdAt: stats.birthtimeMs,
      modifiedAt: stats.mtimeMs,
      title: metaCommon.title || path.parse(normalizedPath).name,
      artist: metaCommon.artist || 'Artista Desconocido',
      album: metaCommon.album || null,
      year: metaCommon.year || null,
      genre: Array.isArray(metaCommon.genre) && metaCommon.genre.length > 0 ? metaCommon.genre.join(', ') : null,
      duration: metaFormat.duration || 0,
      bitrate: metaFormat.bitrate ? Math.round(metaFormat.bitrate / 1000) : null,
      sampleRate: metaFormat.sampleRate || null,
      numberOfChannels: metaFormat.numberOfChannels || null,
      bitsPerSample: metaFormat.bitsPerSample || null,
      codec: metaFormat.codec || metaFormat.container || path.extname(normalizedPath).replace('.', '').toUpperCase()
    }
  } catch (err) {
    console.error('Error obteniendo propiedades de pista:', err.message)
    return null
  }
})

ipcMain.handle('update-track-tags', async (_, { filePath, filePaths, title, artist, album, selectedDirectory }) => {
  const targetPaths = new Set()
  if (Array.isArray(filePaths) && filePaths.length > 0) {
    filePaths.forEach((p) => {
      if (p && typeof p === 'string') targetPaths.add(p)
    })
  } else if (filePath) {
    targetPaths.add(filePath)
  }

  if (targetPaths.size === 0) {
    return { success: false, error: 'No se proporcionaron rutas de archivo válidas' }
  }

  let updatedCount = 0
  const tags = {}
  if (typeof title === 'string') tags.title = title.trim()
  if (typeof artist === 'string') tags.artist = artist.trim()
  if (typeof album === 'string') tags.album = album.trim()

  for (const rawPath of targetPaths) {
    try {
      if (!fs.existsSync(rawPath)) continue
      const normalizedPath = path.normalize(rawPath)
      const ext = path.extname(normalizedPath).toLowerCase()
      if (ext === '.mp3') {
        NodeID3.update(tags, normalizedPath)
      }

      removeFromMetadataCache(normalizedPath)
      removeFromMetadataCache(rawPath)
      updatedCount++
    } catch (tagErr) {
      console.warn(`Aviso al actualizar tags en ${rawPath}:`, tagErr.message)
    }
  }

  try {
    const musicDir = selectedDirectory || (await getMusicDirectory())
    const userDataDir = app.getPath('userData')
    const library = await scanMusicDirectory(musicDir, userDataDir)

    const primaryPath = filePath ? path.normalize(filePath) : Array.from(targetPaths)[0]
    return {
      success: true,
      updatedCount,
      library,
      updatedTrack: {
        path: primaryPath,
        title: title ? title.trim() : path.parse(primaryPath).name,
        artist: artist ? artist.trim() : 'Artista Desconocido',
        album: album ? album.trim() : null
      }
    }
  } catch (err) {
    console.error('Error actualizando etiquetas ID3:', err)
    return { success: false, error: err.message || 'Error al guardar los cambios en el archivo' }
  }
})

/**
 * Parsea el contenido en formato LRC (marcas de tiempo [mm:ss.xx]) o texto plano.
 * Retorna { synced: boolean, lines: Array<{ time: number, text: string }> }
 */
function parseLrcText(content) {
  if (!content || typeof content !== 'string') return { synced: false, lines: [] }
  const cleanContent = content.replace(/^\uFEFF/, '')
  const rawLines = cleanContent.split(/\r?\n/)
  const parsedLines = []
  const timeRegex = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g

  let hasTimestamp = false

  for (const rawLine of rawLines) {
    const line = rawLine.trim()
    if (!line) continue

    // Ignorar etiquetas de metadata como [ti:], [ar:], [al:], etc.
    if (/^\[(ti|ar|al|by|offset|length|re|ve):/i.test(line)) {
      continue
    }

    const matches = [...line.matchAll(timeRegex)]
    if (matches.length > 0) {
      hasTimestamp = true
      const text = line.replace(timeRegex, '').trim()
      for (const match of matches) {
        const min = parseInt(match[1], 10)
        const sec = parseInt(match[2], 10)
        const msStr = match[3] || '0'
        let ms = 0
        if (msStr.length === 1) ms = parseInt(msStr, 10) * 100
        else if (msStr.length === 2) ms = parseInt(msStr, 10) * 10
        else ms = parseInt(msStr.slice(0, 3), 10)

        const time = min * 60 + sec + ms / 1000
        parsedLines.push({ time, text: text || '♪' })
      }
    }
  }

  if (hasTimestamp && parsedLines.length > 0) {
    parsedLines.sort((a, b) => a.time - b.time)
    return { synced: true, lines: parsedLines }
  }

  // Letra sin sincronización (texto plano)
  const plainLines = rawLines
    .map(l => l.trim())
    .filter(l => l.length > 0 && !/^\[(ti|ar|al|by|offset|length):/i.test(l))
    .map((text, idx) => ({ time: idx, text }))

  return { synced: false, lines: plainLines }
}

ipcMain.handle('get-track-lyrics', async (_, filePath) => {
  if (!filePath || typeof filePath !== 'string') return { synced: false, lines: [] }
  try {
    const normalizedPath = path.normalize(filePath)
    const dir = path.dirname(normalizedPath)
    const baseName = path.parse(normalizedPath).name

    // 1. Buscar archivo .lrc o .txt externo en el mismo directorio
    const candidateFiles = [
      path.join(dir, `${baseName}.lrc`),
      path.join(dir, `${baseName}.LRC`),
      path.join(dir, `${baseName}.txt`)
    ]

    for (const candidate of candidateFiles) {
      if (fs.existsSync(candidate)) {
        try {
          const content = await fs.promises.readFile(candidate, 'utf-8')
          const parsed = parseLrcText(content)
          if (parsed.lines.length > 0) {
            return { ...parsed, source: 'lrc' }
          }
        } catch (_) {}
      }
    }

    // 2. Metadatos ID3 usando NodeID3 (MP3)
    const ext = path.extname(normalizedPath).toLowerCase()
    if (ext === '.mp3') {
      try {
        const tags = NodeID3.read(normalizedPath)
        if (tags?.synchronisedLyrics && Array.isArray(tags.synchronisedLyrics) && tags.synchronisedLyrics.length > 0) {
          const lines = tags.synchronisedLyrics.map(item => ({
            time: (item.timeStamp || 0) / 1000,
            text: (item.text || '').trim() || '♪'
          })).filter(l => Boolean(l.text))
          if (lines.length > 0) {
            lines.sort((a, b) => a.time - b.time)
            return { synced: true, lines, source: 'id3-sylt' }
          }
        }
        const rawUnsynced = tags?.unsynchronisedLyrics?.text || tags?.unsynchronisedLyrics
        if (typeof rawUnsynced === 'string' && rawUnsynced.trim()) {
          const parsed = parseLrcText(rawUnsynced)
          if (parsed.lines.length > 0) {
            return { ...parsed, source: 'id3-uslt' }
          }
        }
      } catch (_) {}
    }

    // 3. Respaldo: parseFile de music-metadata (FLAC, M4A, OGG, WAV, etc.)
    try {
      const parsed = await parseFile(normalizedPath, { skipCovers: true })
      if (parsed?.common?.lyrics && Array.isArray(parsed.common.lyrics) && parsed.common.lyrics.length > 0) {
        const text = parsed.common.lyrics.join('\n')
        const parsedLyrics = parseLrcText(text)
        if (parsedLyrics.lines.length > 0) {
          return { ...parsedLyrics, source: 'metadata' }
        }
      }
    } catch (_) {}

    return { synced: false, lines: [] }
  } catch (err) {
    console.error('Error obteniendo letras de pista:', err)
    return { synced: false, lines: [] }
  }
})

ipcMain.handle('create-album', async (_, { albumName, parentDir, selectedDirectory }) => {
  if (!albumName || typeof albumName !== 'string') {
    return { success: false, error: 'Nombre de álbum inválido' }
  }

  const sanitized = albumName
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (!sanitized || sanitized.startsWith('.')) {
    return { success: false, error: 'Ingresa un nombre válido para el álbum' }
  }

  const musicDir = selectedDirectory || await getMusicDirectory()
  const baseTarget = parentDir && typeof parentDir === 'string' ? parentDir : musicDir
  const newAlbumPath = path.join(baseTarget, sanitized)

  try {
    await fs.promises.access(newAlbumPath)
    return { success: false, error: 'Ya existe un álbum con ese nombre' }
  } catch (_) {}

  try {
    await fs.promises.mkdir(newAlbumPath, { recursive: true })
  } catch (err) {
    return { success: false, error: err.message || 'No se pudo crear la carpeta del álbum' }
  }

  const userDataDir = app.getPath('userData')
  const library = await scanMusicDirectory(musicDir, userDataDir)
  return {
    success: true,
    albumId: newAlbumPath,
    albumPath: newAlbumPath,
    albumName: sanitized,
    library
  }
})

ipcMain.handle('move-album-folder', async (_, { sourcePath, targetParentDir, selectedDirectory }) => {
  if (!sourcePath || typeof sourcePath !== 'string') {
    return { success: false, error: 'Ruta de origen inválida' }
  }

  const musicDir = selectedDirectory || await getMusicDirectory()
  const destParent =
    !targetParentDir || targetParentDir === '__ROOT__'
      ? musicDir
      : targetParentDir

  const resolvedSource = path.resolve(sourcePath)
  const resolvedDestParent = path.resolve(destParent)
  const folderName = path.basename(resolvedSource)
  const resolvedDest = path.join(resolvedDestParent, folderName)

  if (resolvedSource.toLowerCase() === resolvedDestParent.toLowerCase()) {
    return { success: false, error: 'No se puede mover un álbum dentro de sí mismo' }
  }

  if (
    resolvedDestParent.toLowerCase().startsWith(resolvedSource.toLowerCase() + path.sep)
  ) {
    return { success: false, error: 'No se puede mover una carpeta dentro de una subcarpeta propia' }
  }

  if (resolvedSource.toLowerCase() === resolvedDest.toLowerCase()) {
    return { success: false, error: 'El álbum ya se encuentra en esa ubicación' }
  }

  try {
    await fs.promises.access(resolvedDest)
    return { success: false, error: `Ya existe "${folderName}" en el destino` }
  } catch (_) {}

  try {
    await fs.promises.mkdir(resolvedDestParent, { recursive: true })
    try {
      await fs.promises.rename(resolvedSource, resolvedDest)
    } catch (renameErr) {
      await fs.promises.cp(resolvedSource, resolvedDest, { recursive: true })
      await fs.promises.rm(resolvedSource, { recursive: true, force: true })
    }
  } catch (err) {
    console.error('Error moviendo carpeta de álbum:', err.message)
    return { success: false, error: err.message || 'No se pudo mover el álbum' }
  }

  const userDataDir = app.getPath('userData')
  const library = await scanMusicDirectory(musicDir, userDataDir)
  return {
    success: true,
    oldPath: resolvedSource,
    newPath: resolvedDest,
    parentPath: resolvedDestParent,
    library
  }
})

ipcMain.handle('rename-album-folder', async (_, { albumPath, newName, selectedDirectory }) => {
  if (!albumPath || typeof albumPath !== 'string') {
    return { success: false, error: 'Ruta de álbum inválida' }
  }

  const sanitized = (newName || '').replace(/[\\/:*?"<>|]/g, '').trim()
  if (!sanitized) {
    return { success: false, error: 'El nombre del álbum no puede estar vacío ni contener caracteres especiales' }
  }

  const musicDir = selectedDirectory || await getMusicDirectory()
  const resolvedPath = path.resolve(albumPath)
  const currentBaseName = path.basename(resolvedPath)

  if (currentBaseName === sanitized) {
    return { success: true, unchanged: true, oldPath: resolvedPath, newPath: resolvedPath, newName: sanitized }
  }

  const destPath = path.join(path.dirname(resolvedPath), sanitized)

  if (destPath.toLowerCase() !== resolvedPath.toLowerCase()) {
    try {
      await fs.promises.access(destPath)
      return { success: false, error: `Ya existe una carpeta llamada "${sanitized}"` }
    } catch (_) {}
  }

  try {
    try {
      await fs.promises.rename(resolvedPath, destPath)
    } catch (renameErr) {
      await fs.promises.cp(resolvedPath, destPath, { recursive: true })
      await fs.promises.rm(resolvedPath, { recursive: true, force: true })
    }
  } catch (err) {
    console.error('Error renombrando álbum:', err.message)
    return { success: false, error: err.message || 'No se pudo renombrar el álbum' }
  }

  const userDataDir = app.getPath('userData')
  const library = await scanMusicDirectory(musicDir, userDataDir)
  return {
    success: true,
    oldPath: resolvedPath,
    newPath: destPath,
    newName: sanitized,
    library
  }
})

ipcMain.handle('delete-album-folder', async (_, { albumPath, selectedDirectory }) => {
  if (!albumPath || typeof albumPath !== 'string') {
    return { success: false, error: 'Ruta de álbum inválida' }
  }

  const musicDir = path.resolve(selectedDirectory || await getMusicDirectory())
  const resolvedPath = path.resolve(albumPath)

  // Medida de seguridad esencial: no permitir borrar fuera de musicDir ni la carpeta raíz
  if (resolvedPath.toLowerCase() === musicDir.toLowerCase()) {
    return { success: false, error: 'No se puede eliminar la carpeta raíz de música' }
  }

  if (!resolvedPath.toLowerCase().startsWith(musicDir.toLowerCase() + path.sep)) {
    return { success: false, error: 'La carpeta está fuera del directorio de música' }
  }

  try {
    await fs.promises.access(resolvedPath)
  } catch {
    return { success: false, error: 'La carpeta no existe en disco' }
  }

  try {
    try {
      await shell.trashItem(resolvedPath)
    } catch {
      await fs.promises.rm(resolvedPath, { recursive: true, force: true })
    }
  } catch (err) {
    console.error('Error eliminando álbum:', err.message)
    return { success: false, error: err.message || 'No se pudo eliminar la carpeta' }
  }

  const userDataDir = app.getPath('userData')
  const library = await scanMusicDirectory(musicDir, userDataDir)
  return {
    success: true,
    deletedPath: resolvedPath,
    library
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

  updateTrayMenu()

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
  createTray()
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
  if (dirWatcher) {
    try { dirWatcher.close() } catch (_) {}
    dirWatcher = null
  }
  if (tray && !tray.isDestroyed()) {
    try { tray.destroy() } catch (_) {}
    tray = null
  }
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
