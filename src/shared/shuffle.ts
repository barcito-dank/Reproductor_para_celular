/**
 * Algoritmo de barajado uniforme Fisher-Yates con prevención de repetición inmediata de ciclo.
 */
export function buildShuffledIndices<T extends { id?: string | number }>(
  list: T[],
  excludeIds: Set<string | number> = new Set(),
  avoidRecentIds: Set<string | number> = new Set()
): number[] {
  const indices: number[] = []
  for (let i = 0; i < list.length; i++) {
    const id = list[i]?.id ?? i
    if (!excludeIds.has(id)) {
      indices.push(i)
    }
  }

  // Fisher-Yates shuffle
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const tmp = indices[i]
    indices[i] = indices[j]
    indices[j] = tmp
  }

  // Evitar que las canciones recién escuchadas al final del ciclo anterior
  // salgan primeras en el nuevo ciclo (las enviamos al principio para salir últimas con .pop())
  if (avoidRecentIds.size > 0 && indices.length > avoidRecentIds.size) {
    const fresh: number[] = []
    const recent: number[] = []
    for (const idx of indices) {
      const id = list[idx]?.id ?? idx
      if (avoidRecentIds.has(id)) {
        recent.push(idx)
      } else {
        fresh.push(idx)
      }
    }
    return [...recent, ...fresh]
  }

  return indices
}
