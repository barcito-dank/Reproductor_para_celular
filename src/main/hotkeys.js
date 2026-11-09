import fs from 'fs'
import path from 'path'
import { app, globalShortcut } from 'electron'

/**
 * Atajos de teclado por defecto
 */
export const DEFAULT_HOTKEYS = {
  restoreMainWindow: 'Ctrl+Shift+R',
  toggleAlwaysOnTop: 'Ctrl+Shift+F',
  togglePanel: 'Ctrl+Shift+M',
  toggleOverlay: 'Ctrl+Alt+H',
  playPause: 'Ctrl+Space',
  next: 'Ctrl+Right',
  previous: 'Ctrl+Left',
  volumeUp: 'Ctrl+Up',
  volumeDown: 'Ctrl+Down'
}

/**
 * Atajos secundarios / multimedia que siempre se registran en paralelo como respaldo
 */
export const SECONDARY_HOTKEYS = {
  restoreMainWindow: ['Ctrl+Alt+R'],
  toggleAlwaysOnTop: ['Ctrl+Alt+F', 'Ctrl+Shift+T'],
  togglePanel: ['Ctrl+Alt+M'],
  toggleOverlay: ['Ctrl+Shift+H'],
  playPause: ['MediaPlayPause', 'Ctrl+Shift+Space', 'Ctrl+Alt+Space'],
  next: ['MediaNextTrack', 'Ctrl+Alt+Right'],
  previous: ['MediaPreviousTrack', 'Ctrl+Alt+Left'],
  volumeUp: ['Ctrl+Alt+Up', 'Ctrl+Shift+Up', 'VolumeUp'],
  volumeDown: ['Ctrl+Alt+Down', 'Ctrl+Shift+Down', 'VolumeDown']
}

export const BLOCKED_KEYS = ['F1', 'F2']

export const HOTKEY_METADATA = {
  restoreMainWindow: {
    category: 'window',
    title: 'Abrir / Restaurar Ventana Principal',
    desc: 'Restaura y enfoca la aplicación inmediatamente desde segundo plano o minimizada'
  },
  toggleAlwaysOnTop: {
    category: 'window',
    title: 'Fijar en Primer Plano (Always on Top)',
    desc: 'Alterna si el reproductor permanece siempre sobre las demás ventanas abiertas'
  },
  togglePanel: {
    category: 'window',
    title: 'Mini Panel Lateral Rápido',
    desc: 'Muestra u oculta la barra vertical del lateral derecho de tu pantalla'
  },
  toggleOverlay: {
    category: 'window',
    title: 'HUD / Widget Flotante de Juego',
    desc: 'Activa o esconde la mini cápsula flotante sobre videojuegos a pantalla completa'
  },
  playPause: {
    category: 'playback',
    title: 'Reproducir / Pausar',
    desc: 'Pausa o reanuda la música al instante'
  },
  next: {
    category: 'playback',
    title: 'Pista Siguiente',
    desc: 'Avanza a la próxima canción en la cola'
  },
  previous: {
    category: 'playback',
    title: 'Pista Anterior',
    desc: 'Vuelve a la canción anterior del historial'
  },
  volumeUp: {
    category: 'playback',
    title: 'Subir Volumen (+5%)',
    desc: 'Aumenta el volumen un 5% de forma global'
  },
  volumeDown: {
    category: 'playback',
    title: 'Bajar Volumen (-5%)',
    desc: 'Disminuye el volumen un 5% de forma global'
  }
}

let customHotkeys = { ...DEFAULT_HOTKEYS }
let registeredShortcuts = []
let activeActionsRef = null

function getConfigFile() {
  try {
    return path.join(app.getPath('userData'), 'hotkeys.json')
  } catch (_) {
    return null
  }
}

export function loadSavedHotkeys() {
  try {
    const file = getConfigFile()
    if (file && fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (data && typeof data === 'object') {
        customHotkeys = { ...DEFAULT_HOTKEYS, ...data }
      }
    }
  } catch (err) {
    console.warn('Aviso cargando hotkeys personalizadas:', err.message)
  }
  return customHotkeys
}

export function saveHotkeys(newMap) {
  try {
    customHotkeys = { ...DEFAULT_HOTKEYS, ...newMap }
    const file = getConfigFile()
    if (file) {
      fs.writeFileSync(file, JSON.stringify(customHotkeys, null, 2), 'utf8')
    }
  } catch (err) {
    console.warn('Aviso guardando hotkeys personalizadas:', err.message)
  }
}

export function getHotkeysConfig() {
  loadSavedHotkeys()
  const result = {}
  for (const [key, meta] of Object.entries(HOTKEY_METADATA)) {
    result[key] = {
      action: key,
      shortcut: customHotkeys[key] || DEFAULT_HOTKEYS[key],
      defaultShortcut: DEFAULT_HOTKEYS[key],
      ...meta
    }
  }
  return result
}

export function updateHotkey(action, accelerator, actions = activeActionsRef) {
  if (!HOTKEY_METADATA[action]) {
    return { success: false, error: 'Acción no válida' }
  }
  if (!accelerator || typeof accelerator !== 'string') {
    return { success: false, error: 'Combinación de teclas inválida' }
  }

  const trimmed = accelerator.trim()
  if (BLOCKED_KEYS.includes(trimmed.toUpperCase())) {
    return { success: false, error: 'Las teclas F1 y F2 están bloqueadas' }
  }
  customHotkeys[action] = trimmed
  saveHotkeys(customHotkeys)

  if (actions) {
    registerHotkeys(actions)
  }

  return { success: true, hotkeys: getHotkeysConfig() }
}

export function resetHotkeys(actions = activeActionsRef) {
  try {
    const file = getConfigFile()
    if (file && fs.existsSync(file)) {
      fs.unlinkSync(file)
    }
  } catch (_) {}

  customHotkeys = { ...DEFAULT_HOTKEYS }
  if (actions) {
    registerHotkeys(actions)
  }

  return { success: true, hotkeys: getHotkeysConfig() }
}

/**
 * Registra los atajos globales con las acciones proporcionadas.
 * Admite tanto el atajo configurado por el usuario como los atajos alternativos / multimedia.
 */
export function registerHotkeys(actions) {
  activeActionsRef = actions
  unregisterHotkeys()
  loadSavedHotkeys()

  for (const [action, actionFn] of Object.entries(actions)) {
    if (!actionFn) continue

    const primary = customHotkeys[action] || DEFAULT_HOTKEYS[action]
    const secondaryList = SECONDARY_HOTKEYS[action] || []
    const candidates = Array.from(new Set([primary, ...secondaryList].filter(Boolean)))

    for (const accelerator of candidates) {
      try {
        const success = globalShortcut.register(accelerator, actionFn)
        if (success) {
          registeredShortcuts.push(accelerator)
        } else {
          console.warn(`No se pudo registrar hotkey global: ${accelerator} para ${action}`)
        }
      } catch (err) {
        console.warn(`Error registrando hotkey ${accelerator}:`, err.message)
      }
    }
  }
  // Bloqueo explícito de teclas del sistema (F1 y F2) a nivel global
  for (const blockedKey of BLOCKED_KEYS) {
    try {
      const success = globalShortcut.register(blockedKey, () => {
        // Evento capturado y neutralizado para que Windows ni otras aplicaciones lo procesen
      })
      if (success) {
        registeredShortcuts.push(blockedKey)
      }
    } catch (_) {}
  }

  console.log(`[Hotkeys] ${registeredShortcuts.length} atajos globales activos.`)
}

/**
 * Desregistra todos los atajos globales.
 */
export function unregisterHotkeys() {
  globalShortcut.unregisterAll()
  registeredShortcuts = []
}
