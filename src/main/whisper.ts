import { spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { app } from 'electron'
import OpenAI, { toFile } from 'openai'
import { getSettings } from './settings'

function getResourcesDir(): string {
  if (app.isPackaged) {
    return process.resourcesPath
  }
  return path.join(__dirname, '../../resources')
}

function getWhisperBinaryPath(): string {
  const dir = path.join(getResourcesDir(), 'whisper')
  const mainExe = path.join(dir, 'main.exe')
  if (fs.existsSync(mainExe)) return mainExe
  const cliExe = path.join(dir, 'whisper-cli.exe')
  if (fs.existsSync(cliExe)) return cliExe
  return ''
}

function getDefaultModelPath(): string {
  return path.join(getResourcesDir(), 'models', 'ggml-base.en.bin')
}

async function transcribeWhisperCpp(wavBuffer: ArrayBuffer): Promise<string> {
  const settings = getSettings()

  const binaryPath = getWhisperBinaryPath()
  if (!binaryPath) {
    if (settings.openaiApiKey) {
      console.warn('whisper.cpp binary not found, falling back to OpenAI API')
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
    const args = ['-m', modelPath, '-f', tmpFile, '--output-txt', '-nt']
    if (settings.language && settings.language !== 'auto') {
      args.push('-l', settings.language)
    }

    const transcript = await new Promise<string>((resolve, reject) => {
      const proc = spawn(binaryPath, args, { windowsHide: true })
      let stdout = ''
      let stderr = ''

      proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`whisper.cpp exited with code ${code}: ${stderr}`))
        } else {
          resolve(stdout.trim())
        }
      })

      proc.on('error', (err) => {
        reject(new Error(`Failed to spawn whisper.cpp: ${err.message}`))
      })
    })

    const txtFile = tmpFile + '.txt'
    if (fs.existsSync(txtFile)) fs.unlinkSync(txtFile)

    return transcript
  } finally {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile)
  }
}

async function transcribeOpenAI(wavBuffer: ArrayBuffer): Promise<string> {
  const settings = getSettings()
  if (!settings.openaiApiKey) {
    throw new Error('OpenAI API key is not set')
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
