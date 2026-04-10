import React, { useState, useEffect, useRef, useCallback } from 'react'
import { AppSettings } from '../App'
import KeyCapture, { KeyInfo } from '../components/KeyCapture'

interface Props {
  settings: AppSettings
  onSave: (partial: Partial<AppSettings>) => Promise<void>
}

// ── UI primitives ──────────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-app-surface rounded-lg border border-app-border p-4">
      <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-3">{title}</h3>
      <div className="space-y-3">{children}</div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs text-gray-400">{label}</label>
      {children}
    </div>
  )
}

const inputClass =
  'bg-gray-800 border border-gray-600 rounded px-2 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-app-accent w-full'

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!value)}
      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${value ? 'bg-app-accent' : 'bg-gray-600'}`}
    >
      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${value ? 'translate-x-5' : 'translate-x-0.5'}`} />
    </button>
  )
}

// ── Mic Test ───────────────────────────────────────────────────────────────────

function MicTest({ micDeviceId }: { micDeviceId: string }) {
  const [state, setState] = useState<'idle'|'testing'|'done'|'error'>('idle')
  const [rms, setRms] = useState(0)
  const [playbackUrl, setPlaybackUrl] = useState<string>('')
  const [errorMsg, setErrorMsg] = useState('')
  const intervalRef = useRef<ReturnType<typeof setInterval>|null>(null)
  const chunksRef = useRef<Blob[]>([])
  const recorderRef = useRef<MediaRecorder|null>(null)
  const analyserRef = useRef<AnalyserNode|null>(null)
  const streamRef = useRef<MediaStream|null>(null)
  const ctxRef = useRef<AudioContext|null>(null)

  const stopAll = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current)
    recorderRef.current?.stop()
    streamRef.current?.getTracks().forEach(t => t.stop())
    ctxRef.current?.close()
    recorderRef.current = null
    analyserRef.current = null
    streamRef.current = null
    ctxRef.current = null
  }, [])

  const startTest = useCallback(async () => {
    setState('testing')
    setRms(0)
    setPlaybackUrl('')
    chunksRef.current = []
    try {
      const constraints: MediaTrackConstraints = micDeviceId
        ? { deviceId: { exact: micDeviceId } }
        : {}
      const stream = await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false })
      streamRef.current = stream

      const ctx = new AudioContext()
      ctxRef.current = ctx
      const src = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      src.connect(analyser)
      analyserRef.current = analyser

      const recorder = new MediaRecorder(stream)
      recorderRef.current = recorder
      recorder.ondataavailable = e => chunksRef.current.push(e.data)
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
        setPlaybackUrl(URL.createObjectURL(blob))
        setState('done')
        stopAll()
      }
      recorder.start(100)

      const data = new Float32Array(analyser.fftSize)
      intervalRef.current = setInterval(() => {
        analyser.getFloatTimeDomainData(data)
        let sum = 0
        for (let i = 0; i < data.length; i++) sum += data[i] * data[i]
        setRms(Math.sqrt(sum / data.length))
      }, 50)

      // Auto-stop after 4s
      setTimeout(() => {
        if (recorderRef.current?.state === 'recording') recorderRef.current.stop()
      }, 4000)
    } catch (e) {
      setErrorMsg((e as Error).message)
      setState('error')
      stopAll()
    }
  }, [micDeviceId, stopAll])

  useEffect(() => () => stopAll(), [stopAll])

  const barWidth = Math.min(100, rms * 1200)

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        {state !== 'testing' && (
          <button
            onClick={startTest}
            className="px-3 py-1.5 text-xs rounded bg-indigo-700 hover:bg-indigo-600 text-white"
          >
            🎙 Mic-Test (4s)
          </button>
        )}
        {state === 'testing' && (
          <button
            onClick={() => recorderRef.current?.stop()}
            className="px-3 py-1.5 text-xs rounded bg-red-700 hover:bg-red-600 text-white"
          >
            ⏹ Stopp
          </button>
        )}
        {state === 'done' && playbackUrl && (
          <audio src={playbackUrl} controls className="h-7 flex-1" />
        )}
        {state === 'error' && <span className="text-xs text-red-400">{errorMsg}</span>}
      </div>
      {state === 'testing' && (
        <div className="h-2 bg-gray-700 rounded overflow-hidden">
          <div
            className="h-full bg-green-500 transition-all duration-75 rounded"
            style={{ width: `${barWidth}%` }}
          />
        </div>
      )}
    </div>
  )
}

// ── Main Settings component ────────────────────────────────────────────────────

export default function Settings({ settings, onSave }: Props) {
  const [form, setForm] = useState<AppSettings>(settings)
  const [saving, setSaving] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string } | null>(null)
  const [testing, setTesting] = useState(false)
  const [mics, setMics] = useState<{ deviceId: string; label: string }[]>([])

  useEffect(() => { setForm(settings) }, [settings])

  // Enumerate microphones
  useEffect(() => {
    navigator.mediaDevices.enumerateDevices().then(devices => {
      const inputs = devices
        .filter(d => d.kind === 'audioinput')
        .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Mikrofon ${i + 1}` }))
      setMics(inputs)
    }).catch(() => {})
  }, [])

  const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) =>
    setForm(prev => ({ ...prev, [key]: value }))

  const handleSave = async () => {
    setSaving(true)
    try { await onSave(form) } finally { setSaving(false) }
  }

  const handleTestWs = async () => {
    setTesting(true); setTestResult(null)
    await onSave({ wsUrl: form.wsUrl, wsSecret: form.wsSecret })
    const result = await window.voiceApi.testWebSocket()
    setTestResult(result); setTesting(false)
  }

  const handleKeyCapture = (info: KeyInfo) => {
    setForm(prev => ({
      ...prev,
      pttKey: info.label,
      pttKeyCode: info.keyCode,
      pttModCtrl: info.modCtrl,
      pttModAlt: info.modAlt,
      pttModShift: info.modShift,
      pttModMeta: info.modMeta,
    }))
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto p-4 space-y-4">

        {/* WebSocket */}
        <Section title="WebSocket">
          <Field label="Aktiv">
            <Toggle value={form.wsEnabled} onChange={v => set('wsEnabled', v)} />
          </Field>
          <Field label="URL">
            <input className={inputClass} value={form.wsUrl}
              onChange={e => set('wsUrl', e.target.value)} placeholder="wss://…" />
          </Field>
          <Field label="Secret Key">
            <input className={inputClass} type="password" value={form.wsSecret}
              onChange={e => set('wsSecret', e.target.value)} placeholder="Secret…" />
          </Field>
          <div className="flex items-center gap-2">
            <button onClick={handleTestWs} disabled={testing}
              className="px-3 py-1.5 text-xs rounded bg-blue-700 hover:bg-blue-600 disabled:opacity-50 text-white">
              {testing ? 'Teste…' : 'Verbindung testen'}
            </button>
            {testResult && (
              <span className={`text-xs ${testResult.success ? 'text-green-400' : 'text-red-400'}`}>
                {testResult.success ? 'Verbunden!' : `Fehler: ${testResult.error}`}
              </span>
            )}
          </div>
        </Section>

        {/* Push-To-Talk */}
        <Section title="Push-To-Talk">
          <Field label="Aktiv">
            <Toggle value={form.pttEnabled} onChange={v => set('pttEnabled', v)} />
          </Field>
          <Field label="Modus">
            <div className="flex rounded overflow-hidden border border-gray-600 text-xs">
              <button
                onClick={() => set('pttMode', 'ptt')}
                className={`flex-1 py-1.5 transition-colors ${form.pttMode === 'ptt' ? 'bg-app-accent text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`}
              >
                🎙 Push-to-Talk <span className="opacity-60">(halten)</span>
              </button>
              <button
                onClick={() => set('pttMode', 'toggle')}
                className={`flex-1 py-1.5 transition-colors ${form.pttMode === 'toggle' ? 'bg-app-accent text-white' : 'bg-gray-800 text-gray-400 hover:text-white'}`}
              >
                🔁 Toggle-to-Talk <span className="opacity-60">(ein/aus)</span>
              </button>
            </div>
            {form.pttMode === 'ptt' && (
              <p className="text-xs text-yellow-400 mt-1">
                ⚠ PTT (halten) benötigt uiohook-napi. Taste muss als Key-Code hinterlegt sein.
              </p>
            )}
          </Field>
          <Field label="Taste / Kombination">
            <KeyCapture
              label={form.pttKey}
              keyCode={form.pttKeyCode}
              modCtrl={form.pttModCtrl}
              modAlt={form.pttModAlt}
              modShift={form.pttModShift}
              modMeta={form.pttModMeta}
              onChange={handleKeyCapture}
            />
            {form.pttKeyCode === 0 && form.pttMode === 'ptt' && (
              <p className="text-xs text-red-400">Taste noch nicht gesetzt – bitte oben klicken und Taste drücken.</p>
            )}
          </Field>
        </Section>

        {/* Keyword */}
        <Section title="Aktivierungswort">
          <Field label="Aktiv">
            <Toggle value={form.keywordEnabled} onChange={v => set('keywordEnabled', v)} />
          </Field>
          <Field label="Keyword / Phrase">
            <input className={inputClass} value={form.keyword}
              onChange={e => set('keyword', e.target.value)} placeholder="hey panda" />
          </Field>
        </Section>

        {/* Microphone */}
        <Section title="Mikrofon">
          <Field label="Gerät">
            <select className={inputClass} value={form.micDeviceId}
              onChange={e => set('micDeviceId', e.target.value)}>
              <option value="">System-Standard</option>
              {mics.map(m => (
                <option key={m.deviceId} value={m.deviceId}>{m.label}</option>
              ))}
            </select>
          </Field>
          <MicTest micDeviceId={form.micDeviceId} />
        </Section>

        {/* Recording */}
        <Section title="Aufnahme">
          <Field label={`Stille-Dauer: ${form.silenceDuration} ms`}>
            <input className={inputClass} type="number" min={300} max={5000} step={100}
              value={form.silenceDuration} onChange={e => set('silenceDuration', Number(e.target.value))} />
          </Field>
          <Field label={`Stille-Schwelle: ${form.silenceThreshold.toFixed(3)} (RMS)`}>
            <input type="range" min={0} max={0.1} step={0.001}
              value={form.silenceThreshold}
              onChange={e => set('silenceThreshold', Number(e.target.value))}
              className="w-full accent-app-accent" />
          </Field>
          <Field label={`Max. Aufnahmedauer: ${form.recordingTimeout} ms`}>
            <input className={inputClass} type="number" min={5000} max={120000} step={1000}
              value={form.recordingTimeout} onChange={e => set('recordingTimeout', Number(e.target.value))} />
          </Field>
        </Section>

        {/* Whisper */}
        <Section title="Whisper / Transkription">
          <Field label="Modus">
            <select className={inputClass} value={form.whisperMode}
              onChange={e => set('whisperMode', e.target.value as AppSettings['whisperMode'])}>
              <option value="whisper.cpp">whisper.cpp (lokal)</option>
              <option value="openai">OpenAI API</option>
            </select>
          </Field>
          {form.whisperMode === 'whisper.cpp' && (
            <Field label="Modell-Pfad (leer = mitgeliefertes Modell)">
              <input className={inputClass} value={form.whisperModelPath}
                onChange={e => set('whisperModelPath', e.target.value)}
                placeholder="z.B. C:\models\ggml-base.en.bin" />
            </Field>
          )}
          <Field label="Sprache">
            <select className={inputClass} value={form.language}
              onChange={e => set('language', e.target.value)}>
              <option value="auto">Automatisch erkennen</option>
              <option value="de">Deutsch</option>
              <option value="en">Englisch</option>
              <option value="fr">Französisch</option>
              <option value="es">Spanisch</option>
              <option value="it">Italienisch</option>
              <option value="ja">Japanisch</option>
              <option value="zh">Chinesisch</option>
            </select>
          </Field>
          {form.whisperMode === 'openai' && (
            <>
              <Field label="OpenAI API Key">
                <input className={inputClass} type="password" value={form.openaiApiKey}
                  onChange={e => set('openaiApiKey', e.target.value)} placeholder="sk-…" />
              </Field>
              <Field label="Modell">
                <input className={inputClass} value={form.openaiModel}
                  onChange={e => set('openaiModel', e.target.value)} placeholder="whisper-1" />
              </Field>
            </>
          )}
        </Section>
      </div>

      <div className="p-4 border-t border-app-border bg-app-surface">
        <button onClick={handleSave} disabled={saving}
          className="w-full py-2 rounded bg-app-accent hover:bg-red-500 disabled:opacity-50 text-white text-sm font-medium transition-colors">
          {saving ? 'Speichern…' : 'Einstellungen speichern'}
        </button>
      </div>
    </div>
  )
}
