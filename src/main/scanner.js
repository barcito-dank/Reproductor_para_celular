import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { pathToFileURL, fileURLToPath } from 'url'
import { parseFile } from 'music-metadata'

const SUPPORTED_EXTENSIONS = ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.wma', '.opus']

// Caché en memoria y en disco para arranque instantáneo
let metadataCache = {}
let loadedCacheKey = null
const knownCovers = new Set()
let activeCoversDir = null

function getDirHash(dirPath) {
  const normalized = path.resolve(dirPath).toLowerCase()
  return crypto.createHash('md5').update(normalized).digest('hex').slice(0, 12)
}

function getPrimaryCachePath(baseDir, userDataDir) {
  // Guarda el archivo de caché directamente en la carpeta de música (.library_cache.json)
  return path.join(baseDir, '.library_cache.json')
}

function getLegacyCachePath(baseDir, userDataDir) {
  if (userDataDir) {
    return path.join(userDataDir, 'cache', `library_cache_${getDirHash(baseDir)}.json`)
  }
  return path.join(baseDir, '.library_cache.json')
}

function getSongAlbumsIndexPath(baseDir, userDataDir) {
  // Guarda el índice de canciones en la carpeta de música (.song_albums_index.json)
  return path.join(baseDir, '.song_albums_index.json')
}

/**
 * Genera una clave canónica de identidad para detectar canciones iguales
 * en múltiples álbumes dentro del directorio de música.
 */
function computeTrackUniqueKey(track) {
  if (!track) return ''

  const normTitle = (track.title || '')
    .toLowerCase()
    .replace(/(?:\s*-\s*(?:copia|copy)|\s*\(\d+\))+$/i, '')
    .replace(/\s+/g, ' ')
    .trim()

  const normArtist = (track.artist || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()

  const roundedDuration = Math.round(track.duration || 0)

  if (normTitle) {
    return `${normTitle}|${normArtist}|${roundedDuration}`
  }

  const rawPath = track.path || track.id || ''
  const fileName = rawPath.split(/[\\/]/).pop() || rawPath
  const stem = fileName
    .replace(/\.[^/.]+$/, '')
    .toLowerCase()
    .replace(/(?:\s*-\s*(?:copia|copy)|\s*\(\d+\))+$/i, '')
    .replace(/\s+/g, ' ')
    .trim()

  return `${stem}|${normArtist}|${roundedDuration}`
}

function toFileUrl(filePath) {
  if (!filePath) return null
  try {
    return pathToFileURL(filePath).href
  } catch (_) {
    return null
  }
}

/**
 * Asegura la existencia del subdirectorio de carátulas en baseDir/.covers (con fallback a userData/cache/covers)
 */
async function ensureCoversDir(baseDir, userDataDir) {
  if (activeCoversDir) return activeCoversDir

  const candidates = [
    path.join(baseDir, '.covers')
  ]
  if (userDataDir) {
    candidates.push(path.join(userDataDir, 'cache', 'covers'))
  }

  for (const candidate of candidates) {
    try {
      await fs.promises.mkdir(candidate, { recursive: true })
      activeCoversDir = candidate

      // Pre-cargar en memoria los nombres de carátulas existentes para validaciones O(1) sin I/O a disco
      try {
        const existingFiles = await fs.promises.readdir(candidate)
        for (const file of existingFiles) {
          const fullPath = path.join(candidate, file)
          knownCovers.add(fullPath)
          knownCovers.add(fullPath.toLowerCase())
          knownCovers.add(fullPath.replace(/\\/g, '/').toLowerCase())
        }
      } catch (_) {}

      return activeCoversDir
    } catch (err) {
      console.warn(`No se pudo crear directorio de carátulas en ${candidate}:`, err.message)
    }
  }

  return candidates[0]
}

/**
 * Guarda los bytes de la carátula integrada en el directorio de caché de carátulas.
 * Deduplica automáticamente mediante hash MD5 y caché en memoria.
 */
async function saveCoverBuffer(baseDir, userDataDir, buffer, format) {
  if (!buffer || buffer.length === 0) return null
  try {
    const coversDir = await ensureCoversDir(baseDir, userDataDir)
    const hash = crypto.createHash('md5').update(buffer).digest('hex')
    const ext = format && format.toLowerCase().includes('png') ? '.png' : '.jpg'
    const fileName = `${hash}${ext}`
    const filePath = path.join(coversDir, fileName)
    const normalizedKey = filePath.toLowerCase()

    if (knownCovers.has(filePath) || knownCovers.has(normalizedKey)) {
      return toFileUrl(filePath)
    }

    try {
      await fs.promises.access(filePath)
      knownCovers.add(filePath)
      knownCovers.add(normalizedKey)
    } catch (_) {
      await fs.promises.writeFile(filePath, buffer)
      knownCovers.add(filePath)
      knownCovers.add(normalizedKey)
    }

    return toFileUrl(filePath)
  } catch (err) {
    console.error('Error guardando carátula en disco:', err)
    return null
  }
}

async function loadCache(baseDir, userDataDir) {
  const cacheKey = `${userDataDir || ''}|${path.resolve(baseDir)}`
  if (loadedCacheKey === cacheKey) return

  const primaryFile = getPrimaryCachePath(baseDir, userDataDir)
  const legacyFile = getLegacyCachePath(baseDir, userDataDir)
  const candidates = primaryFile !== legacyFile ? [primaryFile, legacyFile] : [primaryFile]

  metadataCache = {}
  for (const cacheFile of candidates) {
    try {
      const raw = await fs.promises.readFile(cacheFile, 'utf8')
      if (!raw.includes('data:image')) {
        metadataCache = JSON.parse(raw)
        break
      }
    } catch (err) {
      if (err.code !== 'ENOENT') {
        console.warn(`Aviso al cargar caché de ${cacheFile}:`, err.message)
      }
    }
  }
  loadedCacheKey = cacheKey
}

async function saveCache(baseDir, userDataDir) {
  const primaryFile = getPrimaryCachePath(baseDir, userDataDir)
  const legacyFile = getLegacyCachePath(baseDir, userDataDir)
  const candidates = primaryFile !== legacyFile ? [primaryFile, legacyFile] : [primaryFile]

  for (const cacheFile of candidates) {
    try {
      await fs.promises.mkdir(path.dirname(cacheFile), { recursive: true })
      await fs.promises.writeFile(cacheFile, JSON.stringify(metadataCache), 'utf8')
      return
    } catch (err) {
      console.warn(`No se pudo guardar caché de metadatos en ${cacheFile}:`, err.message)
    }
  }
}

/**
 * Busca una imagen de portada en la carpeta del álbum de manera asíncrona.
 * Si se proporcionan las entradas ya leídas del directorio, evita volver a leer el disco.
 */
async function findCoverImage(albumDir, preloadedEntries = null) {
  const coverNames = ['cover', 'folder', 'album', 'front', 'artwork', 'thumb']
  const imageExts = ['.jpg', '.jpeg', '.png', '.webp', '.bmp']
  try {
    let fileNames = []
    if (preloadedEntries && Array.isArray(preloadedEntries)) {
      fileNames = preloadedEntries
        .filter(e => !e.isDirectory())
        .map(e => e.name)
    } else {
      fileNames = await fs.promises.readdir(albumDir)
    }

    for (const file of fileNames) {
      const name = path.parse(file).name.toLowerCase()
      const ext = path.extname(file).toLowerCase()
      if (imageExts.includes(ext) && coverNames.some(cn => name.includes(cn))) {
        return path.join(albumDir, file)
      }
    }
    for (const file of fileNames) {
      const ext = path.extname(file).toLowerCase()
      if (imageExts.includes(ext)) {
        return path.join(albumDir, file)
      }
    }
  } catch (err) {
    console.error(`Error buscando carátula en ${albumDir}:`, err.message)
  }
  return null
}

/**
 * Extrae metadata de un archivo de audio con soporte para caché por fecha de modificación
 * de forma 100% asíncrona para no bloquear el hilo principal.
 */
async function extractMetadata(filePath, baseDir, userDataDir) {
  try {
    const stats = await fs.promises.stat(filePath)
    const mtime = stats.mtimeMs
    const size = stats.size

    if (metadataCache[filePath] && metadataCache[filePath].mtime === mtime) {
      const cached = metadataCache[filePath].data
      if (cached && (!cached.embeddedCover || !cached.embeddedCover.startsWith('data:'))) {
        let coverValid = true
        if (cached.embeddedCover && cached.embeddedCover.startsWith('file:')) {
          try {
            let coverFilePath = fileURLToPath(cached.embeddedCover)
            const normalizedPath = coverFilePath.toLowerCase()
            if (!knownCovers.has(coverFilePath) && !knownCovers.has(normalizedPath)) {
              try {
                await fs.promises.access(coverFilePath)
                knownCovers.add(coverFilePath)
                knownCovers.add(normalizedPath)
              } catch (_) {
                // Si la ruta anterior apuntaba a otro directorio, buscarla en baseDir/.covers
                const localAlternative = path.join(baseDir, '.covers', path.basename(coverFilePath))
                const normalizedLocal = localAlternative.toLowerCase()
                if (knownCovers.has(localAlternative) || knownCovers.has(normalizedLocal)) {
                  cached.embeddedCover = toFileUrl(localAlternative)
                } else {
                  await fs.promises.access(localAlternative)
                  knownCovers.add(localAlternative)
                  knownCovers.add(normalizedLocal)
                  cached.embeddedCover = toFileUrl(localAlternative)
                }
              }
            }
          } catch (_) {
            coverValid = false
          }
        }
        if (coverValid) {
          if (typeof cached.hasLyrics === 'boolean') {
            return {
              ...cached,
              size: cached.size ?? size,
              mtime
            }
          }
          // Si no los tiene aún en caché, verificar rápidamente letras
          let hasLyrics = false
          let syncedLyrics = false
          try {
            const dir = path.dirname(filePath)
            const base = path.parse(filePath).name
            const lrcCandidate = path.join(dir, `${base}.lrc`)
            if (fs.existsSync(lrcCandidate)) {
              hasLyrics = true
              const lrcContent = await fs.promises.readFile(lrcCandidate, 'utf8')
              syncedLyrics = /\[\d{1,2}:\d{2}/.test(lrcContent)
            }
          } catch (_) {}

          cached.hasLyrics = hasLyrics
          cached.syncedLyrics = syncedLyrics

          return {
            ...cached,
            size: cached.size ?? size,
            mtime
          }
        }
      }
    }

    const metadata = await parseFile(filePath)
    const { common, format } = metadata
    let coverUrl = null

    if (common.picture && common.picture.length > 0) {
      const pic = common.picture[0]
      coverUrl = await saveCoverBuffer(baseDir, userDataDir, pic.data, pic.format)
    }

    // Detección de letras (LRC externo o ID3/metadatos)
    let hasLyrics = false
    let syncedLyrics = false
    try {
      const dir = path.dirname(filePath)
      const base = path.parse(filePath).name
      const lrcCandidate = path.join(dir, `${base}.lrc`)
      if (fs.existsSync(lrcCandidate)) {
        hasLyrics = true
        const lrcContent = await fs.promises.readFile(lrcCandidate, 'utf8')
        syncedLyrics = /\[\d{1,2}:\d{2}/.test(lrcContent)
      }
    } catch (_) {}

    if (!hasLyrics && common.lyrics && common.lyrics.length > 0) {
      hasLyrics = true
      const rawText = typeof common.lyrics[0] === 'string' ? common.lyrics[0] : (common.lyrics[0].text || '')
      if (rawText && /\[\d{1,2}:\d{2}/.test(rawText)) {
        syncedLyrics = true
      }
    }

    const data = {
      title: common.title || path.parse(filePath).name,
      artist: common.artist || 'Artista Desconocido',
      album: common.album || null,
      trackNumber: common.track?.no || 0,
      duration: format.duration || 0,
      bitrate: format.bitrate ? Math.round(format.bitrate / 1000) : null,
      sampleRate: format.sampleRate || null,
      codec: format.codec || format.container || path.extname(filePath).replace('.', '').toUpperCase(),
      size,
      mtime,
      embeddedCover: coverUrl,
      hasLyrics,
      syncedLyrics
    }

    metadataCache[filePath] = { mtime, data }
    return data
  } catch (err) {
    console.error(`Error leyendo metadata de ${filePath}:`, err.message || err)
    return {
      title: path.parse(filePath).name,
      artist: 'Artista Desconocido',
      album: null,
      trackNumber: 0,
      duration: 0,
      bitrate: null,
      sampleRate: null,
      codec: path.extname(filePath).replace('.', '').toUpperCase(),
      size: 0,
      mtime: 0,
      embeddedCover: null,
      hasLyrics: false,
      syncedLyrics: false
    }
  }
}

/**
 * Limitador de concurrencia ligero sin dependencias externas
 */
function createLimiter(concurrency) {
  let active = 0
  const queue = []

  const next = () => {
    if (active < concurrency && queue.length > 0) {
      active++
      const { fn, resolve, reject } = queue.shift()
      fn().then(resolve, reject).finally(() => {
        active--
        next()
      })
    }
  }

  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject })
    next()
  })
}

function countTracksRecursive(nodes) {
  let count = 0
  for (const n of nodes) {
    if (n.type === 'album') {
      count += n.trackCount || 0
    } else if (n.children) {
      count += countTracksRecursive(n.children)
    }
  }
  return count
}

/**
 * Escanea un nodo del directorio de forma recursiva y asíncrona.
 * - Si no tiene subdirectorios y tiene audios: genera un nodo Tipo 'album' (con carátula e información).
 * - Si tiene subdirectorios: genera un nodo Tipo 'folder' (barra desplegable sin imagen).
 *   - Si contiene audios propios directos, añade un álbum hijo para ellos.
 */
async function scanDirectoryNode(dir, baseDir, userDataDir, parentPathName = '', limitMetadata, limitDirScan) {
  let entries = []
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch (err) {
    console.error(`Error leyendo directorio ${dir}:`, err.message)
    return null
  }

  const dirName = path.basename(dir)
  const currentCategoryPath = parentPathName ? `${parentPathName} > ${dirName}` : dirName

  const directAudioFiles = []
  const subDirs = []

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      subDirs.push(fullPath)
    } else if (SUPPORTED_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) {
      directAudioFiles.push(fullPath)
    }
  }

  // Helper para procesar una lista de archivos de audio como un álbum
  async function createAlbumFromFiles(albumId, albumName, albumPath, audioFiles, catPath, folderEntries, allowEmpty = false) {
    if (audioFiles.length === 0 && !allowEmpty) return null

    const coverFilePath = await findCoverImage(albumPath, folderEntries)
    const albumCoverUrl = coverFilePath ? toFileUrl(coverFilePath) : null

    const trackDataList = await Promise.all(
      audioFiles.map((audioFile) =>
        limitMetadata(async () => {
          const meta = await extractMetadata(audioFile, baseDir, userDataDir)
          const baseTrack = {
            id: audioFile,
            path: audioFile,
            fileUrl: toFileUrl(audioFile),
            title: meta.title,
            artist: meta.artist,
            trackNumber: meta.trackNumber,
            duration: meta.duration,
            size: meta.size || 0,
            mtime: meta.mtime || 0,
            bitrate: meta.bitrate || null,
            sampleRate: meta.sampleRate || null,
            codec: meta.codec || path.extname(audioFile).replace('.', '').toUpperCase(),
            albumId,
            albumName,
            albumPath,
            cover: meta.embeddedCover || albumCoverUrl,
            hasLyrics: Boolean(meta.hasLyrics),
            syncedLyrics: Boolean(meta.syncedLyrics)
          }
          baseTrack.uniqueKey = computeTrackUniqueKey(baseTrack)
          return baseTrack
        })
      )
    )

    trackDataList.sort((a, b) => {
      if (a.trackNumber && b.trackNumber) return a.trackNumber - b.trackNumber
      return a.title.localeCompare(b.title)
    })

    const firstCoverWithImage = trackDataList.find(t => t.cover)?.cover || null
    const finalAlbumCover = albumCoverUrl || firstCoverWithImage

    for (const t of trackDataList) {
      if (!t.cover && finalAlbumCover) {
        t.cover = finalAlbumCover
      }
    }

    return {
      id: albumId,
      type: 'album',
      name: albumName,
      path: albumPath,
      categoryPath: catPath,
      cover: finalAlbumCover,
      trackCount: trackDataList.length,
      tracks: trackDataList
    }
  }

  // Caso 1: Carpeta sin subdirectorios (Álbum clásico, incluyendo álbumes recién creados vacíos)
  if (subDirs.length === 0) {
    return createAlbumFromFiles(dir, dirName, dir, directAudioFiles, parentPathName, entries, true)
  }

  // Caso 2: Carpeta con subdirectorios (Barra desplegable)
  const children = []

  // Si tiene canciones directamente en esta carpeta, crear un álbum hijo para ellas
  if (directAudioFiles.length > 0) {
    const directAlbum = await createAlbumFromFiles(
      dir + '___direct',
      `${dirName} (Principal)`,
      dir,
      directAudioFiles,
      currentCategoryPath,
      entries
    )
    if (directAlbum) children.push(directAlbum)
  }

  // Escanear cada subdirectorio con concurrencia controlada
  const subDirNodes = await Promise.all(
    subDirs.map((subDir) =>
      limitDirScan(() => scanDirectoryNode(subDir, baseDir, userDataDir, currentCategoryPath, limitMetadata, limitDirScan))
    )
  )

  for (const childNode of subDirNodes) {
    if (childNode) children.push(childNode)
  }

  if (children.length === 0) return null

  // Ordenar hijos: carpetas primero y luego alfabéticamente
  children.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'folder' ? -1 : 1
    }
    return a.name.localeCompare(b.name)
  })

  return {
    id: dir,
    type: 'folder',
    name: dirName,
    path: dir,
    categoryPath: parentPathName,
    children: children,
    totalTracks: countTracksRecursive(children),
    itemCount: children.length
  }
}

/**
 * Recorre el árbol de álbumes para identificar canciones iguales en diferentes álbumes,
 * anota en memoria en cada canción cuántos y cuáles álbumes la contienen.
 */
function annotateSongAlbumsModel(tree) {
  const albumNodes = []
  function collectAlbums(nodes) {
    if (!nodes || !Array.isArray(nodes)) return
    for (const node of nodes) {
      if (node.type === 'album') {
        albumNodes.push(node)
      }
      if (node.children && Array.isArray(node.children)) {
        collectAlbums(node.children)
      }
    }
  }
  collectAlbums(tree)

  const songMap = new Map()

  for (const album of albumNodes) {
    if (!album.tracks) continue
    for (const track of album.tracks) {
      const key = track.uniqueKey || computeTrackUniqueKey(track)
      track.uniqueKey = key
      if (!songMap.has(key)) {
        songMap.set(key, {
          uniqueKey: key,
          title: track.title,
          artist: track.artist,
          duration: track.duration,
          albumIdsSet: new Set(),
          albumNamesSet: new Set(),
          copies: []
        })
      }
      const entry = songMap.get(key)
      entry.albumIdsSet.add(album.id)
      entry.albumNamesSet.add(album.name)
      entry.copies.push({
        albumId: album.id,
        albumName: album.name,
        albumPath: album.path,
        filePath: track.path
      })
    }
  }

  const persistedIndex = {}
  for (const [key, entry] of songMap.entries()) {
    const albumIds = Array.from(entry.albumIdsSet)
    const albumNames = Array.from(entry.albumNamesSet)
    entry.albumIds = albumIds
    entry.albumNames = albumNames
    entry.albumCount = albumIds.length
    persistedIndex[key] = {
      uniqueKey: key,
      title: entry.title,
      artist: entry.artist,
      duration: entry.duration,
      albumCount: entry.albumCount,
      albumIds,
      albumNames,
      copies: entry.copies
    }
  }

  for (const album of albumNodes) {
    if (!album.tracks) continue
    for (const track of album.tracks) {
      const entry = songMap.get(track.uniqueKey)
      if (entry) {
        track.albumIds = entry.albumIds
        track.albumNames = entry.albumNames
        track.albumCount = entry.albumCount
      } else {
        track.albumIds = [album.id]
        track.albumNames = [album.name]
        track.albumCount = 1
      }
    }
  }

  return persistedIndex
}

async function saveSongAlbumsModel(persistedIndex, baseDir, userDataDir) {
  if (!persistedIndex) return
  const indexPath = getSongAlbumsIndexPath(baseDir, userDataDir)
  try {
    await fs.promises.mkdir(path.dirname(indexPath), { recursive: true })
    await fs.promises.writeFile(indexPath, JSON.stringify(persistedIndex), 'utf8')
  } catch (err) {
    console.warn(`Aviso al guardar índice de álbumes por canción en ${indexPath}:`, err.message)
  }
}

function removeFromMetadataCache(filePath) {
  if (filePath && metadataCache[filePath]) {
    delete metadataCache[filePath]
  }
}

/**
 * Escanea el directorio de música y genera una estructura de árbol:
 * - Carpetas con subdirectorios -> Barras desplegables sin imagen (tipo 'folder')
 * - Carpetas con pistas directas -> Álbumes con miniatura e información (tipo 'album')
 *
 * Utiliza I/O asíncrono y concurrencia acotada para evitar congelar el hilo de Electron.
 */
async function scanMusicDirectory(baseDir, userDataDir = null) {
  try {
    await fs.promises.access(baseDir)
  } catch (_) {
    console.warn(`Directorio de música no encontrado: ${baseDir}`)
    try {
      await fs.promises.mkdir(baseDir, { recursive: true })
    } catch (err) {
      console.error(`Error creando directorio de música ${baseDir}:`, err.message)
    }
    return []
  }

  activeCoversDir = null
  await loadCache(baseDir, userDataDir)

  let topEntries = []
  try {
    topEntries = await fs.promises.readdir(baseDir, { withFileTypes: true })
  } catch (err) {
    console.error(`Error leyendo directorio raíz de música ${baseDir}:`, err.message)
    return []
  }

  // Límites compartidos de concurrencia:
  // - limitDirScan: 8 directorios simultáneos
  // - limitMetadata: 16 archivos simultáneos (evita saturar el disco o descriptores EMFILE)
  const limitDirScan = createLimiter(8)
  const limitMetadata = createLimiter(16)

  const validDirs = topEntries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))

  const nodes = await Promise.all(
    validDirs.map((entry) => {
      const itemPath = path.join(baseDir, entry.name)
      return limitDirScan(() => scanDirectoryNode(itemPath, baseDir, userDataDir, '', limitMetadata, limitDirScan))
    })
  )

  const tree = nodes.filter(Boolean)

  // Ordenar árbol alfabéticamente
  tree.sort((a, b) => a.name.localeCompare(b.name))

  // Anotación en memoria imprescindible para el árbol
  const persistedIndex = annotateSongAlbumsModel(tree)

  // Guardado de índices y caché en disco en segundo plano (no bloquea el retorno ni la interfaz)
  saveSongAlbumsModel(persistedIndex, baseDir, userDataDir).catch((err) => {
    console.warn('Aviso guardando índice de álbumes en disco:', err.message)
  })
  saveCache(baseDir, userDataDir).catch((err) => {
    console.warn('Aviso guardando caché en disco:', err.message)
  })

  return tree
}

export { scanMusicDirectory, computeTrackUniqueKey, removeFromMetadataCache }
