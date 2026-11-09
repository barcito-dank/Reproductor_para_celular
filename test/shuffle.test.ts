import { describe, it, expect } from 'vitest'
import { buildShuffledIndices } from '../src/shared/shuffle'

describe('Shuffle - Algoritmo Fisher-Yates y Ciclos', () => {
  const mockTracks = [
    { id: 'track-1', title: 'Song 1' },
    { id: 'track-2', title: 'Song 2' },
    { id: 'track-3', title: 'Song 3' },
    { id: 'track-4', title: 'Song 4' },
    { id: 'track-5', title: 'Song 5' }
  ]

  it('baraja todos los elementos sin perder ni duplicar índices', () => {
    const indices = buildShuffledIndices(mockTracks)
    expect(indices).toHaveLength(5)
    expect(new Set(indices).size).toBe(5)
    expect(indices.sort()).toEqual([0, 1, 2, 3, 4])
  })

  it('excluye correctamente los IDs especificados en excludeIds', () => {
    const exclude = new Set(['track-2', 'track-4'])
    const indices = buildShuffledIndices(mockTracks, exclude)
    expect(indices).toHaveLength(3)
    expect(indices).not.toContain(1) // track-2
    expect(indices).not.toContain(3) // track-4
  })

  it('evita repetición inmediata de canciones recientes colocándolas al inicio para salir al final con pop()', () => {
    const avoidRecent = new Set(['track-1'])
    // Con 5 pistas y avoidRecent=['track-1'] (índice 0):
    // El índice 0 debe ser colocado en la mitad inferior (recent) del array
    let wasAtStart = 0
    const iterations = 50
    for (let i = 0; i < iterations; i++) {
      const indices = buildShuffledIndices(mockTracks, new Set(), avoidRecent)
      // Como pop() saca del final, si avoidRecent se colocó al principio, no debe estar en la última posición
      const lastElement = indices[indices.length - 1]
      if (lastElement === 0) {
        wasAtStart++
      }
    }
    // No debería estar nunca en la última posición (la primera que saldría con pop())
    expect(wasAtStart).toBe(0)
  })

  it('soporta arreglos vacíos de forma segura', () => {
    expect(buildShuffledIndices([])).toEqual([])
  })
})
