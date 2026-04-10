import { spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { app } from 'electron'
import OpenAI, { toFile } from 'openai'
import { getSettings } from './settings'

// Minimum WAV size to bother transcribing (~500ms at 16kHz mono 16-bit = ~16044 bytes)
const MIN_WAV_BYTES = 16044

function getResourcesDir(): string {
  if (app.isPackaged) {
    return process.resourcesPath
  }
  return path.join(__dirname, '../../resources')
}

function getWhisperBinaryPath(): string {
  const dir = path.join(getResourcesDir(), 'whisper')
  for (const name of ['main.exe', 'whisper-cli.exe']) {
    const p = path.join(dir, name)
    if (fs.existsSync(p)) return p
  }
  return ''
}

function getDefaultModelPath(): string {
  return path.join(getResourcesDir(), 'models', 'ggml-base.en.bin')
}

// Strip whisper.cpp timestamp lines like "[00:00.000 --> 00:02.340]  text"
function stripTimestamps(raw: string): string {
  return raw
    .split('\n')
    .map((line) => line.replace(/^\[[\d:.,\s>-]+\]\s*/, '').trim())
    .filter(Boolean)
    .join(' ')
    .trim()
}

async function transcribeWhisperCpp(wavBuffer: ArrayBuffer): Promise<string> {
  const settings = getSettings()

  // Skip if recording is too short (likely accidental trigger)
  if (wavBuffer.byteLength < MIN_WAV_BYTES) {
    return ''
  }

  const binaryPath = getWhisperBinaryPath()
  if (!binaryPath) {
    if (settings.openaiApiKey) {
      console.warn('[whisper] binary not found, falling back to OpenAI API')
      return transcribeOpenAI(wavBuffer)
    }
    throw new Error(
      'whisper.cpp binary not found. Place main.exe or whisper-cli.exe in resources/whisper/'
    )
  }

  const modelPath = settings.whisperModelPath || getDefaultModelPath()
  if (!fs.existsSync(modelPath)) {
    throw new Error(`Whisper model not found at: ${modelPath}`)
  }

  const tmpFile = path.join(os.tmpdir(), `vc-audio-${Date.now()}.wav`)
  fs.writeFileSync(tmpFile, Buffer.from(wavBuffer))

  try {
    // -nt = no timestamps in output
    // Run with cwd = binary directory so DLLs are found on Windows
    const args = ['-m', modelPath, '-f', tmpFile, '-nt']
    if (settings.language && settings.language !== 'auto') {
      args.push('-l', settings.language)
    }

    const whisperDir = path.dirname(binaryPath)

    const result = await new Promise<string>((resolve, reject) => {
      const proc = spawn(binaryPath, args, {
        windowsHide: true,
        cwd: whisperDir, // ← ensures DLLs next to the binary are found
      })
      let stdout = ''
      let stderr = ''

      proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

      proc.on('close', (code) => {
        if (code !== 0) {
          const detail = stderr.trim() || '(no stderr)'
          reject(new Error(`whisper.cpp exited with code ${code}: ${detail}`))
        } else {
          // stdout may have timestamps or plain text depending on version
          resolve(stripTimestamps(stdout) || stdout.trim())
        }
      })

      proc.on('error', (err) => {
        reject(new Error(`Failed to spawn whisper.cpp: ${err.message}`))
      })
    })

    // Clean up any output files whisper may have created
    for (const ext of ['.txt', '.wav.txt']) {
      const f = tmpFile + ext
      if (fs.existsSync(f)) fs.unlinkSync(f)
    }

    return result
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
  }
}

async function transcribeOpenAI(wavBuffer: ArrayBuffer): Promise<string> {
  const settings = getSettings()
  if (!settings.openaiApiKey) {
    throw new Error('OpenAI API key is not set')
  }

  // Skip tiny recordings
  if (wavBuffer.byteLength < MIN_WAV_BYTES) {
    return ''
  }

  const client = new OpenAI({ apiKey: settings.openaiApiKey })
  const tmpFile = path.join(os.tmpdir(), `vc-audio-${Date.now()}.wav`)
  fs.writeFileSync(tmpFile, Buffer.from(wavBuffer))

  try {
    const file = await toFile(fs.createReadStream(tmpFile), 'audio.wav', { type: 'audio/wav' })
    const result = await client.audio.transcriptions.create({
      file,
      model: settings.openaiModel || 'whisper-1',
      ...(settings.language && settings.language !== 'auto' ? { language: settings.language } : {}),
    })
    return result.text.trim()
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
  }
}

export async function transcribeAudio(wavBuffer: ArrayBuffer): Promise<string> {
  const settings = getSettings()
  if (settings.whisperMode === 'openai') {
    return transcribeOpenAI(wavBuffer)
  }
  return transcribeWhisperCpp(wavBuffer)
}
