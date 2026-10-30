import { globalShortcut } from 'electron'

/**
 * =============================================
 * CONFIGURACIÓN DE ATAJOS DE TECLADO GLOBALES
 * =============================================
 * 
 * Modifica estas constantes para cambiar los atajos.
 * Formato: Combinación de modificadores + tecla
 * Modificadores: Ctrl, Alt, Shift, Super/Meta
 * 
 * Ejemplos:
 *   'Ctrl+Right'       → Ctrl + Flecha Derecha
 *   'Alt+Shift+N'      → Alt + Shift + N
 *   'MediaNextTrack'   → Tecla multimedia Siguiente
 */
export const HOTKEY_CONFIG = {
  // Siguiente canción (Flecha, Multimedia o Ctrl+Alt para gamers)
  next: ['Ctrl+Right', 'MediaNextTrack', 'Ctrl+Alt+Right'],
  
  // Canción anterior
  previous: ['Ctrl+Left', 'MediaPreviousTrack', 'Ctrl+Alt+Left'],

  // Play / Pausa
  playPause: ['MediaPlayPause', 'Ctrl+Shift+Space', 'Ctrl+Alt+Space'],

  // Subir volumen (+5%)
  volumeUp: ['Ctrl+Up', 'Ctrl+Alt+Up'],

  // Bajar volumen (-5%)
  volumeDown: ['Ctrl+Down', 'Ctrl+Alt+Down'],
  
  // Mostrar/ocultar panel lateral
  togglePanel: ['Ctrl+Shift+M', 'Ctrl+Alt+M']
}

let registeredShortcuts = []

/**
 * Registra los atajos globales con las acciones proporcionadas.
 * Admite tanto un único acelerador como un arreglo de alternativas.
 * @param {Object} actions - { next: fn, previous: fn, playPause: fn, volumeUp: fn, volumeDown: fn, togglePanel: fn }
 */
export function registerHotkeys(actions) {
  unregisterHotkeys()

  for (const [action, accelerators] of Object.entries(HOTKEY_CONFIG)) {
    const actionFn = actions[action]
    if (!actionFn) continue

    const list = Array.isArray(accelerators) ? accelerators : [accelerators]
    for (const accelerator of list) {
      try {
        const success = globalShortcut.register(accelerator, actionFn)
        if (success) {
          registeredShortcuts.push(accelerator)
          console.log(`Hotkey registrado: ${accelerator} → ${action}`)
        } else {
          console.warn(`No se pudo registrar hotkey: ${accelerator}`)
        }
      } catch (err) {
        console.warn(`Error registrando hotkey ${accelerator}:`, err.message)
      }
    }
  }
}

/**
 * Desregistra todos los atajos globales.
 */
export function unregisterHotkeys() {
  globalShortcut.unregisterAll()
  registeredShortcuts = []
}
