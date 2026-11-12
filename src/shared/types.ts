/**
 * Tipos de Dominio Compartidos para el Reproductor de Música
 * Utilizados transversalmente por Main Process, Preload y Renderer.
 */

export interface Track {
  id: string
  path: string
  title: string
  artist: string
  album?: string
  duration: number
  cover?: string
  hasLyrics?: boolean
  albumCount?: number
  ino?: string | number
  mtimeMs?: number
  size?: number
  sizeBytes?: number
  mediaType?: 'audio' | 'video'
  format?: {
    bitrate?: number
    sampleRate?: number
    codec?: string
    lossless?: boolean
  }
}

export interface Album {
  id: string
  name: string
  path: string
  cover?: string
  categoryPath?: string
  isAllTracks?: boolean
  tracks: Track[]
}

export interface FolderNode {
  type: 'folder' | 'album'
  name: string
  path: string
  cover?: string
  tracks?: Track[]
  children?: FolderNode[]
}

export interface PlayerState {
  currentTrack: Track | null
  isPlaying: boolean
  currentTime: number
  duration: number
  volume: number
  isMuted: boolean
  isShuffle: boolean
  repeatMode: 'off' | 'all' | 'one'
  playlist: Track[]
  currentIndex: number
  currentAlbumName?: string
}

export interface PanelSettings {
  pinned: boolean
  autoHide: boolean
}

export interface HotkeyConfig {
  next: string
  previous: string
  playPause: string
  volumeUp: string
  volumeDown: string
  togglePanel: string
  toggleOverlay: string
  restoreMainWindow: string
  toggleAlwaysOnTop: string
}

export interface HealthCheckResult {
  healthy: boolean
  totalHardlinks: number
  brokenLinks: string[]
  desynchronizedInodes: Array<{ linkPath: string; masterPath: string }>
  orphanedMasters: string[]
  repairedCount?: number
  message?: string
}

export interface LrcLine {
  time: number
  text: string
}

export interface IpcResponse<T = unknown> {
  success: boolean
  data?: T
  error?: string
  message?: string
}
