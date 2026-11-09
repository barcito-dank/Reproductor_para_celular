import fs from 'fs'
import path from 'path'

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'

export class LoggerService {
  private logFilePath: string | null = null
  private maxSizeBytes: number = 5 * 1024 * 1024 // 5 MB
  private writeQueue: string[] = []
  private isWriting: boolean = false

  public init(userDataDir: string): void {
    try {
      const logsDir = path.join(userDataDir, 'logs')
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true })
      }
      this.logFilePath = path.join(logsDir, 'app.log')
      this.flushQueue()
      this.info('Logger', `Sistema de registro iniciado en ${this.logFilePath}`)
    } catch (err: any) {
      console.warn('[Logger] No se pudo inicializar archivo de log:', err?.message)
    }
  }

  private formatMessage(level: LogLevel, tag: string, message: string, extra?: any): string {
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 23)
    let extraStr = ''
    if (extra !== undefined) {
      if (extra instanceof Error) {
        extraStr = `\n${extra.stack || extra.message}`
      } else if (typeof extra === 'object') {
        try {
          extraStr = ` ${JSON.stringify(extra)}`
        } catch (_) {
          extraStr = ` [Object]`
        }
      } else {
        extraStr = ` ${extra}`
      }
    }
    return `[${timestamp}] [${level.padEnd(5)}] [${tag}] ${message}${extraStr}\n`
  }

  private writeToFile(formattedMsg: string): void {
    if (!this.logFilePath) {
      this.writeQueue.push(formattedMsg)
      if (this.writeQueue.length > 500) this.writeQueue.shift()
      return
    }

    this.writeQueue.push(formattedMsg)
    this.flushQueue()
  }

  private flushQueue(): void {
    if (this.isWriting || !this.logFilePath || this.writeQueue.length === 0) return
    this.isWriting = true

    const batch = this.writeQueue.splice(0, this.writeQueue.length).join('')

    // Verificar rotación de log
    try {
      if (fs.existsSync(this.logFilePath)) {
        const stats = fs.statSync(this.logFilePath)
        if (stats.size > this.maxSizeBytes) {
          const oldLogPath = path.join(path.dirname(this.logFilePath), 'app.old.log')
          try {
            if (fs.existsSync(oldLogPath)) fs.unlinkSync(oldLogPath)
            fs.renameSync(this.logFilePath, oldLogPath)
          } catch (_) {}
        }
      }
    } catch (_) {}

    fs.appendFile(this.logFilePath, batch, 'utf8', (err) => {
      this.isWriting = false
      if (err) {
        console.warn('[Logger] Error escribiendo en app.log:', err.message)
      }
      if (this.writeQueue.length > 0) {
        this.flushQueue()
      }
    })
  }

  public debug(tag: string, message: string, extra?: any): void {
    const formatted = this.formatMessage('DEBUG', tag, message, extra)
    if (process.env.NODE_ENV !== 'production') {
      console.debug(`[${tag}] ${message}`, extra ?? '')
    }
    this.writeToFile(formatted)
  }

  public info(tag: string, message: string, extra?: any): void {
    const formatted = this.formatMessage('INFO', tag, message, extra)
    console.log(`[${tag}] ${message}`, extra ?? '')
    this.writeToFile(formatted)
  }

  public warn(tag: string, message: string, extra?: any): void {
    const formatted = this.formatMessage('WARN', tag, message, extra)
    console.warn(`[${tag}] ${message}`, extra ?? '')
    this.writeToFile(formatted)
  }

  public error(tag: string, message: string, extra?: any): void {
    const formatted = this.formatMessage('ERROR', tag, message, extra)
    console.error(`[${tag}] ${message}`, extra ?? '')
    this.writeToFile(formatted)
  }
}

export const Logger = new LoggerService()
