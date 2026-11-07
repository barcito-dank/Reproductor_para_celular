import net from 'net'

/**
 * Cliente nativo Discord RPC sobre Windows Named Pipes (\\?\pipe\discord-ipc-0 a 9)
 * No requiere paquetes externos ni compiladores C++; 100% nativo en Node.js.
 */
class DiscordRPC {
  constructor(clientId = '1300000000000000000') {
    this.clientId = clientId
    this.socket = null
    this.connected = false
    this.ready = false
    this.connecting = false
    this.lastActivity = null
    this.reconnectTimer = null
    this.enabled = false
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled)
    if (this.enabled) {
      this.connect()
    } else {
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer)
        this.reconnectTimer = null
      }
      this.clearActivity()
      this.disconnect()
    }
  }

  getStatus() {
    return {
      enabled: this.enabled,
      connected: this.connected && this.ready
    }
  }

  _getPipePath(index) {
    if (process.platform === 'win32') {
      return `\\\\?\\pipe\\discord-ipc-${index}`
    }
    const base = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || '/tmp'
    return `${base}/discord-ipc-${index}`
  }

  connect(pipeIndex = 0) {
    if (this.connected || !this.enabled) return
    if (pipeIndex === 0 && this.connecting) return

    if (pipeIndex >= 10) {
      this.connecting = false
      if (this.enabled && !this.reconnectTimer) {
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null
          if (this.enabled) this.connect(0)
        }, 12000)
      }
      return
    }

    this.connecting = true
    const pipePath = this._getPipePath(pipeIndex)
    let settled = false

    try {
      const sock = net.createConnection(pipePath)

      sock.once('connect', () => {
        if (settled) return
        settled = true
        this.connecting = false
        this.socket = sock
        this.connected = true
        this.ready = false

        // Enviar Opcode 0: HANDSHAKE
        this._send(0, { v: 1, client_id: this.clientId })
      })

      sock.on('data', () => {
        // Primer paquete tras handshake es el evento READY de Discord
        if (!this.ready) {
          this.ready = true
          if (this.lastActivity && this.enabled) {
            this._dispatchActivity(this.lastActivity)
          }
        }
      })

      sock.on('error', () => {
        if (!settled) {
          settled = true
          try { sock.destroy() } catch (_) {}
          this.connect(pipeIndex + 1)
          return
        }
        this.disconnect()
      })

      sock.on('close', () => {
        if (settled) {
          this.disconnect()
        }
      })
    } catch (_) {
      if (!settled) {
        settled = true
        this.connect(pipeIndex + 1)
      }
    }
  }

  _send(opcode, payload) {
    if (!this.socket || !this.connected) return
    try {
      const json = JSON.stringify(payload)
      const len = Buffer.byteLength(json)
      const packet = Buffer.alloc(8 + len)
      packet.writeInt32LE(opcode, 0)
      packet.writeInt32LE(len, 4)
      packet.write(json, 8)
      this.socket.write(packet)
    } catch (_) {}
  }

  _dispatchActivity(activity) {
    if (!this.socket || !this.connected || !this.ready) return
    this._send(1, {
      cmd: 'SET_ACTIVITY',
      args: {
        pid: process.pid,
        activity
      },
      nonce: Math.random().toString(36).substring(2)
    })
  }

  setActivity(activity) {
    this.lastActivity = activity
    if (!this.enabled) return
    if (!this.connected) {
      this.connect(0)
      return
    }
    if (this.ready) {
      this._dispatchActivity(activity)
    }
  }

  updateTrack(track, isPlaying, currentTime = 0) {
    if (!track) {
      this.clearActivity()
      return
    }

    if (!isPlaying) {
      this.setActivity({
        details: track.title || 'Canción',
        state: `En pausa · ${track.artist || 'Artista Desconocido'}`,
        assets: {
          large_image: 'music_icon',
          large_text: track.albumName || 'Reproductor de Música',
          small_image: 'pause_icon',
          small_text: 'Pausa'
        }
      })
      return
    }

    const duration = track.duration || 0
    const now = Math.floor(Date.now() / 1000)
    const startTimestamp = now - Math.floor(currentTime || 0)
    const endTimestamp = duration > 0 ? startTimestamp + Math.floor(duration) : undefined

    this.setActivity({
      details: track.title || 'Canción',
      state: `${track.artist || 'Artista'} — ${track.albumName || 'Álbum'}`,
      timestamps: {
        start: startTimestamp,
        end: endTimestamp
      },
      assets: {
        large_image: 'music_icon',
        large_text: track.albumName || 'Reproductor de Música',
        small_image: 'play_icon',
        small_text: 'Reproduciendo'
      }
    })
  }

  clearActivity() {
    this.lastActivity = null
    if (this.connected && this.ready) {
      this._dispatchActivity(null)
    }
  }

  disconnect() {
    this.connected = false
    this.ready = false
    this.connecting = false
    if (this.socket) {
      try {
        this.socket.destroy()
      } catch (_) {}
      this.socket = null
    }
  }
}

export const discordRpc = new DiscordRPC()
