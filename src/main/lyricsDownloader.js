import fs from 'fs'
import path from 'path'
import NodeID3 from 'node-id3'

// Caché en memoria para respuestas instantáneas (0ms) al volver a reproducir o abrir el panel de letras
const memoryLyricsCache = new Map()

const UNKNOWN_ARTIST_REGEX = /^(artista desconocido|unknown artist|desconocido|unknown|varios artistas|various artists|—|-|ninguno|none)$/i

/**
 * Limpia el título y el artista para optimizar la coincidencia en APIs externas
 */
function parseAndCleanTrackInfo(rawTitle, rawArtist) {
  let title = (rawTitle || '').trim()
  let artist = (rawArtist || '').trim()

  if (UNKNOWN_ARTIST_REGEX.test(artist)) {
    artist = ''
  }

  // Quitar extensión de archivo si estuviera en el título
  title = title.replace(/\.(mp3|flac|wav|ogg|m4a|aac)$/i, '').trim()

  // Quitar numeración inicial de pista (ej. "01 - ", "02. ", "1_ ")
  title = title.replace(/^\d{1,3}[\s._-]+/, '').trim()

  // Si no hay artista válido pero el título tiene formato "Artista - Canción", separarlos
  if (!artist && title.includes(' - ')) {
    const parts = title.split(' - ')
    if (parts.length >= 2) {
      const candidateArtist = parts[0].trim()
      const candidateTitle = parts.slice(1).join(' - ').trim()
      if (candidateArtist && candidateTitle && !UNKNOWN_ARTIST_REGEX.test(candidateArtist)) {
        artist = candidateArtist
        title = candidateTitle
      }
    }
  }

  const cleanStr = (str) => {
    if (!str) return ''
    return str
      .replace(/\[[^\]]*\]/g, '') // Quitar [Official Video], [Lyrics], [HD], etc.
      .replace(/\([^)]*(?:official|oficial|video|vídeo|audio|remaster|letra|lyrics|hd|hq|4k|live|en vivo|visualizer|clip|karaoke|version|versión)[^)]*\)/gi, '')
      .replace(/\b(?:ft\.?|feat\.?|featuring)\b.*$/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim()
  }

  return {
    cleanTitle: cleanStr(title) || title,
    cleanArtist: cleanStr(artist)
  }
}

/**
 * Selecciona el mejor resultado de una lista de candidatos de LRCLIB priorizando:
 * 1) Que tenga letras sincronizadas (syncedLyrics)
 * 2) Que su duración sea lo más cercana posible a la duración real del archivo local
 */
function pickBestLyricsCandidate(list, targetDuration = 0) {
  if (!Array.isArray(list) || list.length === 0) return null

  const valid = list.filter((item) => item && (item.syncedLyrics || item.plainLyrics))
  if (valid.length === 0) return null

  const scored = valid.map((item) => {
    const hasSynced = Boolean(item.syncedLyrics && item.syncedLyrics.trim())
    const itemDur = Number(item.duration) || 0
    const durDiff = targetDuration > 0 && itemDur > 0 ? Math.abs(itemDur - targetDuration) : 0

    let score = 0
    if (hasSynced) score += 100
    if (targetDuration > 0 && itemDur > 0) {
      if (durDiff <= 2) score += 80
      else if (durDiff <= 5) score += 55
      else if (durDiff <= 12) score += 25
      else score -= Math.min(60, durDiff)
    }

    return { item, score, durDiff }
  })

  scored.sort((a, b) => b.score - a.score || a.durDiff - b.durDiff)
  return scored[0].item
}

/**
 * Consulta la API pública y gratuita de LRCLIB (con búsqueda rápida y tolerante a variaciones)
 */
export async function fetchLyricsFromLRCLIB(title, artist, duration = 0) {
  const { cleanTitle, cleanArtist } = parseAndCleanTrackInfo(title, artist)
  if (!cleanTitle) return null

  // 1. Si tenemos artista y título limpios, intentar coincidencia directa rápida (timeout corto de 3s)
  if (cleanArtist) {
    try {
      const params = new URLSearchParams({
        track_name: cleanTitle,
        artist_name: cleanArtist
      })
      if (duration > 0) {
        params.append('duration', Math.round(duration).toString())
      }

      const res = await fetch(`https://lrclib.net/api/get?${params.toString()}`, {
        headers: { 'User-Agent': 'ReproductorDeMusica/1.0.0 (https://github.com/reproductor-de-musica)' },
        signal: AbortSignal.timeout(3000)
      })

      if (res.ok) {
        const data = await res.json()
        if (data && (data.syncedLyrics || data.plainLyrics)) {
          return data
        }
      }
    } catch (_) {}
  }

  // 2. Búsqueda flexible por consulta general (artista + título)
  try {
    const q = cleanArtist ? `${cleanArtist} ${cleanTitle}`.trim() : cleanTitle
    const res = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(q)}`, {
      headers: { 'User-Agent': 'ReproductorDeMusica/1.0.0 (https://github.com/reproductor-de-musica)' },
      signal: AbortSignal.timeout(4000)
    })

    if (res.ok) {
      const list = await res.json()
      const best = pickBestLyricsCandidate(list, duration)
      if (best) return best
    }
  } catch (_) {}

  // 3. Último intento: si la búsqueda con artista no dio resultados (ej. artista mal etiquetado), buscar solo por título
  if (cleanArtist) {
    try {
      const res = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(cleanTitle)}`, {
        headers: { 'User-Agent': 'ReproductorDeMusica/1.0.0 (https://github.com/reproductor-de-musica)' },
        signal: AbortSignal.timeout(3500)
      })

      if (res.ok) {
        const list = await res.json()
        const best = pickBestLyricsCandidate(list, duration)
        if (best) return best
      }
    } catch (_) {}
  }

  return null
}

/**
 * Guarda manualmente o en modo permanente un archivo .lrc junto a la canción
 */
export async function saveTrackLrcFile(trackPath, lyricsText, realMusicDir = null) {
  if (!trackPath || !lyricsText || typeof lyricsText !== 'string') {
    return { success: false, error: 'Datos de letra inválidos' }
  }
  try {
    const normalizedPath = path.normalize(trackPath)
    const dir = path.dirname(normalizedPath)
    const baseName = path.basename(normalizedPath, path.extname(normalizedPath))
    const extName = path.extname(normalizedPath).toLowerCase()
    const hasTimestamps = /\[\d{1,2}:\d{2}/.test(lyricsText)
    const ext = hasTimestamps ? '.lrc' : '.txt'
    const targetFile = path.join(dir, `${baseName}${ext}`)

    // 1. Guardar archivo .lrc en la carpeta de la pista
    await fs.promises.writeFile(targetFile, lyricsText, 'utf8')

    // 2. Si existe carpeta Canciones_reales, guardar también allí para el archivo maestro
    if (realMusicDir && fs.existsSync(realMusicDir)) {
      try {
        const masterLrc = path.join(realMusicDir, `${baseName}${ext}`)
        await fs.promises.writeFile(masterLrc, lyricsText, 'utf8')
      } catch (err) {
        console.warn('Aviso guardando lrc en Canciones_reales:', err.message)
      }
    }

    // 3. Incrustar letras en las etiquetas del archivo de audio original y todos sus hard links
    if (extName === '.mp3') {
      try {
        const tags = {
          unsynchronisedLyrics: {
            language: 'eng',
            text: lyricsText
          }
        }
        NodeID3.update(tags, normalizedPath)

        if (realMusicDir) {
          const masterPath = path.join(realMusicDir, path.basename(normalizedPath))
          if (fs.existsSync(masterPath)) {
            try {
              NodeID3.update(tags, masterPath)
            } catch (_) {}
          }
        }
      } catch (tagErr) {
        console.warn('Aviso incrustando letras en ID3:', tagErr.message)
      }
    }

    // Actualizar caché en memoria para respuesta instantánea
    memoryLyricsCache.set(normalizedPath.toLowerCase(), {
      lyrics: lyricsText,
      savedToDisk: true,
      source: 'lrc',
      synced: hasTimestamps
    })

    return { success: true, filePath: targetFile, synced: hasTimestamps }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

export async function deleteTrackLrcFile(trackPath, realMusicDir = null) {
  if (!trackPath) return { success: false, error: 'Ruta inválida' }
  try {
    const normalizedPath = path.normalize(trackPath)
    const dir = path.dirname(normalizedPath)
    const baseName = path.parse(normalizedPath).name
    const extName = path.extname(normalizedPath).toLowerCase()
    const candidates = [
      path.join(dir, `${baseName}.lrc`),
      path.join(dir, `${baseName}.LRC`),
      path.join(dir, `${baseName}.txt`)
    ]
    if (realMusicDir && fs.existsSync(realMusicDir)) {
      candidates.push(
        path.join(realMusicDir, `${baseName}.lrc`),
        path.join(realMusicDir, `${baseName}.LRC`),
        path.join(realMusicDir, `${baseName}.txt`)
      )
    }

    let deletedAny = false
    for (const file of candidates) {
      if (fs.existsSync(file)) {
        try {
          await fs.promises.unlink(file)
          deletedAny = true
        } catch (_) {}
      }
    }

    // Sacar las letras de las etiquetas del archivo original y sus hard links
    if (extName === '.mp3') {
      try {
        const tags = NodeID3.read(normalizedPath)
        if (tags) {
          delete tags.unsynchronisedLyrics
          delete tags.synchronisedLyrics
          if (tags.raw) {
            delete tags.raw.USLT
            delete tags.raw.SYLT
          }
          NodeID3.write(tags, normalizedPath)
        }

        if (realMusicDir) {
          const masterPath = path.join(realMusicDir, path.basename(normalizedPath))
          if (fs.existsSync(masterPath)) {
            try {
              const mTags = NodeID3.read(masterPath)
              if (mTags) {
                delete mTags.unsynchronisedLyrics
                delete mTags.synchronisedLyrics
                if (mTags.raw) {
                  delete mTags.raw.USLT
                  delete mTags.raw.SYLT
                }
                NodeID3.write(mTags, masterPath)
              }
            } catch (_) {}
          }
        }
      } catch (tagErr) {
        console.warn('Aviso eliminando letras en ID3:', tagErr.message)
      }
    }

    memoryLyricsCache.delete(normalizedPath.toLowerCase())
    return { success: true, deleted: deletedAny }
  } catch (err) {
    return { success: false, error: err.message }
  }
}

export async function downloadTrackMetadataAndLyrics(trackPath, title, artist, duration = 0, options = {}) {
  if (!trackPath) return { success: false, error: 'Ruta de archivo inválida' }

  const { saveToDisk = false, bypassCache = false } = options
  const cacheKey = path.normalize(trackPath).toLowerCase()

  if (!bypassCache && memoryLyricsCache.has(cacheKey)) {
    const cached = memoryLyricsCache.get(cacheKey)
    if (saveToDisk && !cached.savedToDisk && cached.lyrics) {
      const saveRes = await saveTrackLrcFile(trackPath, cached.lyrics)
      if (saveRes.success) {
        cached.savedToDisk = true
      }
    }
    return cached
  }

  let lyricsFound = false
  let savedLyrics = null
  let isSynced = false
  let savedToDisk = false
  let matchedTrack = null

  try {
    const lyricsData = await fetchLyricsFromLRCLIB(title, artist, duration)
    if (lyricsData) {
      const synced = lyricsData.syncedLyrics
      const plain = lyricsData.plainLyrics
      savedLyrics = synced || plain

      if (savedLyrics) {
        lyricsFound = true
        isSynced = Boolean(synced)
        matchedTrack = {
          title: lyricsData.trackName || title,
          artist: lyricsData.artistName || artist,
          album: lyricsData.albumName || null,
          duration: lyricsData.duration || 0
        }

        // Solo escribir archivo .lrc en disco si el usuario eligió modo permanente (no temporal)
        if (saveToDisk) {
          const saveRes = await saveTrackLrcFile(trackPath, savedLyrics)
          savedToDisk = Boolean(saveRes.success)
        }
      }
    }
  } catch (err) {
    console.warn('[Lyrics] Error obteniendo letras:', err.message)
  }

  const result = {
    success: true,
    lyricsFound,
    synced: isSynced,
    savedToDisk,
    lyrics: savedLyrics,
    matchedTrack
  }

  if (lyricsFound) {
    memoryLyricsCache.set(cacheKey, result)
  }

  return result
}
