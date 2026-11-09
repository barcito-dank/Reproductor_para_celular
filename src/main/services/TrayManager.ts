import { Tray, Menu, app, BrowserWindow } from 'electron'
import fs from 'fs'
import { Logger } from './Logger'

export interface TrayCallbacks {
  onTogglePlay: () => void
  onNext: () => void
  onPrevious: () => void
  onRestore: () => void
  onQuit: () => void
}

export class TrayManager {
  private static tray: Tray | null = null
  private static callbacks: TrayCallbacks | null = null

  public static init(iconPath: string | undefined, callbacks: TrayCallbacks): void {
    if (this.tray) return
    if (!iconPath || !fs.existsSync(iconPath)) {
      Logger.warn('TrayManager', `No se encontró el icono para la bandeja del sistema: ${iconPath}`)
      return
    }

    this.callbacks = callbacks
    try {
      this.tray = new Tray(iconPath)
      this.tray.setToolTip('Reproductor de Música')
      this.updateMenu(null)

      this.tray.on('click', () => {
        this.callbacks?.onRestore()
      })
      Logger.info('TrayManager', 'Bandeja del sistema inicializada correctamente')
    } catch (err: any) {
      Logger.warn('TrayManager', `Error creando Tray: ${err?.message}`)
    }
  }

  public static updateMenu(playerState: { isPlaying?: boolean; currentTrack?: { title?: string; artist?: string } } | null): void {
    if (!this.tray || this.tray.isDestroyed()) return

    const isPlaying = playerState?.isPlaying ?? false
    const track = playerState?.currentTrack
    const trackTitle = track?.title
      ? `${track.title} — ${track.artist || 'Artista'}`
      : 'Reproductor de Música'

    const contextMenu = Menu.buildFromTemplate([
      {
        label: trackTitle.length > 36 ? trackTitle.slice(0, 36) + '…' : trackTitle,
        enabled: false
      },
      { type: 'separator' },
      {
        label: isPlaying ? '⏸ Pausar' : '▶ Reproducir',
        click: () => this.callbacks?.onTogglePlay()
      },
      {
        label: '⏭ Siguiente',
        click: () => this.callbacks?.onNext()
      },
      {
        label: '⏮ Anterior',
        click: () => this.callbacks?.onPrevious()
      },
      { type: 'separator' },
      {
        label: 'Mostrar reproductor',
        click: () => this.callbacks?.onRestore()
      },
      {
        label: 'Salir',
        click: () => {
          ;(app as any).isQuitting = true
          this.callbacks?.onQuit()
        }
      }
    ])

    this.tray.setContextMenu(contextMenu)
  }

  public static destroy(): void {
    if (this.tray && !this.tray.isDestroyed()) {
      try {
        this.tray.destroy()
      } catch (_) {}
      this.tray = null
    }
  }
}
