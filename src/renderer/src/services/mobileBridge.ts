import { storageVault, LibraryNode, VaultHealthReport } from './StorageVaultService'
import { fetchLyricsFromLrcLib } from '@shared/lrclibClient'
import { parseLrcText, ParsedLyrics } from '@shared/lyricsParser'
import { HotkeyConfig } from '@shared/types'

type UnsubscribeFn = () => void

const DEFAULT_HOTKEYS: Record<string, { shortcut: string; description: string }> = {
  restoreMainWindow: {
    shortcut: 'Ctrl+Shift+R',
    description: 'Abrir / Restaurar Ventana Principal'
  },
  toggleAlwaysOnTop: {
    shortcut: 'Ctrl+Shift+F',
    description: 'Fijar en Primer Plano (Always on Top)'
  },
  togglePanel: {
    shortcut: 'Ctrl+Shift+M',
    description: 'Mini Panel Lateral Rápido'
  },
  toggleOverlay: {
    shortcut: 'Ctrl+Alt+H',
    description: 'HUD / Widget Flotante de Juego'
  },
  playPause: {
    shortcut: 'Ctrl+Alt+Space',
    description: 'Reproducir / Pausar'
  },
  next: {
    shortcut: 'Ctrl+Right',
    description: 'Siguiente Pista'
  },
  previous: {
    shortcut: 'Ctrl+Left',
    description: 'Pista Anterior'
  },
  volumeUp: {
    shortcut: 'Ctrl+Up',
    description: 'Subir Volumen'
  },
  volumeDown: {
    shortcut: 'Ctrl+Down',
    description: 'Bajar Volumen'
  }
}

class MobileBridgeEmitter {
  private libraryListeners = new Set<(tree: LibraryNode[]) => void>()
  private playerStateListeners = new Set<(state: Record<string, unknown>) => void>()
  private playerTimeListeners = new Set<(time: number) => void>()
  private playerCommandListeners = new Set<(cmd: unknown) => void>()
  private batchLyricsListeners = new Set<
    (progress: { current: number; total: number; downloadedCount: number }) => void
  >()
  private repairProgressListeners = new Set<
    (progress: { current: number; total: number; repairedCount: number }) => void
  >()

  public lastPlayerState: Record<string, unknown> = {}

  public onLibraryUpdated(cb: (tree: LibraryNode[]) => void): UnsubscribeFn {
    this.libraryListeners.add(cb)
    return () => this.libraryListeners.delete(cb)
  }

  public emitLibraryUpdated(tree: LibraryNode[]): void {
    for (const cb of this.libraryListeners) {
      try {
        cb(tree)
      } catch (_) {}
    }
  }

  public onPlayerStateSync(cb: (state: Record<string, unknown>) => void): UnsubscribeFn {
    this.playerStateListeners.add(cb)
    return () => this.playerStateListeners.delete(cb)
  }

  public emitPlayerState(state: Record<string, unknown>): void {
    this.lastPlayerState = { ...this.lastPlayerState, ...state }
    for (const cb of this.playerStateListeners) {
      try {
        cb(state)
      } catch (_) {}
    }
  }

  public onPlayerTimeSync(cb: (time: number) => void): UnsubscribeFn {
    this.playerTimeListeners.add(cb)
    return () => this.playerTimeListeners.delete(cb)
  }

  public emitPlayerTime(time: number): void {
    this.lastPlayerState.currentTime = time
    for (const cb of this.playerTimeListeners) {
      try {
        cb(time)
      } catch (_) {}
    }
  }

  public onPlayerCommand(cb: (cmd: unknown) => void): UnsubscribeFn {
    this.playerCommandListeners.add(cb)
    return () => this.playerCommandListeners.delete(cb)
  }

  public emitPlayerCommand(cmd: unknown): void {
    for (const cb of this.playerCommandListeners) {
      try {
        cb(cmd)
      } catch (_) {}
    }
  }

  public onBatchLyricsProgress(
    cb: (progress: { current: number; total: number; downloadedCount: number }) => void
  ): UnsubscribeFn {
    this.batchLyricsListeners.add(cb)
    return () => this.batchLyricsListeners.delete(cb)
  }

  public emitBatchLyricsProgress(progress: {
    current: number
    total: number
    downloadedCount: number
  }): void {
    for (const cb of this.batchLyricsListeners) {
      try {
        cb(progress)
      } catch (_) {}
    }
  }

  public onRepairHardlinksProgress(
    cb: (progress: { current: number; total: number; repairedCount: number }) => void
  ): UnsubscribeFn {
    this.repairProgressListeners.add(cb)
    return () => this.repairProgressListeners.delete(cb)
  }

  public emitRepairProgress(progress: {
    current: number
    total: number
    repairedCount: number
  }): void {
    for (const cb of this.repairProgressListeners) {
      try {
        cb(progress)
      } catch (_) {}
    }
  }
}

const emitter = new MobileBridgeEmitter()
const onlineLyricsCache = new Map<
  string,
  {
    lyricsFound: boolean
    lyrics?: string
    parsed?: ParsedLyrics
    matchedTrack?: Record<string, unknown> | null
    savedToDisk?: boolean
  }
>()

function getActiveAlbumIdFromSession(): string | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null
    const raw = window.localStorage.getItem('musicPlayerSessionState')
    if (!raw) return null
    const parsed = JSON.parse(raw)
    const selId = parsed?.selectedAlbumId
    if (selId && typeof selId === 'string' && selId !== '__all_tracks__') {
      const node = storageVault.resolveNodeByIdOrPath(selId)
      if (node && node.node_type === 'album') {
        return node.id
      }
    }
  } catch (_) {}
  return null
}

/**
 * Abre un selector de archivos nativo (Android SAF / WebView / Desktop) para importar audio y video.
 */
function pickMediaFilesFromDom(): Promise<File[]> {
  if (typeof document === 'undefined') {
    return Promise.resolve([])
  }

  return new Promise<File[]>((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = true
    input.accept = 'audio/*,video/*,.mp3,.flac,.m4a,.wav,.ogg,.opus,.mp4,.mkv,.webm'
    input.style.display = 'none'
    document.body.appendChild(input)

    let settled = false
    const cleanup = (files: File[]) => {
      if (settled) return
      settled = true
      try {
        input.remove()
      } catch (_) {}
      resolve(files)
    }

    input.addEventListener('change', () => {
      const list = input.files ? Array.from(input.files) : []
      cleanup(list)
    })

    input.addEventListener('cancel', () => {
      cleanup([])
    })

    input.click()
  })
}

async function buildAndDecorateTree() {
  const res = await storageVault.buildLibraryResponse()
  const treeWithMeta = Object.assign([...res.tree], {
    tree: res.tree,
    songAlbumsIndex: res.songAlbumsIndex,
    vaultStats: res.vaultStats
  })
  return { res, treeWithMeta }
}

export const mobileBridge = {
  /**
   * Escanea la bóveda SQLite y construye la respuesta jerárquica para PlayerContext.jsx.
   */
  async scanMusic(_directory?: string) {
    const { treeWithMeta } = await buildAndDecorateTree()
    return treeWithMeta
  },

  /**
   * Importa archivos de audio/video a la bóveda física (`app_vault/tracks/`) y los vincula
   * al álbum activo (o al álbum por defecto).
   */
  async importMediaFiles(options?: { albumId?: string; files?: File[] }) {
    const files = options?.files ?? (await pickMediaFilesFromDom())
    if (!files || files.length === 0) {
      return { success: false, importedCount: 0, canceled: true }
    }

    let targetAlbumId = options?.albumId || getActiveAlbumIdFromSession()
    if (!targetAlbumId) {
      const defaultAlb = await storageVault.ensureDefaultAlbum()
      targetAlbumId = defaultAlb.id
    }

    let importedCount = 0
    for (const file of files) {
      await storageVault.importTrackToVault({
        file,
        fileName: file.name,
        albumIds: [targetAlbumId]
      })
      importedCount++
    }

    const { res, treeWithMeta } = await buildAndDecorateTree()
    emitter.emitLibraryUpdated(treeWithMeta)

    return {
      success: true,
      importedCount,
      library: treeWithMeta,
      songAlbumsIndex: res.songAlbumsIndex,
      vaultStats: res.vaultStats
    }
  },

  /**
   * En móvil/Web reemplaza la selección de carpeta de escritorio por el importador de archivos a la bóveda.
   */
  async selectMusicDirectory(): Promise<string | null> {
    const result = await mobileBridge.importMediaFiles()
    if (result.success && result.importedCount > 0) {
      return 'app_vault'
    }
    return null
  },

  /**
   * Vincula una canción existente a uno o varios álbumes en milisegundos (relación M:N en `album_tracks`).
   * Soporta tanto `{ track, albumIds }` como `{ sourceTrackPath, targetAlbums }`.
   */
  async addTrackToAlbums(payload: {
    track?: { id?: string; path?: string } | string
    albumIds?: string[]
    sourceTrackPath?: string
    targetAlbums?: Array<{ id?: string; name?: string; path?: string } | string>
  }) {
    try {
      const trackKey =
        typeof payload.track === 'string'
          ? payload.track
          : payload.track?.id || payload.track?.path || payload.sourceTrackPath || ''

      const rawAlbums: string[] = []
      if (Array.isArray(payload.albumIds)) {
        rawAlbums.push(...payload.albumIds)
      }
      if (Array.isArray(payload.targetAlbums)) {
        for (const item of payload.targetAlbums) {
          if (typeof item === 'string') {
            rawAlbums.push(item)
          } else if (item && typeof item === 'object') {
            const candidate = item.id || item.path || item.name
            if (candidate) rawAlbums.push(candidate)
          }
        }
      }

      if (!trackKey || rawAlbums.length === 0) {
        return { success: false, error: 'Parámetros de pista o álbumes destino inválidos.' }
      }

      await storageVault.linkTrackToAlbums(trackKey, rawAlbums)
      const { res, treeWithMeta } = await buildAndDecorateTree()
      emitter.emitLibraryUpdated(treeWithMeta)

      return {
        success: true,
        library: treeWithMeta,
        songAlbumsIndex: res.songAlbumsIndex,
        vaultStats: res.vaultStats
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return { success: false, error: message }
    }
  },

  /**
   * Elimina el vínculo de una pista en un álbum (o todas sus copias si `deleteAllCopies === true`),
   * aplicando conteo de referencias para borrar el archivo maestro cuando `ref_count === 0`.
   */
  async deleteTrackFile(payload: {
    filePath?: string
    trackId?: string
    albumId?: string
    deleteAllCopies?: boolean
    forceDeleteMaster?: boolean
    skipScan?: boolean
  }) {
    try {
      const hasSpecificAlbumContext = Boolean(
        payload.albumId ||
          (payload.filePath && !payload.filePath.startsWith('app_vault/tracks/'))
      )
      const deleteAllCopies =
        payload.deleteAllCopies !== undefined
          ? Boolean(payload.deleteAllCopies)
          : !hasSpecificAlbumContext && Boolean(payload.forceDeleteMaster)

      const delRes = await storageVault.deleteTrackFromAlbum({
        trackId: payload.trackId,
        albumId: payload.albumId,
        filePath: payload.filePath,
        deleteAllCopies
      })

      if (!delRes.success) {
        return { success: false, error: 'No se encontró la pista solicitada en la bóveda.' }
      }

      if (payload.skipScan) {
        return {
          ...delRes,
          success: true
        }
      }

      const { res, treeWithMeta } = await buildAndDecorateTree()
      emitter.emitLibraryUpdated(treeWithMeta)

      return {
        ...delRes,
        success: true,
        library: treeWithMeta,
        songAlbumsIndex: res.songAlbumsIndex,
        vaultStats: res.vaultStats
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return { success: false, error: message }
    }
  },

  /**
   * Crea un nuevo álbum en la tabla `albums`.
   */
  async createAlbum(payload: { albumName: string; parentDir?: string | null }) {
    try {
      const node = await storageVault.createNode({
        name: payload.albumName,
        parentId: payload.parentDir || null,
        nodeType: 'album'
      })
      const albumPath = storageVault.getNodeVirtualPath(node.id)
      const { res, treeWithMeta } = await buildAndDecorateTree()
      emitter.emitLibraryUpdated(treeWithMeta)

      return {
        success: true,
        albumId: node.id,
        albumPath,
        library: treeWithMeta,
        songAlbumsIndex: res.songAlbumsIndex,
        vaultStats: res.vaultStats
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return { success: false, error: message }
    }
  },

  /**
   * Crea una nueva carpeta jerárquica en la tabla `albums`.
   */
  async createFolder(payload: { folderName: string; parentDir?: string | null }) {
    try {
      const node = await storageVault.createNode({
        name: payload.folderName,
        parentId: payload.parentDir || null,
        nodeType: 'folder'
      })
      const folderPath = storageVault.getNodeVirtualPath(node.id)
      const { res, treeWithMeta } = await buildAndDecorateTree()
      emitter.emitLibraryUpdated(treeWithMeta)

      return {
        success: true,
        folderId: node.id,
        folderPath,
        library: treeWithMeta,
        songAlbumsIndex: res.songAlbumsIndex,
        vaultStats: res.vaultStats
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return { success: false, error: message }
    }
  },

  /**
   * Mueve un álbum o carpeta a otro destino jerárquico.
   */
  async moveAlbumFolder(payload: { sourcePath: string; targetParentDir?: string | null }) {
    try {
      const moveRes = await storageVault.moveNode(
        payload.sourcePath,
        payload.targetParentDir || '__ROOT__'
      )
      if (!moveRes.success) return moveRes

      const { res, treeWithMeta } = await buildAndDecorateTree()
      emitter.emitLibraryUpdated(treeWithMeta)

      return {
        success: true,
        newPath: moveRes.newPath,
        library: treeWithMeta,
        songAlbumsIndex: res.songAlbumsIndex,
        vaultStats: res.vaultStats
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return { success: false, error: message }
    }
  },

  /**
   * Renombra un álbum o carpeta existente.
   */
  async renameAlbumFolder(payload: { albumPath: string; newName: string }) {
    try {
      const renRes = await storageVault.renameNode(payload.albumPath, payload.newName)
      if (!renRes.success) return renRes

      const { res, treeWithMeta } = await buildAndDecorateTree()
      emitter.emitLibraryUpdated(treeWithMeta)

      return {
        success: true,
        newPath: renRes.newPath,
        library: treeWithMeta,
        songAlbumsIndex: res.songAlbumsIndex,
        vaultStats: res.vaultStats
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return { success: false, error: message }
    }
  },

  /**
   * Elimina un álbum o carpeta y limpia automáticamente las pistas sin referencias restantes.
   */
  async deleteAlbumFolder(payload: { albumPath: string }) {
    try {
      const delRes = await storageVault.deleteNode(payload.albumPath)
      if (!delRes.success) return delRes

      const { res, treeWithMeta } = await buildAndDecorateTree()
      emitter.emitLibraryUpdated(treeWithMeta)

      return {
        ...delRes,
        library: treeWithMeta,
        songAlbumsIndex: res.songAlbumsIndex,
        vaultStats: res.vaultStats
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return { success: false, error: message }
    }
  },

  /**
   * Cambia la portada personalizada de un álbum.
   */
  async changeAlbumCover(payload: {
    albumPath: string
    trackPath?: string
    coverUrl?: string
  }) {
    try {
      const covRes = await storageVault.setAlbumCustomCover(
        payload.albumPath,
        payload.trackPath,
        payload.coverUrl
      )
      if (!covRes.success) return covRes

      const { res, treeWithMeta } = await buildAndDecorateTree()
      emitter.emitLibraryUpdated(treeWithMeta)

      return {
        ...covRes,
        library: treeWithMeta,
        songAlbumsIndex: res.songAlbumsIndex,
        vaultStats: res.vaultStats
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return { success: false, error: message }
    }
  },

  /**
   * Devuelve las propiedades técnicas y etiquetas de una pista en la bóveda.
   */
  async getTrackProperties(trackPath: string) {
    const track = storageVault.resolveTrackByPathOrId(trackPath)
    if (!track) return null

    const ext = (track.file_name.split('.').pop() || 'mp3').toUpperCase()
    return {
      title: track.title,
      artist: track.artist,
      album: track.album_tag || '',
      duration: track.duration,
      size: track.size_bytes,
      filePath: track.file_path,
      fileName: track.file_name,
      mediaType: track.media_type,
      codec: ext,
      bitrate: 320000,
      sampleRate: 44100,
      numberOfChannels: 2,
      createdAt: track.created_at,
      modifiedAt: track.created_at
    }
  },

  /**
   * Actualiza los metadatos de título, artista y álbum de una pista en la tabla `tracks`.
   */
  async updateTrackTags(payload: {
    filePath: string
    filePaths?: string[]
    title?: string
    artist?: string
    album?: string
  }) {
    try {
      const targetKey = payload.filePath || payload.filePaths?.[0] || ''
      const upd = await storageVault.updateTrackMetadata(targetKey, {
        title: payload.title,
        artist: payload.artist,
        album: payload.album
      })
      if (!upd.success) return upd

      const { res, treeWithMeta } = await buildAndDecorateTree()
      emitter.emitLibraryUpdated(treeWithMeta)

      return {
        success: true,
        library: treeWithMeta,
        songAlbumsIndex: res.songAlbumsIndex,
        vaultStats: res.vaultStats
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      return { success: false, error: message }
    }
  },

  /**
   * Obtiene la letra local (.lrc) almacenada en `app_vault/lyrics/<trackId>.lrc`.
   */
  async getTrackLyrics(trackPath: string) {
    const rawLrc = await storageVault.readTrackLyrics(trackPath)
    if (!rawLrc) {
      return { synced: false, lines: [], source: null }
    }
    const parsed = parseLrcText(rawLrc)
    return {
      synced: parsed.synced,
      lines: parsed.lines,
      source: 'lrc'
    }
  },

  /**
   * Busca letras sincronizadas en línea mediante LRCLIB y opcionalmente las guarda en `app_vault/lyrics/`.
   */
  async fetchTrackLyricsOnline(payload: {
    trackPath: string
    title: string
    artist?: string
    album?: string
    duration?: number
    saveToDisk?: boolean
    bypassCache?: boolean
  }) {
    const cacheKey = `${payload.trackPath}|${payload.title}|${payload.artist || ''}`
    if (!payload.bypassCache && onlineLyricsCache.has(cacheKey)) {
      const cached = onlineLyricsCache.get(cacheKey)!
      if (payload.saveToDisk && cached.lyrics && !cached.savedToDisk) {
        await storageVault.saveTrackLyrics(payload.trackPath, cached.lyrics)
        cached.savedToDisk = true
      }
      return cached
    }

    const found = await fetchLyricsFromLrcLib({
      title: payload.title,
      artist: payload.artist,
      album: payload.album,
      duration: payload.duration
    })

    if (!found || !found.lyrics) {
      const miss = { lyricsFound: false }
      onlineLyricsCache.set(cacheKey, miss)
      return miss
    }

    const parsed = parseLrcText(found.lyrics)
    let savedToDisk = false
    if (payload.saveToDisk) {
      savedToDisk = await storageVault.saveTrackLyrics(payload.trackPath, found.lyrics)
    }

    const response = {
      lyricsFound: true,
      lyrics: found.lyrics,
      parsed,
      matchedTrack: found.matchedTrack,
      savedToDisk
    }
    onlineLyricsCache.set(cacheKey, response)
    return response
  },

  /**
   * Guarda un archivo `.lrc` permanentemente en `app_vault/lyrics/<trackId>.lrc`.
   */
  async saveTrackLrc(payload: { trackPath: string; lyricsText: string }) {
    if (!payload?.trackPath || !payload?.lyricsText) {
      return { success: false, error: 'Datos de letra incompletos.' }
    }
    const parsed = parseLrcText(payload.lyricsText)
    const ok = await storageVault.saveTrackLyrics(payload.trackPath, payload.lyricsText)
    return {
      success: ok,
      synced: parsed.synced
    }
  },

  /**
   * Elimina el archivo `.lrc` asociado a una pista de `app_vault/lyrics/`.
   */
  async deleteTrackLrc(payload: { trackPath: string }) {
    if (!payload?.trackPath) return { success: false }
    const ok = await storageVault.deleteTrackLyrics(payload.trackPath)
    return { success: ok }
  },

  /**
   * Descarga masiva de letras faltantes para todas las pistas de la bóveda.
   */
  async batchDownloadLyrics() {
    const tracks = storageVault.getAllTracks()
    const missing = tracks.filter((t) => !t.has_lrc)
    const total = missing.length
    let current = 0
    let downloadedCount = 0

    for (const track of missing) {
      current++
      try {
        const res = await fetchLyricsFromLrcLib({
          title: track.title,
          artist: track.artist,
          album: track.album_tag,
          duration: track.duration
        })
        if (res && res.lyrics) {
          const saved = await storageVault.saveTrackLyrics(track.id, res.lyrics)
          if (saved) downloadedCount++
        }
      } catch (_) {}
      emitter.emitBatchLyricsProgress({ current, total, downloadedCount })
    }

    const { treeWithMeta } = await buildAndDecorateTree()
    emitter.emitLibraryUpdated(treeWithMeta)

    return {
      success: true,
      totalScanned: total,
      downloadedCount
    }
  },

  onBatchLyricsProgress(
    cb: (progress: { current: number; total: number; downloadedCount: number }) => void
  ): UnsubscribeFn {
    return emitter.onBatchLyricsProgress(cb)
  },

  /**
   * Auditoría de Integridad de la Bóveda SQLite (reemplaza al diagnóstico NTFS Hardlinks en móvil).
   */
  async checkHardlinksHealth(): Promise<VaultHealthReport> {
    return await storageVault.auditVaultIntegrity()
  },

  /**
   * Repara y compacta la Bóveda SQLite eliminando huérfanos y enlaces rotos.
   */
  async repairHardlinksIntegrity(): Promise<VaultHealthReport> {
    const report = await storageVault.repairVaultIntegrity((p) => {
      emitter.emitRepairProgress(p)
    })
    const { treeWithMeta } = await buildAndDecorateTree()
    emitter.emitLibraryUpdated(treeWithMeta)
    return report
  },

  onRepairHardlinksProgress(
    cb: (progress: { current: number; total: number; repairedCount: number }) => void
  ): UnsubscribeFn {
    return emitter.onRepairHardlinksProgress(cb)
  },

  // Sincronización de estado y eventos de reproducción
  sendPlayerState(state: Record<string, unknown>) {
    emitter.emitPlayerState(state)
  },

  sendPlayerTime(time: number) {
    emitter.emitPlayerTime(time)
  },

  sendPlayerCommand(command: unknown) {
    emitter.emitPlayerCommand(command)
  },

  async getInitialPlayerState() {
    return emitter.lastPlayerState
  },

  onPlayerStateSync(cb: (state: Record<string, unknown>) => void): UnsubscribeFn {
    return emitter.onPlayerStateSync(cb)
  },

  onPlayerTimeSync(cb: (time: number) => void): UnsubscribeFn {
    return emitter.onPlayerTimeSync(cb)
  },

  onPlayerCommand(cb: (cmd: unknown) => void): UnsubscribeFn {
    return emitter.onPlayerCommand(cb)
  },

  onLibraryUpdated(cb: (tree: LibraryNode[]) => void): UnsubscribeFn {
    return emitter.onLibraryUpdated(cb)
  },

  // Stubs seguros no-op para métodos exclusivos de escritorio
  notifyRendererReady() {},
  showItemInFolder(_filePath: string) {},
  async getHotkeysConfig(): Promise<Record<string, { shortcut: string; description: string }>> {
    return { ...DEFAULT_HOTKEYS }
  },
  async updateHotkey(_payload: { action: keyof HotkeyConfig; accelerator: string }) {
    return { success: true, config: { ...DEFAULT_HOTKEYS } }
  },
  async resetHotkeys() {
    return { success: true, config: { ...DEFAULT_HOTKEYS } }
  },
  setDiscordRpc(_enabled: boolean) {},
  async getDiscordRpcStatus() {
    return { enabled: false, connected: false }
  },
  toggleGameOverlay(_enabled: boolean) {},
  async getGameOverlayStatus() {
    return false
  },
  onGameOverlayStatusChanged(_cb: (active: boolean) => void): UnsubscribeFn {
    return () => {}
  },
  setMainAlwaysOnTop(_enabled: boolean) {},
  onAlwaysOnTopStatusChanged(_cb: (isTop: boolean) => void): UnsubscribeFn {
    return () => {}
  },
  onMainWindowVisibility(_cb: (visible: boolean) => void): UnsubscribeFn {
    return () => {}
  }
}

declare global {
  interface Window {
    electronAPI: typeof mobileBridge
  }
}

export function initMobileBridge(): typeof mobileBridge {
  if (typeof window !== 'undefined') {
    window.electronAPI = mobileBridge
  }
  return mobileBridge
}
