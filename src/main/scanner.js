import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { pathToFileURL } from 'url'
import { parseFile } from 'music-metadata'

const SUPPORTED_EXTENSIONS = ['.mp3', '.wav', '.ogg', '.flac', '.m4a', '.aac', '.wma', '.opus']

// Caché en memoria y en disco para arranque instantáneo
let metadataCache = {}
let cacheLoaded = false
const knownCovers = new Set()
let coversDirReady = false

function getCachePath(baseDir) {
  return path.join(baseDir, '.library_cache.json')
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
 * Asegura la existencia del subdirectorio .covers de forma asíncrona una sola vez
 */
async function ensureCoversDir(baseDir) {
  const coversDir = path.join(baseDir, '.covers')
  if (!coversDirReady) {
    try {
      await fs.promises.mkdir(coversDir, { recursive: true })
      coversDirReady = true
    } catch (err) {
      console.error('Error creando directorio .covers:', err.message)
    }
  }
  return coversDir
}

/**
 * Guarda los bytes de la carátula integrada en el subdirectorio .covers del directorio de música.
 * Deduplica automáticamente mediante hash MD5 y caché en memoria.
 */
async function saveCoverBuffer(baseDir, buffer, format) {
  if (!buffer || buffer.length === 0) return null
  try {
    const coversDir = await ensureCoversDir(baseDir)
    const hash = crypto.createHash('md5').update(buffer).digest('hex')
    const ext = format && format.toLowerCase().includes('png') ? '.png' : '.jpg'
    const fileName = `${hash}${ext}`
    const filePath = path.join(coversDir, fileName)

    if (knownCovers.has(fileName)) {
      return toFileUrl(filePath)
    }

    try {
      await fs.promises.access(filePath)
      knownCovers.add(fileName)
    } catch (_) {
      await fs.promises.writeFile(filePath, buffer)
      knownCovers.add(fileName)
    }

    return toFileUrl(filePath)
  } catch (err) {
    console.error('Error guardando carátula en disco:', err)
    return null
  }
}

async function loadCache(baseDir) {
  if (cacheLoaded) return
  try {
    const cacheFile = getCachePath(baseDir)
    const raw = await fs.promises.readFile(cacheFile, 'utf8')
    if (raw.includes('data:image')) {
      metadataCache = {}
    } else {
      metadataCache = JSON.parse(raw)
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`Aviso al cargar caché de ${baseDir}:`, err.message)
    }
    metadataCache = {}
  }
  cacheLoaded = true
}

async function saveCache(baseDir) {
  try {
    const cacheFile = getCachePath(baseDir)
    await fs.promises.writeFile(cacheFile, JSON.stringify(metadataCache), 'utf8')
  } catch (err) {
    console.error('Error guardando caché de metadatos:', err.message)
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
async function extractMetadata(filePath, baseDir) {
  try {
    const stats = await fs.promises.stat(filePath)
    const mtime = stats.mtimeMs

    if (metadataCache[filePath] && metadataCache[filePath].mtime === mtime) {
      const cached = metadataCache[filePath].data
      if (cached && (!cached.embeddedCover || !cached.embeddedCover.startsWith('data:'))) {
        return cached
      }
    }

    const metadata = await parseFile(filePath)
    const { common, format } = metadata
    let coverUrl = null

    if (common.picture && common.picture.length > 0) {
      const pic = common.picture[0]
      coverUrl = await saveCoverBuffer(baseDir, pic.data, pic.format)
    }

    const data = {
      title: common.title || path.parse(filePath).name,
      artist: common.artist || 'Artista Desconocido',
      album: common.album || null,
      trackNumber: common.track?.no || 0,
      duration: format.duration || 0,
      embeddedCover: coverUrl
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
      embeddedCover: null
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
async function scanDirectoryNode(dir, baseDir, parentPathName = '', limitMetadata, limitDirScan) {
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
  async function createAlbumFromFiles(albumId, albumName, albumPath, audioFiles, catPath, folderEntries) {
    if (audioFiles.length === 0) return null

    const coverFilePath = await findCoverImage(albumPath, folderEntries)
    const albumCoverUrl = coverFilePath ? toFileUrl(coverFilePath) : null

    const trackDataList = await Promise.all(
      audioFiles.map((audioFile) =>
        limitMetadata(async () => {
          const meta = await extractMetadata(audioFile, baseDir)
          return {
            id: audioFile,
            path: audioFile,
            fileUrl: toFileUrl(audioFile),
            title: meta.title,
            artist: meta.artist,
            trackNumber: meta.trackNumber,
            duration: meta.duration,
            cover: meta.embeddedCover || albumCoverUrl
          }
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

  // Caso 1: Carpeta sin subdirectorios (Álbum clásico)
  if (subDirs.length === 0) {
    return createAlbumFromFiles(dir, dirName, dir, directAudioFiles, parentPathName, entries)
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
      limitDirScan(() => scanDirectoryNode(subDir, baseDir, currentCategoryPath, limitMetadata, limitDirScan))
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
 * Escanea el directorio de música y genera una estructura de árbol:
 * - Carpetas con subdirectorios -> Barras desplegables sin imagen (tipo 'folder')
 * - Carpetas con pistas directas -> Álbumes con miniatura e información (tipo 'album')
 *
 * Utiliza I/O asíncrono y concurrencia acotada para evitar congelar el hilo de Electron.
 */
async function scanMusicDirectory(baseDir) {
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

  await loadCache(baseDir)

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
      return limitDirScan(() => scanDirectoryNode(itemPath, baseDir, '', limitMetadata, limitDirScan))
    })
  )

  const tree = nodes.filter(Boolean)

  // Ordenar árbol alfabéticamente
  tree.sort((a, b) => a.name.localeCompare(b.name))

  await saveCache(baseDir)

  return tree
}

export { scanMusicDirectory }
