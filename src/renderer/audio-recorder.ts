/**
 * Audio recorder using Web Audio API.
 * Captures microphone input, detects silence, and encodes 16kHz mono WAV.
 */

export interface RecorderOptions {
  silenceDuration: number    // ms of silence before auto-stop
  silenceThreshold: number   // RMS 0-1 range
  recordingTimeout: number   // max ms
  micDeviceId?: string       // '' or undefined = system default
  onRecordingStart?: () => void
  onRecordingStop?: () => void
  onSpeechDetected?: () => void
}

export interface AudioRecorder {
  startRecording(): void
  stopRecording(): Promise<ArrayBuffer>
  startKeywordMode(onAudio: (buf: ArrayBuffer) => void): void
  stopKeywordMode(): void
  cleanup(): void
}

// ── WAV encoding ───────────────────────────────────────────────────────────────

function downsample(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return samples
  const ratio = fromRate / toRate
  const newLength = Math.round(samples.length / ratio)
  const result = new Float32Array(newLength)
  for (let i = 0; i < newLength; i++) {
    const start = Math.floor(i * ratio)
    const end = Math.min(Math.ceil((i + 1) * ratio), samples.length)
    let sum = 0
    for (let j = start; j < end; j++) sum += samples[j]
    result[i] = sum / (end - start)
  }
  return result
}

export function encodeWAV(chunks: Float32Array[], sampleRate: number): ArrayBuffer {
  // Concatenate all chunks
  let totalLength = 0
  for (const c of chunks) totalLength += c.length
  const merged = new Float32Array(totalLength)
  let offset = 0
  for (const c of chunks) {
    merged.set(c, offset)
    offset += c.length
  }

  const targetSampleRate = 16000
  const pcmFloat = downsample(merged, sampleRate, targetSampleRate)

  // Convert float32 to int16
  const pcm16 = new Int16Array(pcmFloat.length)
  for (let i = 0; i < pcmFloat.length; i++) {
    const s = Math.max(-1, Math.min(1, pcmFloat[i]))
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }

  const dataSize = pcm16.byteLength
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  function writeString(off: number, str: string) {
    for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i))
  }

  writeString(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeString(8, 'WAVE')
  writeString(12, 'fmt ')
  view.setUint32(16, 16, true)          // Subchunk1Size
  view.setUint16(20, 1, true)           // AudioFormat: PCM
  view.setUint16(22, 1, true)           // NumChannels: mono
  view.setUint32(24, targetSampleRate, true)
  view.setUint32(28, targetSampleRate * 2, true) // ByteRate
  view.setUint16(32, 2, true)           // BlockAlign
  view.setUint16(34, 16, true)          // BitsPerSample
  writeString(36, 'data')
  view.setUint32(40, dataSize, true)

  // Copy PCM data
  const uint8View = new Uint8Array(buffer, 44)
  uint8View.set(new Uint8Array(pcm16.buffer))

  return buffer
}

// ── RMS calculation ────────────────────────────────────────────────────────────

function calcRMS(data: Float32Array): number {
  let sum = 0
  for (let i = 0; i < data.length; i++) sum += data[i] * data[i]
  return Math.sqrt(sum / data.length)
}

// ── Recorder factory ───────────────────────────────────────────────────────────

export async function createAudioRecorder(options: RecorderOptions): Promise<AudioRecorder> {
  const audioCtx = new AudioContext()
  const audioConstraints: MediaTrackConstraints = options.micDeviceId
    ? { deviceId: { exact: options.micDeviceId }, echoCancellation: true, noiseSuppression: true }
    : { echoCancellation: true, noiseSuppression: true }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false })
  const source = audioCtx.createMediaStreamSource(stream)

  // AnalyserNode for VAD
  const analyser = audioCtx.createAnalyser()
  analyser.fftSize = 2048
  source.connect(analyser)

  // ScriptProcessorNode for capturing samples
  const bufferSize = 4096
  const processor = audioCtx.createScriptProcessor(bufferSize, 1, 1)
  source.connect(processor)
  processor.connect(audioCtx.destination)

  // State
  let recording = false
  let chunks: Float32Array[] = []
  let silenceStart: number | null = null
  let speechDetected = false
  let recordingStartTime = 0
  let recordingResolve: ((buf: ArrayBuffer) => void) | null = null
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null

  // Pre-buffer for keyword mode (~500ms)
  const preBufferMaxMs = 500
  const preBufferMaxChunks = Math.ceil((audioCtx.sampleRate * preBufferMaxMs) / (1000 * bufferSize))
  let preBuffer: Float32Array[] = []

  // Keyword mode state
  let keywordMode = false
  let kwRecording = false
  let kwChunks: Float32Array[] = []
  let kwSilenceStart: number | null = null
  let kwSpeechDetected = false
  let kwCallback: ((buf: ArrayBuffer) => void) | null = null
  let kwTimeoutTimer: ReturnType<typeof setTimeout> | null = null

  processor.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0)
    const copy = new Float32Array(input)

    // Rolling pre-buffer for keyword mode
    if (keywordMode && !kwRecording) {
      preBuffer.push(copy)
      if (preBuffer.length > preBufferMaxChunks) {
        preBuffer.shift()
      }
    }

    // PTT recording
    if (recording) {
      chunks.push(copy)
    }

    // Keyword recording
    if (kwRecording) {
      kwChunks.push(copy)
    }
  }

  // VAD loop via AnalyserNode
  const vadData = new Float32Array(analyser.fftSize)

  function vadTick() {
    if (!keywordMode && !recording) return

    analyser.getFloatTimeDomainData(vadData)
    const rms = calcRMS(vadData)
    const now = Date.now()

    // ── PTT VAD ────────────────────────────────────────────────────────────
    if (recording) {
      if (rms > options.silenceThreshold) {
        speechDetected = true
        silenceStart = null
        if (!speechDetected) options.onSpeechDetected?.()
      } else if (speechDetected) {
        if (silenceStart === null) silenceStart = now
        else if (now - silenceStart > options.silenceDuration) {
          // Auto-stop after silence
          _finishPttRecording()
          return
        }
      }

      // Recording timeout
      if (now - recordingStartTime > options.recordingTimeout) {
        _finishPttRecording()
        return
      }
    }

    // ── Keyword VAD ────────────────────────────────────────────────────────
    if (keywordMode) {
      if (!kwRecording) {
        if (rms > options.silenceThreshold) {
          // Start keyword recording, prepend pre-buffer
          kwRecording = true
          kwChunks = [...preBuffer]
          preBuffer = []
          kwSpeechDetected = true
          kwSilenceStart = null
          options.onSpeechDetected?.()

          kwTimeoutTimer = setTimeout(() => {
            if (kwRecording) _finishKwRecording()
          }, options.recordingTimeout)
        }
      } else {
        if (rms > options.silenceThreshold) {
          kwSilenceStart = null
          kwSpeechDetected = true
        } else if (kwSpeechDetected) {
          if (kwSilenceStart === null) kwSilenceStart = now
          else if (now - kwSilenceStart > options.silenceDuration) {
            _finishKwRecording()
            return
          }
        }
      }
    }
  }

  const vadInterval = setInterval(vadTick, 100)

  function _finishPttRecording() {
    if (!recording) return
    recording = false
    if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null }
    options.onRecordingStop?.()

    const wav = encodeWAV(chunks, audioCtx.sampleRate)
    chunks = []
    speechDetected = false
    silenceStart = null

    if (recordingResolve) {
      recordingResolve(wav)
      recordingResolve = null
    }
  }

  function _finishKwRecording() {
    if (!kwRecording) return
    kwRecording = false
    if (kwTimeoutTimer) { clearTimeout(kwTimeoutTimer); kwTimeoutTimer = null }

    const wav = encodeWAV(kwChunks, audioCtx.sampleRate)
    kwChunks = []
    kwSpeechDetected = false
    kwSilenceStart = null

    if (kwCallback) kwCallback(wav)
  }

  return {
    startRecording() {
      if (recording) return
      chunks = []
      speechDetected = false
      silenceStart = null
      recordingStartTime = Date.now()
      recording = true
      options.onRecordingStart?.()

      timeoutTimer = setTimeout(() => {
        if (recording) _finishPttRecording()
      }, options.recordingTimeout)
    },

    stopRecording(): Promise<ArrayBuffer> {
      if (!recording) {
        // Return empty WAV if not currently recording
        return Promise.resolve(encodeWAV([], audioCtx.sampleRate))
      }

      return new Promise((resolve) => {
        recordingResolve = resolve
        _finishPttRecording()
      })
    },

    startKeywordMode(onAudio: (buf: ArrayBuffer) => void) {
      kwCallback = onAudio
      keywordMode = true
      kwRecording = false
      kwChunks = []
      preBuffer = []
    },

    stopKeywordMode() {
      keywordMode = false
      kwRecording = false
      kwChunks = []
      preBuffer = []
      kwCallback = null
    },

    cleanup() {
      clearInterval(vadInterval)
      if (timeoutTimer) clearTimeout(timeoutTimer)
      if (kwTimeoutTimer) clearTimeout(kwTimeoutTimer)
      processor.disconnect()
      analyser.disconnect()
      source.disconnect()
      stream.getTracks().forEach((t) => t.stop())
      audioCtx.close()
    },
  }
}
