import { describe, it, expect } from 'vitest'
import { parseLrcText } from '../src/shared/lyricsParser'

describe('LyricsParser - Parseo de Letras LRC y Texto Plano', () => {
  it('parsea letras sincronizadas con timestamps [mm:ss.xx]', () => {
    const lrc = `
      [ti: Canción de Prueba]
      [ar: Artista Demo]
      [00:12.50] Primera línea de la canción
      [00:15.80] Segunda línea sincronizada
      [00:20.00] Tercera línea
    `
    const result = parseLrcText(lrc)
    expect(result.synced).toBe(true)
    expect(result.lines).toHaveLength(3)
    expect(result.lines[0].time).toBeCloseTo(12.5)
    expect(result.lines[0].text).toBe('Primera línea de la canción')
    expect(result.lines[1].time).toBeCloseTo(15.8)
    expect(result.lines[2].time).toBeCloseTo(20.0)
  })

  it('ordena cronológicamente las líneas si vienen desordenadas en el archivo', () => {
    const lrc = `
      [00:30.00] Final
      [00:10.00] Principio
      [00:20.00] Medio
    `
    const result = parseLrcText(lrc)
    expect(result.lines[0].text).toBe('Principio')
    expect(result.lines[1].text).toBe('Medio')
    expect(result.lines[2].text).toBe('Final')
  })

  it('procesa texto plano cuando no hay etiquetas de tiempo', () => {
    const plain = `
      Esta es una letra sin sincronizar
      Línea dos del texto
      Línea tres
    `
    const result = parseLrcText(plain)
    expect(result.synced).toBe(false)
    expect(result.lines).toHaveLength(3)
    expect(result.lines[0].text).toBe('Esta es una letra sin sincronizar')
  })

  it('ignora encabezados de metadatos como [length:], [by:], [offset:]', () => {
    const lrc = `
      [offset: +200]
      [by: Antigravity]
      [00:05.00] Hola mundo
    `
    const result = parseLrcText(lrc)
    expect(result.lines).toHaveLength(1)
    expect(result.lines[0].text).toBe('Hola mundo')
  })

  it('retorna arreglo vacío si la entrada es nula o vacía', () => {
    expect(parseLrcText(null)).toEqual({ synced: false, lines: [] })
    expect(parseLrcText('')).toEqual({ synced: false, lines: [] })
  })
})
