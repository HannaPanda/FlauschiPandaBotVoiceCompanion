import Store from 'electron-store'

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

const defaults: Settings = {
  wsEnabled: true,
  wsUrl: 'wss://api.flauschipandabot.de/voice',
  wsSecret: '',

  pttEnabled: true,
  pttKey: 'F9',

  keywordEnabled: false,
  keyword: 'hey panda',

  silenceDuration: 1500,
  silenceThreshold: 0.02,
  recordingTimeout: 30000,

  whisperMode: 'whisper.cpp',
  whisperModelPath: '',
  language: 'auto',
  openaiApiKey: '',
  openaiModel: 'whisper-1',
}

export const store = new Store<Settings>({
  name: 'config',
  defaults,
})

export function getSettings(): Settings {
  return store.store as Settings
}

export function setSettings(partial: Partial<Settings>): void {
  for (const [key, value] of Object.entries(partial)) {
    store.set(key as keyof Settings, value as Settings[keyof Settings])
  }
}
