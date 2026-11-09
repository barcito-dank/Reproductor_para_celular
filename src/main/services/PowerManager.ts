import os from 'os'
import { powerSaveBlocker } from 'electron'
import { Logger } from './Logger'

export class PowerManager {
  private static powerSaveBlockerId: number | null = null

  /**
   * Eleva la prioridad del proceso de Electron en el sistema operativo a PRIORITY_ABOVE_NORMAL
   * para prevenir interrupciones o micro-cortes de audio cuando la CPU está bajo carga intensiva.
   */
  public static boostProcessPriority(): void {
    try {
      os.setPriority(os.constants.priority.PRIORITY_ABOVE_NORMAL)
      Logger.info('PowerManager', 'Prioridad de proceso Main elevada a PRIORITY_ABOVE_NORMAL')
    } catch (err: any) {
      Logger.warn('PowerManager', `No se pudo elevar la prioridad del proceso Main: ${err?.message}`)
    }
  }

  /**
   * Eleva la prioridad del proceso Renderer (hilo de audio/Web Audio API) para blindarlo
   * contra EcoQoS / Efficiency Mode de Windows 11 cuando la app corre en segundo plano o minimizada.
   */
  public static boostRendererPriority(pid: number): void {
    try {
      if (pid && pid > 0) {
        os.setPriority(pid, os.constants.priority.PRIORITY_ABOVE_NORMAL)
        Logger.info('PowerManager', `Prioridad del proceso Renderer (PID ${pid}) elevada a PRIORITY_ABOVE_NORMAL`)
      }
    } catch (err: any) {
      Logger.warn('PowerManager', `No se pudo elevar la prioridad del proceso Renderer ${pid}: ${err?.message}`)
    }
  }

  /**
   * Sincroniza dinámicamente el bloqueo de suspensión del sistema operativo (powerSaveBlocker).
   * Mantiene la app despierta mientras haya reproducción de audio activa.
   */
  public static syncPowerSaveBlocker(isPlaying: boolean): void {
    try {
      if (isPlaying) {
        if (this.powerSaveBlockerId === null || !powerSaveBlocker.isStarted(this.powerSaveBlockerId)) {
          this.powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension')
          Logger.info('PowerManager', `powerSaveBlocker activado (ID: ${this.powerSaveBlockerId})`)
        }
      } else {
        if (this.powerSaveBlockerId !== null && powerSaveBlocker.isStarted(this.powerSaveBlockerId)) {
          powerSaveBlocker.stop(this.powerSaveBlockerId)
          Logger.info('PowerManager', 'powerSaveBlocker detenido (reproducción pausada)')
          this.powerSaveBlockerId = null
        }
      }
    } catch (err: any) {
      Logger.warn('PowerManager', `Error gestionando powerSaveBlocker: ${err?.message}`)
    }
  }

  /**
   * Libera cualquier bloqueo activo antes del cierre de la aplicación.
   */
  public static cleanup(): void {
    if (this.powerSaveBlockerId !== null) {
      try {
        if (powerSaveBlocker.isStarted(this.powerSaveBlockerId)) {
          powerSaveBlocker.stop(this.powerSaveBlockerId)
        }
      } catch (_) {}
      this.powerSaveBlockerId = null
    }
  }
}
