import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import { App } from '@capacitor/app'

export interface LoadTrackOptions {
  url: string
  filePath: string
  title: string
  artist: string
  album: string
  coverUrl?: string
  duration?: number
  autoPlay?: boolean
}

export interface NativePlaybackState {
  isPlaying: boolean
  currentTime: number
  duration: number
}

export type NativeAudioEventName =
  | 'playbackProgress'
  | 'trackEnded'
  | 'remoteCommand'
  | 'playbackStateChanged'

export interface NativeRemoteCommandPayload {
  command?: 'play' | 'pause' | 'togglePlay' | 'next' | 'previous' | 'seekTo' | string
  action?: string
  position?: number
  seekTime?: number
}

export interface NativePlaybackProgressPayload {
  currentTime: number
  duration?: number
  isPlaying?: boolean
}

export interface NativePlaybackStateChangedPayload {
  isPlaying: boolean
  currentTime?: number
  duration?: number
}

export interface NativeAudioPluginInterface {
  loadTrack(options: LoadTrackOptions): Promise<void>
  play(): Promise<void>
  pause(): Promise<void>
  seekTo(options: { position: number }): Promise<void>
  setVolume(options: { volume: number }): Promise<void>
  setEqualizerBands(options: { gains: number[] }): Promise<void>
  getPlaybackState(): Promise<NativePlaybackState>
  addListener(
    eventName: NativeAudioEventName,
    listenerFunc: (data: any) => void
  ): Promise<PluginListenerHandle>
}

export const NativeAudioPlayer = registerPlugin<NativeAudioPluginInterface>('NativeAudioPlayer')

export interface PlayerSyncCallbacks {
  onTogglePlay?: () => void
  onPlay?: () => void
  onPause?: () => void
  onNext?: () => void
  onPrevious?: () => void
  onSeekTo?: (positionSeconds: number) => void
  onTrackEnded?: () => void
  onPlaybackProgress?: (currentTime: number, duration?: number) => void
  onStateReconcile?: (state: NativePlaybackState) => void
  getCurrentAudioState?: () => {
    isPlaying: boolean
    currentTime: number
    duration: number
  }
}

function isNativeAndroid(): boolean {
  try {
    return (
      typeof Capacitor !== 'undefined' &&
      typeof Capacitor.isNativePlatform === 'function' &&
      Capacitor.isNativePlatform()
    )
  } catch (_) {
    return false
  }
}

class NativeAudioSyncManager {
  private isAppInBackground = false
  private lastSyncedTrackId: string | null = null

  public isNativePlatform(): boolean {
    return isNativeAndroid()
  }

  public isInBackground(): boolean {
    return this.isAppInBackground
  }

  /**
   * Carga metadatos y pista en el servicio nativo AndroidX Media3 / ExoPlayer + ForegroundService.
   */
  public async loadTrack(options: LoadTrackOptions & { id?: string }): Promise<void> {
    if (!isNativeAndroid()) return
    try {
      this.lastSyncedTrackId = options.id || options.filePath || options.url
      await NativeAudioPlayer.loadTrack({
        url: options.url,
        filePath: options.filePath,
        title: options.title || 'Canción',
        artist: options.artist || 'Artista Desconocido',
        album: options.album || '',
        coverUrl: options.coverUrl || undefined,
        duration: typeof options.duration === 'number' ? options.duration : 0,
        autoPlay: Boolean(options.autoPlay)
      })
    } catch (_) {
      // Silencioso si el plugin nativo aún no está compilado o en WebView de prueba
    }
  }

  public async play(): Promise<void> {
    if (!isNativeAndroid()) return
    try {
      await NativeAudioPlayer.play()
    } catch (_) {}
  }

  public async pause(): Promise<void> {
    if (!isNativeAndroid()) return
    try {
      await NativeAudioPlayer.pause()
    } catch (_) {}
  }

  public async syncPlayState(isPlaying: boolean): Promise<void> {
    if (!isNativeAndroid()) return
    try {
      if (isPlaying) {
        await NativeAudioPlayer.play()
      } else {
        await NativeAudioPlayer.pause()
      }
    } catch (_) {}
  }

  public async seekTo(positionSeconds: number): Promise<void> {
    if (!isNativeAndroid() || typeof positionSeconds !== 'number' || isNaN(positionSeconds)) return
    try {
      await NativeAudioPlayer.seekTo({ position: Math.max(0, positionSeconds) })
    } catch (_) {}
  }

  public async setVolume(volume: number): Promise<void> {
    if (!isNativeAndroid() || typeof volume !== 'number' || isNaN(volume)) return
    try {
      const clamped = Math.max(0, Math.min(1, volume))
      await NativeAudioPlayer.setVolume({ volume: clamped })
    } catch (_) {}
  }

  public async setEqualizerBands(gains: number[], enabled = true): Promise<void> {
    if (!isNativeAndroid() || !Array.isArray(gains)) return
    try {
      const effectiveGains = enabled
        ? gains.map((g) => Math.max(-12, Math.min(12, Number(g) || 0)))
        : [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
      await NativeAudioPlayer.setEqualizerBands({ gains: effectiveGains })
    } catch (_) {}
  }

  public async getPlaybackState(): Promise<NativePlaybackState | null> {
    if (!isNativeAndroid()) return null
    try {
      return await NativeAudioPlayer.getPlaybackState()
    } catch (_) {
      return null
    }
  }

  /**
   * Conecta los listeners del servicio nativo Media3 (notificación multimedia, auriculares Bluetooth)
   * y los eventos de ciclo de vida de `@capacitor/app` (`appStateChange` y `backButton`).
   */
  public bindListeners(callbacks: PlayerSyncCallbacks): () => void {
    const handles: Array<PluginListenerHandle | Promise<PluginListenerHandle>> = []
    let disposed = false

    const safeAddPluginListener = async (
      eventName: NativeAudioEventName,
      handler: (data: any) => void
    ) => {
      if (!isNativeAndroid()) return
      try {
        const handle = await NativeAudioPlayer.addListener(eventName, (data) => {
          if (!disposed) handler(data)
        })
        if (disposed) {
          await handle.remove()
        } else {
          handles.push(handle)
        }
      } catch (_) {}
    }

    // 1. Comandos remotos de cortina de notificaciones Android y auriculares Bluetooth
    void safeAddPluginListener('remoteCommand', (payload: NativeRemoteCommandPayload) => {
      const cmd = payload?.command || payload?.action
      if (!cmd) return
      switch (cmd) {
        case 'play':
          if (callbacks.onPlay) callbacks.onPlay()
          else callbacks.onTogglePlay?.()
          break
        case 'pause':
          if (callbacks.onPause) callbacks.onPause()
          else callbacks.onTogglePlay?.()
          break
        case 'togglePlay':
        case 'toggle-play':
          callbacks.onTogglePlay?.()
          break
        case 'next':
        case 'nextTrack':
          callbacks.onNext?.()
          break
        case 'previous':
        case 'previousTrack':
          callbacks.onPrevious?.()
          break
        case 'seekTo':
        case 'seek': {
          const targetPos =
            typeof payload.position === 'number'
              ? payload.position
              : typeof payload.seekTime === 'number'
                ? payload.seekTime
                : null
          if (targetPos !== null && !isNaN(targetPos)) {
            callbacks.onSeekTo?.(targetPos)
          }
          break
        }
        default:
          break
      }
    })

    // 2. Fin de pista reportado por ExoPlayer (tanto en primer como en segundo plano)
    void safeAddPluginListener('trackEnded', () => {
      callbacks.onTrackEnded?.()
    })

    // 3. Progreso de reproducción reportado por ExoPlayer (~500ms)
    void safeAddPluginListener('playbackProgress', (data: NativePlaybackProgressPayload) => {
      if (typeof data?.currentTime === 'number') {
        callbacks.onPlaybackProgress?.(data.currentTime, data.duration)
      }
    })

    // 4. Cambios de estado de reproducción nativo (notificación, pantalla de bloqueo, auriculares Bluetooth)
    void safeAddPluginListener('playbackStateChanged', (data: NativePlaybackStateChangedPayload) => {
      if (data && typeof data.isPlaying === 'boolean') {
        callbacks.onStateReconcile?.({
          isPlaying: data.isPlaying,
          currentTime: typeof data.currentTime === 'number' ? data.currentTime : 0,
          duration: typeof data.duration === 'number' ? data.duration : 0
        })
      }
    })

    // 5. Ciclo de vida de la App en Android (@capacitor/app: segundo plano / pantalla apagada en Motorola)
    if (isNativeAndroid()) {
      try {
        const appStatePromise = App.addListener('appStateChange', async ({ isActive }) => {
          if (disposed) return
          this.isAppInBackground = !isActive

          if (isActive) {
            // Al volver al primer plano: consultar el estado real de ExoPlayer y reconciliar la UI
            const nativeState = await this.getPlaybackState()
            if (nativeState && callbacks.onStateReconcile) {
              callbacks.onStateReconcile(nativeState)
            }
          }
        })
        handles.push(appStatePromise)
      } catch (_) {}

      try {
        const backBtnPromise = App.addListener('backButton', ({ canGoBack }) => {
          if (disposed) return
          // Emitir evento global para que modales abiertos puedan cerrarse antes de minimizar la app
          const customEvt = new CustomEvent('capacitor:back-button', {
            cancelable: true,
            detail: { canGoBack }
          })
          const notCancelled = window.dispatchEvent(customEvt)
          if (notCancelled && !canGoBack) {
            // Minimizar la aplicación sin destruir el proceso de reproducción de música
            App.minimizeApp().catch(() => {})
          }
        })
        handles.push(backBtnPromise)
      } catch (_) {}
    }

    return () => {
      disposed = true
      for (const h of handles) {
        Promise.resolve(h)
          .then((resolved) => resolved?.remove?.())
          .catch(() => {})
      }
    }
  }
}

export const nativeAudioSync = new NativeAudioSyncManager()
