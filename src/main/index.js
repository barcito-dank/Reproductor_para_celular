import { app, BrowserWindow, dialog, ipcMain, screen, globalShortcut, shell, Tray, Menu, clipboard } from 'electron'
import path from 'path'
import fs from 'fs'
import os from 'os'
import { spawn } from 'child_process'
import { parseFile } from 'music-metadata'
import NodeID3 from 'node-id3'
import { scanMusicDirectory, removeFromMetadataCache } from './scanner'
import { registerHotkeys, unregisterHotkeys, HOTKEY_CONFIG } from './hotkeys'
import { discordRpc } from './discordRpc'
import { runHardlinksHealthCheck, repairHardlinksIntegrity } from './hardlinksHealth'
import { downloadTrackMetadataAndLyrics, saveTrackLrcFile, deleteTrackLrcFile } from './lyricsDownloader'

let mainWindow = null
let sidePanel = null
let notificationWindow = null
let overlayWindow = null
let isOverlayLoaded = false
let isGameOverlayEnabled = false
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
    show: false, // Ocultar hasta el primer pintado listo para evitar parpadeos y marco oscuro vacío
    icon: getAppIconPath(),
    webPreferences: {
      preload: getPreloadPath(),
      sandbox: false,
      webSecurity: false,
      backgroundThrottling: false // No pausar ni reducir rendimiento cuando se juega (ej. LoL)
    }
  })

  // Mostrar la ventana suavemente únicamente cuando el DOM y el CSS inicial estén completamente listos
  mainWindow.once('ready-to-show', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show()
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
    isGameOverlayEnabled = false
    try { discordRpc.setEnabled(false) } catch (_) {}
    if (sidePanel && !sidePanel.isDestroyed()) {
      try { sidePanel.destroy() } catch (_) {}
      sidePanel = null
    }
    if (notificationWindow && !notificationWindow.isDestroyed()) {
      try { notificationWindow.destroy() } catch (_) {}
      notificationWindow = null
    }
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      try { overlayWindow.destroy() } catch (_) {}
      overlayWindow = null
      isOverlayLoaded = false
    }
    if (tray && !tray.isDestroyed()) {
      try { tray.destroy() } catch (_) {}
      tray = null
    }
    app.quit()
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

const OVERLAY_WIDTH = 340
const OVERLAY_HEIGHT = 70

function syncStateToOverlayWindow() {
  if (!overlayWindow || overlayWindow.isDestroyed() || !isOverlayLoaded) return
  if (lastPlayerState) {
    overlayWindow.webContents.send('player-state-sync', {
      ...lastPlayerState,
      currentTime: lastCurrentTime,
      playlist: lastPlaylist
    })
  }
  overlayWindow.webContents.send('player-time-sync', lastCurrentTime)
}

function createOverlayWindow() {
  if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow
  const primaryDisplay = screen.getPrimaryDisplay()
  const { width } = primaryDisplay.workAreaSize
  const { x: dispX, y: dispY } = primaryDisplay.bounds

  isOverlayLoaded = false
  overlayWindow = new BrowserWindow({
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT,
    x: Math.round(dispX + (width - OVERLAY_WIDTH) / 2),
    y: dispY + 28,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    show: false,
    hasShadow: false,
    webPreferences: {
      preload: getPreloadPath(),
      sandbox: false,
      webSecurity: false,
      backgroundThrottling: false
    }
  })

  overlayWindow.setAlwaysOnTop(true, 'screen-saver', 1)
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  overlayWindow.webContents.on('did-finish-load', () => {
    isOverlayLoaded = true
    syncStateToOverlayWindow()
    if (isGameOverlayEnabled && overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.showInactive()
      overlayWindow.setAlwaysOnTop(true, 'screen-saver', 1)
    }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    overlayWindow.loadURL(process.env['ELECTRON_RENDERER_URL'] + '#/overlay')
  } else {
    overlayWindow.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: '/overlay' })
  }

  overlayWindow.on('closed', () => {
    overlayWindow = null
    isOverlayLoaded = false
  })

  return overlayWindow
}

function setGameOverlayState(targetEnabled) {
  isGameOverlayEnabled = Boolean(targetEnabled)

  if (isGameOverlayEnabled) {
    createOverlayWindow()
    if (isOverlayLoaded && overlayWindow && !overlayWindow.isDestroyed()) {
      syncStateToOverlayWindow()
      overlayWindow.showInactive()
      overlayWindow.setAlwaysOnTop(true, 'screen-saver', 1)
    }
  } else {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.hide()
    }
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('game-overlay-status-changed', isGameOverlayEnabled)
  }

  return isGameOverlayEnabled
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

// Configuración del directorio de música (Enlaces duros en canciones_organizadas -> Archivos maestros en Canciones_reales)
const CONFIGURED_MUSIC_DIR = 'C:\\Users\\barre\\Music\\canciones_organizadas'
const CONFIGURED_REAL_MUSIC_DIR = 'C:\\Users\\barre\\Music\\Canciones_reales'

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

async function getRealMusicDirectory() {
  try {
    await fs.promises.access(CONFIGURED_REAL_MUSIC_DIR)
    return CONFIGURED_REAL_MUSIC_DIR
  } catch (_) {}

  const defaultRealMusic = path.join(app.getPath('music'), 'Canciones_reales')
  try {
    await fs.promises.access(defaultRealMusic)
    return defaultRealMusic
  } catch (_) {}

  return CONFIGURED_REAL_MUSIC_DIR
}

/**
 * Busca en Canciones_reales el archivo maestro que comparte el mismo inodo NTFS (stats.ino)
 * que el enlace duro en canciones_organizadas.
 */
async function findRealMusicFilesByInode(targetIno, fallbackFileName) {
  const realDir = await getRealMusicDirectory()
  try {
    await fs.promises.access(realDir)
  } catch (_) {
    return []
  }

  const matches = []
  const resolvedRealDir = path.resolve(realDir).toLowerCase()

  // 1. Vía rápida O(1): comprobar si existe con el mismo nombre de archivo directamente en Canciones_reales
  if (fallbackFileName) {
    const directCandidate = path.join(realDir, fallbackFileName)
    try {
      const st = await fs.promises.stat(directCandidate, { bigint: true })
      if (st.isFile()) {
        if (targetIno && targetIno > 0n && st.ino === targetIno) {
          return [{ path: directCandidate, nlink: Number(st.nlink || 1) }]
        }
      }
    } catch (_) {}
  }

  // 2. Búsqueda recursiva por inodo NTFS (por si el archivo fue renombrado o está en subcarpetas dentro de Canciones_reales)
  if (!targetIno || targetIno <= 0n) return matches

  async function walk(currentDir) {
    let entries = []
    try {
      entries = await fs.promises.readdir(currentDir, { withFileTypes: true })
    } catch (_) {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const fullPath = path.join(currentDir, entry.name)
      if (entry.isDirectory()) {
        await walk(fullPath)
      } else if (entry.isFile()) {
        try {
          const st = await fs.promises.stat(fullPath, { bigint: true })
          if (st.ino === targetIno && path.resolve(fullPath).toLowerCase().startsWith(resolvedRealDir)) {
            matches.push({ path: fullPath, nlink: Number(st.nlink || 1) })
          }
        } catch (_) {}
      }
    }
  }

  await walk(realDir)
  return matches
}

async function unlinkWithRetry(targetPath, maxRetries = 3, delayMs = 80) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await fs.promises.unlink(targetPath)
      return { success: true }
    } catch (err) {
      if (err.code === 'ENOENT') {
        return { success: true }
      }
      if (attempt < maxRetries && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')) {
        await new Promise((r) => setTimeout(r, delayMs * attempt))
      } else {
        return { success: false, error: err.message }
      }
    }
  }
  return { success: false, error: 'No se pudo eliminar el archivo' }
}

/**
 * Elimina un enlace duro (Hard Link) en canciones_organizadas usando fs.promises.unlink.
 * NO toca el archivo original en Canciones_reales salvo que este enlace sea el último
 * enlace duro en la biblioteca (o se indique forceDeleteMaster), en cuyo caso también
 * elimina el archivo maestro en Canciones_reales.
 */
async function unlinkHardLinkAndCleanupMaster(filePath, { forceDeleteMaster = false } = {}) {
  const normalizedPath = path.normalize(filePath)
  let targetIno = 0n
  let nlinkBefore = 1
  const fileName = path.basename(normalizedPath)

  try {
    const st = await fs.promises.stat(normalizedPath, { bigint: true })
    targetIno = st.ino || 0n
    nlinkBefore = Number(st.nlink || 1)
  } catch (err) {
    return { success: false, error: 'El enlace o archivo ya no existe en el disco' }
  }

  // 1. Eliminar exclusivamente el enlace en canciones_organizadas con reintentos para bloqueos transitorios en Windows
  const unlinkRes = await unlinkWithRetry(normalizedPath)
  if (!unlinkRes.success) {
    return { success: false, error: unlinkRes.error || 'No se pudo eliminar el enlace duro' }
  }

  removeFromMetadataCache(normalizedPath)
  removeFromMetadataCache(filePath)

  // 2. Si era el último enlace en canciones_organizadas (nlinkBefore <= 2: 1 en canciones_organizadas + 1 en Canciones_reales)
  // o si se solicitó eliminar de todos lados (forceDeleteMaster), verificar y borrar el original en Canciones_reales
  let masterDeleted = false
  const deletedMasterPaths = []

  if (nlinkBefore <= 2 || forceDeleteMaster) {
    try {
      const realMatches = await findRealMusicFilesByInode(targetIno, fileName)
      for (const match of realMatches) {
        // Solo borrar en Canciones_reales si ya no le queda ningún otro enlace en canciones_organizadas (nlink <= 1) o forceDeleteMaster
        if (match.nlink <= 1 || forceDeleteMaster) {
          const masterUnlinkRes = await unlinkWithRetry(match.path)
          if (masterUnlinkRes.success) {
            removeFromMetadataCache(match.path)
            masterDeleted = true
            deletedMasterPaths.push(match.path)
            console.log(`[HardLink] Último enlace eliminado -> Archivo maestro eliminado en Canciones_reales: ${match.path}`)
          } else {
            console.warn(`[HardLink] No se pudo eliminar el archivo maestro en ${match.path}:`, masterUnlinkRes.error)
          }
        }
      }
    } catch (err) {
      console.warn('[HardLink] Error verificando archivo maestro en Canciones_reales:', err.message)
    }
  }

  return {
    success: true,
    masterDeleted,
    deletedMasterPaths
  }
}

/**
 * Mueve o renombra una carpeta de álbum preservando siempre los Hard Links hacia Canciones_reales:
 * 1. Intenta fs.promises.rename (en Windows NTFS conserva el vínculo al archivo original al 100%).
 * 2. Si falla (ej. bloqueo temporal de carpeta en Windows), recrea la estructura creando un nuevo
 *    Hard Link (fs.promises.link) en la carpeta destino y borrando el enlace viejo (fs.promises.unlink).
 */
async function moveDirectoryPreservingHardLinks(srcDir, destDir) {
  try {
    await fs.promises.rename(srcDir, destDir)
    return
  } catch (firstRenameErr) {
    // Breve espera por si el watcher o Windows Explorer tenían un handle abierto
    await new Promise((r) => setTimeout(r, 60))
    try {
      await fs.promises.rename(srcDir, destDir)
      return
    } catch (_) {
      // Fallback explícito mediante fs.link (nuevo enlace duro) + fs.unlink (borrar enlace viejo)
      await relinkDirectoryRecursive(srcDir, destDir)
    }
  }
}

async function relinkDirectoryRecursive(srcDir, destDir) {
  await fs.promises.mkdir(destDir, { recursive: true })
  const entries = await fs.promises.readdir(srcDir, { withFileTypes: true })

  for (const entry of entries) {
    const srcEntryPath = path.join(srcDir, entry.name)
    const destEntryPath = path.join(destDir, entry.name)

    if (entry.isDirectory()) {
      await relinkDirectoryRecursive(srcEntryPath, destEntryPath)
    } else {
      // Crear el nuevo Hard Link apuntando al mismo inodo del archivo original y luego borrar el enlace antiguo
      try {
        await fs.promises.link(srcEntryPath, destEntryPath)
      } catch (linkErr) {
        if (linkErr.code === 'EEXIST') {
          await fs.promises.unlink(destEntryPath)
          await fs.promises.link(srcEntryPath, destEntryPath)
        } else if (linkErr.code === 'EXDEV') {
          await fs.promises.copyFile(srcEntryPath, destEntryPath)
        } else {
          throw linkErr
        }
      }
      await fs.promises.unlink(srcEntryPath)
      removeFromMetadataCache(srcEntryPath)
    }
  }

  await fs.promises.rmdir(srcDir)
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
        // Crear un nuevo Hard Link apuntando al mismo inodo del archivo real en Canciones_reales
        try {
          await fs.promises.link(sourceTrackPath, destPath)
        } catch (linkErr) {
          if (linkErr.code === 'EEXIST') {
            await fs.promises.unlink(destPath)
            await fs.promises.link(sourceTrackPath, destPath)
          } else if (linkErr.code === 'EXDEV') {
            await fs.promises.copyFile(sourceTrackPath, destPath)
          } else {
            throw linkErr
          }
        }
        copiedAlbums.push({ id: album.id, name: album.name, destPath })
      }
    } catch (err) {
      console.error(`Error enlazando pista a ${album.path}:`, err.message)
    }
  }

  const musicDir = selectedDirectory || await getMusicDirectory()
  const userDataDir = app.getPath('userData')
  const library = await scanMusicDirectory(musicDir, userDataDir)
  return { success: true, copiedAlbums, library }
})

ipcMain.handle('delete-track-file', async (_, { filePath, forceDeleteMaster = false, skipScan = false, selectedDirectory }) => {
  if (!filePath || typeof filePath !== 'string') {
    return { success: false, error: 'Ruta de archivo inválida' }
  }

  const res = await unlinkHardLinkAndCleanupMaster(filePath, { forceDeleteMaster: Boolean(forceDeleteMaster) })
  if (!res.success) {
    return { success: false, error: res.error || 'No se pudo eliminar el enlace de la pista' }
  }

  if (skipScan) {
    return {
      success: true,
      masterDeleted: res.masterDeleted,
      deletedMasterPaths: res.deletedMasterPaths
    }
  }

  const musicDir = selectedDirectory || await getMusicDirectory()
  const userDataDir = app.getPath('userData')
  const library = await scanMusicDirectory(musicDir, userDataDir)
  return {
    success: true,
    masterDeleted: res.masterDeleted,
    deletedMasterPaths: res.deletedMasterPaths,
    library
  }
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
  const writtenInodes = new Set()
  const validNormalizedPaths = []
  const tags = {}
  if (typeof title === 'string') tags.title = title.trim()
  if (typeof artist === 'string') tags.artist = artist.trim()
  if (typeof album === 'string') tags.album = album.trim()

  for (const rawPath of targetPaths) {
    try {
      if (!fs.existsSync(rawPath)) continue
      const normalizedPath = path.normalize(rawPath)
      validNormalizedPaths.push(normalizedPath)
      const ext = path.extname(normalizedPath).toLowerCase()
      if (ext === '.mp3') {
        let ino = 0n
        try {
          const st = await fs.promises.stat(normalizedPath, { bigint: true })
          ino = st.ino || 0n
        } catch (_) {}

        // Al ser Hard Links al mismo archivo en Canciones_reales, escribir una sola vez por inodo actualiza todos los enlaces
        if (!ino || !writtenInodes.has(ino)) {
          NodeID3.update(tags, normalizedPath)
          if (ino) writtenInodes.add(ino)
        }
      }

      removeFromMetadataCache(normalizedPath)
      removeFromMetadataCache(rawPath)
      updatedCount++
    } catch (tagErr) {
      console.warn(`Aviso al actualizar tags en ${rawPath}:`, tagErr.message)
    }
  }

  // --- Sincronización de inodos con Canciones_reales ante edición ID3 ---
  try {
    const realDir = await getRealMusicDirectory()
    if (realDir && fs.existsSync(realDir) && validNormalizedPaths.length > 0) {
      const primaryPath = validNormalizedPaths[0]
      const primaryFileName = path.basename(primaryPath)
      const primaryExt = path.extname(primaryPath).toLowerCase()

      // Obtener el inodo actual del archivo en canciones_organizadas
      let currentIno = 0n
      try {
        const pst = await fs.promises.stat(primaryPath, { bigint: true })
        currentIno = pst.ino || 0n
      } catch (_) {}

      // Buscar archivo maestro correspondiente en Canciones_reales
      let masterPath = null
      let masterIno = 0n

      // 1. Vía directa: por mismo nombre de archivo en Canciones_reales
      const directCandidate = path.join(realDir, primaryFileName)
      if (fs.existsSync(directCandidate)) {
        masterPath = directCandidate
        try {
          const mst = await fs.promises.stat(directCandidate, { bigint: true })
          masterIno = mst.ino || 0n
        } catch (_) {}
      }

      // 2. Si no se encontró por nombre, buscar por inodo NTFS en Canciones_reales
      if (!masterPath && currentIno && currentIno > 0n) {
        const matches = await findRealMusicFilesByInode(currentIno, null)
        if (matches && matches.length > 0) {
          masterPath = matches[0].path
          masterIno = currentIno
        }
      }

      if (masterPath) {
        removeFromMetadataCache(masterPath)

        if (primaryExt === '.mp3') {
          // Si el inodo es diferente (desincronizado por ediciones independientes o copias antiguas),
          // unificar y re-vincular para garantizar inodo 100% compartido entre Canciones_reales y canciones_organizadas
          if (masterIno && currentIno && masterIno !== currentIno) {
            console.log(`[ID3 Sync] Sincronizando inodos divergentes con Canciones_reales: ${masterPath}`)
            NodeID3.update(tags, masterPath)

            // Re-enlazar todas las instancias de canciones_organizadas al archivo maestro unificado
            for (const orgPath of validNormalizedPaths) {
              try {
                await unlinkWithRetry(orgPath)
                await fs.promises.link(masterPath, orgPath)
                removeFromMetadataCache(orgPath)
              } catch (relinkErr) {
                console.warn(`[ID3 Sync] Aviso al re-enlazar inodo en ${orgPath}:`, relinkErr.message)
              }
            }
          } else if (!writtenInodes.has(masterIno)) {
            NodeID3.update(tags, masterPath)
          }
        }
      } else {
        // Si aún no existía en Canciones_reales, crear un Hard Link hacia Canciones_reales como archivo maestro
        try {
          const newMaster = path.join(realDir, primaryFileName)
          await fs.promises.link(primaryPath, newMaster)
          removeFromMetadataCache(newMaster)
          console.log(`[ID3 Sync] Nuevo archivo maestro enlazado en Canciones_reales: ${newMaster}`)
        } catch (createMasterErr) {
          console.warn('[ID3 Sync] No se pudo crear enlace maestro en Canciones_reales:', createMasterErr.message)
        }
      }
    }
  } catch (syncErr) {
    console.warn('[ID3 Sync] Error durante la sincronización de inodos con Canciones_reales:', syncErr.message)
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

    // 1. Buscar archivo .lrc o .txt externo en el mismo directorio del álbum o en Canciones_reales
    const realMusicDir = await getRealMusicDirectory()
    const candidateFiles = [
      path.join(dir, `${baseName}.lrc`),
      path.join(dir, `${baseName}.LRC`),
      path.join(dir, `${baseName}.txt`),
      path.join(realMusicDir, `${baseName}.lrc`),
      path.join(realMusicDir, `${baseName}.LRC`),
      path.join(realMusicDir, `${baseName}.txt`)
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
  const baseTarget = parentDir && typeof parentDir === 'string' && parentDir !== '__ROOT__' ? parentDir : musicDir
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

ipcMain.handle('create-folder', async (_, { folderName, parentDir, selectedDirectory }) => {
  if (!folderName || typeof folderName !== 'string') {
    return { success: false, error: 'Nombre de carpeta inválido' }
  }

  const sanitized = folderName
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (!sanitized || sanitized.startsWith('.')) {
    return { success: false, error: 'Ingresa un nombre válido para la carpeta padre' }
  }

  const musicDir = selectedDirectory || await getMusicDirectory()
  const baseTarget = parentDir && typeof parentDir === 'string' && parentDir !== '__ROOT__' ? parentDir : musicDir
  const newFolderPath = path.join(baseTarget, sanitized)

  try {
    await fs.promises.access(newFolderPath)
    return { success: false, error: 'Ya existe una carpeta con ese nombre' }
  } catch (_) {}

  try {
    await fs.promises.mkdir(newFolderPath, { recursive: true })
    // Crear marcador explícito para que el escáner la reconozca como carpeta padre contenedora de álbumes
    await fs.promises.writeFile(path.join(newFolderPath, '.parent_folder'), '', 'utf8')
  } catch (err) {
    return { success: false, error: err.message || 'No se pudo crear la carpeta padre' }
  }

  const userDataDir = app.getPath('userData')
  const library = await scanMusicDirectory(musicDir, userDataDir)
  return {
    success: true,
    folderId: newFolderPath,
    folderPath: newFolderPath,
    folderName: sanitized,
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
    await moveDirectoryPreservingHardLinks(resolvedSource, resolvedDest)
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
    await moveDirectoryPreservingHardLinks(resolvedPath, destPath)
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
    // Desenlazar cada archivo con fs.unlink y limpiar en Canciones_reales solo aquellos cuyo último enlace estaba en este álbum
    async function unlinkFolderContents(dirPath) {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name)
        if (entry.isDirectory()) {
          await unlinkFolderContents(fullPath)
        } else {
          await unlinkHardLinkAndCleanupMaster(fullPath)
        }
      }
    }

    await unlinkFolderContents(resolvedPath)
    await fs.promises.rm(resolvedPath, { recursive: true, force: true })
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
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('player-state-sync', state)
  }
  if (mainWindow && !mainWindow.isDestroyed() && event.sender !== mainWindow.webContents) {
    mainWindow.webContents.send('player-state-sync', state)
  }

  // Actualizar Discord Rich Presence
  if (state && (state.currentTrack !== undefined || state.isPlaying !== undefined)) {
    discordRpc.updateTrack(state.currentTrack, state.isPlaying, lastCurrentTime)
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
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('player-time-sync', time)
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
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.webContents.send('player-command', command)
  }
  if (notificationWindow && !notificationWindow.isDestroyed()) {
    notificationWindow.webContents.send('player-command', command)
  }
})

ipcMain.handle('toggle-main-always-on-top', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false
  const currentState = mainWindow.isAlwaysOnTop()
  const newState = !currentState
  mainWindow.setAlwaysOnTop(newState, 'pop-up-menu')
  if (sidePanel && !sidePanel.isDestroyed() && (isSidePanelExpanded || isMarkerShowing)) {
    sidePanel.setAlwaysOnTop(true, 'screen-saver', 2)
    sidePanel.moveTop()
  }
  mainWindow.webContents.send('always-on-top-status-changed', newState)
  return newState
})

ipcMain.handle('set-main-always-on-top', (_, enabled) => {
  if (!mainWindow || mainWindow.isDestroyed()) return false
  const newState = Boolean(enabled)
  mainWindow.setAlwaysOnTop(newState, 'pop-up-menu')
  if (sidePanel && !sidePanel.isDestroyed() && (isSidePanelExpanded || isMarkerShowing)) {
    sidePanel.setAlwaysOnTop(true, 'screen-saver', 2)
    sidePanel.moveTop()
  }
  mainWindow.webContents.send('always-on-top-status-changed', newState)
  return newState
})

ipcMain.handle('get-main-always-on-top', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return false
  return mainWindow.isAlwaysOnTop()
})

// --- Ajustes Avanzados: Extractor, Hard Links, Letras, Discord RPC y HUD Overlay ---

ipcMain.handle('launch-extractor', async (_, payload) => {
  const url = payload?.url
  if (url && typeof url === 'string') {
    clipboard.writeText(url)
  }

  const possiblePaths = [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Extractor_Musica', 'Extractor_Musica.exe'),
    'C:\\Users\\barre\\AppData\\Local\\Programs\\Extractor_Musica\\Extractor_Musica.exe',
    'C:\\Users\\barre\\PyCharmMiscProject\\Extractor_Musica\\dist\\Extractor_Musica_Portable\\Extractor_Musica.exe'
  ]

  for (const exePath of possiblePaths) {
    try {
      await fs.promises.access(exePath)
      const child = spawn(exePath, [], { detached: true, stdio: 'ignore' })
      child.unref()
      return { success: true, method: 'exe', path: exePath }
    } catch (_) {}
  }

  // Fallback a script Python en PyCharmMiscProject
  const pythonPath = 'C:\\Users\\barre\\PyCharmMiscProject\\Extractor_Musica\\.venv\\Scripts\\python.exe'
  const scriptPath = 'C:\\Users\\barre\\PyCharmMiscProject\\Extractor_Musica\\main.py'
  try {
    await fs.promises.access(pythonPath)
    await fs.promises.access(scriptPath)
    const child = spawn(pythonPath, [scriptPath], {
      cwd: 'C:\\Users\\barre\\PyCharmMiscProject\\Extractor_Musica',
      detached: true,
      stdio: 'ignore'
    })
    child.unref()
    return { success: true, method: 'python' }
  } catch (err) {
    return { success: false, error: 'No se encontró el ejecutable ni el entorno de Extractor_Musica' }
  }
})

ipcMain.handle('check-hardlinks-health', async () => {
  const musicDir = await getMusicDirectory()
  const realMusicDir = await getRealMusicDirectory()
  return await runHardlinksHealthCheck(musicDir, realMusicDir)
})

ipcMain.handle('repair-hardlinks-integrity', async () => {
  const musicDir = await getMusicDirectory()
  const realMusicDir = await getRealMusicDirectory()
  const repairRes = await repairHardlinksIntegrity(musicDir, realMusicDir)
  const userDataDir = app.getPath('userData')
  const library = await scanMusicDirectory(musicDir, userDataDir)
  return { ...repairRes, library }
})

ipcMain.handle('fetch-track-lyrics-online', async (_, { trackPath, title, artist, duration, saveToDisk = false, bypassCache = false }) => {
  const res = await downloadTrackMetadataAndLyrics(trackPath, title, artist, duration, {
    saveToDisk: Boolean(saveToDisk),
    bypassCache: Boolean(bypassCache)
  })
  if (res?.lyricsFound && res.lyrics) {
    return {
      ...res,
      parsed: parseLrcText(res.lyrics)
    }
  }
  return res
})

ipcMain.handle('save-track-lrc', async (_, { trackPath, lyricsText }) => {
  removeFromMetadataCache(trackPath)
  const realMusicDir = await getRealMusicDirectory()
  const res = await saveTrackLrcFile(trackPath, lyricsText, realMusicDir)
  removeFromMetadataCache(trackPath)
  return res
})

ipcMain.handle('delete-track-lrc', async (_, { trackPath }) => {
  removeFromMetadataCache(trackPath)
  const realMusicDir = await getRealMusicDirectory()
  const res = await deleteTrackLrcFile(trackPath, realMusicDir)
  removeFromMetadataCache(trackPath)
  return res
})

ipcMain.handle('batch-download-lyrics', async () => {
  const musicDir = await getMusicDirectory()
  const userDataDir = app.getPath('userData')
  const library = await scanMusicDirectory(musicDir, userDataDir)

  const allTracks = []
  function collect(nodes) {
    if (!Array.isArray(nodes)) return
    for (const n of nodes) {
      if (n.type === 'album' && Array.isArray(n.tracks)) {
        for (const t of n.tracks) {
          if (!t.hasLyrics && t.path) allTracks.push(t)
        }
      }
      if (n.children) collect(n.children)
    }
  }
  collect(library)

  let downloadedCount = 0
  const limit = Math.min(allTracks.length, 30)
  for (let i = 0; i < limit; i++) {
    const t = allTracks[i]
    try {
      const res = await downloadTrackMetadataAndLyrics(t.path, t.title, t.artist, t.duration, { saveToDisk: true })
      if (res?.lyricsFound) downloadedCount++
      await new Promise((r) => setTimeout(r, 100))
    } catch (_) {}
  }

  const updatedLibrary = await scanMusicDirectory(musicDir, userDataDir)
  return { success: true, totalScanned: limit, downloadedCount, library: updatedLibrary }
})

ipcMain.handle('set-discord-rpc', (_, enabled) => {
  discordRpc.setEnabled(enabled)
  if (lastPlayerState?.currentTrack) {
    discordRpc.updateTrack(lastPlayerState.currentTrack, lastPlayerState.isPlaying, lastCurrentTime)
  }
  return discordRpc.getStatus()
})

ipcMain.handle('get-discord-rpc-status', () => {
  return discordRpc.getStatus()
})

ipcMain.handle('toggle-game-overlay', (_, enabled) => {
  const nextState = typeof enabled === 'boolean' ? enabled : !isGameOverlayEnabled
  return setGameOverlayState(nextState)
})

ipcMain.handle('get-game-overlay-status', () => {
  return Boolean(isGameOverlayEnabled && overlayWindow && !overlayWindow.isDestroyed() && overlayWindow.isVisible())
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
    togglePanel: () => toggleSidePanel(),
    toggleOverlay: () => setGameOverlayState(!isGameOverlayEnabled),
    restoreMainWindow: () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.show()
        mainWindow.focus()
      }
    },
    toggleAlwaysOnTop: () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        const nextState = !mainWindow.isAlwaysOnTop()
        mainWindow.setAlwaysOnTop(nextState, 'pop-up-menu')
        if (sidePanel && !sidePanel.isDestroyed() && (isSidePanelExpanded || isMarkerShowing)) {
          sidePanel.setAlwaysOnTop(true, 'screen-saver', 2)
          sidePanel.moveTop()
        }
        mainWindow.webContents.send('always-on-top-status-changed', nextState)
      }
    }
  }

  registerHotkeys(hotkeyActions)
})

app.on('will-quit', () => {
  isGameOverlayEnabled = false
  try { discordRpc.setEnabled(false) } catch (_) {}
  if (dirWatcher) {
    try { dirWatcher.close() } catch (_) {}
    dirWatcher = null
  }
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    try { overlayWindow.destroy() } catch (_) {}
    overlayWindow = null
  }
  if (sidePanel && !sidePanel.isDestroyed()) {
    try { sidePanel.destroy() } catch (_) {}
    sidePanel = null
  }
  if (notificationWindow && !notificationWindow.isDestroyed()) {
    try { notificationWindow.destroy() } catch (_) {}
    notificationWindow = null
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
