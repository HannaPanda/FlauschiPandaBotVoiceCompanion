import Store from 'electron-store'

export interface Settings {
  wsEnabled: boolean
  wsUrl: string
  wsSecret: string

  /** 'ptt' = hold key to talk, 'toggle' = press to start/stop */
  pttMode: 'ptt' | 'toggle'
  pttEnabled: boolean
  pttKey: string          // Electron accelerator (for toggle) / display label (for ptt)
  pttKeyCode: number      // uiohook scan code (for ptt hold mode), 0 = unset
  pttModCtrl: boolean
  pttModAlt: boolean
  pttModShift: boolean
  pttModMeta: boolean

  keywordEnabled: boolean
  keyword: string

  silenceDuration: number
  silenceThreshold: number
  recordingTimeout: number

  micDeviceId: string     // '' = system default

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

  pttMode: 'toggle',
  pttEnabled: true,
  pttKey: 'F9',
  pttKeyCode: 0,
  pttModCtrl: false,
  pttModAlt: false,
  pttModShift: false,
  pttModMeta: false,

  keywordEnabled: false,
  keyword: 'hey panda',

  silenceDuration: 1500,
  silenceThreshold: 0.02,
  recordingTimeout: 30000,

  micDeviceId: '',

  whisperMode: 'whisper.cpp',
  whisperModelPath: '',
  language: 'de',
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
