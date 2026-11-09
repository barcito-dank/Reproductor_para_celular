import fs from 'fs'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { parseFile } from 'music-metadata'
import { Logger } from './Logger'
import { SecurityService } from './SecurityService'
import { removeFromMetadataCache } from '../scanner'

export interface UnlinkResult {
  success: boolean
  error?: string
  masterDeleted?: boolean
  deletedMasterPaths?: string[]
}

export class FileSystemService {
  /**
   * Intenta eliminar un archivo con reintentos exponenciales para tolerar
   * bloqueos transitorios en Windows (EBUSY / EPERM / EACCES por antivirus o watchers).
   */
  public static async unlinkWithRetry(
    targetPath: string,
    maxRetries: number = 3,
    delayMs: number = 80
  ): Promise<{ success: boolean; error?: string }> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await fs.promises.unlink(targetPath)
        return { success: true }
      } catch (err: any) {
        if (err.code === 'ENOENT') {
          return { success: true }
        }
        if (attempt < maxRetries && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')) {
          await new Promise((r) => setTimeout(r, delayMs * attempt))
        } else {
          return { success: false, error: err.message }
        }
      }
    }
    return { success: false, error: 'No se pudo eliminar el archivo tras reintentos' }
  }

  /**
   * Busca en el directorio maestro todos los archivos físicos que compartan el mismo inodo NTFS.
   */
  public static async findRealMusicFilesByInode(
    targetIno: bigint,
    fileName: string,
    realDir: string
  ): Promise<Array<{ path: string; nlink: number }>> {
    const matches: Array<{ path: string; nlink: number }> = []
    if (!targetIno || !realDir || !fs.existsSync(realDir)) return matches

    const resolvedRealDir = SecurityService.normalizePath(realDir)

    // Búsqueda directa por nombre primero (optimización O(1))
    const directCandidate = path.join(realDir, fileName)
    try {
      const st = await fs.promises.stat(directCandidate, { bigint: true })
      if (st.ino === targetIno) {
        matches.push({ path: directCandidate, nlink: Number(st.nlink || 1) })
        return matches
      }
    } catch (_) {}

    // Búsqueda recursiva completa en caso de subcarpetas
    async function walk(currentDir: string): Promise<void> {
      let entries: fs.Dirent[] = []
      try {
        entries = await fs.promises.readdir(currentDir, { withFileTypes: true })
      } catch (_) {
        return
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        const fullPath = path.join(currentDir, entry.name)
        if (entry.isDirectory()) {
          await walk(fullPath)
        } else if (entry.isFile()) {
          try {
            const st = await fs.promises.stat(fullPath, { bigint: true })
            if (st.ino === targetIno && SecurityService.isPathInside(fullPath, [realDir])) {
              matches.push({ path: fullPath, nlink: Number(st.nlink || 1) })
            }
          } catch (_) {}
        }
      }
    }

    await walk(realDir)
    return matches
  }

  /**
   * Elimina un enlace duro (Hard Link) en canciones_organizadas de forma segura.
   * El archivo maestro en Canciones_reales SOLO se elimina si no quedan más enlaces duros
   * en la biblioteca (nlink <= 1) o si forceDeleteMaster es true.
   */
  public static async unlinkHardLinkAndCleanupMaster(
    filePath: string,
    realMusicDir: string,
    options: { forceDeleteMaster?: boolean } = {}
  ): Promise<UnlinkResult> {
    const normalizedPath = path.normalize(filePath)
    let targetIno = 0n
    let nlinkBefore = 1
    const fileName = path.basename(normalizedPath)

    try {
      const st = await fs.promises.stat(normalizedPath, { bigint: true })
      targetIno = st.ino || 0n
      nlinkBefore = Number(st.nlink || 1)
    } catch (err: any) {
      return { success: false, error: 'El archivo o enlace no existe en el disco' }
    }

    // 1. Desvincular el enlace duro actual
    const unlinkRes = await this.unlinkWithRetry(normalizedPath)
    if (!unlinkRes.success) {
      return { success: false, error: unlinkRes.error || 'No se pudo eliminar el enlace duro' }
    }

    removeFromMetadataCache(normalizedPath)
    removeFromMetadataCache(filePath)

    let masterDeleted = false
    const deletedMasterPaths: string[] = []

    // 2. Si era el último enlace duro activo o forceDeleteMaster, limpiar en Canciones_reales
    if (nlinkBefore <= 2 || options.forceDeleteMaster) {
      try {
        const realMatches = await this.findRealMusicFilesByInode(targetIno, fileName, realMusicDir)
        for (const match of realMatches) {
          if (match.nlink <= 1 || options.forceDeleteMaster) {
            const masterUnlinkRes = await this.unlinkWithRetry(match.path)
            if (masterUnlinkRes.success) {
              removeFromMetadataCache(match.path)
              masterDeleted = true
              deletedMasterPaths.push(match.path)
              Logger.info('FileSystemService', `Archivo maestro eliminado en Canciones_reales: ${match.path}`)
            } else {
              Logger.warn('FileSystemService', `No se pudo eliminar archivo maestro: ${masterUnlinkRes.error}`)
            }
          }
        }
      } catch (err: any) {
        Logger.warn('FileSystemService', `Error verificando archivo maestro en Canciones_reales: ${err?.message}`)
      }
    }

    return {
      success: true,
      masterDeleted,
      deletedMasterPaths
    }
  }

  /**
   * Extrae y aplica una nueva portada para una carpeta de álbum, eliminando carátulas previas.
   */
  public static async applyAlbumCover(
    albumPath: string,
    trackPath?: string,
    coverUrl?: string
  ): Promise<{ success: boolean; targetFilePath?: string; error?: string }> {
    try {
      const stat = await fs.promises.stat(albumPath)
      if (!stat.isDirectory()) {
        return { success: false, error: 'La ruta indicada no es un directorio' }
      }
    } catch (err: any) {
      return { success: false, error: `No se pudo acceder a la carpeta: ${err.message}` }
    }

    let imageBuffer: Buffer | null = null
    let imageFormat = 'image/jpeg'

    // 1. Leer desde file:// URL si existe
    if (coverUrl && typeof coverUrl === 'string' && coverUrl.startsWith('file://')) {
      try {
        const cleanUrl = coverUrl.split('?')[0]
        const srcPath = fileURLToPath(cleanUrl)
        if (fs.existsSync(srcPath)) {
          imageBuffer = await fs.promises.readFile(srcPath)
          const ext = path.extname(srcPath).toLowerCase()
          if (ext === '.png') imageFormat = 'image/png'
          else if (ext === '.webp') imageFormat = 'image/webp'
          else imageFormat = 'image/jpeg'
        }
      } catch (err: any) {
        Logger.warn('FileSystemService', `No se pudo leer carátula desde coverUrl: ${err.message}`)
      }
    }

    // 2. Extraer de etiquetas ID3 de trackPath
    if (!imageBuffer && trackPath && typeof trackPath === 'string') {
      try {
        const meta = await parseFile(trackPath)
        if (meta.common.picture && meta.common.picture.length > 0) {
          const pic = meta.common.picture[0]
          if (pic.data && pic.data.length > 0) {
            imageBuffer = Buffer.from(pic.data)
            if (pic.format) imageFormat = pic.format
          }
        }
      } catch (err: any) {
        Logger.warn('FileSystemService', `No se pudo extraer carátula de ID3: ${err.message}`)
      }
    }

    // 3. Decodificar desde data URL Base64
    if (!imageBuffer && coverUrl && typeof coverUrl === 'string' && coverUrl.startsWith('data:image/')) {
      try {
        const matches = coverUrl.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/)
        if (matches && matches.length === 3) {
          imageFormat = matches[1]
          imageBuffer = Buffer.from(matches[2], 'base64')
        }
      } catch (err: any) {
        Logger.warn('FileSystemService', `No se pudo decodificar data URL: ${err.message}`)
      }
    }

    if (!imageBuffer || imageBuffer.length === 0) {
      return { success: false, error: 'No se pudo obtener una imagen válida de portada' }
    }

    // Detectar extensión correcta por magic bytes
    let ext = '.jpg'
    if (imageBuffer.length >= 4) {
      if (imageBuffer[0] === 0x89 && imageBuffer[1] === 0x50 && imageBuffer[2] === 0x4e && imageBuffer[3] === 0x47) {
        ext = '.png'
      } else if (imageBuffer[0] === 0x52 && imageBuffer[1] === 0x49 && imageBuffer[2] === 0x46 && imageBuffer[3] === 0x46) {
        ext = '.webp'
      } else if (imageFormat.includes('png')) {
        ext = '.png'
      } else if (imageFormat.includes('webp')) {
        ext = '.webp'
      }
    }

    const targetFileName = `cover${ext}`
    const targetFilePath = path.join(albumPath, targetFileName)

    // Eliminar carátulas anteriores
    const coverNames = ['cover', 'folder', 'album', 'front', 'artwork', 'thumb']
    const imageExts = ['.jpg', '.jpeg', '.png', '.webp', '.bmp']

    try {
      const existingEntries = await fs.promises.readdir(albumPath)
      for (const entry of existingEntries) {
        const parsed = path.parse(entry)
        const nameLower = parsed.name.toLowerCase()
        const extLower = parsed.ext.toLowerCase()
        if (coverNames.some((cn) => nameLower.includes(cn)) && imageExts.includes(extLower)) {
          const toDelete = path.join(albumPath, entry)
          if (toDelete.toLowerCase() !== targetFilePath.toLowerCase()) {
            try {
              await fs.promises.unlink(toDelete)
            } catch (_) {}
          }
        }
      }

      await fs.promises.writeFile(targetFilePath, imageBuffer)
      const now = new Date()
      try {
        await fs.promises.utimes(targetFilePath, now, now)
      } catch (_) {}

      Logger.info('FileSystemService', `Nueva portada guardada exitosamente: ${targetFilePath}`)
      return { success: true, targetFilePath }
    } catch (err: any) {
      Logger.error('FileSystemService', `Error escribiendo portada en disco: ${err?.message}`, err)
      return { success: false, error: err?.message || 'Error guardando archivo de portada' }
    }
  }
}
