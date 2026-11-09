import { LrcLine } from './types'

export interface ParsedLyrics {
  synced: boolean
  lines: LrcLine[]
}

/**
 * Parsea contenido en formato LRC estándar o texto plano de letras de canciones.
 * Soporta etiquetas de tiempo [mm:ss.xx] o [mm:ss:xx], múltiples etiquetas por línea,
 * y filtra encabezados de metadatos ID3/LRC ([ti:], [ar:], etc.).
 */
export function parseLrcText(content: unknown): ParsedLyrics {
  if (!content || typeof content !== 'string') return { synced: false, lines: [] }
  const cleanContent = content.replace(/^\uFEFF/, '')
  const rawLines = cleanContent.split(/\r?\n/)
  const parsedLines: LrcLine[] = []
  const timeRegex = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g

  let hasTimestamp = false

  for (const rawLine of rawLines) {
    const line = rawLine.trim()
    if (!line) continue

    // Ignorar etiquetas de metadata como [ti:], [ar:], [al:], etc.
    if (/^\[(ti|ar|al|by|offset|length|re|ve):/i.test(line)) {
      continue
    }

    const matches = [...line.matchAll(timeRegex)]
    if (matches.length > 0) {
      hasTimestamp = true
      const text = line.replace(timeRegex, '').trim()
      for (const match of matches) {
        const min = parseInt(match[1], 10)
        const sec = parseInt(match[2], 10)
        const msStr = match[3] || '0'
        let ms = 0
        if (msStr.length === 1) ms = parseInt(msStr, 10) * 100
        else if (msStr.length === 2) ms = parseInt(msStr, 10) * 10
        else ms = parseInt(msStr.slice(0, 3), 10)

        const time = min * 60 + sec + ms / 1000
        parsedLines.push({ time, text: text || '♪' })
      }
    }
  }

  if (hasTimestamp && parsedLines.length > 0) {
    parsedLines.sort((a, b) => a.time - b.time)
    return { synced: true, lines: parsedLines }
  }

  // Letra sin sincronización (texto plano)
  const plainLines: LrcLine[] = rawLines
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^\[(ti|ar|al|by|offset|length):/i.test(l))
    .map((text, idx) => ({ time: idx, text }))

  return { synced: false, lines: plainLines }
}
