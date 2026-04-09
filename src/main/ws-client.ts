import WebSocket from 'ws'
import { EventEmitter } from 'events'
import { getSettings } from './settings'

export interface WsStatus {
  connected: boolean
  reconnecting: boolean
}

export interface LogEntry {
  timestamp: string
  level: 'info' | 'warn' | 'error'
  message: string
}

export class WsClient extends EventEmitter {
  private ws: WebSocket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelay = 1000
  private authenticated = false
  private destroyed = false
  private status: WsStatus = { connected: false, reconnecting: false }

  connect(): void {
    if (this.destroyed) return
    const settings = getSettings()
    if (!settings.wsEnabled) return
    this._clearReconnect()
    this._doConnect(settings.wsUrl, settings.wsSecret)
  }

  disconnect(): void {
    this._clearReconnect()
    if (this.ws) {
      this.ws.removeAllListeners()
      this.ws.close()
      this.ws = null
    }
    this.authenticated = false
    this._updateStatus({ connected: false, reconnecting: false })
  }

  destroy(): void {
    this.destroyed = true
    this.disconnect()
  }

  sendVoiceInput(text: string): void {
    if (!this.ws || !this.authenticated) {
      this._log('warn', 'WebSocket not ready, dropping voice_input')
      return
    }
    this.ws.send(
      JSON.stringify({
        type: 'voice_input',
        text,
        timestamp: new Date().toISOString(),
      })
    )
    this._log('info', `Sent voice_input: "${text}"`)
  }

  async testConnection(url: string, secret: string): Promise<{ success: boolean; error?: string }> {
    return new Promise((resolve) => {
      let settled = false
      const ws = new WebSocket(url)
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          ws.close()
          resolve({ success: false, error: 'Connection timed out' })
        }
      }, 5000)

      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'auth', secret, plugin: 'voice-companion' }))
      })

      ws.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString())
          if (!settled) {
            settled = true
            clearTimeout(timer)
            ws.close()
            if (msg.type === 'auth_ok') {
              resolve({ success: true })
            } else {
              resolve({ success: false, error: `Unexpected response: ${msg.type}` })
            }
          }
        } catch {
          // ignore parse errors
        }
      })

      ws.on('error', (err: Error) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          resolve({ success: false, error: err.message })
        }
      })

      ws.on('close', () => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          resolve({ success: false, error: 'Connection closed without auth_ok' })
        }
      })
    })
  }

  private _doConnect(url: string, secret: string): void {
    this._log('info', `Connecting to ${url}`)
    this._updateStatus({ connected: false, reconnecting: this.reconnectDelay > 1000 })

    try {
      this.ws = new WebSocket(url)
    } catch (err) {
      this._log('error', `Failed to create WebSocket: ${(err as Error).message}`)
      this._scheduleReconnect()
      return
    }

    this.ws.on('open', () => {
      this._log('info', 'WebSocket connected, authenticating…')
      this.ws!.send(JSON.stringify({ type: 'auth', secret, plugin: 'voice-companion' }))
    })

    this.ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'auth_ok') {
          this.authenticated = true
          this.reconnectDelay = 1000
          this._updateStatus({ connected: true, reconnecting: false })
          this._log('info', 'WebSocket authenticated')
        }
      } catch {
        // ignore parse errors
      }
    })

    this.ws.on('close', (code: number) => {
      this.authenticated = false
      this._log('warn', `WebSocket closed (code ${code})`)
      this._updateStatus({ connected: false, reconnecting: true })
      if (!this.destroyed) this._scheduleReconnect()
    })

    this.ws.on('error', (err: Error) => {
      this._log('error', `WebSocket error: ${err.message}`)
    })
  }

  private _scheduleReconnect(): void {
    this._clearReconnect()
    const delay = this.reconnectDelay
    this._log('info', `Reconnecting in ${delay / 1000}s…`)
    this.reconnectTimer = setTimeout(() => {
      const settings = getSettings()
      if (!settings.wsEnabled || this.destroyed) return
      this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000)
      this._doConnect(settings.wsUrl, settings.wsSecret)
    }, delay)
  }

  private _clearReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private _updateStatus(s: WsStatus): void {
    this.status = s
    this.emit('status', s)
  }

  private _log(level: 'info' | 'warn' | 'error', message: string): void {
    const entry: LogEntry = { timestamp: new Date().toISOString(), level, message }
    this.emit('log', entry)
  }

  getStatus(): WsStatus {
    return this.status
  }
}

export const wsClient = new WsClient()
