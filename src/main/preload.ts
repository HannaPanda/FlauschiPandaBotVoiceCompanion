import { contextBridge, ipcRenderer } from 'electron'

export interface Settings {
  wsEnabled: boolean
  wsUrl: string
  wsSecret: string
  pttMode: 'ptt' | 'toggle'
  pttEnabled: boolean
  pttKey: string
  pttKeyCode: number
  pttModCtrl: boolean
  pttModAlt: boolean
  pttModShift: boolean
  pttModMeta: boolean
  keywordEnabled: boolean
  keyword: string
  silenceDuration: number
  silenceThreshold: number
  recordingTimeout: number
  micDeviceId: string
  whisperMode: 'whisper.cpp' | 'openai'
  whisperModelPath: string
  language: string
  openaiApiKey: string
  openaiModel: string
}

export interface WsStatus { connected: boolean; reconnecting: boolean }
export interface LogEntry  { timestamp: string; level: 'info'|'warn'|'error'; message: string }

const voiceApi = {
  getSettings():                    Promise<Settings>               { return ipcRenderer.invoke('settings:get') },
  setSettings(s: Partial<Settings>):Promise<void>                   { return ipcRenderer.invoke('settings:set', s) },
  testWebSocket():                  Promise<{success:boolean;error?:string}> { return ipcRenderer.invoke('settings:test-ws') },
  submitAudio(buf: ArrayBuffer):    Promise<string>                 { return ipcRenderer.invoke('audio:submit', buf) },
  sendVoiceInput(text: string):     Promise<void>                   { return ipcRenderer.invoke('ws:voice-input', text) },

  onPttStart(cb: () => void):              () => void { const h = () => cb(); ipcRenderer.on('ptt:start', h); return () => ipcRenderer.removeListener('ptt:start', h) },
  onPttStop(cb: () => void):               () => void { const h = () => cb(); ipcRenderer.on('ptt:stop',  h); return () => ipcRenderer.removeListener('ptt:stop',  h) },
  onWsStatus(cb: (s: WsStatus) => void):   () => void { const h = (_: unknown, s: WsStatus)  => cb(s); ipcRenderer.on('ws:status',         h); return () => ipcRenderer.removeListener('ws:status',         h) },
  onLogEntry(cb: (e: LogEntry) => void):   () => void { const h = (_: unknown, e: LogEntry)  => cb(e); ipcRenderer.on('log:entry',          h); return () => ipcRenderer.removeListener('log:entry',          h) },
  onSettingsChanged(cb: (s: Settings) => void): () => void { const h = (_: unknown, s: Settings) => cb(s); ipcRenderer.on('settings:changed', h); return () => ipcRenderer.removeListener('settings:changed', h) },
  onTranscription(cb: (t: string) => void):() => void { const h = (_: unknown, t: string)   => cb(t); ipcRenderer.on('transcription:result',h); return () => ipcRenderer.removeListener('transcription:result',h) },

  minimize(): void { ipcRenderer.send('window:minimize') },
  close():    void { ipcRenderer.send('window:close') },
}

contextBridge.exposeInMainWorld('voiceApi', voiceApi)
