import { spawn, execFileSync } from 'child_process'
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
  // whisper-cli.exe first — main.exe is deprecated and exits with code 1
  for (const name of ['whisper-cli.exe', 'main.exe']) {
    const p = path.join(dir, name)
    if (fs.existsSync(p)) return p
  }
  return ''
}

function getDefaultModelPath(): string {
  const resDir = getResourcesDir()
  // Prefer multilingual model, fall back to English-only
  const multi = path.join(resDir, 'models', 'ggml-base.bin')
  if (fs.existsSync(multi)) return multi
  return path.join(resDir, 'models', 'ggml-base.en.bin')
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

/**
 * Run at app startup to verify the whisper binary can execute at all.
 * Logs detailed diagnostics about binary, DLLs, and model.
 */
export function diagnoseWhisper(): { ok: boolean; details: string[] } {
  const details: string[] = []
  const resDir = getResourcesDir()
  details.push(`Resources dir: ${resDir}`)

  // Check binary
  const binaryPath = getWhisperBinaryPath()
  if (!binaryPath) {
    const whisperDir = path.join(resDir, 'whisper')
    const exists = fs.existsSync(whisperDir)
    details.push(`Whisper dir exists: ${exists}`)
    if (exists) {
      const files = fs.readdirSync(whisperDir)
      details.push(`Whisper dir contents: ${files.join(', ') || '(empty)'}`)
    }
    details.push('FAIL: No whisper binary (main.exe / whisper-cli.exe) found')
    return { ok: false, details }
  }
  details.push(`Binary: ${binaryPath}`)

  // List DLLs next to binary
  const whisperDir = path.dirname(binaryPath)
  const dlls = fs.readdirSync(whisperDir).filter(f => f.endsWith('.dll'))
  details.push(`DLLs in whisper dir: ${dlls.join(', ') || '(none)'}`)

  // Check model
  const settings = getSettings()
  const modelPath = settings.whisperModelPath || getDefaultModelPath()
  const modelExists = fs.existsSync(modelPath)
  details.push(`Model: ${modelPath} (exists: ${modelExists})`)
  if (modelExists) {
    const modelSize = fs.statSync(modelPath).size
    details.push(`Model size: ${(modelSize / 1024 / 1024).toFixed(1)} MB`)
  }

  // Try running the binary with --help to see if it loads
  try {
    const out = execFileSync(binaryPath, ['--help'], {
      cwd: whisperDir,
      windowsHide: true,
      timeout: 5000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    details.push(`Binary --help: OK (${out.length} chars output)`)
  } catch (err: unknown) {
    const e = err as { status?: number; stderr?: string; message?: string }
    // --help often exits with code 1 but still produces output, that's fine
    if (e.stderr && e.stderr.length > 0) {
      details.push(`Binary --help stderr: ${e.stderr.slice(0, 200)}`)
    }
    if (e.status !== undefined && e.status !== 0 && e.status !== 1) {
      details.push(`WARN: Binary --help exited with code ${e.status}`)
    } else {
      details.push(`Binary --help: OK (exit ${e.status ?? 'unknown'})`)
    }
  }

  return { ok: true, details }
}

async function transcribeWhisperCpp(wavBuffer: ArrayBuffer): Promise<string> {
  const settings = getSettings()

  // Skip if recording is too short (likely accidental trigger)
  console.log(`[whisper] Received WAV buffer: ${wavBuffer.byteLength} bytes`)
  if (wavBuffer.byteLength < MIN_WAV_BYTES) {
    console.log('[whisper] Buffer too small, skipping')
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

  // Write WAV to temp file
  const buf = Buffer.from(wavBuffer)
  const tmpFile = path.join(os.tmpdir(), `vc-audio-${Date.now()}.wav`)
  fs.writeFileSync(tmpFile, buf)

  // Validate WAV header
  const header = buf.toString('ascii', 0, 4)
  const format = buf.toString('ascii', 8, 12)
  const channels = buf.readUInt16LE(22)
  const sampleRate = buf.readUInt32LE(24)
  const bitsPerSample = buf.readUInt16LE(34)
  console.log(`[whisper] WAV header: "${header}" format: "${format}" ch=${channels} rate=${sampleRate} bits=${bitsPerSample} fileSize=${buf.byteLength}`)

  // Save debug copy
  const debugWav = path.join(os.tmpdir(), 'vc-debug-last.wav')
  try { fs.copyFileSync(tmpFile, debugWav) } catch { /* ignore */ }
  console.log(`[whisper] Debug WAV saved to: ${debugWav}`)

  try {
    // -nt = no timestamps in output
    // Run with cwd = binary directory so DLLs are found on Windows
    const args = ['-m', modelPath, '-f', tmpFile, '-nt']
    if (settings.language && settings.language !== 'auto') {
      args.push('-l', settings.language)
    }

    const whisperDir = path.dirname(binaryPath)
    console.log(`[whisper] Running: ${binaryPath} ${args.join(' ')}`)
    console.log(`[whisper] CWD: ${whisperDir}`)

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
        console.log(`[whisper] Exit code: ${code}`)
        console.log(`[whisper] stdout (${stdout.length} chars): ${stdout.slice(0, 500)}`)
        console.log(`[whisper] stderr (${stderr.length} chars): ${stderr.slice(0, 500)}`)
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
