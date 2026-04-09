import React from 'react'
import { AppSettings, WsStatus, LogEntry } from '../App'

interface Props {
  wsStatus: WsStatus
  settings: AppSettings
  isRecording: boolean
  lastTranscription: string
  logs: LogEntry[]
}

function WsIndicator({ status }: { status: WsStatus }) {
  let color = 'bg-red-500'
  let label = 'Disconnected'
  if (status.connected) {
    color = 'bg-green-500'
    label = 'Connected'
  } else if (status.reconnecting) {
    color = 'bg-orange-400'
    label = 'Reconnecting…'
  }

  return (
    <div className="flex items-center gap-2">
      <div className={`w-2.5 h-2.5 rounded-full ${color} ${status.reconnecting ? 'animate-pulse' : ''}`} />
      <span className="text-sm text-gray-300">{label}</span>
    </div>
  )
}

function ModeIndicator({ settings }: { settings: AppSettings }) {
  const modes: string[] = []
  if (settings.pttEnabled) modes.push(`PTT (${settings.pttKey})`)
  if (settings.keywordEnabled) modes.push(`Keyword ("${settings.keyword}")`)

  const label = modes.length === 0 ? 'Off' : modes.join(' + ')
  const color = modes.length === 0 ? 'text-gray-500' : 'text-blue-400'

  return (
    <div className="flex items-center gap-2">
      <span className="text-gray-500 text-sm">Mode:</span>
      <span className={`text-sm font-medium ${color}`}>{label}</span>
    </div>
  )
}

function RecordingIndicator({ isRecording }: { isRecording: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center py-6">
      <div
        className={`w-20 h-20 rounded-full flex items-center justify-center transition-all duration-300 ${
          isRecording
            ? 'bg-red-600 shadow-[0_0_30px_rgba(220,38,38,0.7)] animate-pulse'
            : 'bg-gray-800 border-2 border-gray-600'
        }`}
      >
        {/* Microphone icon */}
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className={`w-8 h-8 ${isRecording ? 'text-white' : 'text-gray-500'}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z"
          />
        </svg>
      </div>
      <span className={`mt-3 text-sm font-medium ${isRecording ? 'text-red-400' : 'text-gray-500'}`}>
        {isRecording ? 'Recording…' : 'Idle'}
      </span>
    </div>
  )
}

const levelColors: Record<string, string> = {
  info: 'text-green-400',
  warn: 'text-yellow-400',
  error: 'text-red-400',
}

export default function Dashboard({ wsStatus, settings, isRecording, lastTranscription, logs }: Props) {
  return (
    <div className="flex flex-col gap-4 p-4 h-full overflow-y-auto">
      {/* Status row */}
      <div className="bg-app-surface rounded-lg p-3 border border-app-border flex items-center justify-between">
        <WsIndicator status={wsStatus} />
        <ModeIndicator settings={settings} />
      </div>

      {/* Recording indicator */}
      <div className="bg-app-surface rounded-lg border border-app-border">
        <RecordingIndicator isRecording={isRecording} />
      </div>

      {/* Last transcription */}
      <div className="bg-app-surface rounded-lg p-3 border border-app-border">
        <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">Last Transcription</div>
        {lastTranscription ? (
          <p className="text-gray-200 text-sm selectable leading-relaxed">{lastTranscription}</p>
        ) : (
          <p className="text-gray-600 text-sm italic">No transcription yet…</p>
        )}
      </div>

      {/* Recent activity */}
      <div className="bg-app-surface rounded-lg p-3 border border-app-border flex-1 min-h-0">
        <div className="text-xs text-gray-500 uppercase tracking-wide mb-2">Recent Activity</div>
        {logs.length === 0 ? (
          <p className="text-gray-600 text-sm italic">No activity yet…</p>
        ) : (
          <ul className="space-y-1">
            {[...logs].reverse().map((entry, i) => (
              <li key={i} className="flex gap-2 text-xs">
                <span className="text-gray-600 shrink-0">
                  {new Date(entry.timestamp).toLocaleTimeString()}
                </span>
                <span className={`${levelColors[entry.level] ?? 'text-gray-400'} break-all`}>
                  {entry.message}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
