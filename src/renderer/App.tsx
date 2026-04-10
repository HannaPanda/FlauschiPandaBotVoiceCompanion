import React, { useState, useEffect, useRef, useCallback } from 'react'
import Dashboard from './pages/Dashboard'
import Settings from './pages/Settings'
import Log from './pages/Log'
import { createAudioRecorder, AudioRecorder } from './audio-recorder'

export interface AppSettings {
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

export interface WsStatus {
  connected: boolean
  reconnecting: boolean
}

export interface LogEntry {
  timestamp: string
  level: 'info' | 'warn' | 'error'
  message: string
}

type Tab = 'dashboard' | 'settings' | 'log'

export default function App() {
  const [tab, setTab] = useState<Tab>('dashboard')
  const [settings, setSettingsState] = useState<AppSettings | null>(null)
  const [wsStatus, setWsStatus] = useState<WsStatus>({ connected: false, reconnecting: false })
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [isRecording, setIsRecording] = useState(false)
  const [lastTranscription, setLastTranscription] = useState('')

  const recorderRef = useRef<AudioRecorder | null>(null)
  const settingsRef = useRef<AppSettings | null>(null)

  const addLog = useCallback((entry: LogEntry) => {
    setLogs((prev) => [...prev.slice(-499), entry])
  }, [])

  // Load initial settings
  useEffect(() => {
    window.voiceApi.getSettings().then((s) => {
      setSettingsState(s)
      settingsRef.current = s
    })
  }, [])

  // Wire up global events from main process
  useEffect(() => {
    const cleanups: (() => void)[] = []

    cleanups.push(
      window.voiceApi.onWsStatus((status) => setWsStatus(status))
    )
    cleanups.push(
      window.voiceApi.onLogEntry((entry) => addLog(entry))
    )
    cleanups.push(
      window.voiceApi.onSettingsChanged((s) => {
        setSettingsState(s)
        settingsRef.current = s
      })
    )
    cleanups.push(
      window.voiceApi.onTranscription((text) => setLastTranscription(text))
    )

    return () => cleanups.forEach((fn) => fn())
  }, [addLog])

  // Recorder initialization (lazy, on first PTT/keyword use)
  const getRecorder = useCallback(async (): Promise<AudioRecorder> => {
    if (recorderRef.current) return recorderRef.current
    const s = settingsRef.current
    const recorder = await createAudioRecorder({
      silenceDuration: s?.silenceDuration ?? 1500,
      silenceThreshold: s?.silenceThreshold ?? 0.02,
      recordingTimeout: s?.recordingTimeout ?? 30000,
      micDeviceId: s?.micDeviceId ?? '',
      onRecordingStart: () => setIsRecording(true),
      onRecordingStop: () => setIsRecording(false),
    })
    recorderRef.current = recorder
    return recorder
  }, [])

  // PTT event handlers
  useEffect(() => {
    const cleanups: (() => void)[] = []

    cleanups.push(
      window.voiceApi.onPttStart(async () => {
        try {
          const recorder = await getRecorder()
          recorder.startRecording()
          setIsRecording(true)
          addLog({ timestamp: new Date().toISOString(), level: 'info', message: 'PTT recording started' })
        } catch (err) {
          addLog({ timestamp: new Date().toISOString(), level: 'error', message: `Mic error: ${(err as Error).message}` })
        }
      })
    )

    cleanups.push(
      window.voiceApi.onPttStop(async () => {
        try {
          const recorder = await getRecorder()
          const wav = await recorder.stopRecording()
          setIsRecording(false)
          if (wav.byteLength < 16044) {
            addLog({ timestamp: new Date().toISOString(), level: 'info', message: 'PTT: recording too short, skipped' })
            return
          }
          addLog({ timestamp: new Date().toISOString(), level: 'info', message: 'PTT recording stopped, transcribing…' })
          const transcript = await window.voiceApi.submitAudio(wav)
          if (transcript) {
            setLastTranscription(transcript)
            await window.voiceApi.sendVoiceInput(transcript)
            addLog({ timestamp: new Date().toISOString(), level: 'info', message: `Sent: "${transcript}"` })
          }
        } catch (err) {
          addLog({ timestamp: new Date().toISOString(), level: 'error', message: `PTT error: ${(err as Error).message}` })
          setIsRecording(false)
        }
      })
    )

    return () => cleanups.forEach((fn) => fn())
  }, [getRecorder, addLog])

  // Keyword mode management
  useEffect(() => {
    if (!settings) return

    let active = false

    if (settings.keywordEnabled) {
      getRecorder().then((recorder) => {
        active = true
        recorder.startKeywordMode(async (wav) => {
          addLog({ timestamp: new Date().toISOString(), level: 'info', message: 'Keyword mode: audio captured, transcribing…' })
          try {
            const transcript = await window.voiceApi.submitAudio(wav)
            if (!transcript) return

            const kw = settings.keyword.toLowerCase().trim()
            const lower = transcript.toLowerCase().trim()

            if (lower.startsWith(kw)) {
              const rest = transcript.slice(kw.length).trim()
              setLastTranscription(rest)
              await window.voiceApi.sendVoiceInput(rest)
              addLog({ timestamp: new Date().toISOString(), level: 'info', message: `Keyword matched! Sent: "${rest}"` })
            } else {
              addLog({ timestamp: new Date().toISOString(), level: 'info', message: `Keyword not matched, discarded: "${transcript}"` })
            }
          } catch (err) {
            addLog({ timestamp: new Date().toISOString(), level: 'error', message: `Keyword transcription error: ${(err as Error).message}` })
          }
        })
      }).catch((err) => {
        addLog({ timestamp: new Date().toISOString(), level: 'error', message: `Mic error: ${(err as Error).message}` })
      })
    }

    return () => {
      if (active && recorderRef.current) {
        recorderRef.current.stopKeywordMode()
      }
    }
  }, [settings?.keywordEnabled, settings?.keyword, getRecorder, addLog])

  // Recreate recorder when mic device changes
  useEffect(() => {
    if (recorderRef.current) {
      recorderRef.current.cleanup()
      recorderRef.current = null
    }
  }, [settings?.micDeviceId])

  // Cleanup recorder on unmount
  useEffect(() => {
    return () => {
      recorderRef.current?.cleanup()
    }
  }, [])

  if (!settings) {
    return (
      <div className="flex items-center justify-center h-full bg-app-bg text-gray-400">
        Loading…
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full bg-app-bg">
      {/* Title bar */}
      <div
        className="flex items-center justify-between px-3 py-2 bg-app-surface border-b border-app-border"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-app-accent" />
          <span className="text-sm font-semibold text-gray-200">Voice Companion</span>
        </div>
        <div
          className="flex gap-1"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <button
            onClick={() => window.voiceApi.minimize()}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-gray-700 text-gray-400 hover:text-white text-xs"
            title="Minimize"
          >
            ─
          </button>
          <button
            onClick={() => window.voiceApi.close()}
            className="w-6 h-6 flex items-center justify-center rounded hover:bg-red-600 text-gray-400 hover:text-white text-xs"
            title="Close to tray"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-app-border bg-app-surface">
        {(['dashboard', 'settings', 'log'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm capitalize transition-colors ${
              tab === t
                ? 'text-white border-b-2 border-app-accent'
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {tab === 'dashboard' && (
          <Dashboard
            wsStatus={wsStatus}
            settings={settings}
            isRecording={isRecording}
            lastTranscription={lastTranscription}
            logs={logs.slice(-5)}
          />
        )}
        {tab === 'settings' && (
          <Settings
            settings={settings}
            onSave={async (partial) => {
              await window.voiceApi.setSettings(partial)
              const updated = await window.voiceApi.getSettings()
              setSettingsState(updated)
              settingsRef.current = updated
              addLog({ timestamp: new Date().toISOString(), level: 'info', message: 'Settings saved' })
            }}
          />
        )}
        {tab === 'log' && (
          <Log logs={logs} onClear={() => setLogs([])} />
        )}
      </div>
    </div>
  )
}

// Extend Window interface
declare global {
  interface Window {
    voiceApi: {
      getSettings(): Promise<AppSettings>
      setSettings(settings: Partial<AppSettings>): Promise<void>
      testWebSocket(): Promise<{ success: boolean; error?: string }>
      submitAudio(buffer: ArrayBuffer): Promise<string>
      sendVoiceInput(text: string): Promise<void>
      onPttStart(cb: () => void): () => void
      onPttStop(cb: () => void): () => void
      onPttStop(cb: () => void): () => void
      onWsStatus(cb: (status: WsStatus) => void): () => void
      onLogEntry(cb: (entry: LogEntry) => void): () => void
      onSettingsChanged(cb: (settings: AppSettings) => void): () => void
      onTranscription(cb: (text: string) => void): () => void
      minimize(): void
      close(): void
    }
  }
}
