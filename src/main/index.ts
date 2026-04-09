import {
  app,
  BrowserWindow,
  ipcMain,
  globalShortcut,
  Tray,
  Menu,
  nativeImage,
  session,
} from 'electron'
import * as path from 'path'
import { getSettings, setSettings, Settings } from './settings'
import { wsClient } from './ws-client'
import { transcribeAudio } from './whisper'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isRecording = false
let currentPttKey = ''

// ── Logging ────────────────────────────────────────────────────────────────────

function log(level: 'info' | 'warn' | 'error', message: string): void {
  const entry = { timestamp: new Date().toISOString(), level, message }
  console[level](`[${entry.timestamp}] ${message}`)
  mainWindow?.webContents.send('log:entry', entry)
}

// ── Window ─────────────────────────────────────────────────────────────────────

function createWindow(): void {
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
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // Allow microphone access
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    if (permission === 'media') {
      callback(true)
    } else {
      callback(false)
    }
  })

  if (!app.isPackaged) {
    const devUrl = process.env.VITE_DEV_SERVER_URL ?? 'http://localhost:5173'
    mainWindow.loadURL(devUrl)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(path.join(process.resourcesPath, 'renderer', 'index.html'))
  }

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// ── Tray ───────────────────────────────────────────────────────────────────────

function createTray(): void {
  const icon = nativeImage.createEmpty()
  tray = new Tray(icon)
  tray.setToolTip('Voice Companion')
  updateTrayMenu()

  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) {
        mainWindow.hide()
      } else {
        mainWindow.show()
        mainWindow.focus()
      }
    }
  })
}

function updateTrayMenu(): void {
  if (!tray) return
  const menu = Menu.buildFromTemplate([
    {
      label: 'Show / Hide',
      click: () => {
        if (mainWindow?.isVisible()) {
          mainWindow.hide()
        } else {
          mainWindow?.show()
          mainWindow?.focus()
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.quit()
      },
    },
  ])
  tray.setContextMenu(menu)
}

// ── PTT Shortcut ───────────────────────────────────────────────────────────────

function registerPtt(key: string): void {
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
    log('info', `PTT registered: ${key}`)
  } catch (err) {
    log('error', `Failed to register PTT key "${key}": ${(err as Error).message}`)
  }
}

function unregisterPtt(): void {
  if (currentPttKey) {
    try {
      globalShortcut.unregister(currentPttKey)
    } catch {
      // ignore
    }
    currentPttKey = ''
  }
}

// ── IPC Handlers ───────────────────────────────────────────────────────────────

function setupIpcHandlers(): void {
  ipcMain.handle('settings:get', () => {
    return getSettings()
  })

  ipcMain.handle('settings:set', (_event, partial: Partial<Settings>) => {
    const oldSettings = getSettings()

    // Handle PTT key change
    if (partial.pttKey && partial.pttKey !== oldSettings.pttKey) {
      unregisterPtt()
    }

    setSettings(partial)
    const newSettings = getSettings()

    // Re-register PTT if needed
    if (partial.pttKey && partial.pttKey !== oldSettings.pttKey) {
      if (newSettings.pttEnabled) {
        registerPtt(newSettings.pttKey)
      }
    }
    if (partial.pttEnabled !== undefined) {
      if (partial.pttEnabled) {
        if (!currentPttKey) registerPtt(newSettings.pttKey)
      } else {
        unregisterPtt()
      }
    }

    // Handle WS URL/secret/enabled changes
    if (
      partial.wsUrl !== undefined ||
      partial.wsSecret !== undefined ||
      partial.wsEnabled !== undefined
    ) {
      wsClient.disconnect()
      if (newSettings.wsEnabled) {
        wsClient.connect()
      }
    }

    mainWindow?.webContents.send('settings:changed', newSettings)
    log('info', 'Settings updated')
  })

  ipcMain.handle('settings:test-ws', async () => {
    const settings = getSettings()
    return wsClient.testConnection(settings.wsUrl, settings.wsSecret)
  })

  // Transcribe audio and return text. Renderer decides whether to send to WS.
  ipcMain.handle('audio:submit', async (_event, buffer: ArrayBuffer) => {
    try {
      log('info', 'Transcribing audio…')
      const transcript = await transcribeAudio(buffer)
      log('info', `Transcript: "${transcript}"`)
      isRecording = false
      return transcript
    } catch (err) {
      const msg = (err as Error).message
      log('error', `Transcription error: ${msg}`)
      isRecording = false
      throw err
    }
  })

  // Send transcribed text to WebSocket
  ipcMain.handle('ws:voice-input', (_event, text: string) => {
    wsClient.sendVoiceInput(text)
    mainWindow?.webContents.send('transcription:result', text)
  })

  ipcMain.on('window:minimize', () => {
    mainWindow?.minimize()
  })

  ipcMain.on('window:close', () => {
    mainWindow?.hide()
  })
}

// ── App lifecycle ──────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createWindow()
  createTray()
  setupIpcHandlers()

  // Wire WS client events to renderer
  wsClient.on('status', (status) => {
    mainWindow?.webContents.send('ws:status', status)
  })
  wsClient.on('log', (entry: { level: 'info' | 'warn' | 'error'; message: string }) => {
    const fn = entry.level === 'error' ? console.error : entry.level === 'warn' ? console.warn : console.log
    fn(`[WS] ${entry.message}`)
    mainWindow?.webContents.send('log:entry', entry)
  })

  // Initial WS connect
  const settings = getSettings()
  if (settings.wsEnabled) {
    wsClient.connect()
  }

  // Register PTT
  if (settings.pttEnabled && settings.pttKey) {
    registerPtt(settings.pttKey)
  }
})

app.on('window-all-closed', () => {
  // Keep running in tray
})

app.on('activate', () => {
  if (!mainWindow) createWindow()
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  wsClient.destroy()
})
