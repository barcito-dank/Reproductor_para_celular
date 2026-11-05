import todosCoverSvg from '../assets/todos-cover.svg?raw'

/**
 * Carátula genérica vectorial dedicada para el álbum "Todos"
 * (codificada como Data URI in-memory para carga instantánea en 0ms y compatibilidad total en dev/exe).
 */
export const TODOS_ALBUM_COVER = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  todosCoverSvg.trim()
)
  .replace(/'/g, '%27')
  .replace(/\(/g, '%28')
  .replace(/\)/g, '%29')}`

/**
 * Genera una clave canónica de identidad para detectar canciones duplicadas
 * cuando el mismo archivo o canción está presente en varios álbumes/carpetas.
 */
export function getTrackUniqueKey(track) {
  if (!track) return ''

  if (track.ino && String(track.ino) !== '0') {
    return `ino:${track.ino}`
  }

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

/**
 * Compara si dos referencias de pista corresponden a la misma canción
 * (ya sea por id exacto o por clave única cuando se visualiza el álbum "Todos").
 */
export function areSameTrack(trackA, trackB, matchByUniqueKey = false) {
  if (!trackA || !trackB) return false
  if (trackA.id === trackB.id) return true
  if (!matchByUniqueKey) return false
  const keyA = trackA.uniqueKey || getTrackUniqueKey(trackA)
  const keyB = trackB.uniqueKey || getTrackUniqueKey(trackB)
  return Boolean(keyA && keyA === keyB)
}
