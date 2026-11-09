import { describe, it, expect } from 'vitest'
import { SecurityService } from '../src/main/services/SecurityService'
import path from 'path'

describe('SecurityService - Sanitización y Validación de Rutas', () => {
  const allowedRoots = [
    'C:\\Users\\test\\Music\\canciones_organizadas',
    'C:\\Users\\test\\Music\\Canciones_reales'
  ]

  it('permite rutas legítimas dentro de las raíces autorizadas', () => {
    const validPath = 'C:\\Users\\test\\Music\\canciones_organizadas\\Rock\\song.mp3'
    expect(SecurityService.isPathInside(validPath, allowedRoots)).toBe(true)
  })

  it('bloquea intentos de Path Traversal relativos (..)', () => {
    const attackPath = 'C:\\Users\\test\\Music\\canciones_organizadas\\..\\..\\Windows\\System32\\cmd.exe'
    expect(SecurityService.isPathInside(attackPath, allowedRoots)).toBe(false)
  })

  it('bloquea inyección de byte nulo (\0)', () => {
    const attackPath = 'C:\\Users\\test\\Music\\canciones_organizadas\\song.mp3\0.exe'
    expect(SecurityService.isPathInside(attackPath, allowedRoots)).toBe(false)
  })

  it('bloquea rutas fuera de las raíces permitidas', () => {
    const outsidePath = 'D:\\Juegos\\game.exe'
    expect(SecurityService.isPathInside(outsidePath, allowedRoots)).toBe(false)
  })

  it('sanitiza nombres ilegales en Windows reemplazando caracteres prohibidos', () => {
    const raw = 'Rock / Pop: Lo mejor * 2026? <Edition> | "Deluxe"'
    const clean = SecurityService.sanitizeFileName(raw)
    expect(clean).not.toMatch(/[\\/:*?"<>|]/)
    expect(clean).toBe('Rock _ Pop_ Lo mejor _ 2026_ _Edition_ _ _Deluxe_')
  })

  it('protege contra nombres reservados de Windows (CON, PRN, AUX, etc.)', () => {
    expect(SecurityService.sanitizeFileName('CON')).toBe('_CON')
    expect(SecurityService.sanitizeFileName('aux.mp3')).toBe('_aux.mp3')
    expect(SecurityService.sanitizeFileName('com1')).toBe('_com1')
  })

  it('valida cadenas recibidas por IPC y rechaza entradas no conformes', () => {
    expect(SecurityService.validateString('  Hola Mundo  ', 'titulo')).toBe('Hola Mundo')
    expect(() => SecurityService.validateString('', 'titulo', 100, false)).toThrow()
    expect(() => SecurityService.validateString('a'.repeat(20), 'titulo', 10)).toThrow()
    expect(() => SecurityService.validateString(123, 'titulo')).toThrow()
  })

  it('valida números de IPC dentro de límites numéricos', () => {
    expect(SecurityService.validateNumber(42, 'volumen', 0, 100)).toBe(42)
    expect(SecurityService.validateNumber('80', 'volumen', 0, 100)).toBe(80)
    expect(() => SecurityService.validateNumber(150, 'volumen', 0, 100)).toThrow()
    expect(() => SecurityService.validateNumber(-5, 'volumen', 0, 100)).toThrow()
    expect(() => SecurityService.validateNumber('no-es-numero', 'volumen')).toThrow()
  })
})
