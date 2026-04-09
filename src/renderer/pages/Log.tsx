import React, { useEffect, useRef } from 'react'
import { LogEntry } from '../App'

interface Props {
  logs: LogEntry[]
  onClear: () => void
}

const levelColors: Record<string, string> = {
  info: 'text-green-400',
  warn: 'text-yellow-400',
  error: 'text-red-400',
}

const levelBadge: Record<string, string> = {
  info: 'bg-green-900 text-green-300',
  warn: 'bg-yellow-900 text-yellow-300',
  error: 'bg-red-900 text-red-300',
}

export default function Log({ logs, onClear }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [logs.length])

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-app-border bg-app-surface">
        <span className="text-xs text-gray-500">{logs.length} entries</span>
        <button
          onClick={onClear}
          className="text-xs px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-300"
        >
          Clear
        </button>
      </div>

      {/* Log list */}
      <div className="flex-1 overflow-y-auto p-3 space-y-1 selectable font-mono">
        {logs.length === 0 ? (
          <p className="text-gray-600 text-sm italic text-center mt-8">No log entries yet…</p>
        ) : (
          logs.map((entry, i) => (
            <div key={i} className="flex gap-2 text-xs leading-5 hover:bg-gray-800 rounded px-1">
              <span className="text-gray-600 shrink-0 tabular-nums">
                {new Date(entry.timestamp).toLocaleTimeString('en-US', {
                  hour12: false,
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                })}
              </span>
              <span
                className={`shrink-0 px-1 rounded text-[10px] font-semibold uppercase ${levelBadge[entry.level] ?? 'bg-gray-700 text-gray-300'}`}
              >
                {entry.level}
              </span>
              <span className={`${levelColors[entry.level] ?? 'text-gray-400'} break-all`}>
                {entry.message}
              </span>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
