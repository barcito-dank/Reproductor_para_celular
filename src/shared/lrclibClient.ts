export interface LrcLibQuery {
  title: string
  artist?: string
  album?: string
  duration?: number
}

export interface LrcLibRecord {
  id?: number
  trackName?: string
  artistName?: string
  albumName?: string
  duration?: number
  instrumental?: boolean
  plainLyrics?: string | null
  syncedLyrics?: string | null
}

export interface LrcLibResult {
  lyrics: string
  synced: boolean
  syncedLyrics: string | null
  plainLyrics: string | null
  matchedTrack: {
    title: string
    artist: string
    album: string | null
    duration: number
  }
}

const UNKNOWN_ARTIST_REGEX =
  /^(artista desconocido|unknown artist|desconocido|unknown|varios artistas|various artists|—|-|ninguno|none)$/i

/**
 * Limpia el título y el artista para optimizar la coincidencia en APIs externas
 */
export function parseAndCleanTrackInfo(
  rawTitle?: string | null,
  rawArtist?: string | null
): { cleanTitle: string; cleanArtist: string } {
  let title = (rawTitle || '').trim()
  let artist = (rawArtist || '').trim()

  if (UNKNOWN_ARTIST_REGEX.test(artist)) {
    artist = ''
  }

  // Quitar extensión de archivo si estuviera en el título
  title = title.replace(/\.(mp3|flac|wav|ogg|m4a|aac|opus)$/i, '').trim()

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

  const cleanStr = (str: string): string => {
    if (!str) return ''
    return str
      .replace(/\[[^\]]*\]/g, '') // Quitar [Official Video], [Lyrics], [HD], etc.
      .replace(
        /\([^)]*(?:official|oficial|video|vídeo|audio|remaster|letra|lyrics|hd|hq|4k|live|en vivo|visualizer|clip|karaoke|version|versión)[^)]*\)/gi,
        ''
      )
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
export function pickBestLyricsCandidate(
  list: LrcLibRecord[],
  targetDuration: number = 0
): LrcLibRecord | null {
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

function toLrcLibResult(
  record: LrcLibRecord,
  fallbackTitle: string,
  fallbackArtist: string
): LrcLibResult | null {
  const synced = record.syncedLyrics?.trim() || null
  const plain = record.plainLyrics?.trim() || null
  const lyrics = synced || plain
  if (!lyrics) return null

  return {
    lyrics,
    synced: Boolean(synced),
    syncedLyrics: synced,
    plainLyrics: plain,
    matchedTrack: {
      title: record.trackName || fallbackTitle,
      artist: record.artistName || fallbackArtist,
      album: record.albumName || null,
      duration: Number(record.duration) || 0
    }
  }
}

/**
 * Consulta la API pública y gratuita de LRCLIB (con búsqueda rápida y tolerante a variaciones)
 */
export async function fetchLyricsFromLrcLib({
  title,
  artist = '',
  album = '',
  duration = 0
}: LrcLibQuery): Promise<LrcLibResult | null> {
  const { cleanTitle, cleanArtist } = parseAndCleanTrackInfo(title, artist)
  if (!cleanTitle) return null

  // 1. Si tenemos artista y título limpios, intentar coincidencia directa rápida (timeout corto de 3s)
  if (cleanArtist) {
    try {
      const params = new URLSearchParams({
        track_name: cleanTitle,
        artist_name: cleanArtist
      })
      if (album && album.trim()) {
        params.append('album_name', album.trim())
      }
      if (duration > 0) {
        params.append('duration', Math.round(duration).toString())
      }

      const res = await fetch(`https://lrclib.net/api/get?${params.toString()}`, {
        headers: {
          'User-Agent': 'ReproductorDeMusica/1.0.0 (https://github.com/reproductor-de-musica)'
        },
        signal: AbortSignal.timeout(3000)
      })

      if (res.ok) {
        const data = (await res.json()) as LrcLibRecord
        if (data && (data.syncedLyrics || data.plainLyrics)) {
          return toLrcLibResult(data, cleanTitle, cleanArtist)
        }
      }
    } catch (_) {}
  }

  // 2. Búsqueda flexible por consulta general (artista + título)
  try {
    const q = cleanArtist ? `${cleanArtist} ${cleanTitle}`.trim() : cleanTitle
    const res = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(q)}`, {
      headers: {
        'User-Agent': 'ReproductorDeMusica/1.0.0 (https://github.com/reproductor-de-musica)'
      },
      signal: AbortSignal.timeout(4000)
    })

    if (res.ok) {
      const list = (await res.json()) as LrcLibRecord[]
      const best = pickBestLyricsCandidate(list, duration)
      if (best) return toLrcLibResult(best, cleanTitle, cleanArtist)
    }
  } catch (_) {}

  // 3. Último intento: si la búsqueda con artista no dio resultados (ej. artista mal etiquetado), buscar solo por título
  if (cleanArtist) {
    try {
      const res = await fetch(`https://lrclib.net/api/search?q=${encodeURIComponent(cleanTitle)}`, {
        headers: {
          'User-Agent': 'ReproductorDeMusica/1.0.0 (https://github.com/reproductor-de-musica)'
        },
        signal: AbortSignal.timeout(3500)
      })

      if (res.ok) {
        const list = (await res.json()) as LrcLibRecord[]
        const best = pickBestLyricsCandidate(list, duration)
        if (best) return toLrcLibResult(best, cleanTitle, cleanArtist)
      }
    } catch (_) {}
  }

  return null
}

export const fetchLyricsFromLRCLIB = fetchLyricsFromLrcLib
