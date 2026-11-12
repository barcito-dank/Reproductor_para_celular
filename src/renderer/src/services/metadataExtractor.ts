import { parseAndCleanTrackInfo } from '@shared/lrclibClient'

export type MediaType = 'audio' | 'video'

export interface ExtractedMetadata {
  title: string
  artist: string
  album: string
  duration: number
  mediaType: MediaType
  coverBytes: Uint8Array | null
  coverMimeType: string | null
  coverHash: string | null
  sizeBytes: number
  ext: string
}

const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mkv'])
const AUDIO_EXTENSIONS = new Set(['mp3', 'flac', 'm4a', 'wav', 'ogg', 'opus', 'aac'])

/**
 * Determina la extensión en minúsculas sin punto de un nombre de archivo.
 */
export function getFileExtension(fileName: string): string {
  const clean = (fileName || '').trim()
  const idx = clean.lastIndexOf('.')
  if (idx < 0 || idx === clean.length - 1) return 'mp3'
  return clean.slice(idx + 1).toLowerCase()
}

/**
 * Determina si un archivo es de audio o de video según su extensión o MIME type.
 */
export function detectMediaType(fileName: string, mimeType?: string): MediaType {
  const ext = getFileExtension(fileName)
  if (VIDEO_EXTENSIONS.has(ext)) return 'video'
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio'
  if (mimeType && mimeType.toLowerCase().startsWith('video/')) return 'video'
  return 'audio'
}

/**
 * Calcula un hash determinista en hexadecimal (32 caracteres) para deduplicar portadas
 * o generar identificadores canónicos de archivos.
 * Usa Web Crypto API (SHA-256) cuando está disponible y un fallback rápido FNV-1a de 128 bits.
 */
export async function computeBufferHash(data: Uint8Array): Promise<string> {
  try {
    if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
      const digest = await globalThis.crypto.subtle.digest(
        'SHA-256',
        data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
      )
      const hashArray = Array.from(new Uint8Array(digest))
      return hashArray
        .slice(0, 16)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
    }
  } catch (_) {
    // Fallback a hash sincrónico
  }
  return computeFastHashSync(data)
}

/**
 * Hash sincrónico rápido FNV-1a en 4 bloques de 32 bits (128 bits en hex = 32 chars).
 */
export function computeFastHashSync(data: Uint8Array): string {
  let h1 = 0x811c9dc5
  let h2 = 0x811c9dc5 ^ 0x9e3779b9
  let h3 = 0x811c9dc5 ^ 0x85ebca6b
  let h4 = 0x811c9dc5 ^ 0xc2b2ae35

  const len = data.length
  const step = len > 65536 ? Math.max(1, Math.floor(len / 32768)) : 1

  for (let i = 0; i < len; i += step) {
    const byte = data[i]
    h1 = Math.imul(h1 ^ byte, 0x01000193)
    h2 = Math.imul(h2 ^ ((byte + i) & 0xff), 0x01000193)
    h3 = Math.imul(h3 ^ (byte ^ (i & 0xff)), 0x01000193)
    h4 = Math.imul(h4 ^ ((byte * 7) & 0xff), 0x01000193)
  }

  h1 = (h1 ^ len) >>> 0
  h2 = (h2 ^ len) >>> 0
  h3 = (h3 ^ len) >>> 0
  h4 = (h4 ^ len) >>> 0

  return (
    h1.toString(16).padStart(8, '0') +
    h2.toString(16).padStart(8, '0') +
    h3.toString(16).padStart(8, '0') +
    h4.toString(16).padStart(8, '0')
  )
}

/**
 * Decodifica texto desde un frame ID3 según su byte de codificación:
 * 0 = ISO-8859-1, 1 = UTF-16 con BOM, 2 = UTF-16BE, 3 = UTF-8
 */
function decodeId3Text(payload: Uint8Array): string {
  if (!payload || payload.length <= 1) return ''
  const encoding = payload[0]
  const textBytes = payload.subarray(1)

  try {
    let decoded = ''
    if (encoding === 0) {
      decoded = new TextDecoder('iso-8859-1').decode(textBytes)
    } else if (encoding === 1) {
      decoded = new TextDecoder('utf-16').decode(textBytes)
    } else if (encoding === 2) {
      decoded = new TextDecoder('utf-16be').decode(textBytes)
    } else {
      decoded = new TextDecoder('utf-8').decode(textBytes)
    }
    return decoded.replace(/\0+/g, '').trim()
  } catch (_) {
    return ''
  }
}

/**
 * Extrae la imagen embebida de un frame APIC (ID3v2.3 / ID3v2.4) o PIC (ID3v2.2).
 */
function parseId3ApicFrame(
  payload: Uint8Array,
  isV22: boolean
): { bytes: Uint8Array; mimeType: string } | null {
  if (!payload || payload.length < 8) return null
  const encoding = payload[0]
  let offset = 1
  let mimeType = 'image/jpeg'

  if (isV22) {
    // 3 bytes de formato de imagen ("JPG" o "PNG")
    const fmt = String.fromCharCode(payload[1] || 0, payload[2] || 0, payload[3] || 0).toUpperCase()
    mimeType = fmt === 'PNG' ? 'image/png' : 'image/jpeg'
    offset = 4
  } else {
    // Cadena MIME terminada en \0
    let mimeEnd = offset
    while (mimeEnd < payload.length && payload[mimeEnd] !== 0) {
      mimeEnd++
    }
    const rawMime = new TextDecoder('iso-8859-1')
      .decode(payload.subarray(offset, mimeEnd))
      .trim()
      .toLowerCase()
    if (rawMime) {
      mimeType = rawMime.includes('png') ? 'image/png' : 'image/jpeg'
    }
    offset = mimeEnd + 1
  }

  if (offset >= payload.length) return null
  // Saltar byte de Picture Type (1 byte)
  offset += 1

  // Saltar descripción terminada en null (\0 para encoding 0/3, \0\0 para UTF-16 encoding 1/2)
  if (encoding === 1 || encoding === 2) {
    while (offset + 1 < payload.length && !(payload[offset] === 0 && payload[offset + 1] === 0)) {
      offset += 2
    }
    offset += 2
  } else {
    while (offset < payload.length && payload[offset] !== 0) {
      offset += 1
    }
    offset += 1
  }

  if (offset >= payload.length) return null
  const imageBytes = payload.slice(offset)
  if (imageBytes.length < 16) return null

  return { bytes: imageBytes, mimeType }
}

/**
 * Parser ligero de etiquetas ID3v2 (v2.2, v2.3 y v2.4) directo sobre Uint8Array sin Node 'fs'.
 */
export function parseId3v2Tags(bytes: Uint8Array): {
  title?: string
  artist?: string
  album?: string
  coverBytes?: Uint8Array
  coverMimeType?: string
} {
  const result: {
    title?: string
    artist?: string
    album?: string
    coverBytes?: Uint8Array
    coverMimeType?: string
  } = {}

  if (!bytes || bytes.length < 10) return result
  if (bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) {
    // No empieza con "ID3"
    return result
  }

  const versionMajor = bytes[3]
  const flags = bytes[5]
  // Tamaño synchsafe (4 * 7 bits)
  const tagSize =
    ((bytes[6] & 0x7f) << 21) |
    ((bytes[7] & 0x7f) << 14) |
    ((bytes[8] & 0x7f) << 7) |
    (bytes[9] & 0x7f)

  const limit = Math.min(bytes.length, 10 + tagSize)
  let offset = 10

  // Si tiene cabecera extendida (bit 6 de flags), saltarla
  if ((flags & 0x40) !== 0 && offset + 4 <= limit) {
    const extSize =
      versionMajor === 4
        ? ((bytes[offset] & 0x7f) << 21) |
          ((bytes[offset + 1] & 0x7f) << 14) |
          ((bytes[offset + 2] & 0x7f) << 7) |
          (bytes[offset + 3] & 0x7f)
        : (bytes[offset] << 24) |
          (bytes[offset + 1] << 16) |
          (bytes[offset + 2] << 8) |
          bytes[offset + 3]
    offset += extSize
  }

  const isV22 = versionMajor === 2
  const headerSize = isV22 ? 6 : 10

  while (offset + headerSize <= limit) {
    if (bytes[offset] === 0) break // Padding alcanzado

    let frameId = ''
    let frameSize = 0

    if (isV22) {
      frameId = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2])
      frameSize = (bytes[offset + 3] << 16) | (bytes[offset + 4] << 8) | bytes[offset + 5]
    } else {
      frameId = String.fromCharCode(
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3]
      )
      if (versionMajor === 4) {
        frameSize =
          ((bytes[offset + 4] & 0x7f) << 21) |
          ((bytes[offset + 5] & 0x7f) << 14) |
          ((bytes[offset + 6] & 0x7f) << 7) |
          (bytes[offset + 7] & 0x7f)
      } else {
        frameSize =
          ((bytes[offset + 4] << 24) >>> 0) +
          (bytes[offset + 5] << 16) +
          (bytes[offset + 6] << 8) +
          bytes[offset + 7]
      }
    }

    if (frameSize <= 0 || offset + headerSize + frameSize > limit) {
      break
    }

    const payload = bytes.subarray(offset + headerSize, offset + headerSize + frameSize)

    if ((frameId === 'TIT2' || frameId === 'TT2') && !result.title) {
      const val = decodeId3Text(payload)
      if (val) result.title = val
    } else if ((frameId === 'TPE1' || frameId === 'TP1') && !result.artist) {
      const val = decodeId3Text(payload)
      if (val) result.artist = val
    } else if ((frameId === 'TALB' || frameId === 'TAL') && !result.album) {
      const val = decodeId3Text(payload)
      if (val) result.album = val
    } else if ((frameId === 'APIC' || frameId === 'PIC') && !result.coverBytes) {
      const apic = parseId3ApicFrame(payload, isV22)
      if (apic) {
        result.coverBytes = apic.bytes
        result.coverMimeType = apic.mimeType
      }
    }

    offset += headerSize + frameSize
  }

  return result
}

/**
 * Parser ligero de átomos MP4/M4A (ilst: ©nam, ©ART, ©alb, covr) sobre Uint8Array.
 */
export function parseMp4Atoms(bytes: Uint8Array): {
  title?: string
  artist?: string
  album?: string
  coverBytes?: Uint8Array
  coverMimeType?: string
} {
  const result: {
    title?: string
    artist?: string
    album?: string
    coverBytes?: Uint8Array
    coverMimeType?: string
  } = {}

  if (!bytes || bytes.length < 16) return result
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  function readDataAtomText(start: number, end: number): string {
    for (let pos = start; pos + 16 <= end; ) {
      const size = view.getUint32(pos, false)
      if (size < 16 || pos + size > end) break
      const type = String.fromCharCode(
        bytes[pos + 4],
        bytes[pos + 5],
        bytes[pos + 6],
        bytes[pos + 7]
      )
      if (type === 'data') {
        const textSlice = bytes.subarray(pos + 16, pos + size)
        return new TextDecoder('utf-8').decode(textSlice).replace(/\0+/g, '').trim()
      }
      pos += size
    }
    return ''
  }

  function readDataAtomCover(
    start: number,
    end: number
  ): { bytes: Uint8Array; mimeType: string } | null {
    for (let pos = start; pos + 16 <= end; ) {
      const size = view.getUint32(pos, false)
      if (size < 16 || pos + size > end) break
      const type = String.fromCharCode(
        bytes[pos + 4],
        bytes[pos + 5],
        bytes[pos + 6],
        bytes[pos + 7]
      )
      if (type === 'data') {
        const flags = view.getUint32(pos + 8, false) & 0xffffff
        const imgBytes = bytes.slice(pos + 16, pos + size)
        if (imgBytes.length > 16) {
          const isPng =
            flags === 14 || (imgBytes[0] === 0x89 && imgBytes[1] === 0x50 && imgBytes[2] === 0x4e)
          return {
            bytes: imgBytes,
            mimeType: isPng ? 'image/png' : 'image/jpeg'
          }
        }
      }
      pos += size
    }
    return null
  }

  const CONTAINERS = new Set(['moov', 'udta', 'meta', 'ilst'])

  function walkAtoms(start: number, end: number, depth: number): void {
    if (depth > 8) return
    let pos = start
    while (pos + 8 <= end) {
      const size = view.getUint32(pos, false)
      if (size < 8 || pos + size > end) break
      const type = String.fromCharCode(
        bytes[pos + 4],
        bytes[pos + 5],
        bytes[pos + 6],
        bytes[pos + 7]
      )

      if (CONTAINERS.has(type)) {
        const headerOffset = type === 'meta' ? 12 : 8
        walkAtoms(pos + headerOffset, pos + size, depth + 1)
      } else if (type === '\xa9nam' && !result.title) {
        const v = readDataAtomText(pos + 8, pos + size)
        if (v) result.title = v
      } else if (type === '\xa9ART' && !result.artist) {
        const v = readDataAtomText(pos + 8, pos + size)
        if (v) result.artist = v
      } else if (type === '\xa9alb' && !result.album) {
        const v = readDataAtomText(pos + 8, pos + size)
        if (v) result.album = v
      } else if (type === 'covr' && !result.coverBytes) {
        const cov = readDataAtomCover(pos + 8, pos + size)
        if (cov) {
          result.coverBytes = cov.bytes
          result.coverMimeType = cov.mimeType
        }
      }

      pos += size
    }
  }

  walkAtoms(0, bytes.length, 0)
  return result
}

/**
 * Obtiene la duración real en segundos mediante un elemento temporal <audio> o <video>
 * en entornos navegador/WebView. En entornos de test sin soporte multimedia resuelve a 0 rápidamente.
 */
export async function probeMediaDuration(
  blob: Blob,
  mediaType: MediaType = 'audio',
  timeoutMs: number = 1500
): Promise<number> {
  if (
    typeof document === 'undefined' ||
    typeof URL === 'undefined' ||
    typeof URL.createObjectURL !== 'function'
  ) {
    return 0
  }

  return new Promise<number>((resolve) => {
    let settled = false
    let objectUrl = ''
    let el: HTMLMediaElement | null = null

    const finish = (dur: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (el) {
        el.onloadedmetadata = null
        el.onerror = null
        try {
          el.removeAttribute('src')
          el.load()
        } catch (_) {}
      }
      if (objectUrl) {
        try {
          URL.revokeObjectURL(objectUrl)
        } catch (_) {}
      }
      resolve(Number.isFinite(dur) && dur > 0 ? dur : 0)
    }

    const timer = setTimeout(() => finish(0), timeoutMs)

    try {
      objectUrl = URL.createObjectURL(blob)
      el = document.createElement(mediaType === 'video' ? 'video' : 'audio')
      el.preload = 'metadata'
      el.muted = true
      el.onloadedmetadata = () => finish(el ? el.duration : 0)
      el.onerror = () => finish(0)
      el.src = objectUrl
    } catch (_) {
      finish(0)
    }
  })
}

/**
 * Extrae metadatos, carátula embebida deduplicada por hash y duración real de un File, Blob o Uint8Array.
 */
export async function extractMediaMetadata(
  input: File | Blob | Uint8Array | ArrayBuffer,
  options: {
    fileName?: string
    mimeType?: string
    fallbackDuration?: number
    skipDomDurationProbe?: boolean
  } = {}
): Promise<ExtractedMetadata> {
  const fileName =
    options.fileName ||
    (typeof File !== 'undefined' && input instanceof File ? input.name : 'track.mp3')
  const mimeType =
    options.mimeType || (typeof Blob !== 'undefined' && input instanceof Blob ? input.type : '')

  const ext = getFileExtension(fileName)
  const mediaType = detectMediaType(fileName, mimeType)

  let bytes: Uint8Array
  let sizeBytes = 0
  let blobForProbe: Blob | null = null

  if (input instanceof Uint8Array) {
    bytes = input
    sizeBytes = input.byteLength
  } else if (input instanceof ArrayBuffer) {
    bytes = new Uint8Array(input)
    sizeBytes = input.byteLength
  } else {
    sizeBytes = input.size || 0
    blobForProbe = input
    // Leer hasta los primeros 2 MB para extraer etiquetas ID3v2 / MP4 atoms / APIC sin cargar archivos gigantes enteros si no hace falta
    const headerSlice = input.slice(0, Math.min(input.size, 2 * 1024 * 1024))
    const buf = await headerSlice.arrayBuffer()
    bytes = new Uint8Array(buf)
  }

  let parsedTags: {
    title?: string
    artist?: string
    album?: string
    coverBytes?: Uint8Array
    coverMimeType?: string
  } = {}

  if (ext === 'm4a' || ext === 'mp4' || ext === 'aac') {
    parsedTags = parseMp4Atoms(bytes)
  } else {
    parsedTags = parseId3v2Tags(bytes)
    if (!parsedTags.title && !parsedTags.artist && !parsedTags.coverBytes) {
      parsedTags = parseMp4Atoms(bytes)
    }
  }

  const stemName = fileName.replace(/\.[^/.]+$/, '').trim()
  const cleanedFromName = parseAndCleanTrackInfo(stemName, '')

  const title = (parsedTags.title || cleanedFromName.cleanTitle || stemName || 'Canción').trim()
  const artist = (
    parsedTags.artist ||
    cleanedFromName.cleanArtist ||
    'Artista Desconocido'
  ).trim()
  const album = (parsedTags.album || '').trim()

  let coverHash: string | null = null
  const coverBytes = parsedTags.coverBytes || null
  const coverMimeType = parsedTags.coverMimeType || null

  if (coverBytes && coverBytes.length > 0) {
    coverHash = await computeBufferHash(coverBytes)
  }

  let duration = options.fallbackDuration || 0
  if (!duration && !options.skipDomDurationProbe && blobForProbe) {
    duration = await probeMediaDuration(blobForProbe, mediaType)
  }

  return {
    title,
    artist,
    album,
    duration,
    mediaType,
    coverBytes,
    coverMimeType,
    coverHash,
    sizeBytes,
    ext
  }
}
