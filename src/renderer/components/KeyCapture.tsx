import React, { useState, useEffect, useCallback } from 'react'

export interface KeyInfo {
  label: string       // display / Electron accelerator
  keyCode: number     // uiohook scan code for hold-to-talk
  modCtrl: boolean
  modAlt: boolean
  modShift: boolean
  modMeta: boolean
}

interface Props {
  label: string
  keyCode: number
  modCtrl: boolean
  modAlt: boolean
  modShift: boolean
  modMeta: boolean
  onChange: (info: KeyInfo) => void
}

// browser KeyboardEvent.code → uiohook-napi scan code
const CODE_TO_UIOHOOK: Record<string, number> = {
  Escape:0x01,
  Digit1:0x02,Digit2:0x03,Digit3:0x04,Digit4:0x05,Digit5:0x06,
  Digit6:0x07,Digit7:0x08,Digit8:0x09,Digit9:0x0A,Digit0:0x0B,
  Minus:0x0C,Equal:0x0D,Backspace:0x0E,Tab:0x0F,
  KeyQ:0x10,KeyW:0x11,KeyE:0x12,KeyR:0x13,KeyT:0x14,
  KeyY:0x15,KeyU:0x16,KeyI:0x17,KeyO:0x18,KeyP:0x19,
  BracketLeft:0x1A,BracketRight:0x1B,Enter:0x1C,
  ControlLeft:0x1D,ControlRight:0xE01D,
  KeyA:0x1E,KeyS:0x1F,KeyD:0x20,KeyF:0x21,KeyG:0x22,
  KeyH:0x23,KeyJ:0x24,KeyK:0x25,KeyL:0x26,
  Semicolon:0x27,Quote:0x28,Backquote:0x29,
  ShiftLeft:0x2A,Backslash:0x2B,IntlBackslash:0x56,
  KeyZ:0x2C,KeyX:0x2D,KeyC:0x2E,KeyV:0x2F,KeyB:0x30,
  KeyN:0x31,KeyM:0x32,
  Comma:0x33,Period:0x34,Slash:0x35,ShiftRight:0x36,
  NumpadMultiply:0x37,AltLeft:0x38,AltRight:0xE038,Space:0x39,CapsLock:0x3A,
  F1:0x3B,F2:0x3C,F3:0x3D,F4:0x3E,F5:0x3F,
  F6:0x40,F7:0x41,F8:0x42,F9:0x43,F10:0x44,
  NumLock:0x45,ScrollLock:0x46,
  Numpad7:0x47,Numpad8:0x48,Numpad9:0x49,NumpadSubtract:0x4A,
  Numpad4:0x4B,Numpad5:0x4C,Numpad6:0x4D,NumpadAdd:0x4E,
  Numpad1:0x4F,Numpad2:0x50,Numpad3:0x51,Numpad0:0x52,NumpadDecimal:0x53,
  F11:0x57,F12:0x58,
  F13:0x64,F14:0x65,F15:0x66,F16:0x67,F17:0x68,F18:0x69,
  F19:0x6A,F20:0x6B,F21:0x6C,F22:0x6D,F23:0x6E,F24:0x76,
  NumpadEnter:0xE01C,NumpadDivide:0xE035,
  PrintScreen:0xE037,Insert:0xE052,Delete:0xE053,
  Home:0xE047,End:0xE04F,PageUp:0xE049,PageDown:0xE051,
  ArrowLeft:0xE04B,ArrowUp:0xE048,ArrowRight:0xE04D,ArrowDown:0xE050,
  MetaLeft:0xE05B,MetaRight:0xE05C,ContextMenu:0xE05D,
}

const KEY_DISPLAY: Record<string, string> = {
  ArrowUp:'↑',ArrowDown:'↓',ArrowLeft:'←',ArrowRight:'→',
  Space:'Space',Enter:'Enter',Backspace:'Backspace',Delete:'Delete',
  Escape:'Esc',Tab:'Tab',CapsLock:'CapsLock',
  ShiftLeft:'Shift',ShiftRight:'Shift',ControlLeft:'Ctrl',ControlRight:'Ctrl',
  AltLeft:'Alt',AltRight:'Alt',MetaLeft:'Win',MetaRight:'Win',
}

function buildLabel(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey && e.code !== 'ControlLeft' && e.code !== 'ControlRight') parts.push('Control')
  if (e.altKey  && e.code !== 'AltLeft'     && e.code !== 'AltRight')     parts.push('Alt')
  if (e.shiftKey&& e.code !== 'ShiftLeft'   && e.code !== 'ShiftRight')   parts.push('Shift')
  if (e.metaKey && e.code !== 'MetaLeft'    && e.code !== 'MetaRight')    parts.push('Super')
  const disp = KEY_DISPLAY[e.code] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key)
  parts.push(disp)
  return parts.join('+')
}

export default function KeyCapture({ label, keyCode, modCtrl, modAlt, modShift, modMeta, onChange }: Props) {
  const [capturing, setCapturing] = useState(false)

  const displayLabel = label || (keyCode ? `[code:0x${keyCode.toString(16)}]` : '')

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    e.preventDefault()
    e.stopPropagation()

    if (e.key === 'Escape') { setCapturing(false); return }

    // Ignore standalone modifiers
    if (['Control','Alt','Shift','Meta'].includes(e.key)) return

    const code = CODE_TO_UIOHOOK[e.code] ?? 0
    onChange({
      label:    buildLabel(e),
      keyCode:  code,
      modCtrl:  e.ctrlKey,
      modAlt:   e.altKey,
      modShift: e.shiftKey,
      modMeta:  e.metaKey,
    })
    setCapturing(false)
  }, [onChange])

  useEffect(() => {
    if (!capturing) return
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [capturing, handleKeyDown])

  const modStr = [modCtrl&&'Ctrl',modAlt&&'Alt',modShift&&'Shift',modMeta&&'Win']
    .filter(Boolean).join('+')
  const fullLabel = modStr ? `${modStr}+${label}` : label

  return (
    <button
      type="button"
      onClick={() => setCapturing(true)}
      className={`w-full px-3 py-2 rounded text-sm text-left font-mono transition-all border ${
        capturing
          ? 'border-app-accent bg-app-accent/20 text-white animate-pulse cursor-default'
          : 'border-gray-600 bg-gray-800 text-gray-200 hover:border-gray-400'
      }`}
    >
      {capturing
        ? '⌨ Taste drücken… (Esc = Abbrechen)'
        : fullLabel || 'Klicken, dann Taste drücken'}
    </button>
  )
}
