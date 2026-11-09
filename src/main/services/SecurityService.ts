import path from 'path'

export class SecurityService {
  /**
   * Lista de nombres reservados en sistemas de archivos Windows que no pueden ser usados
   * como nombres de archivos o carpetas.
   */
  private static readonly WINDOWS_RESERVED_NAMES = new Set([
    'CON', 'PRN', 'AUX', 'NUL',
    'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
    'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
  ])

  /**
   * Sanitiza un nombre de archivo o carpeta eliminando caracteres ilegales y secuencias de escape.
   */
  public static sanitizeFileName(rawName: unknown): string {
    if (typeof rawName !== 'string') return ''
    
    // 1. Eliminar caracteres de control y nulos
    let clean = rawName.replace(/[\x00-\x1f\x80-\x9f]/g, '').trim()

    // 2. Reemplazar caracteres ilegales en Windows (\ / : * ? " < > |)
    clean = clean.replace(/[\\/:*?"<>|]/g, '_')

    // 3. Eliminar puntos o espacios al final (prohibidos en Windows)
    clean = clean.replace(/[. ]+$/, '')

    // 4. Prevenir nombres reservados
    const baseUpper = clean.toUpperCase().split('.')[0]
    if (this.WINDOWS_RESERVED_NAMES.has(baseUpper)) {
      clean = `_${clean}`
    }

    return clean.slice(0, 255)
  }

  /**
   * Normaliza una ruta absoluta en Windows resolviendo mayúsculas/minúsculas y barras.
   */
  public static normalizePath(p: string): string {
    const resolved = path.resolve(p)
    // En Windows normalizamos la letra de unidad a minúscula para comparaciones seguras
    if (/^[A-Za-z]:/.test(resolved)) {
      return resolved[0].toLowerCase() + resolved.slice(1)
    }
    return resolved
  }

  /**
   * Valida si una ruta objetivo reside estrictamente dentro de una o más rutas base permitidas,
   * bloqueando ataques de Path Traversal (ej. ../../Windows/System32).
   */
  public static isPathInside(targetPath: string, allowedRoots: string[]): boolean {
    if (!targetPath || typeof targetPath !== 'string') return false
    if (targetPath.includes('\0')) return false // Inyección de byte nulo

    try {
      const normalizedTarget = this.normalizePath(targetPath)

      return allowedRoots.some((root) => {
        if (!root || typeof root !== 'string') return false
        const normalizedRoot = this.normalizePath(root)
        
        // Exact match
        if (normalizedTarget === normalizedRoot) return true

        // Child path check con separador seguro
        const prefix = normalizedRoot.endsWith(path.sep) ? normalizedRoot : normalizedRoot + path.sep
        return normalizedTarget.startsWith(prefix)
      })
    } catch (_) {
      return false
    }
  }

  /**
   * Valida y sanitiza una cadena recibida por IPC.
   */
  public static validateString(
    val: unknown,
    fieldName: string,
    maxLength: number = 500,
    allowEmpty: boolean = false
  ): string {
    if (typeof val !== 'string') {
      throw new Error(`El campo '${fieldName}' debe ser una cadena de texto válida.`)
    }
    const trimmed = val.trim()
    if (!allowEmpty && trimmed.length === 0) {
      throw new Error(`El campo '${fieldName}' no puede estar vacío.`)
    }
    if (trimmed.length > maxLength) {
      throw new Error(`El campo '${fieldName}' excede la longitud máxima permitida (${maxLength} caracteres).`)
    }
    return trimmed
  }

  /**
   * Valida un número recibido por IPC dentro de un rango opcional.
   */
  public static validateNumber(
    val: unknown,
    fieldName: string,
    min?: number,
    max?: number
  ): number {
    const num = Number(val)
    if (isNaN(num)) {
      throw new Error(`El campo '${fieldName}' debe ser un valor numérico válido.`)
    }
    if (min !== undefined && num < min) {
      throw new Error(`El campo '${fieldName}' no puede ser menor que ${min}.`)
    }
    if (max !== undefined && num > max) {
      throw new Error(`El campo '${fieldName}' no puede ser mayor que ${max}.`)
    }
    return num
  }
}
