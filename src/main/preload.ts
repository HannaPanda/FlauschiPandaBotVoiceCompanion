import { contextBridge, ipcRenderer } from 'electron'

export interface Settings {
  wsEnabled: boolean
  wsUrl: string
  wsSecret: string
  pttEnabled: boolean
  pttKey: string
  keywordEnabled: boolean
  keyword: string
  silenceDuration: number
  silenceThreshold: number
  recordingTimeout: number
  whisperMode: 'whisper.cpp' | 'openai'
  whisperModelPath: string
  language: string
  openaiApiKey: string
  openaiModel: string
}

export interface WsStatus {
  connected: boolean
  reconnecting: boolean
}

export interface LogEntry {
  timestamp: string
  level: 'info' | 'warn' | 'error'
  message: string
}

const voiceApi = {
  // Settings
  getSettings(): Promise<Settings> {
    return ipcRenderer.invoke('settings:get')
  },
  setSettings(settings: Partial<Settings>): Promise<void> {
    return ipcRenderer.invoke('settings:set', settings)
  },
  testWebSocket(): Promise<{ success: boolean; error?: string }> {
    return ipcRenderer.invoke('settings:test-ws')
  },

  // Audio
  submitAudio(buffer: ArrayBuffer): Promise<string> {
    return ipcRenderer.invoke('audio:submit', buffer)
  },
  sendVoiceInput(text: string): Promise<void> {
    return ipcRenderer.invoke('ws:voice-input', text)
  },

  // PTT events
  onPttStart(cb: () => void): () => void {
    const handler = () => cb()
    ipcRenderer.on('ptt:start', handler)
    return () => ipcRenderer.removeListener('ptt:start', handler)
  },
  onPttStop(cb: () => void): () => void {
    const handler = () => cb()
    ipcRenderer.on('ptt:stop', handler)
    return () => ipcRenderer.removeListener('ptt:stop', handler)
  },

  // WS status
  onWsStatus(cb: (status: WsStatus) => void): () => void {
    const handler = (_: unknown, status: WsStatus) => cb(status)
    ipcRenderer.on('ws:status', handler)
    return () => ipcRenderer.removeListener('ws:status', handler)
  },

  // Log entries
  onLogEntry(cb: (entry: LogEntry) => void): () => void {
    const handler = (_: unknown, entry: LogEntry) => cb(entry)
    ipcRenderer.on('log:entry', handler)
    return () => ipcRenderer.removeListener('log:entry', handler)
  },

  // Settings changed
  onSettingsChanged(cb: (settings: Settings) => void): () => void {
    const handler = (_: unknown, settings: Settings) => cb(settings)
    ipcRenderer.on('settings:changed', handler)
    return () => ipcRenderer.removeListener('settings:changed', handler)
  },

  // Transcription result
  onTranscription(cb: (text: string) => void): () => void {
    const handler = (_: unknown, text: string) => cb(text)
    ipcRenderer.on('transcription:result', handler)
    return () => ipcRenderer.removeListener('transcription:result', handler)
  },

  // Window controls
  minimize(): void {
    ipcRenderer.send('window:minimize')
  },
  close(): void {
    ipcRenderer.send('window:close')
  },
}

contextBridge.exposeInMainWorld('voiceApi', voiceApi)
