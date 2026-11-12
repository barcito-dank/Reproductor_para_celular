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

    // 2. Reemplazar caracteres ilegales en sistemas de archivos (\ / : * ? " < > |)
    clean = clean.replace(/[\\/:*?"<>|]/g, '_')

    // 3. Eliminar puntos o espacios al final
    clean = clean.replace(/[. ]+$/, '')

    // 4. Prevenir nombres reservados
    const baseUpper = clean.toUpperCase().split('.')[0]
    if (this.WINDOWS_RESERVED_NAMES.has(baseUpper)) {
      clean = `_${clean}`
    }

    return clean.slice(0, 255)
  }

  /**
   * Normaliza una ruta de forma pura (sin depender del módulo 'path' de Node),
   * unificando separadores a '/', resolviendo '.' y '..' y normalizando letras de unidad.
   */
  public static normalizePath(p: string): string {
    const unified = p.replace(/\\/g, '/').trim()
    let prefix = ''
    let rest = unified

    if (/^[A-Za-z]:/.test(unified)) {
      prefix = unified.slice(0, 2).toLowerCase()
      rest = unified.slice(2)
    } else if (unified.startsWith('/')) {
      prefix = '/'
      rest = unified.slice(1)
    }

    const parts = rest.split('/')
    const stack: string[] = []

    for (const part of parts) {
      if (!part || part === '.') continue
      if (part === '..') {
        stack.pop()
      } else {
        stack.push(part)
      }
    }

    if (prefix) {
      if (prefix === '/') {
        return '/' + stack.join('/')
      }
      return prefix + '/' + stack.join('/')
    }

    return stack.join('/')
  }

  /**
   * Valida si una ruta objetivo reside estrictamente dentro de una o más rutas base permitidas,
   * bloqueando ataques de Path Traversal (ej. ../../Windows/System32 o ../..).
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

        // Child path check con separador seguro '/'
        const prefix = normalizedRoot.endsWith('/') ? normalizedRoot : normalizedRoot + '/'
        return normalizedTarget.startsWith(prefix)
      })
    } catch (_) {
      return false
    }
  }

  /**
   * Valida y sanitiza una cadena recibida por IPC / Bridge.
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
   * Valida un número recibido por IPC / Bridge dentro de un rango opcional.
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
