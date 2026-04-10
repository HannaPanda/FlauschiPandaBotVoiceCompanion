import {
  app,
  BrowserWindow,
  ipcMain,
  globalShortcut,
  Tray,
  Menu,
  nativeImage,
  session,
  protocol,
} from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { getSettings, setSettings, Settings } from './settings'
import { wsClient } from './ws-client'
import { transcribeAudio, diagnoseWhisper } from './whisper'

let mainWindow: BrowserWindow | null = null
let splashWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isRecording = false
let currentPttKey = ''
const startupLogs: { timestamp: string; level: string; message: string }[] = []

// uiohook for hold-to-talk (loaded lazily)
let uiohookStarted = false
const modState = { ctrl: false, alt: false, shift: false, meta: false }

// ── Paths ──────────────────────────────────────────────────────────────────────

function getAssetPath(filename: string): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'assets', filename)
  return path.join(__dirname, '../../assets', filename)
}

function getRendererPath(filename: string): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'renderer', filename)
  return path.join(__dirname, '../../src/renderer/public', filename)
}

// ── Logging ────────────────────────────────────────────────────────────────────

function log(level: 'info' | 'warn' | 'error', message: string): void {
  const entry = { timestamp: new Date().toISOString(), level, message }
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
  fn(`[${entry.timestamp}] ${message}`)
  mainWindow?.webContents.send('log:entry', entry)
}

// ── Protocol ───────────────────────────────────────────────────────────────────

function registerAppProtocol(): void {
  protocol.registerFileProtocol('app', (request, callback) => {
    const url = request.url.replace('app://', '')
    const decoded = decodeURIComponent(url)
    const filePath = app.isPackaged
      ? path.join(process.resourcesPath, decoded)
      : path.join(__dirname, '../../', decoded)
    callback({ path: filePath })
  })
}

// ── Splash ─────────────────────────────────────────────────────────────────────

function createSplash(): void {
  splashWindow = new BrowserWindow({
    width: 360,
    height: 360,
    frame: false,
    transparent: false,
    backgroundColor: '#0d0d1a',
    resizable: false,
    center: true,
    show: true,
    skipTaskbar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  })
  splashWindow.loadFile(getRendererPath('splash.html'))
  splashWindow.on('closed', () => { splashWindow = null })
}

function closeSplash(): void {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.close()
    splashWindow = null
  }
}

// ── Main Window ────────────────────────────────────────────────────────────────

function loadAppIcon(): Electron.NativeImage | undefined {
  // Try ICO first (best for Windows taskbar), then PNG
  for (const name of ['icon.ico', 'icon.png']) {
    const p = getAssetPath(name)
    if (fs.existsSync(p)) {
      const img = nativeImage.createFromPath(p)
      if (!img.isEmpty()) {
        log('info', `Loaded app icon from ${p} (${img.getSize().width}x${img.getSize().height})`)
        return img
      }
    }
  }
  log('warn', 'No app icon found')
  return undefined
}

function createWindow(): void {
  const appIcon = loadAppIcon()

  mainWindow = new BrowserWindow({
    width: 450,
    height: 700,
    minWidth: 400,
    minHeight: 600,
    frame: false,
    transparent: false,
    backgroundColor: '#1a1a2e',
    resizable: true,
    show: false,
    ...(appIcon ? { icon: appIcon } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media')
  })

  if (!app.isPackaged) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173')
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(path.join(process.resourcesPath, 'renderer', 'index.html'))
  }

  mainWindow.once('ready-to-show', () => {
    closeSplash()
    mainWindow?.show()
    // Send buffered startup logs once renderer is ready
    for (const line of startupLogs) {
      mainWindow?.webContents.send('log:entry', line)
    }
  })

  mainWindow.on('closed', () => { mainWindow = null })
}

// ── Tray ───────────────────────────────────────────────────────────────────────

function createTray(): void {
  const appIcon = loadAppIcon()
  // Windows tray icons are typically 16x16 but we provide 32x32 for high-DPI
  const icon = appIcon
    ? appIcon.resize({ width: 32, height: 32 })
    : nativeImage.createEmpty()
  tray = new Tray(icon)
  tray.setToolTip('Voice Companion')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Zeigen / Verstecken', click: toggleWindow },
    { type: 'separator' },
    { label: 'Beenden', click: () => app.quit() },
  ]))
  tray.on('click', toggleWindow)
}

function toggleWindow(): void {
  if (!mainWindow) return
  if (mainWindow.isVisible()) { mainWindow.hide() }
  else { mainWindow.show(); mainWindow.focus() }
}

// ── PTT – Toggle mode (globalShortcut) ────────────────────────────────────────

function registerTogglePtt(key: string): void {
  if (!key) return
  try {
    globalShortcut.register(key, () => {
      if (isRecording) {
        log('info', 'PTT: stop (key pressed again while recording)')
        isRecording = false
        mainWindow?.webContents.send('ptt:stop')
      } else {
        log('info', 'PTT: start')
        isRecording = true
        mainWindow?.webContents.send('ptt:start')
      }
    })
    currentPttKey = key
    log('info', `Toggle PTT registered: ${key}`)
  } catch (err) {
    log('error', `Failed to register toggle PTT "${key}": ${(err as Error).message}`)
  }
}

function unregisterTogglePtt(): void {
  if (currentPttKey) {
    try { globalShortcut.unregister(currentPttKey) } catch { /* ignore */ }
    currentPttKey = ''
  }
}

// ── PTT – Hold mode (uiohook-napi) ────────────────────────────────────────────

const CTRL_CODES  = new Set([0x1D, 0xE01D])
const ALT_CODES   = new Set([0x38, 0xE038])
const SHIFT_CODES = new Set([0x2A, 0x36])
const META_CODES  = new Set([0xE05B, 0xE05C])

function startUiohook(): void {
  if (uiohookStarted) return
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { uIOhook } = require('uiohook-napi') as typeof import('uiohook-napi')

    uIOhook.on('keydown', (e) => {
      if (CTRL_CODES.has(e.keycode))  modState.ctrl  = true
      if (ALT_CODES.has(e.keycode))   modState.alt   = true
      if (SHIFT_CODES.has(e.keycode)) modState.shift = true
      if (META_CODES.has(e.keycode))  modState.meta  = true

      const s = getSettings()
      if (!s.pttEnabled || s.pttMode !== 'ptt' || isRecording) return
      if (e.keycode !== s.pttKeyCode) return
      if (modState.ctrl !== s.pttModCtrl)   return
      if (modState.alt  !== s.pttModAlt)    return
      if (modState.shift !== s.pttModShift) return
      if (modState.meta !== s.pttModMeta)   return

      log('info', 'PTT: start (hold)')
      isRecording = true
      mainWindow?.webContents.send('ptt:start')
    })

    uIOhook.on('keyup', (e) => {
      if (CTRL_CODES.has(e.keycode))  modState.ctrl  = false
      if (ALT_CODES.has(e.keycode))   modState.alt   = false
      if (SHIFT_CODES.has(e.keycode)) modState.shift = false
      if (META_CODES.has(e.keycode))  modState.meta  = false

      const s = getSettings()
      if (!s.pttEnabled || s.pttMode !== 'ptt' || !isRecording) return
      if (e.keycode !== s.pttKeyCode) return

      log('info', 'PTT: stop (key released)')
      isRecording = false
      mainWindow?.webContents.send('ptt:stop')
    })

    uIOhook.start()
    uiohookStarted = true
    log('info', 'uiohook started (hold-to-talk ready)')
  } catch (err) {
    log('warn', `uiohook-napi not available: ${(err as Error).message}. Hold-to-talk disabled.`)
  }
}

function stopUiohook(): void {
  if (!uiohookStarted) return
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { uIOhook } = require('uiohook-napi') as typeof import('uiohook-napi')
    uIOhook.stop()
    uiohookStarted = false
  } catch { /* ignore */ }
}

// ── Apply PTT settings ─────────────────────────────────────────────────────────

function applyPttSettings(s: Settings): void {
  unregisterTogglePtt()
  stopUiohook()

  if (!s.pttEnabled) return

  if (s.pttMode === 'toggle') {
    registerTogglePtt(s.pttKey)
  } else {
    // hold mode – needs uiohook
    if (s.pttKeyCode > 0) startUiohook()
    else log('warn', 'PTT hold mode: no key code set. Configure a key in Settings.')
  }
}

// ── IPC ────────────────────────────────────────────────────────────────────────

function setupIpcHandlers(): void {

  ipcMain.handle('settings:get', () => getSettings())

  ipcMain.handle('settings:set', (_e, partial: Partial<Settings>) => {
    const old = getSettings()
    setSettings(partial)
    const updated = getSettings()

    const pttChanged = ['pttEnabled','pttMode','pttKey','pttKeyCode',
      'pttModCtrl','pttModAlt','pttModShift','pttModMeta']
      .some(k => (partial as Record<string,unknown>)[k] !== undefined)

    if (pttChanged) applyPttSettings(updated)

    const wsChanged = ['wsUrl','wsSecret','wsEnabled']
      .some(k => (partial as Record<string,unknown>)[k] !== undefined)

    if (wsChanged) {
      wsClient.disconnect()
      if (updated.wsEnabled) wsClient.connect()
    }

    mainWindow?.webContents.send('settings:changed', updated)
    log('info', 'Settings updated')
  })

  ipcMain.handle('settings:test-ws', async () => {
    const s = getSettings()
    return wsClient.testConnection(s.wsUrl, s.wsSecret)
  })

  ipcMain.handle('audio:submit', async (_e, buffer: ArrayBuffer) => {
    try {
      log('info', 'Transcribing audio…')
      const transcript = await transcribeAudio(buffer)
      log('info', `Transcript: "${transcript}"`)
      isRecording = false
      return transcript
    } catch (err) {
      log('error', `Transcription error: ${(err as Error).message}`)
      isRecording = false
      throw err
    }
  })

  ipcMain.handle('ws:voice-input', (_e, text: string) => {
    wsClient.sendVoiceInput(text)
    mainWindow?.webContents.send('transcription:result', text)
  })

  ipcMain.on('window:minimize', () => mainWindow?.minimize())
  ipcMain.on('window:close',    () => mainWindow?.hide())

  // Microphone enumeration (renderer uses Web API, but we proxy for IPC pattern)
  // Actual enumeration happens in renderer via navigator.mediaDevices.enumerateDevices()
}

// ── App lifecycle ──────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  registerAppProtocol()
  createSplash()
  createWindow()
  createTray()
  setupIpcHandlers()

  wsClient.on('status', (status) => {
    mainWindow?.webContents.send('ws:status', status)
  })
  wsClient.on('log', (entry: { level: 'info' | 'warn' | 'error'; message: string }) => {
    const fn = entry.level === 'error' ? console.error : entry.level === 'warn' ? console.warn : console.log
    fn(`[WS] ${entry.message}`)
    mainWindow?.webContents.send('log:entry', entry)
  })

  // Diagnose whisper on startup — buffer for renderer
  const diag = diagnoseWhisper()
  for (const line of diag.details) {
    const entry = { timestamp: new Date().toISOString(), level: 'info', message: `[whisper-diag] ${line}` }
    console.log(entry.message)
    startupLogs.push(entry)
  }
  if (!diag.ok) {
    const entry = { timestamp: new Date().toISOString(), level: 'error', message: '[whisper-diag] Whisper binary NOT functional — check log above' }
    console.error(entry.message)
    startupLogs.push(entry)
  }

  const s = getSettings()
  if (s.wsEnabled) wsClient.connect()
  applyPttSettings(s)
})

app.on('window-all-closed', () => { /* keep running in tray */ })
app.on('activate', () => { if (!mainWindow) createWindow() })
app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  stopUiohook()
  wsClient.destroy()
})
