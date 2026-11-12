import { Capacitor } from '@capacitor/core'
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem'
import { CapacitorSQLite, SQLiteConnection, SQLiteDBConnection } from '@capacitor-community/sqlite'
import { SecurityService } from '@shared/security'
import {
  extractMediaMetadata,
  computeBufferHash,
  getFileExtension,
  detectMediaType,
  MediaType
} from './metadataExtractor'

export interface VaultTrackRow {
  id: string
  file_path: string
  file_name: string
  title: string
  artist: string
  album_tag: string
  duration: number
  cover_hash: string | null
  has_lrc: number
  media_type: MediaType
  size_bytes: number
  created_at: number
}

export interface VaultAlbumRow {
  id: string
  name: string
  parent_id: string | null
  node_type: 'album' | 'folder'
  custom_cover: string | null
  created_at: number
}

export interface VaultAlbumTrackRow {
  album_id: string
  track_id: string
  track_order: number
  added_at: number
}

export interface LibraryTrackItem {
  id: string
  ino: string
  uniqueKey: string
  title: string
  artist: string
  album: string
  albumId: string
  albumName: string
  duration: number
  path: string
  filePath: string
  fileName: string
  fileUrl: string
  cover: string | null
  hasLrc: boolean
  hasLyrics: boolean
  syncedLyrics: boolean
  mediaType: MediaType
  size: number
  mtimeMs: number
}

export interface LibraryNode {
  id: string
  type: 'album' | 'folder'
  name: string
  path: string
  categoryPath?: string
  cover?: string | null
  trackCount?: number
  tracks?: LibraryTrackItem[]
  itemCount?: number
  totalTracks?: number
  children?: LibraryNode[]
}

export interface VaultStats {
  totalTracks: number
  totalAlbums: number
  totalSizeBytes: number
}

export interface LibraryResponse {
  tree: LibraryNode[]
  songAlbumsIndex: Record<string, { albumIds: string[]; albumNames: string[] }>
  vaultStats: VaultStats
}

export interface DeleteTrackResult {
  success: boolean
  trackId: string
  albumId?: string
  remainingReferences: number
  masterDeleted: boolean
  physicalFileDeleted: boolean
}

export interface VaultHealthReport {
  success: boolean
  healthy: boolean
  healthPercentage: number
  totalHardlinks: number
  totalOrganizedFiles: number
  totalMasterFiles: number
  healthyCount: number
  divergentCount: number
  unlinkedCount: number
  savedSpaceBytes: number
  savedSpaceFormatted: string
  brokenLinks: string[]
  desynchronizedInodes: Array<{ linkPath: string; masterPath: string }>
  orphanedMasters: string[]
  orphanedPhysicalFiles: string[]
  repairedCount?: number
  message?: string
}

const VAULT_STORAGE_KEY = 'music_vault_relational_store_v1'
const DEFAULT_ALBUM_NAME = 'Favoritos'

function uint8ArrayToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
  }
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const sub = bytes.subarray(i, i + chunkSize)
    binary += String.fromCharCode(...sub)
  }
  return btoa(binary)
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export class StorageVaultService {
  private static instance: StorageVaultService | null = null

  public static getInstance(): StorageVaultService {
    if (!this.instance) {
      this.instance = new StorageVaultService()
    }
    return this.instance
  }

  private initialized = false
  private isNative = false
  private sqliteConnection: SQLiteConnection | null = null
  private db: SQLiteDBConnection | null = null

  // Tablas relacionales en memoria (sincronizadas con SQLite en Android o localStorage/IndexedDB en Web/Test)
  private tracksTable = new Map<string, VaultTrackRow>()
  private albumsTable = new Map<string, VaultAlbumRow>()
  private albumTracksTable = new Map<string, VaultAlbumTrackRow>() // Key: `${album_id}::${track_id}`

  // Almacén físico virtual para entorno Web / Test y caché de URLs reproducibles
  private physicalTrackFiles = new Map<string, { sizeBytes: number; fileUrl: string }>() // Key: `app_vault/tracks/<id>.<ext>`
  private physicalLyricsFiles = new Map<string, string>() // Key: `app_vault/lyrics/<id>.lrc`
  private physicalCoverFiles = new Map<string, string>() // Key: `.covers/<hash>.jpg` -> dataUrl / fileUrl
  private nativeDataUriBase = ''
  private nativeCacheUriBase = ''

  public async init(options: { createDefaultAlbumIfEmpty?: boolean } = {}): Promise<void> {
    const createDefault = options.createDefaultAlbumIfEmpty ?? true
    if (this.initialized) {
      if (createDefault && this.albumsTable.size === 0) {
        await this.ensureDefaultAlbum()
      }
      return
    }

    this.isNative = Boolean(
      typeof Capacitor !== 'undefined' &&
        typeof Capacitor.isNativePlatform === 'function' &&
        Capacitor.isNativePlatform()
    )

    if (this.isNative) {
      try {
        await this.initNativeDirectories()
        await this.initNativeSQLite()
      } catch (err) {
        console.warn('[StorageVault] Fallback a motor relacional en memoria/Web:', err)
        this.isNative = false
        this.loadWebPersistence()
      }
    } else {
      this.loadWebPersistence()
    }

    this.initialized = true

    if (createDefault && this.albumsTable.size === 0) {
      await this.ensureDefaultAlbum()
    }
  }

  private async initNativeDirectories(): Promise<void> {
    try {
      await Filesystem.mkdir({
        path: 'app_vault/tracks',
        directory: Directory.Data,
        recursive: true
      })
    } catch (_) {}

    try {
      await Filesystem.mkdir({
        path: 'app_vault/lyrics',
        directory: Directory.Data,
        recursive: true
      })
    } catch (_) {}

    try {
      await Filesystem.mkdir({
        path: '.covers',
        directory: Directory.Cache,
        recursive: true
      })
    } catch (_) {}

    try {
      const dataUri = await Filesystem.getUri({
        path: 'app_vault',
        directory: Directory.Data
      })
      this.nativeDataUriBase = dataUri.uri.replace(/\/+$/, '')
    } catch (_) {}

    try {
      const cacheUri = await Filesystem.getUri({
        path: '.covers',
        directory: Directory.Cache
      })
      this.nativeCacheUriBase = cacheUri.uri.replace(/\/+$/, '')
    } catch (_) {}
  }

  private async initNativeSQLite(): Promise<void> {
    this.sqliteConnection = new SQLiteConnection(CapacitorSQLite)
    const ret = await this.sqliteConnection.checkConnectionsConsistency()
    const isConn = (await this.sqliteConnection.isConnection('music_vault', false)).result
    if (ret.result && isConn) {
      this.db = await this.sqliteConnection.retrieveConnection('music_vault', false)
    } else {
      this.db = await this.sqliteConnection.createConnection(
        'music_vault',
        false,
        'no-encryption',
        1,
        false
      )
    }

    await this.db.open()

    const schemaSql = `
      CREATE TABLE IF NOT EXISTS tracks (
        id TEXT PRIMARY KEY NOT NULL,
        file_path TEXT NOT NULL,
        file_name TEXT NOT NULL,
        title TEXT NOT NULL,
        artist TEXT NOT NULL,
        album_tag TEXT DEFAULT '',
        duration REAL DEFAULT 0,
        cover_hash TEXT,
        has_lrc INTEGER DEFAULT 0,
        media_type TEXT DEFAULT 'audio',
        size_bytes INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS albums (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        parent_id TEXT,
        node_type TEXT NOT NULL DEFAULT 'album',
        custom_cover TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS album_tracks (
        album_id TEXT NOT NULL,
        track_id TEXT NOT NULL,
        track_order INTEGER DEFAULT 0,
        added_at INTEGER NOT NULL,
        PRIMARY KEY (album_id, track_id)
      );
    `
    await this.db.execute(schemaSql)
    await this.reloadFromNativeSQLite()
  }

  private async reloadFromNativeSQLite(): Promise<void> {
    if (!this.db) return
    this.tracksTable.clear()
    this.albumsTable.clear()
    this.albumTracksTable.clear()

    const tracksRes = await this.db.query('SELECT * FROM tracks ORDER BY created_at ASC;')
    for (const r of tracksRes.values || []) {
      const row: VaultTrackRow = {
        id: String(r.id),
        file_path: String(r.file_path),
        file_name: String(r.file_name),
        title: String(r.title),
        artist: String(r.artist),
        album_tag: String(r.album_tag || ''),
        duration: Number(r.duration || 0),
        cover_hash: r.cover_hash ? String(r.cover_hash) : null,
        has_lrc: Number(r.has_lrc || 0),
        media_type: r.media_type === 'video' ? 'video' : 'audio',
        size_bytes: Number(r.size_bytes || 0),
        created_at: Number(r.created_at || Date.now())
      }
      this.tracksTable.set(row.id, row)
    }

    const albumsRes = await this.db.query('SELECT * FROM albums ORDER BY created_at ASC;')
    for (const r of albumsRes.values || []) {
      const row: VaultAlbumRow = {
        id: String(r.id),
        name: String(r.name),
        parent_id: r.parent_id ? String(r.parent_id) : null,
        node_type: r.node_type === 'folder' ? 'folder' : 'album',
        custom_cover: r.custom_cover ? String(r.custom_cover) : null,
        created_at: Number(r.created_at || Date.now())
      }
      this.albumsTable.set(row.id, row)
    }

    const linksRes = await this.db.query(
      'SELECT * FROM album_tracks ORDER BY track_order ASC, added_at ASC;'
    )
    for (const r of linksRes.values || []) {
      const row: VaultAlbumTrackRow = {
        album_id: String(r.album_id),
        track_id: String(r.track_id),
        track_order: Number(r.track_order || 0),
        added_at: Number(r.added_at || Date.now())
      }
      this.albumTracksTable.set(`${row.album_id}::${row.track_id}`, row)
    }
  }

  private loadWebPersistence(): void {
    try {
      if (typeof window === 'undefined' || !window.localStorage) return
      const raw = window.localStorage.getItem(VAULT_STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object') return

      this.tracksTable.clear()
      this.albumsTable.clear()
      this.albumTracksTable.clear()
      this.physicalTrackFiles.clear()
      this.physicalLyricsFiles.clear()
      this.physicalCoverFiles.clear()

      if (Array.isArray(parsed.tracks)) {
        for (const t of parsed.tracks) {
          if (t && t.id) {
            this.tracksTable.set(t.id, t)
          }
        }
      }

      if (Array.isArray(parsed.albums)) {
        for (const a of parsed.albums) {
          if (a && a.id) {
            this.albumsTable.set(a.id, a)
          }
        }
      }

      if (Array.isArray(parsed.albumTracks)) {
        for (const l of parsed.albumTracks) {
          if (l && l.album_id && l.track_id) {
            this.albumTracksTable.set(`${l.album_id}::${l.track_id}`, l)
          }
        }
      }

      if (parsed.physicalTracks && typeof parsed.physicalTracks === 'object') {
        for (const [k, v] of Object.entries(parsed.physicalTracks)) {
          const item = v as { sizeBytes: number; fileUrl: string }
          this.physicalTrackFiles.set(k, item)
        }
      }

      if (parsed.physicalLyrics && typeof parsed.physicalLyrics === 'object') {
        for (const [k, v] of Object.entries(parsed.physicalLyrics)) {
          if (typeof v === 'string') {
            this.physicalLyricsFiles.set(k, v)
          }
        }
      }

      if (parsed.physicalCovers && typeof parsed.physicalCovers === 'object') {
        for (const [k, v] of Object.entries(parsed.physicalCovers)) {
          if (typeof v === 'string') {
            this.physicalCoverFiles.set(k, v)
          }
        }
      }
    } catch (_) {}
  }

  private saveWebPersistence(): void {
    if (this.isNative) return
    try {
      if (typeof window === 'undefined' || !window.localStorage) return
      const payload = {
        tracks: Array.from(this.tracksTable.values()),
        albums: Array.from(this.albumsTable.values()),
        albumTracks: Array.from(this.albumTracksTable.values()),
        physicalTracks: Object.fromEntries(this.physicalTrackFiles.entries()),
        physicalLyrics: Object.fromEntries(this.physicalLyricsFiles.entries()),
        physicalCovers: Object.fromEntries(this.physicalCoverFiles.entries())
      }
      window.localStorage.setItem(VAULT_STORAGE_KEY, JSON.stringify(payload))
    } catch (_) {}
  }

  /**
   * Reinicia completamente la bóveda (útil para pruebas unitarias deterministas).
   */
  public async resetVault(options: { createDefaultAlbum?: boolean } = {}): Promise<void> {
    this.tracksTable.clear()
    this.albumsTable.clear()
    this.albumTracksTable.clear()
    this.physicalTrackFiles.clear()
    this.physicalLyricsFiles.clear()
    this.physicalCoverFiles.clear()

    if (this.isNative && this.db) {
      await this.db.execute('DELETE FROM album_tracks; DELETE FROM tracks; DELETE FROM albums;')
    } else {
      try {
        if (typeof window !== 'undefined' && window.localStorage) {
          window.localStorage.removeItem(VAULT_STORAGE_KEY)
        }
      } catch (_) {}
    }

    this.initialized = true

    if (options.createDefaultAlbum) {
      await this.ensureDefaultAlbum()
    }
  }

  public async ensureDefaultAlbum(): Promise<VaultAlbumRow> {
    for (const alb of this.albumsTable.values()) {
      if (alb.node_type === 'album') {
        return alb
      }
    }
    return await this.createNode({
      name: DEFAULT_ALBUM_NAME,
      parentId: null,
      nodeType: 'album'
    })
  }

  /**
   * Crea un álbum o carpeta jerárquica en la tabla `albums`.
   */
  public async createNode(params: {
    name: string
    parentId?: string | null
    nodeType?: 'album' | 'folder'
    id?: string
  }): Promise<VaultAlbumRow> {
    await this.init({ createDefaultAlbumIfEmpty: false })

    const rawName = SecurityService.validateString(params.name, 'name', 200)
    const cleanName = SecurityService.sanitizeFileName(rawName)
    if (!cleanName) {
      throw new Error('Nombre de álbum o carpeta inválido.')
    }

    const resolvedParentId = this.resolveParentNodeId(params.parentId)
    const nodeType = params.nodeType === 'folder' ? 'folder' : 'album'

    // Verificar si ya existe un hermano con el mismo nombre bajo el mismo padre
    for (const existing of this.albumsTable.values()) {
      if (
        existing.parent_id === resolvedParentId &&
        existing.name.toLowerCase() === cleanName.toLowerCase()
      ) {
        return existing
      }
    }

    const id =
      params.id ||
      `${nodeType}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
    const createdAt = Date.now()

    const row: VaultAlbumRow = {
      id,
      name: cleanName,
      parent_id: resolvedParentId,
      node_type: nodeType,
      custom_cover: null,
      created_at: createdAt
    }

    this.albumsTable.set(id, row)

    if (this.isNative && this.db) {
      await this.db.run(
        'INSERT OR REPLACE INTO albums (id, name, parent_id, node_type, custom_cover, created_at) VALUES (?, ?, ?, ?, ?, ?);',
        [row.id, row.name, row.parent_id, row.node_type, row.custom_cover, row.created_at]
      )
    } else {
      this.saveWebPersistence()
    }

    return row
  }

  /**
   * Resuelve un ID de nodo (álbum o carpeta) a partir de su `id`, su ruta virtual jerárquica (`Carpeta/Álbum`)
   * o su nombre. Devuelve `null` si representa la raíz (`__ROOT__` o vacío).
   */
  public resolveNodeByIdOrPath(idOrPath?: string | null): VaultAlbumRow | null {
    if (!idOrPath || idOrPath === '__ROOT__') return null
    const direct = this.albumsTable.get(idOrPath)
    if (direct) return direct

    const normTarget = SecurityService.normalizePath(idOrPath).toLowerCase()
    for (const node of this.albumsTable.values()) {
      const vPath = this.getNodeVirtualPath(node.id).toLowerCase()
      if (vPath === normTarget || node.id.toLowerCase() === normTarget) {
        return node
      }
    }

    // Fallback por nombre exacto si es único
    const baseName = normTarget.split('/').pop() || normTarget
    for (const node of this.albumsTable.values()) {
      if (node.name.toLowerCase() === baseName) {
        return node
      }
    }

    return null
  }

  private resolveParentNodeId(parentIdOrPath?: string | null): string | null {
    if (!parentIdOrPath || parentIdOrPath === '__ROOT__') return null
    const found = this.resolveNodeByIdOrPath(parentIdOrPath)
    return found ? found.id : null
  }

  /**
   * Construye la ruta virtual jerárquica de un álbum o carpeta (ej. "Rock Clásico/Abbey Road").
   */
  public getNodeVirtualPath(nodeId: string): string {
    const parts: string[] = []
    const visited = new Set<string>()
    let current = this.albumsTable.get(nodeId) || null

    while (current && !visited.has(current.id)) {
      visited.add(current.id)
      parts.unshift(current.name)
      current = current.parent_id ? this.albumsTable.get(current.parent_id) || null : null
    }

    return parts.join('/')
  }

  /**
   * Importa o registra una pista en el almacén físico único (`app_vault/tracks/<id>.<ext>`)
   * y la vincula con uno o más álbumes en `album_tracks` sin duplicar el archivo maestro.
   */
  public async importTrackToVault(params: {
    file?: File | Blob | Uint8Array | ArrayBuffer
    fileName: string
    albumIds?: string[]
    id?: string
    title?: string
    artist?: string
    albumTag?: string
    duration?: number
    mediaType?: MediaType
    sizeBytes?: number
    coverBytes?: Uint8Array | null
    skipDomDurationProbe?: boolean
  }): Promise<{ track: VaultTrackRow; linkedAlbumIds: string[] }> {
    await this.init({ createDefaultAlbumIfEmpty: false })

    const cleanFileName =
      SecurityService.sanitizeFileName(params.fileName || 'track.mp3') || 'track.mp3'
    const ext = getFileExtension(cleanFileName)

    let extracted = {
      title: params.title || cleanFileName.replace(/\.[^/.]+$/, ''),
      artist: params.artist || 'Artista Desconocido',
      album: params.albumTag || '',
      duration: params.duration ?? 0,
      mediaType: params.mediaType || detectMediaType(cleanFileName),
      coverBytes: params.coverBytes ?? null,
      coverMimeType: 'image/jpeg' as string | null,
      coverHash: null as string | null,
      sizeBytes: params.sizeBytes ?? 0,
      ext
    }

    let rawBytes: Uint8Array | null = null
    let blobUrlForWeb = ''

    if (params.file) {
      extracted = await extractMediaMetadata(params.file, {
        fileName: cleanFileName,
        fallbackDuration: params.duration,
        skipDomDurationProbe: params.skipDomDurationProbe
      })
      if (params.title) extracted.title = params.title
      if (params.artist) extracted.artist = params.artist
      if (params.albumTag) extracted.album = params.albumTag
      if (params.duration !== undefined) extracted.duration = params.duration
      if (params.mediaType) extracted.mediaType = params.mediaType

      if (params.file instanceof Uint8Array) {
        rawBytes = params.file
      } else if (params.file instanceof ArrayBuffer) {
        rawBytes = new Uint8Array(params.file)
      } else if (typeof Blob !== 'undefined' && params.file instanceof Blob) {
        const ab = await params.file.arrayBuffer()
        rawBytes = new Uint8Array(ab)
        if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
          try {
            blobUrlForWeb = URL.createObjectURL(params.file)
          } catch (_) {}
        }
      }
    } else if (params.coverBytes && params.coverBytes.length > 0) {
      extracted.coverHash = await computeBufferHash(params.coverBytes)
    }

    // Identificador canónico único basado en hash de contenido o metadatos
    let trackId = params.id || ''
    if (!trackId) {
      if (rawBytes && rawBytes.length > 0) {
        const hash = await computeBufferHash(rawBytes)
        trackId = `trk_${hash}`
      } else {
        const seed = new TextEncoder().encode(
          `${cleanFileName.toLowerCase()}|${extracted.title.toLowerCase()}|${extracted.artist.toLowerCase()}|${extracted.sizeBytes}`
        )
        const hash = await computeBufferHash(seed)
        trackId = `trk_${hash}`
      }
    }

    const physicalPath = `app_vault/tracks/${trackId}.${ext}`

    // Guardar carátula deduplicada en .covers/<cover_hash>.jpg si existe
    if (extracted.coverHash && extracted.coverBytes && extracted.coverBytes.length > 0) {
      await this.saveCoverByHash(
        extracted.coverHash,
        extracted.coverBytes,
        extracted.coverMimeType || 'image/jpeg'
      )
    }

    // Escribir archivo físico únicamente si aún no existe en la bóveda
    const existingTrack = this.tracksTable.get(trackId)
    if (!existingTrack || !this.hasPhysicalTrackFile(physicalPath)) {
      await this.writePhysicalTrackFile(
        physicalPath,
        rawBytes,
        extracted.sizeBytes || (rawBytes ? rawBytes.byteLength : 1024),
        blobUrlForWeb
      )
    }

    const trackRow: VaultTrackRow = existingTrack
      ? {
          ...existingTrack,
          title: params.title ? params.title.trim() : existingTrack.title,
          artist: params.artist ? params.artist.trim() : existingTrack.artist,
          album_tag: params.albumTag ? params.albumTag.trim() : existingTrack.album_tag,
          duration: extracted.duration || existingTrack.duration,
          cover_hash: extracted.coverHash || existingTrack.cover_hash
        }
      : {
          id: trackId,
          file_path: physicalPath,
          file_name: cleanFileName,
          title: extracted.title,
          artist: extracted.artist,
          album_tag: extracted.album,
          duration: extracted.duration,
          cover_hash: extracted.coverHash,
          has_lrc: 0,
          media_type: extracted.mediaType,
          size_bytes: extracted.sizeBytes || (rawBytes ? rawBytes.byteLength : 1024),
          created_at: Date.now()
        }

    this.tracksTable.set(trackId, trackRow)

    if (this.isNative && this.db) {
      await this.db.run(
        `INSERT OR REPLACE INTO tracks
         (id, file_path, file_name, title, artist, album_tag, duration, cover_hash, has_lrc, media_type, size_bytes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`,
        [
          trackRow.id,
          trackRow.file_path,
          trackRow.file_name,
          trackRow.title,
          trackRow.artist,
          trackRow.album_tag,
          trackRow.duration,
          trackRow.cover_hash,
          trackRow.has_lrc,
          trackRow.media_type,
          trackRow.size_bytes,
          trackRow.created_at
        ]
      )
    }

    // Resolver álbumes destino (o usar/crear el álbum por defecto si no se especificaron)
    let targetAlbumIds = (params.albumIds || [])
      .map((aId) => this.resolveNodeByIdOrPath(aId)?.id || '')
      .filter(Boolean)

    if (targetAlbumIds.length === 0) {
      const defaultAlb = await this.ensureDefaultAlbum()
      targetAlbumIds = [defaultAlb.id]
    }

    await this.linkTrackToAlbums(trackId, targetAlbumIds)

    if (!this.isNative) {
      this.saveWebPersistence()
    }

    return {
      track: trackRow,
      linkedAlbumIds: targetAlbumIds
    }
  }

  /**
   * Vincula una pista existente a uno o más álbumes en la tabla M:N `album_tracks`.
   */
  public async linkTrackToAlbums(trackId: string, albumIds: string[]): Promise<number> {
    await this.init({ createDefaultAlbumIfEmpty: false })

    const track = this.resolveTrackByPathOrId(trackId)
    if (!track) {
      throw new Error(`La pista '${trackId}' no existe en la bóveda.`)
    }

    let addedCount = 0
    for (const rawAlbumId of albumIds) {
      const album = this.resolveNodeByIdOrPath(rawAlbumId)
      if (!album || album.node_type !== 'album') continue

      const key = `${album.id}::${track.id}`
      if (this.albumTracksTable.has(key)) continue

      // Calcular el siguiente orden dentro del álbum
      let maxOrder = 0
      for (const link of this.albumTracksTable.values()) {
        if (link.album_id === album.id && link.track_order >= maxOrder) {
          maxOrder = link.track_order + 1
        }
      }

      const row: VaultAlbumTrackRow = {
        album_id: album.id,
        track_id: track.id,
        track_order: maxOrder,
        added_at: Date.now()
      }

      this.albumTracksTable.set(key, row)
      addedCount++

      if (this.isNative && this.db) {
        await this.db.run(
          'INSERT OR IGNORE INTO album_tracks (album_id, track_id, track_order, added_at) VALUES (?, ?, ?, ?);',
          [row.album_id, row.track_id, row.track_order, row.added_at]
        )
      }
    }

    if (!this.isNative) {
      this.saveWebPersistence()
    }

    return addedCount
  }

  /**
   * Cuenta en cuántos álbumes está referenciada actualmente una pista (`SELECT COUNT(*) FROM album_tracks WHERE track_id = ?`).
   */
  public getTrackReferenceCount(trackId: string): number {
    let count = 0
    for (const link of this.albumTracksTable.values()) {
      if (link.track_id === trackId) {
        count++
      }
    }
    return count
  }

  /**
   * Regla de Oro de Eliminación con Conteo de Referencias:
   * - Si `deleteAllCopies === false`: elimina únicamente el vínculo `(album_id, track_id)` en `album_tracks`.
   * - Luego cuenta en cuántos álbumes sigue referenciada esa pista.
   * - Si el conteo llega a `0` O si `deleteAllCopies === true`:
   *   elimina todos sus vínculos en `album_tracks`, elimina el registro maestro en `tracks`,
   *   elimina su `.lrc` asociado y borra el archivo físico en `app_vault/tracks/`.
   */
  public async deleteTrackFromAlbum(params: {
    trackId?: string
    albumId?: string
    filePath?: string
    deleteAllCopies?: boolean
  }): Promise<DeleteTrackResult> {
    await this.init({ createDefaultAlbumIfEmpty: false })

    const resolved = this.resolveTrackAndAlbumFromInput(params)
    if (!resolved.track) {
      return {
        success: false,
        trackId: params.trackId || '',
        albumId: params.albumId,
        remainingReferences: 0,
        masterDeleted: false,
        physicalFileDeleted: false
      }
    }

    const track = resolved.track
    const targetAlbumId = resolved.album?.id
    const deleteAll = Boolean(params.deleteAllCopies)

    if (!deleteAll && targetAlbumId) {
      // Eliminar únicamente el vínculo (album_id, track_id)
      const key = `${targetAlbumId}::${track.id}`
      this.albumTracksTable.delete(key)

      if (this.isNative && this.db) {
        await this.db.run('DELETE FROM album_tracks WHERE album_id = ? AND track_id = ?;', [
          targetAlbumId,
          track.id
        ])
      }
    } else if (!deleteAll && !targetAlbumId) {
      // Si no se especificó álbum y no es deleteAll, desvincular del primer álbum donde esté
      for (const [key, link] of this.albumTracksTable.entries()) {
        if (link.track_id === track.id) {
          this.albumTracksTable.delete(key)
          if (this.isNative && this.db) {
            await this.db.run('DELETE FROM album_tracks WHERE album_id = ? AND track_id = ?;', [
              link.album_id,
              track.id
            ])
          }
          break
        }
      }
    }

    let remainingRefs = this.getTrackReferenceCount(track.id)

    if (deleteAll || remainingRefs === 0) {
      // Eliminar todos los vínculos restantes en album_tracks
      for (const [key, link] of Array.from(this.albumTracksTable.entries())) {
        if (link.track_id === track.id) {
          this.albumTracksTable.delete(key)
        }
      }

      // Eliminar registro maestro en tracks
      this.tracksTable.delete(track.id)

      if (this.isNative && this.db) {
        await this.db.run('DELETE FROM album_tracks WHERE track_id = ?;', [track.id])
        await this.db.run('DELETE FROM tracks WHERE id = ?;', [track.id])
      }

      // Eliminar archivo .lrc asociado si existe
      await this.deletePhysicalLrcFile(track.id)

      // Eliminar archivo físico en app_vault/tracks/<id>.<ext>
      const physicalDeleted = await this.deletePhysicalTrackFile(track.file_path)
      remainingRefs = 0

      if (!this.isNative) {
        this.saveWebPersistence()
      }

      return {
        success: true,
        trackId: track.id,
        albumId: targetAlbumId,
        remainingReferences: 0,
        masterDeleted: true,
        physicalFileDeleted: physicalDeleted
      }
    }

    if (!this.isNative) {
      this.saveWebPersistence()
    }

    return {
      success: true,
      trackId: track.id,
      albumId: targetAlbumId,
      remainingReferences: remainingRefs,
      masterDeleted: false,
      physicalFileDeleted: false
    }
  }

  /**
   * Mueve un álbum o carpeta a otro nodo padre (o a la raíz `__ROOT__`).
   */
  public async moveNode(
    sourceIdOrPath: string,
    targetParentIdOrPath: string | null = '__ROOT__'
  ): Promise<{ success: boolean; newPath?: string; error?: string }> {
    await this.init({ createDefaultAlbumIfEmpty: false })

    const sourceNode = this.resolveNodeByIdOrPath(sourceIdOrPath)
    if (!sourceNode) {
      return { success: false, error: 'El álbum o carpeta de origen no existe.' }
    }

    const targetParent = this.resolveNodeByIdOrPath(targetParentIdOrPath)
    const nextParentId = targetParent ? targetParent.id : null

    if (nextParentId === sourceNode.id) {
      return { success: false, error: 'No se puede mover una carpeta dentro de sí misma.' }
    }

    // Prevenir ciclos jerárquicos (mover un nodo dentro de uno de sus descendientes)
    let cursor = targetParent
    while (cursor) {
      if (cursor.id === sourceNode.id) {
        return {
          success: false,
          error: 'No se puede mover una carpeta dentro de una subcarpeta hija.'
        }
      }
      cursor = cursor.parent_id ? this.albumsTable.get(cursor.parent_id) || null : null
    }

    // Si el nodo destino era un 'album' y recibe hijos dentro, asegurar que pueda actuar como contenedor
    sourceNode.parent_id = nextParentId
    this.albumsTable.set(sourceNode.id, sourceNode)

    if (this.isNative && this.db) {
      await this.db.run('UPDATE albums SET parent_id = ? WHERE id = ?;', [
        nextParentId,
        sourceNode.id
      ])
    } else {
      this.saveWebPersistence()
    }

    return {
      success: true,
      newPath: this.getNodeVirtualPath(sourceNode.id)
    }
  }

  /**
   * Renombra un álbum o carpeta existente.
   */
  public async renameNode(
    albumIdOrPath: string,
    newName: string
  ): Promise<{ success: boolean; newPath?: string; error?: string }> {
    await this.init({ createDefaultAlbumIfEmpty: false })

    const node = this.resolveNodeByIdOrPath(albumIdOrPath)
    if (!node) {
      return { success: false, error: 'Álbum o carpeta no encontrado.' }
    }

    const cleanName = SecurityService.sanitizeFileName(
      SecurityService.validateString(newName, 'newName', 200)
    )
    if (!cleanName) {
      return { success: false, error: 'El nuevo nombre no es válido.' }
    }

    node.name = cleanName
    this.albumsTable.set(node.id, node)

    if (this.isNative && this.db) {
      await this.db.run('UPDATE albums SET name = ? WHERE id = ?;', [cleanName, node.id])
    } else {
      this.saveWebPersistence()
    }

    return {
      success: true,
      newPath: this.getNodeVirtualPath(node.id)
    }
  }

  /**
   * Elimina un álbum o carpeta (y sus sub-nodos recursivamente), aplicando conteo de referencias
   * a cada pista vinculada para borrar del almacén físico aquellas cuyo conteo llegue a 0.
   */
  public async deleteNode(albumIdOrPath: string): Promise<{
    success: boolean
    deletedAlbumIds: string[]
    deletedMasterTrackIds: string[]
    error?: string
  }> {
    await this.init({ createDefaultAlbumIfEmpty: false })

    const rootNode = this.resolveNodeByIdOrPath(albumIdOrPath)
    if (!rootNode) {
      return {
        success: false,
        deletedAlbumIds: [],
        deletedMasterTrackIds: [],
        error: 'Álbum o carpeta no encontrado.'
      }
    }

    // Recolectar el nodo y todos sus descendientes
    const toDeleteIds = new Set<string>([rootNode.id])
    let added = true
    while (added) {
      added = false
      for (const candidate of this.albumsTable.values()) {
        if (
          candidate.parent_id &&
          toDeleteIds.has(candidate.parent_id) &&
          !toDeleteIds.has(candidate.id)
        ) {
          toDeleteIds.add(candidate.id)
          added = true
        }
      }
    }

    // Identificar pistas afectadas en los álbumes a eliminar
    const affectedTrackIds = new Set<string>()
    for (const [key, link] of Array.from(this.albumTracksTable.entries())) {
      if (toDeleteIds.has(link.album_id)) {
        affectedTrackIds.add(link.track_id)
        this.albumTracksTable.delete(key)
        if (this.isNative && this.db) {
          await this.db.run('DELETE FROM album_tracks WHERE album_id = ? AND track_id = ?;', [
            link.album_id,
            link.track_id
          ])
        }
      }
    }

    // Eliminar los álbumes/carpetas
    for (const albId of toDeleteIds) {
      this.albumsTable.delete(albId)
      if (this.isNative && this.db) {
        await this.db.run('DELETE FROM albums WHERE id = ?;', [albId])
      }
    }

    // Aplicar Regla de Oro a las pistas afectadas cuyo conteo de referencias llegó a 0
    const deletedMasterTrackIds: string[] = []
    for (const trackId of affectedTrackIds) {
      const refCount = this.getTrackReferenceCount(trackId)
      if (refCount === 0) {
        const track = this.tracksTable.get(trackId)
        if (track) {
          this.tracksTable.delete(trackId)
          if (this.isNative && this.db) {
            await this.db.run('DELETE FROM tracks WHERE id = ?;', [trackId])
          }
          await this.deletePhysicalLrcFile(trackId)
          await this.deletePhysicalTrackFile(track.file_path)
          deletedMasterTrackIds.push(trackId)
        }
      }
    }

    if (!this.isNative) {
      this.saveWebPersistence()
    }

    return {
      success: true,
      deletedAlbumIds: Array.from(toDeleteIds),
      deletedMasterTrackIds
    }
  }

  /**
   * Cambia la portada personalizada de un álbum.
   */
  public async setAlbumCustomCover(
    albumIdOrPath: string,
    coverUrlOrTrackPath?: string | null,
    explicitCoverUrl?: string | null
  ): Promise<{ success: boolean; coverUrl?: string | null; error?: string }> {
    await this.init({ createDefaultAlbumIfEmpty: false })

    const album = this.resolveNodeByIdOrPath(albumIdOrPath)
    if (!album) {
      return { success: false, error: 'Álbum no encontrado.' }
    }

    let resolvedCover = explicitCoverUrl || null
    if (!resolvedCover && coverUrlOrTrackPath) {
      const track = this.resolveTrackByPathOrId(coverUrlOrTrackPath)
      if (track && track.cover_hash) {
        resolvedCover = this.resolveCoverUrl(track.cover_hash)
      } else if (
        coverUrlOrTrackPath.startsWith('data:') ||
        coverUrlOrTrackPath.startsWith('blob:') ||
        coverUrlOrTrackPath.startsWith('http')
      ) {
        resolvedCover = coverUrlOrTrackPath
      }
    }

    album.custom_cover = resolvedCover
    this.albumsTable.set(album.id, album)

    if (this.isNative && this.db) {
      await this.db.run('UPDATE albums SET custom_cover = ? WHERE id = ?;', [
        resolvedCover,
        album.id
      ])
    } else {
      this.saveWebPersistence()
    }

    return { success: true, coverUrl: resolvedCover }
  }

  /**
   * Actualiza los metadatos de una pista en la tabla `tracks`.
   */
  public async updateTrackMetadata(
    trackIdOrPath: string,
    patch: { title?: string; artist?: string; album?: string }
  ): Promise<{ success: boolean; track?: VaultTrackRow; error?: string }> {
    await this.init({ createDefaultAlbumIfEmpty: false })

    const track = this.resolveTrackByPathOrId(trackIdOrPath)
    if (!track) {
      return { success: false, error: 'Pista no encontrada en la bóveda.' }
    }

    if (typeof patch.title === 'string' && patch.title.trim()) {
      track.title = patch.title.trim()
    }
    if (typeof patch.artist === 'string' && patch.artist.trim()) {
      track.artist = patch.artist.trim()
    }
    if (typeof patch.album === 'string') {
      track.album_tag = patch.album.trim()
    }

    this.tracksTable.set(track.id, track)

    if (this.isNative && this.db) {
      await this.db.run('UPDATE tracks SET title = ?, artist = ?, album_tag = ? WHERE id = ?;', [
        track.title,
        track.artist,
        track.album_tag,
        track.id
      ])
    } else {
      this.saveWebPersistence()
    }

    return { success: true, track }
  }

  /**
   * Guarda un archivo `.lrc` en `app_vault/lyrics/<trackId>.lrc` y marca `has_lrc = 1`.
   */
  public async saveTrackLyrics(trackIdOrPath: string, lrcContent: string): Promise<boolean> {
    await this.init({ createDefaultAlbumIfEmpty: false })
    const track = this.resolveTrackByPathOrId(trackIdOrPath)
    if (!track) return false

    const lrcPath = `app_vault/lyrics/${track.id}.lrc`
    if (this.isNative) {
      try {
        await Filesystem.writeFile({
          path: lrcPath,
          data: lrcContent,
          directory: Directory.Data,
          encoding: Encoding.UTF8,
          recursive: true
        })
      } catch (_) {}
    }

    this.physicalLyricsFiles.set(lrcPath, lrcContent)
    track.has_lrc = 1
    this.tracksTable.set(track.id, track)

    if (this.isNative && this.db) {
      await this.db.run('UPDATE tracks SET has_lrc = 1 WHERE id = ?;', [track.id])
    } else {
      this.saveWebPersistence()
    }

    return true
  }

  /**
   * Lee el contenido `.lrc` asociado a una pista desde `app_vault/lyrics/<trackId>.lrc`.
   */
  public async readTrackLyrics(trackIdOrPath: string): Promise<string | null> {
    await this.init({ createDefaultAlbumIfEmpty: false })
    const track = this.resolveTrackByPathOrId(trackIdOrPath)
    if (!track) return null

    const lrcPath = `app_vault/lyrics/${track.id}.lrc`
    if (this.physicalLyricsFiles.has(lrcPath)) {
      return this.physicalLyricsFiles.get(lrcPath) || null
    }

    if (this.isNative) {
      try {
        const res = await Filesystem.readFile({
          path: lrcPath,
          directory: Directory.Data,
          encoding: Encoding.UTF8
        })
        if (typeof res.data === 'string' && res.data.trim()) {
          this.physicalLyricsFiles.set(lrcPath, res.data)
          return res.data
        }
      } catch (_) {}
    }

    return null
  }

  /**
   * Elimina el archivo `.lrc` asociado a una pista y actualiza `has_lrc = 0`.
   */
  public async deleteTrackLyrics(trackIdOrPath: string): Promise<boolean> {
    await this.init({ createDefaultAlbumIfEmpty: false })
    const track = this.resolveTrackByPathOrId(trackIdOrPath)
    if (!track) return false

    await this.deletePhysicalLrcFile(track.id)
    track.has_lrc = 0
    this.tracksTable.set(track.id, track)

    if (this.isNative && this.db) {
      await this.db.run('UPDATE tracks SET has_lrc = 0 WHERE id = ?;', [track.id])
    } else {
      this.saveWebPersistence()
    }

    return true
  }

  /**
   * Construye la respuesta jerárquica completa de la biblioteca que consume `PlayerContext.jsx`.
   */
  public async buildLibraryResponse(
    options: { ensureDefaultIfEmpty?: boolean } = {}
  ): Promise<LibraryResponse> {
    const shouldEnsureDefault = options.ensureDefaultIfEmpty ?? true
    await this.init({ createDefaultAlbumIfEmpty: shouldEnsureDefault })

    const songAlbumsIndex: Record<string, { albumIds: string[]; albumNames: string[] }> = {}

    // Pre-construir índice de membresía de álbumes por cada pista
    for (const link of this.albumTracksTable.values()) {
      const track = this.tracksTable.get(link.track_id)
      const album = this.albumsTable.get(link.album_id)
      if (!track || !album) continue

      const uKey = `ino:${track.id}`
      if (!songAlbumsIndex[uKey]) {
        songAlbumsIndex[uKey] = { albumIds: [], albumNames: [] }
      }
      if (!songAlbumsIndex[uKey].albumIds.includes(album.id)) {
        songAlbumsIndex[uKey].albumIds.push(album.id)
        songAlbumsIndex[uKey].albumNames.push(album.name)
      }
    }

    const buildAlbumTrackList = (
      album: VaultAlbumRow,
      albumVirtualPath: string
    ): LibraryTrackItem[] => {
      const links = Array.from(this.albumTracksTable.values())
        .filter((l) => l.album_id === album.id)
        .sort((a, b) => a.track_order - b.track_order || a.added_at - b.added_at)

      const items: LibraryTrackItem[] = []
      for (const link of links) {
        const track = this.tracksTable.get(link.track_id)
        if (!track) continue

        const coverUrl = this.resolveCoverUrl(track.cover_hash) || album.custom_cover || null
        const fileUrl = this.resolveTrackPlayableUrl(track)
        const virtualTrackPath = `${albumVirtualPath}/${track.file_name}`
        const hasLrc = Boolean(track.has_lrc)

        items.push({
          id: track.id,
          ino: track.id,
          uniqueKey: `ino:${track.id}`,
          title: track.title,
          artist: track.artist,
          album: track.album_tag || album.name,
          albumId: album.id,
          albumName: album.name,
          duration: track.duration,
          path: virtualTrackPath,
          filePath: track.file_path,
          fileName: track.file_name,
          fileUrl,
          cover: coverUrl,
          hasLrc,
          hasLyrics: hasLrc,
          syncedLyrics: hasLrc,
          mediaType: track.media_type,
          size: track.size_bytes,
          mtimeMs: track.created_at
        })
      }
      return items
    }

    const buildTreeNodes = (parentId: string | null, parentCategoryPath: string): LibraryNode[] => {
      const childrenRows = Array.from(this.albumsTable.values())
        .filter((n) => (n.parent_id || null) === parentId)
        .sort((a, b) => {
          if (a.node_type !== b.node_type) {
            return a.node_type === 'folder' ? -1 : 1
          }
          return a.name.localeCompare(b.name)
        })

      const nodes: LibraryNode[] = []
      for (const row of childrenRows) {
        const virtualPath = this.getNodeVirtualPath(row.id)
        const subChildren = buildTreeNodes(row.id, virtualPath)
        const directTracks = buildAlbumTrackList(row, virtualPath)

        if (row.node_type === 'folder' || subChildren.length > 0) {
          const folderChildren = [...subChildren]
          // Si un nodo que tiene subcarpetas/álbumes hijos también tiene canciones directas
          if (directTracks.length > 0) {
            const directCover =
              row.custom_cover || directTracks.find((t) => t.cover)?.cover || null
            folderChildren.unshift({
              id: `${row.id}___direct`,
              type: 'album',
              name: row.name,
              path: virtualPath,
              categoryPath: parentCategoryPath || 'Colección Principal',
              cover: directCover,
              trackCount: directTracks.length,
              tracks: directTracks
            })
          }

          const totalTracksInFolder = folderChildren.reduce((acc, child) => {
            if (child.type === 'album') return acc + (child.trackCount || 0)
            return acc + (child.totalTracks || 0)
          }, 0)

          nodes.push({
            id: row.id,
            type: 'folder',
            name: row.name,
            path: virtualPath,
            categoryPath: parentCategoryPath || 'Carpeta',
            itemCount: folderChildren.length,
            totalTracks: totalTracksInFolder,
            children: folderChildren
          })
        } else {
          const albumCover = row.custom_cover || directTracks.find((t) => t.cover)?.cover || null
          nodes.push({
            id: row.id,
            type: 'album',
            name: row.name,
            path: virtualPath,
            categoryPath: parentCategoryPath || 'Colección Principal',
            cover: albumCover,
            trackCount: directTracks.length,
            tracks: directTracks
          })
        }
      }

      return nodes
    }

    const tree = buildTreeNodes(null, '')

    let totalSizeBytes = 0
    for (const track of this.tracksTable.values()) {
      totalSizeBytes += track.size_bytes || 0
    }

    let totalAlbums = 0
    for (const alb of this.albumsTable.values()) {
      if (alb.node_type === 'album') totalAlbums++
    }

    return {
      tree,
      songAlbumsIndex,
      vaultStats: {
        totalTracks: this.tracksTable.size,
        totalAlbums,
        totalSizeBytes
      }
    }
  }

  /**
   * Ejecuta una Auditoría de Integridad de la Bóveda SQLite + Almacén Físico.
   * Detecta:
   * - Pistas maestras en `tracks` sin ninguna referencia en `album_tracks` (huérfanas).
   * - Archivos físicos en `app_vault/tracks/` que no tienen registro en `tracks`.
   * - Enlaces rotos en `album_tracks` que apuntan a pistas o álbumes inexistentes.
   */
  public async auditVaultIntegrity(): Promise<VaultHealthReport> {
    await this.init({ createDefaultAlbumIfEmpty: false })

    const brokenLinks: string[] = []
    const orphanedMasters: string[] = []
    const orphanedPhysicalFiles: string[] = []
    const desynchronizedInodes: Array<{ linkPath: string; masterPath: string }> = []

    // 1. Verificar vínculos en album_tracks
    for (const [key, link] of this.albumTracksTable.entries()) {
      const track = this.tracksTable.get(link.track_id)
      const album = this.albumsTable.get(link.album_id)
      if (!track || !album) {
        brokenLinks.push(key)
      } else if (!this.hasPhysicalTrackFile(track.file_path)) {
        desynchronizedInodes.push({
          linkPath: `${this.getNodeVirtualPath(album.id)}/${track.file_name}`,
          masterPath: track.file_path
        })
      }
    }

    // 2. Verificar pistas maestras sin referencias en album_tracks
    for (const track of this.tracksTable.values()) {
      const refCount = this.getTrackReferenceCount(track.id)
      if (refCount === 0) {
        orphanedMasters.push(track.file_path)
      }
    }

    // 3. Verificar archivos físicos en app_vault/tracks/ sin registro en tracks
    const knownPhysicalPaths = new Set<string>(
      Array.from(this.tracksTable.values()).map((t) => t.file_path)
    )
    for (const physPath of this.physicalTrackFiles.keys()) {
      if (!knownPhysicalPaths.has(physPath)) {
        orphanedPhysicalFiles.push(physPath)
      }
    }

    // Calcular espacio ahorrado por deduplicación M:N (inodos virtuales)
    let savedSpaceBytes = 0
    for (const track of this.tracksTable.values()) {
      const refs = this.getTrackReferenceCount(track.id)
      if (refs > 1) {
        savedSpaceBytes += (refs - 1) * (track.size_bytes || 0)
      }
    }

    const totalLinks = this.albumTracksTable.size
    const totalMasters = this.tracksTable.size
    const divergentCount = brokenLinks.length + desynchronizedInodes.length
    const unlinkedCount = orphanedMasters.length + orphanedPhysicalFiles.length
    const healthyCount = Math.max(0, totalLinks - divergentCount)
    const totalChecked = Math.max(1, totalLinks + unlinkedCount)
    const healthPercentage =
      totalLinks === 0 && unlinkedCount === 0
        ? 100
        : Math.max(0, Math.min(100, Math.round((healthyCount / totalChecked) * 100)))

    return {
      success: true,
      healthy: divergentCount === 0 && unlinkedCount === 0,
      healthPercentage,
      totalHardlinks: totalLinks,
      totalOrganizedFiles: totalLinks,
      totalMasterFiles: totalMasters,
      healthyCount,
      divergentCount,
      unlinkedCount,
      savedSpaceBytes,
      savedSpaceFormatted: formatBytes(savedSpaceBytes),
      brokenLinks,
      desynchronizedInodes,
      orphanedMasters,
      orphanedPhysicalFiles
    }
  }

  /**
   * Repara automáticamente la integridad de la bóveda SQLite:
   * limpia enlaces rotos, elimina pistas maestras sin referencias (`ref_count === 0`),
   * borra archivos físicos huérfanos en `app_vault/tracks/` y compacta la base de datos.
   */
  public async repairVaultIntegrity(
    onProgress?: (progress: { current: number; total: number; repairedCount: number }) => void
  ): Promise<VaultHealthReport> {
    const audit = await this.auditVaultIntegrity()
    const totalIssues =
      audit.brokenLinks.length +
      audit.desynchronizedInodes.length +
      audit.orphanedMasters.length +
      audit.orphanedPhysicalFiles.length

    let current = 0
    let repairedCount = 0

    // 1. Limpiar enlaces rotos en album_tracks
    for (const brokenKey of audit.brokenLinks) {
      this.albumTracksTable.delete(brokenKey)
      const [albumId, trackId] = brokenKey.split('::')
      if (this.isNative && this.db && albumId && trackId) {
        await this.db.run('DELETE FROM album_tracks WHERE album_id = ? AND track_id = ?;', [
          albumId,
          trackId
        ])
      }
      current++
      repairedCount++
      onProgress?.({ current, total: totalIssues, repairedCount })
    }

    // 2. Eliminar pistas maestras huérfanas (ref_count === 0)
    for (const track of Array.from(this.tracksTable.values())) {
      if (this.getTrackReferenceCount(track.id) === 0) {
        this.tracksTable.delete(track.id)
        if (this.isNative && this.db) {
          await this.db.run('DELETE FROM tracks WHERE id = ?;', [track.id])
        }
        await this.deletePhysicalLrcFile(track.id)
        await this.deletePhysicalTrackFile(track.file_path)
        current++
        repairedCount++
        onProgress?.({ current, total: totalIssues, repairedCount })
      }
    }

    // 3. Eliminar archivos físicos huérfanos en app_vault/tracks/
    const validPaths = new Set(Array.from(this.tracksTable.values()).map((t) => t.file_path))
    for (const physPath of Array.from(this.physicalTrackFiles.keys())) {
      if (!validPaths.has(physPath)) {
        await this.deletePhysicalTrackFile(physPath)
        current++
        repairedCount++
        onProgress?.({ current, total: totalIssues, repairedCount })
      }
    }

    if (this.isNative && this.db) {
      try {
        await this.db.execute('VACUUM;')
      } catch (_) {}
    } else {
      this.saveWebPersistence()
    }

    const postAudit = await this.auditVaultIntegrity()
    return {
      ...postAudit,
      repairedCount,
      message: `Bóveda compactada y reparada (${repairedCount} elementos corregidos).`
    }
  }

  /**
   * Busca una pista en `tracks` por su `id`, `file_path` (`app_vault/tracks/<id>.<ext>`)
   * o su ruta virtual dentro de un álbum (`<albumPath>/<file_name>`).
   */
  public resolveTrackByPathOrId(pathOrId?: string | null): VaultTrackRow | null {
    if (!pathOrId) return null
    const cleanInput = pathOrId.replace(/^ino:/i, '').trim()

    const byId = this.tracksTable.get(cleanInput)
    if (byId) return byId

    const norm = SecurityService.normalizePath(cleanInput).toLowerCase()
    for (const track of this.tracksTable.values()) {
      if (
        track.id.toLowerCase() === norm ||
        SecurityService.normalizePath(track.file_path).toLowerCase() === norm
      ) {
        return track
      }
    }

    // Buscar coincidencia con ruta virtual <albumVirtualPath>/<track.file_name>
    for (const link of this.albumTracksTable.values()) {
      const album = this.albumsTable.get(link.album_id)
      const track = this.tracksTable.get(link.track_id)
      if (!album || !track) continue
      const virtualPath = `${this.getNodeVirtualPath(album.id)}/${track.file_name}`.toLowerCase()
      if (virtualPath === norm) {
        return track
      }
    }

    // Fallback por nombre de archivo
    const fileNamePart = norm.split('/').pop() || norm
    for (const track of this.tracksTable.values()) {
      if (track.file_name.toLowerCase() === fileNamePart) {
        return track
      }
    }

    return null
  }

  private resolveTrackAndAlbumFromInput(params: {
    trackId?: string
    albumId?: string
    filePath?: string
  }): { track: VaultTrackRow | null; album: VaultAlbumRow | null } {
    let track = params.trackId ? this.resolveTrackByPathOrId(params.trackId) : null
    let album = params.albumId ? this.resolveNodeByIdOrPath(params.albumId) : null

    if (params.filePath) {
      const norm = SecurityService.normalizePath(params.filePath).toLowerCase()
      for (const link of this.albumTracksTable.values()) {
        const candAlbum = this.albumsTable.get(link.album_id)
        const candTrack = this.tracksTable.get(link.track_id)
        if (!candAlbum || !candTrack) continue
        const virtualPath =
          `${this.getNodeVirtualPath(candAlbum.id)}/${candTrack.file_name}`.toLowerCase()
        if (virtualPath === norm) {
          if (!track) track = candTrack
          if (!album) album = candAlbum
          break
        }
      }
      if (!track) {
        track = this.resolveTrackByPathOrId(params.filePath)
      }
    }

    return { track, album }
  }

  public getTrackById(trackId: string): VaultTrackRow | null {
    return this.tracksTable.get(trackId) || null
  }

  public getAlbumById(albumId: string): VaultAlbumRow | null {
    return this.albumsTable.get(albumId) || null
  }

  public getAllTracks(): VaultTrackRow[] {
    return Array.from(this.tracksTable.values())
  }

  public getAllAlbums(): VaultAlbumRow[] {
    return Array.from(this.albumsTable.values())
  }

  public hasPhysicalTrackFile(filePath: string): boolean {
    const norm = SecurityService.normalizePath(filePath)
    return this.physicalTrackFiles.has(norm)
  }

  private async writePhysicalTrackFile(
    filePath: string,
    bytes: Uint8Array | null,
    sizeBytes: number,
    webBlobUrl: string = ''
  ): Promise<void> {
    const norm = SecurityService.normalizePath(filePath)
    let fileUrl = webBlobUrl

    if (this.isNative && bytes && bytes.length > 0) {
      try {
        const b64 = uint8ArrayToBase64(bytes)
        const writeRes = await Filesystem.writeFile({
          path: norm,
          data: b64,
          directory: Directory.Data,
          recursive: true
        })
        if (writeRes.uri) {
          fileUrl = Capacitor.convertFileSrc(writeRes.uri)
        }
      } catch (_) {}
    }

    if (!fileUrl) {
      if (this.isNative && this.nativeDataUriBase) {
        const rel = norm.replace(/^app_vault\/?/, '')
        fileUrl = Capacitor.convertFileSrc(`${this.nativeDataUriBase}/${rel}`)
      } else {
        fileUrl = `vault://${norm}`
      }
    }

    this.physicalTrackFiles.set(norm, {
      sizeBytes,
      fileUrl
    })
  }

  private async deletePhysicalTrackFile(filePath: string): Promise<boolean> {
    const norm = SecurityService.normalizePath(filePath)
    const existed = this.physicalTrackFiles.has(norm)
    const entry = this.physicalTrackFiles.get(norm)

    if (entry?.fileUrl && entry.fileUrl.startsWith('blob:')) {
      try {
        URL.revokeObjectURL(entry.fileUrl)
      } catch (_) {}
    }

    this.physicalTrackFiles.delete(norm)

    if (this.isNative) {
      try {
        await Filesystem.deleteFile({
          path: norm,
          directory: Directory.Data
        })
        return true
      } catch (_) {}
    }

    return existed
  }

  private async deletePhysicalLrcFile(trackId: string): Promise<void> {
    const lrcPath = `app_vault/lyrics/${trackId}.lrc`
    this.physicalLyricsFiles.delete(lrcPath)
    if (this.isNative) {
      try {
        await Filesystem.deleteFile({
          path: lrcPath,
          directory: Directory.Data
        })
      } catch (_) {}
    }
  }

  private async saveCoverByHash(
    coverHash: string,
    coverBytes: Uint8Array,
    mimeType: string
  ): Promise<string> {
    const coverRelPath = `.covers/${coverHash}.jpg`
    const existing = this.physicalCoverFiles.get(coverRelPath)
    if (existing) return existing

    const b64 = uint8ArrayToBase64(coverBytes)
    let coverUrl = `data:${mimeType || 'image/jpeg'};base64,${b64}`

    if (this.isNative) {
      try {
        const writeRes = await Filesystem.writeFile({
          path: coverRelPath,
          data: b64,
          directory: Directory.Cache,
          recursive: true
        })
        if (writeRes.uri) {
          coverUrl = Capacitor.convertFileSrc(writeRes.uri)
        }
      } catch (_) {}
    }

    this.physicalCoverFiles.set(coverRelPath, coverUrl)
    return coverUrl
  }

  private resolveCoverUrl(coverHash?: string | null): string | null {
    if (!coverHash) return null
    const coverRelPath = `.covers/${coverHash}.jpg`
    const cached = this.physicalCoverFiles.get(coverRelPath)
    if (cached) return cached

    if (this.isNative && this.nativeCacheUriBase) {
      return Capacitor.convertFileSrc(`${this.nativeCacheUriBase}/${coverHash}.jpg`)
    }
    return null
  }

  private resolveTrackPlayableUrl(track: VaultTrackRow): string {
    const norm = SecurityService.normalizePath(track.file_path)
    const cached = this.physicalTrackFiles.get(norm)
    if (cached && cached.fileUrl) {
      return cached.fileUrl
    }
    if (this.isNative && this.nativeDataUriBase) {
      const rel = norm.replace(/^app_vault\/?/, '')
      return Capacitor.convertFileSrc(`${this.nativeDataUriBase}/${rel}`)
    }
    return `vault://${norm}`
  }
}

export const storageVault = StorageVaultService.getInstance()
