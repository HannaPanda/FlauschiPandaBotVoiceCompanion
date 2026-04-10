/**
 * Audio recorder using MediaRecorder (reliable in Electron) + AnalyserNode for VAD.
 * After recording, audio is decoded via AudioContext and re-encoded as 16 kHz mono WAV.
 */

export interface RecorderOptions {
  silenceDuration: number    // ms of silence before auto-stop
  silenceThreshold: number   // RMS 0-1 range
  recordingTimeout: number   // max ms
  micDeviceId?: string       // '' or undefined = system default
  onRecordingStart?: () => void
  onRecordingStop?: () => void
}

export interface AudioRecorder {
  startRecording(): void
  stopRecording(): Promise<ArrayBuffer>
  startKeywordMode(onAudio: (buf: ArrayBuffer) => void): void
  stopKeywordMode(): void
  getLevel(): number          // current RMS 0-1 (for UI meters)
  cleanup(): void
}

// ── WAV encoding ───────────────────────────────────────────────────────────────

function downsample(buf: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return buf
  const ratio = from / to
  const len = Math.round(buf.length / ratio)
  const out = new Float32Array(len)
  for (let i = 0; i < len; i++) {
    const start = Math.floor(i * ratio)
    const end   = Math.min(Math.ceil((i + 1) * ratio), buf.length)
    let sum = 0
    for (let j = start; j < end; j++) sum += buf[j]
    out[i] = sum / (end - start)
  }
  return out
}

export function encodeWAV(audioBuffer: AudioBuffer): ArrayBuffer {
  const TARGET_RATE = 16000
  // Mix all channels down to mono
  let mono = new Float32Array(audioBuffer.length)
  for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
    const data = audioBuffer.getChannelData(ch)
    for (let i = 0; i < data.length; i++) mono[i] += data[i]
  }
  if (audioBuffer.numberOfChannels > 1) {
    for (let i = 0; i < mono.length; i++) mono[i] /= audioBuffer.numberOfChannels
  }

  const pcmFloat = downsample(mono, audioBuffer.sampleRate, TARGET_RATE)

  // float32 → int16
  const pcm16 = new Int16Array(pcmFloat.length)
  for (let i = 0; i < pcmFloat.length; i++) {
    const s = Math.max(-1, Math.min(1, pcmFloat[i]))
    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF
  }

  const dataSize = pcm16.byteLength
  const wavBuf = new ArrayBuffer(44 + dataSize)
  const v = new DataView(wavBuf)
  const str = (off: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)) }

  str(0,  'RIFF'); v.setUint32(4,  36 + dataSize, true)
  str(8,  'WAVE'); str(12, 'fmt ')
  v.setUint32(16, 16,          true)  // subchunk1 size
  v.setUint16(20, 1,           true)  // PCM
  v.setUint16(22, 1,           true)  // mono
  v.setUint32(24, TARGET_RATE, true)
  v.setUint32(28, TARGET_RATE * 2, true) // byteRate
  v.setUint16(32, 2,           true)  // blockAlign
  v.setUint16(34, 16,          true)  // bitsPerSample
  str(36, 'data'); v.setUint32(40, dataSize, true)
  new Uint8Array(wavBuf, 44).set(new Uint8Array(pcm16.buffer))

  return wavBuf
}

// Minimum duration to send to Whisper (~500 ms at 16 kHz mono 16-bit)
const MIN_WAV_BYTES = 16044

async function blobsToWav(blobs: Blob[]): Promise<ArrayBuffer> {
  const blob = new Blob(blobs)            // inherits correct MIME from MediaRecorder
  const encoded = await blob.arrayBuffer()

  // Decode via AudioContext (handles webm/opus, ogg, etc.)
  const ctx = new AudioContext()
  try {
    const audioBuf = await ctx.decodeAudioData(encoded)
    return encodeWAV(audioBuf)
  } finally {
    await ctx.close()
  }
}

// ── VAD helper ─────────────────────────────────────────────────────────────────

function calcRMS(data: Float32Array): number {
  let sum = 0
  for (let i = 0; i < data.length; i++) sum += data[i] * data[i]
  return Math.sqrt(sum / data.length)
}

// ── Factory ────────────────────────────────────────────────────────────────────

export async function createAudioRecorder(options: RecorderOptions): Promise<AudioRecorder> {
  const constraints: MediaTrackConstraints = options.micDeviceId
    ? { deviceId: { exact: options.micDeviceId }, echoCancellation: true, noiseSuppression: true }
    : { echoCancellation: true, noiseSuppression: true }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false })

  // AnalyserNode for VAD only (no ScriptProcessorNode needed)
  const vadCtx     = new AudioContext()
  const vadSource  = vadCtx.createMediaStreamSource(stream)
  const analyser   = vadCtx.createAnalyser()
  analyser.fftSize = 1024
  vadSource.connect(analyser)
  const vadData = new Float32Array(analyser.fftSize)

  let currentLevel = 0

  // ── PTT state ────────────────────────────────────────────────────────────────
  let pttRecorder: MediaRecorder | null = null
  let pttBlobs: Blob[] = []
  let pttResolve: ((wav: ArrayBuffer) => void) | null = null
  let pttTimeout: ReturnType<typeof setTimeout> | null = null
  let pttSilenceStart: number | null = null
  let pttSpeechDetected = false

  // ── Keyword state ────────────────────────────────────────────────────────────
  let kwActive   = false
  let kwRecorder: MediaRecorder | null = null
  let kwBlobs: Blob[] = []
  let kwCallback: ((wav: ArrayBuffer) => void) | null = null
  let kwSpeechDetected = false
  let kwSilenceStart: number | null = null
  let kwTimeout: ReturnType<typeof setTimeout> | null = null

  // Pre-buffer: keep last 500 ms of blobs for keyword mode
  const PRE_BUF_MS = 500
  let preBlobs: { blob: Blob; ts: number }[] = []
  let preRecorder: MediaRecorder | null = null

  function getMimeType(): string {
    for (const t of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus']) {
      if (MediaRecorder.isTypeSupported(t)) return t
    }
    return ''
  }
  const mimeType = getMimeType()

  // ── Pre-buffer recorder (always running in keyword mode) ───────────────────

  function startPreBuffer() {
    if (preRecorder) return
    preBlobs = []
    const r = new MediaRecorder(stream, mimeType ? { mimeType } : {})
    r.ondataavailable = e => {
      if (e.data.size > 0) {
        preBlobs.push({ blob: e.data, ts: Date.now() })
        // Trim old blobs
        const cutoff = Date.now() - PRE_BUF_MS - 200
        preBlobs = preBlobs.filter(b => b.ts >= cutoff)
      }
    }
    r.start(100)
    preRecorder = r
  }

  function stopPreBuffer() {
    if (!preRecorder) return
    try { preRecorder.stop() } catch { /* ignore */ }
    preRecorder = null
  }

  // ── PTT helpers ───────────────────────────────────────────────────────────

  function finishPtt() {
    if (!pttRecorder) return
    clearTimeout(pttTimeout ?? undefined)
    pttTimeout = null
    pttRecorder.stop()
    // onstop handles resolve
  }

  // ── Keyword helpers ──────────────────────────────────────────────────────

  function startKwRecording() {
    if (kwRecorder) return
    stopPreBuffer()

    const preData = preBlobs.map(b => b.blob)
    kwBlobs = []

    const r = new MediaRecorder(stream, mimeType ? { mimeType } : {})
    r.ondataavailable = e => { if (e.data.size > 0) kwBlobs.push(e.data) }
    r.onstop = async () => {
      kwRecorder = null
      const allBlobs = [...preData, ...kwBlobs]
      if (allBlobs.length === 0) { restartPreBuffer(); return }
      try {
        const wav = await blobsToWav(allBlobs)
        if (wav.byteLength >= MIN_WAV_BYTES) kwCallback?.(wav)
      } catch { /* ignore decode errors for very short clips */ }
      restartPreBuffer()
    }
    r.start(100)
    kwRecorder = r

    kwTimeout = setTimeout(() => { if (kwRecorder) kwRecorder.stop() }, options.recordingTimeout)
  }

  function stopKwRecording() {
    if (!kwRecorder) return
    clearTimeout(kwTimeout ?? undefined)
    kwTimeout = null
    kwRecorder.stop()
  }

  function restartPreBuffer() {
    if (kwActive) startPreBuffer()
  }

  // ── VAD loop ─────────────────────────────────────────────────────────────

  const vadInterval = setInterval(() => {
    analyser.getFloatTimeDomainData(vadData)
    const rms = calcRMS(vadData)
    currentLevel = rms
    const now  = Date.now()
    const loud = rms > options.silenceThreshold

    // PTT silence detection (stop recording after silence)
    if (pttRecorder && pttSpeechDetected) {
      if (loud) {
        pttSilenceStart = null
      } else {
        if (pttSilenceStart === null) pttSilenceStart = now
        else if (now - pttSilenceStart > options.silenceDuration) {
          finishPtt()
        }
      }
    }
    if (pttRecorder && loud) pttSpeechDetected = true

    // Keyword VAD
    if (kwActive) {
      if (!kwRecorder) {
        if (loud) {
          kwSpeechDetected = true
          kwSilenceStart = null
          startKwRecording()
        }
      } else {
        if (loud) {
          kwSilenceStart = null
          kwSpeechDetected = true
        } else if (kwSpeechDetected) {
          if (kwSilenceStart === null) kwSilenceStart = now
          else if (now - kwSilenceStart > options.silenceDuration) {
            stopKwRecording()
            kwSpeechDetected = false
            kwSilenceStart   = null
          }
        }
      }
    }
  }, 80)

  // ── Public API ────────────────────────────────────────────────────────────

  return {
    startRecording() {
      if (pttRecorder) return
      pttBlobs = []
      pttSpeechDetected = false
      pttSilenceStart   = null

      const r = new MediaRecorder(stream, mimeType ? { mimeType } : {})
      r.ondataavailable = e => { if (e.data.size > 0) pttBlobs.push(e.data) }
      r.onstop = async () => {
        pttRecorder = null
        options.onRecordingStop?.()
        if (pttBlobs.length === 0) { pttResolve?.(new ArrayBuffer(0)); pttResolve = null; return }
        try {
          const wav = await blobsToWav(pttBlobs)
          pttResolve?.(wav)
        } catch (e) {
          pttResolve?.(new ArrayBuffer(0))
        }
        pttResolve = null
      }
      r.start(100)
      pttRecorder = r

      // Hard timeout
      pttTimeout = setTimeout(() => { if (pttRecorder) finishPtt() }, options.recordingTimeout)
      options.onRecordingStart?.()
    },

    stopRecording(): Promise<ArrayBuffer> {
      if (!pttRecorder) return Promise.resolve(new ArrayBuffer(0))
      return new Promise(resolve => {
        pttResolve = resolve
        finishPtt()
      })
    },

    startKeywordMode(cb) {
      kwCallback = cb
      kwActive   = true
      kwSpeechDetected = false
      kwSilenceStart   = null
      startPreBuffer()
    },

    stopKeywordMode() {
      kwActive = false
      stopKwRecording()
      stopPreBuffer()
      kwCallback = null
    },

    getLevel() { return currentLevel },

    cleanup() {
      clearInterval(vadInterval)
      clearTimeout(pttTimeout  ?? undefined)
      clearTimeout(kwTimeout   ?? undefined)
      try { pttRecorder?.stop() }   catch { /* ignore */ }
      try { kwRecorder?.stop() }    catch { /* ignore */ }
      try { preRecorder?.stop() }   catch { /* ignore */ }
      vadSource.disconnect()
      analyser.disconnect()
      vadCtx.close()
      stream.getTracks().forEach(t => t.stop())
    },
  }
}
