import React, { useState, useEffect, useCallback } from 'react'

interface Props {
  value: string
  onChange: (accelerator: string) => void
}

const KEY_MAP: Record<string, string> = {
  ' ': 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Enter: 'Return',
  '+': 'Plus',
  AudioVolumeMute: 'VolumeMute',
  AudioVolumeDown: 'VolumeDown',
  AudioVolumeUp: 'VolumeUp',
  MediaTrackNext: 'MediaNextTrack',
  MediaTrackPrevious: 'MediaPreviousTrack',
  MediaStop: 'MediaStop',
  MediaPlayPause: 'MediaPlayPause',
}

function toAccelerator(e: KeyboardEvent): string | null {
  const { key, ctrlKey, altKey, shiftKey, metaKey } = e

  // Ignore standalone modifier presses
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(key)) return null

  const parts: string[] = []
  if (ctrlKey) parts.push('Control')
  if (altKey) parts.push('Alt')
  if (shiftKey) parts.push('Shift')
  if (metaKey) parts.push('Super')

  const mapped = KEY_MAP[key] ?? (key.length === 1 ? key.toUpperCase() : key)
  parts.push(mapped)

  return parts.join('+')
}

export default function KeyCapture({ value, onChange }: Props) {
  const [capturing, setCapturing] = useState(false)

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()

      if (e.key === 'Escape') {
        setCapturing(false)
        return
      }

      const accel = toAccelerator(e)
      if (accel) {
        onChange(accel)
        setCapturing(false)
      }
    },
    [onChange]
  )

  useEffect(() => {
    if (!capturing) return
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [capturing, handleKeyDown])

  return (
    <button
      type="button"
      onClick={() => setCapturing(true)}
      className={`w-full px-3 py-1.5 rounded text-sm text-left transition-all border ${
        capturing
          ? 'border-app-accent bg-app-accent/20 text-white animate-pulse cursor-default'
          : 'border-gray-600 bg-gray-800 text-gray-200 hover:border-gray-400'
      }`}
    >
      {capturing ? '⌨ Taste drücken… (Esc = Abbrechen)' : value || 'Klicken, dann Taste drücken'}
    </button>
  )
}
