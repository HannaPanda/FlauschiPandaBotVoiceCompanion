import React, { useState, useEffect } from 'react'
import { AppSettings } from '../App'
import KeyCapture from '../components/KeyCapture'

interface Props {
  settings: AppSettings
  onSave: (partial: Partial<AppSettings>) => Promise<void>
}

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

const toggleClass = (on: boolean) =>
  `relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${on ? 'bg-app-accent' : 'bg-gray-600'}`

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" className={toggleClass(value)} onClick={() => onChange(!value)}>
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
          value ? 'translate-x-5' : 'translate-x-0.5'
        }`}
      />
    </button>
  )
}

export default function Settings({ settings, onSave }: Props) {
  const [form, setForm] = useState<AppSettings>(settings)
  const [saving, setSaving] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string } | null>(null)
  const [testing, setTesting] = useState(false)

  useEffect(() => {
    setForm(settings)
  }, [settings])

  const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      await onSave(form)
    } finally {
      setSaving(false)
    }
  }

  const handleTestWs = async () => {
    setTesting(true)
    setTestResult(null)
    // Save current WS fields first so test uses them
    await onSave({ wsUrl: form.wsUrl, wsSecret: form.wsSecret })
    const result = await window.voiceApi.testWebSocket()
    setTestResult(result)
    setTesting(false)
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* WebSocket */}
        <Section title="WebSocket">
          <Field label="Enable">
            <Toggle value={form.wsEnabled} onChange={(v) => set('wsEnabled', v)} />
          </Field>
          <Field label="URL">
            <input
              className={inputClass}
              value={form.wsUrl}
              onChange={(e) => set('wsUrl', e.target.value)}
              placeholder="wss://..."
            />
          </Field>
          <Field label="Secret Key">
            <input
              className={inputClass}
              type="password"
              value={form.wsSecret}
              onChange={(e) => set('wsSecret', e.target.value)}
              placeholder="Secret…"
            />
          </Field>
          <div className="flex items-center gap-2">
            <button
              onClick={handleTestWs}
              disabled={testing}
              className="px-3 py-1.5 text-xs rounded bg-blue-700 hover:bg-blue-600 disabled:opacity-50 text-white"
            >
              {testing ? 'Testing…' : 'Test Connection'}
            </button>
            {testResult && (
              <span className={`text-xs ${testResult.success ? 'text-green-400' : 'text-red-400'}`}>
                {testResult.success ? 'Connected!' : `Failed: ${testResult.error}`}
              </span>
            )}
          </div>
        </Section>

        {/* Push-To-Talk */}
        <Section title="Push-To-Talk">
          <Field label="Enable">
            <Toggle value={form.pttEnabled} onChange={(v) => set('pttEnabled', v)} />
          </Field>
          <Field label="Taste / Kombination">
            <KeyCapture value={form.pttKey} onChange={(v) => set('pttKey', v)} />
          </Field>
        </Section>

        {/* Keyword Detection */}
        <Section title="Keyword Detection">
          <Field label="Enable">
            <Toggle value={form.keywordEnabled} onChange={(v) => set('keywordEnabled', v)} />
          </Field>
          <Field label="Keyword / Phrase">
            <input
              className={inputClass}
              value={form.keyword}
              onChange={(e) => set('keyword', e.target.value)}
              placeholder="hey panda"
            />
          </Field>
        </Section>

        {/* Recording */}
        <Section title="Recording">
          <Field label={`Silence Duration: ${form.silenceDuration} ms`}>
            <input
              className={inputClass}
              type="number"
              min={300}
              max={5000}
              step={100}
              value={form.silenceDuration}
              onChange={(e) => set('silenceDuration', Number(e.target.value))}
            />
          </Field>
          <Field label={`Silence Threshold: ${form.silenceThreshold.toFixed(3)} (RMS)`}>
            <input
              type="range"
              min={0}
              max={0.1}
              step={0.001}
              value={form.silenceThreshold}
              onChange={(e) => set('silenceThreshold', Number(e.target.value))}
              className="w-full accent-app-accent"
            />
          </Field>
          <Field label={`Max Recording Duration: ${form.recordingTimeout} ms`}>
            <input
              className={inputClass}
              type="number"
              min={5000}
              max={120000}
              step={1000}
              value={form.recordingTimeout}
              onChange={(e) => set('recordingTimeout', Number(e.target.value))}
            />
          </Field>
        </Section>

        {/* Whisper */}
        <Section title="Whisper / Transcription">
          <Field label="Mode">
            <select
              className={inputClass}
              value={form.whisperMode}
              onChange={(e) => set('whisperMode', e.target.value as AppSettings['whisperMode'])}
            >
              <option value="whisper.cpp">whisper.cpp (local)</option>
              <option value="openai">OpenAI API</option>
            </select>
          </Field>
          {form.whisperMode === 'whisper.cpp' && (
            <Field label="Model Path (leave blank for bundled default)">
              <input
                className={inputClass}
                value={form.whisperModelPath}
                onChange={(e) => set('whisperModelPath', e.target.value)}
                placeholder="e.g. C:\models\ggml-base.en.bin"
              />
            </Field>
          )}
          <Field label="Language">
            <select
              className={inputClass}
              value={form.language}
              onChange={(e) => set('language', e.target.value)}
            >
              <option value="auto">Auto-detect</option>
              <option value="en">English</option>
              <option value="de">German</option>
              <option value="fr">French</option>
              <option value="es">Spanish</option>
              <option value="it">Italian</option>
              <option value="ja">Japanese</option>
              <option value="zh">Chinese</option>
            </select>
          </Field>
          {form.whisperMode === 'openai' && (
            <>
              <Field label="OpenAI API Key">
                <input
                  className={inputClass}
                  type="password"
                  value={form.openaiApiKey}
                  onChange={(e) => set('openaiApiKey', e.target.value)}
                  placeholder="sk-…"
                />
              </Field>
              <Field label="OpenAI Model">
                <input
                  className={inputClass}
                  value={form.openaiModel}
                  onChange={(e) => set('openaiModel', e.target.value)}
                  placeholder="whisper-1"
                />
              </Field>
            </>
          )}
        </Section>
      </div>

      {/* Save button */}
      <div className="p-4 border-t border-app-border bg-app-surface">
        <button
          onClick={handleSave}
          disabled={saving}
          className="w-full py-2 rounded bg-app-accent hover:bg-red-500 disabled:opacity-50 text-white text-sm font-medium transition-colors"
        >
          {saving ? 'Saving…' : 'Save Settings'}
        </button>
      </div>
    </div>
  )
}
