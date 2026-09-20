export type MicrophoneMonitorState = 'off' | 'requesting' | 'on' | 'error'

export type MicrophoneMonitorErrorCode =
  | 'unsupported'
  | 'permission-denied'
  | 'no-device'
  | 'device-busy'
  | 'constraints'
  | 'device-lost'
  | 'context-suspended'
  | 'unknown'

export interface MicrophoneMonitorTelemetry {
  contextState?: AudioContextState
  contextSampleRate?: number
  baseLatency?: number
  outputLatency?: number
  estimatedOutputLatency?: number
  outputDevice?: 'system-default' | 'explicit-device' | 'unknown'
  trackReadyState?: MediaStreamTrackState
  trackEnabled?: boolean
  trackMuted?: boolean
  trackSampleRate?: number
  trackChannelCount?: number
  trackLatency?: number
  echoCancellation?: boolean
  noiseSuppression?: boolean
  autoGainControl?: boolean
  startToActiveMs?: number
  inputRms?: number
  inputPeak?: number
  outputRms?: number
  outputPeak?: number
  signalDetected?: boolean
  silenceDurationMs?: number
  outputTooHot?: boolean
  outputClipping?: boolean
}

export interface MicrophoneMonitorSnapshot {
  state: MicrophoneMonitorState
  errorCode?: MicrophoneMonitorErrorCode
  error?: string
  gain: number
  telemetry: MicrophoneMonitorTelemetry
}

export const MICROPHONE_CONSTRAINTS: MediaStreamConstraints = {
  video: false,
  audio: {
    channelCount: { ideal: 1 },
    sampleRate: { ideal: 48_000 },
    latency: { ideal: 0.01 },
    echoCancellation: { ideal: false },
    noiseSuppression: { ideal: false },
    autoGainControl: { ideal: false },
  } as MediaTrackConstraints & { latency: ConstrainDouble },
}

export const MIN_MONITOR_GAIN = 0
export const DEFAULT_MONITOR_GAIN = 2
export const MAX_MONITOR_GAIN = 4
export const MONITOR_GAIN_STEP = 0.05
export const SIGNAL_THRESHOLD = 0.001
export const NO_INPUT_WARNING_MS = 1_500
export const OUTPUT_TOO_HOT_THRESHOLD = 0.85
export const OUTPUT_CLIPPING_THRESHOLD = 0.98

type MonitorAudioContext = AudioContext & {
  outputLatency?: number
  sinkId?: string | { type: string }
}

interface MicrophoneMonitorDependencies {
  isSecureContext: () => boolean
  getMediaDevices: () => MediaDevices | undefined
  createAudioContext: () => MonitorAudioContext
  now: () => number
  scheduleMeter: (callback: () => void) => number
  cancelMeter: (handle: number) => void
}

const defaultDependencies: MicrophoneMonitorDependencies = {
  isSecureContext: () => window.isSecureContext,
  getMediaDevices: () => navigator.mediaDevices,
  createAudioContext: () => new AudioContext({ latencyHint: 'interactive' }),
  now: () => performance.now(),
  scheduleMeter: (callback) => window.setInterval(callback, 100),
  cancelMeter: (handle) => window.clearInterval(handle),
}

export function classifyMicrophoneError(reason: unknown): {
  code: MicrophoneMonitorErrorCode
  message: string
} {
  const name = reason instanceof DOMException
    ? reason.name
    : typeof reason === 'object' && reason && 'name' in reason
      ? String(reason.name)
      : ''
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return {
        code: 'permission-denied',
        message: 'Microphone access was denied. Check Windows Privacy & security > Microphone, then retry.',
      }
    case 'NotFoundError':
      return { code: 'no-device', message: 'No microphone is available. Connect one, then retry.' }
    case 'NotReadableError':
    case 'AbortError':
      return { code: 'device-busy', message: 'The microphone is unavailable or in use by another app.' }
    case 'OverconstrainedError':
      return { code: 'constraints', message: 'The microphone could not satisfy the requested audio settings.' }
    default:
      return {
        code: 'unknown',
        message: reason instanceof Error ? reason.message : 'Microphone monitoring could not start.',
      }
  }
}

export class MicrophoneMonitorController {
  private readonly dependencies: MicrophoneMonitorDependencies
  private snapshot: MicrophoneMonitorSnapshot = {
    state: 'off',
    gain: DEFAULT_MONITOR_GAIN,
    telemetry: {},
  }
  private listeners = new Set<(snapshot: MicrophoneMonitorSnapshot) => void>()
  private generation = 0
  private stream?: MediaStream
  private context?: MonitorAudioContext
  private source?: MediaStreamAudioSourceNode
  private gainNode?: GainNode
  private inputAnalyser?: AnalyserNode
  private outputAnalyser?: AnalyserNode
  private mediaDevices?: MediaDevices
  private meterHandle?: number
  private meterStartedAt?: number
  private trackEndHandlers = new Map<MediaStreamTrack, () => void>()
  private contextStateHandler?: () => void
  private deviceChangeHandler?: () => void

  constructor(dependencies: MicrophoneMonitorDependencies = defaultDependencies) {
    this.dependencies = dependencies
  }

  getSnapshot = () => this.snapshot

  subscribe = (listener: (snapshot: MicrophoneMonitorSnapshot) => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  setGain(value: number) {
    const gain = clampMonitorGain(value)
    if (gain === this.snapshot.gain) return
    const context = this.context
    const gainNode = this.gainNode
    if (context && gainNode) {
      gainNode.gain.setTargetAtTime(gain, context.currentTime, 0.008)
    }
    this.update({ gain })
  }

  async enable() {
    if (this.snapshot.state === 'requesting' || this.snapshot.state === 'on') return
    const operation = ++this.generation
    if (this.stream || this.context || this.source || this.gainNode) {
      await this.releaseResources()
      if (operation !== this.generation) return
    }

    const mediaDevices = this.dependencies.getMediaDevices()
    if (!this.dependencies.isSecureContext() || !mediaDevices?.getUserMedia) {
      this.update({
        state: 'error',
        errorCode: 'unsupported',
        error: 'Microphone monitoring requires the secure Karaoke Studio app context.',
        telemetry: {},
      })
      return
    }

    const startedAt = this.dependencies.now()
    this.update({ state: 'requesting', error: undefined, errorCode: undefined, telemetry: {} })
    let context: MonitorAudioContext | undefined
    let stream: MediaStream | undefined
    let source: MediaStreamAudioSourceNode | undefined
    let gainNode: GainNode | undefined
    let inputAnalyser: AnalyserNode | undefined
    let outputAnalyser: AnalyserNode | undefined
    try {
      context = this.dependencies.createAudioContext()
      this.context = context
      if (context.state === 'suspended') await context.resume()
      if (operation !== this.generation) {
        if (this.context === context) this.context = undefined
        await this.releaseLocal(undefined, context)
        return
      }
      stream = await mediaDevices.getUserMedia(MICROPHONE_CONSTRAINTS)
      if (operation !== this.generation) {
        if (this.context === context) this.context = undefined
        await this.releaseLocal(stream, context)
        return
      }
      const audioTrack = stream.getAudioTracks()[0]
      if (!audioTrack) throw new DOMException('No audio track was returned.', 'NotFoundError')
      if (context.state === 'suspended') await context.resume()
      if (context.state !== 'running') {
        throw new DOMException(`Audio context remained ${context.state}.`, 'InvalidStateError')
      }

      source = context.createMediaStreamSource(stream)
      gainNode = context.createGain()
      inputAnalyser = context.createAnalyser()
      outputAnalyser = context.createAnalyser()
      configureAnalyser(inputAnalyser)
      configureAnalyser(outputAnalyser)
      gainNode.gain.setValueAtTime(0, context.currentTime)
      source.connect(inputAnalyser)
      inputAnalyser.connect(gainNode)
      gainNode.connect(outputAnalyser)
      outputAnalyser.connect(context.destination)
      gainNode.gain.linearRampToValueAtTime(this.snapshot.gain, context.currentTime + 0.015)

      this.stream = stream
      this.source = source
      this.gainNode = gainNode
      this.inputAnalyser = inputAnalyser
      this.outputAnalyser = outputAnalyser
      this.mediaDevices = mediaDevices
      this.installLifecycleHandlers()

      const settings = audioTrack.getSettings() as MediaTrackSettings & { latency?: number }
      const baseLatency = finiteNumber(context.baseLatency)
      const outputLatency = finiteNumber(context.outputLatency)
      this.update({
        state: 'on',
        error: undefined,
        errorCode: undefined,
        telemetry: {
          contextState: context.state,
          contextSampleRate: finiteNumber(context.sampleRate),
          baseLatency,
          outputLatency,
          estimatedOutputLatency: sumDefined(baseLatency, outputLatency),
          outputDevice: classifyOutputDevice(context.sinkId),
          trackReadyState: audioTrack.readyState,
          trackEnabled: audioTrack.enabled,
          trackMuted: audioTrack.muted,
          trackSampleRate: finiteNumber(settings.sampleRate),
          trackChannelCount: finiteNumber(settings.channelCount),
          trackLatency: finiteNumber(settings.latency),
          echoCancellation: booleanSetting(settings.echoCancellation),
          noiseSuppression: booleanSetting(settings.noiseSuppression),
          autoGainControl: booleanSetting(settings.autoGainControl),
          startToActiveMs: Math.max(0, this.dependencies.now() - startedAt),
          inputRms: 0,
          inputPeak: 0,
          outputRms: 0,
          outputPeak: 0,
          signalDetected: false,
          silenceDurationMs: 0,
          outputTooHot: false,
          outputClipping: false,
        },
      })
      this.startMeter()
    } catch (reason) {
      if (this.context === context) this.context = undefined
      await this.releaseLocal(stream, context, source, gainNode, inputAnalyser, outputAnalyser)
      if (operation !== this.generation) return
      const classified = classifyMicrophoneError(reason)
      this.update({
        state: 'error',
        errorCode: classified.code,
        error: classified.message,
        telemetry: {},
      })
    }
  }

  async disable() {
    ++this.generation
    await this.releaseResources()
    this.update({ state: 'off', error: undefined, errorCode: undefined, telemetry: {} })
  }

  async dispose() {
    await this.disable()
    this.listeners.clear()
  }

  private installLifecycleHandlers() {
    if (!this.stream || !this.context || !this.mediaDevices) return
    for (const track of this.stream.getTracks()) {
      const handler = () => void this.fail(
        'device-lost',
        'The microphone disconnected or stopped. Reconnect it, then retry.',
      )
      track.addEventListener('ended', handler)
      this.trackEndHandlers.set(track, handler)
    }
    this.contextStateHandler = () => {
      if (this.snapshot.state === 'on'
        && this.context
        && (this.context.state === 'suspended' || this.context.state === 'interrupted')) {
        void this.fail(
          'context-suspended',
          'Audio monitoring was interrupted. Toggle the microphone to retry.',
        )
      }
    }
    this.context.addEventListener('statechange', this.contextStateHandler)
    this.deviceChangeHandler = () => void this.fail(
      'device-lost',
      'The microphone device changed. Toggle monitoring to reconnect safely.',
    )
    this.mediaDevices.addEventListener('devicechange', this.deviceChangeHandler)
  }

  private async fail(code: MicrophoneMonitorErrorCode, error: string) {
    if (this.snapshot.state !== 'on' && this.snapshot.state !== 'requesting') return
    ++this.generation
    this.update({ state: 'error', errorCode: code, error })
    await this.releaseResources()
  }

  private async releaseResources() {
    const stream = this.stream
    const context = this.context
    const source = this.source
    const gainNode = this.gainNode
    const inputAnalyser = this.inputAnalyser
    const outputAnalyser = this.outputAnalyser
    if (this.meterHandle !== undefined) this.dependencies.cancelMeter(this.meterHandle)
    if (context && this.contextStateHandler) {
      context.removeEventListener('statechange', this.contextStateHandler)
    }
    if (this.mediaDevices && this.deviceChangeHandler) {
      this.mediaDevices.removeEventListener('devicechange', this.deviceChangeHandler)
    }
    for (const [track, handler] of this.trackEndHandlers) {
      track.removeEventListener('ended', handler)
    }
    this.stream = undefined
    this.context = undefined
    this.source = undefined
    this.gainNode = undefined
    this.inputAnalyser = undefined
    this.outputAnalyser = undefined
    this.mediaDevices = undefined
    this.meterHandle = undefined
    this.meterStartedAt = undefined
    this.contextStateHandler = undefined
    this.deviceChangeHandler = undefined
    this.trackEndHandlers.clear()
    await this.releaseLocal(stream, context, source, gainNode, inputAnalyser, outputAnalyser)
  }

  private async releaseLocal(
    stream?: MediaStream,
    context?: MonitorAudioContext,
    source?: MediaStreamAudioSourceNode,
    gainNode?: GainNode,
    inputAnalyser?: AnalyserNode,
    outputAnalyser?: AnalyserNode,
  ) {
    try {
      if (gainNode && context) gainNode.gain.setValueAtTime(0, context.currentTime)
    } catch {}
    try { source?.disconnect() } catch {}
    try { inputAnalyser?.disconnect() } catch {}
    try { gainNode?.disconnect() } catch {}
    try { outputAnalyser?.disconnect() } catch {}
    for (const track of stream?.getTracks() ?? []) {
      try { track.stop() } catch {}
    }
    if (context && context.state !== 'closed') {
      try { await context.close() } catch {}
    }
  }

  private update(next: Partial<MicrophoneMonitorSnapshot>) {
    this.snapshot = { ...this.snapshot, ...next }
    for (const listener of this.listeners) listener(this.snapshot)
  }

  private startMeter() {
    if (!this.inputAnalyser || !this.outputAnalyser) return
    this.meterStartedAt = this.dependencies.now()
    const input = new Float32Array(this.inputAnalyser.fftSize)
    const output = new Float32Array(this.outputAnalyser.fftSize)
    this.meterHandle = this.dependencies.scheduleMeter(() => {
      if (this.snapshot.state !== 'on' || !this.inputAnalyser || !this.outputAnalyser) return
      this.inputAnalyser.getFloatTimeDomainData(input)
      this.outputAnalyser.getFloatTimeDomainData(output)
      const inputLevel = signalLevel(input)
      const outputLevel = signalLevel(output)
      const signalDetected = inputLevel.peak >= SIGNAL_THRESHOLD
      const track = this.stream?.getAudioTracks()[0]
      this.update({
        telemetry: {
          ...this.snapshot.telemetry,
          contextState: this.context?.state,
          trackReadyState: track?.readyState,
          trackEnabled: track?.enabled,
          trackMuted: track?.muted,
          inputRms: inputLevel.rms,
          inputPeak: inputLevel.peak,
          outputRms: outputLevel.rms,
          outputPeak: outputLevel.peak,
          signalDetected,
          outputTooHot: outputLevel.peak >= OUTPUT_TOO_HOT_THRESHOLD,
          outputClipping: outputLevel.peak >= OUTPUT_CLIPPING_THRESHOLD,
          silenceDurationMs: signalDetected
            ? 0
            : Math.max(0, this.dependencies.now() - (this.meterStartedAt ?? this.dependencies.now())),
        },
      })
      if (signalDetected) this.meterStartedAt = this.dependencies.now()
    })
  }

}

export function clampMonitorGain(value: number) {
  if (!Number.isFinite(value)) return DEFAULT_MONITOR_GAIN
  return Math.min(MAX_MONITOR_GAIN, Math.max(MIN_MONITOR_GAIN, value))
}

export function monitorGainDecibels(gain: number) {
  return gain > 0 ? 20 * Math.log10(gain) : Number.NEGATIVE_INFINITY
}

function configureAnalyser(analyser: AnalyserNode) {
  analyser.fftSize = 256
  analyser.smoothingTimeConstant = 0.35
}

export function signalLevel(samples: Float32Array) {
  let sumSquares = 0
  let peak = 0
  for (const sample of samples) {
    const magnitude = Math.abs(sample)
    sumSquares += sample * sample
    peak = Math.max(peak, magnitude)
  }
  return {
    rms: samples.length ? Math.sqrt(sumSquares / samples.length) : 0,
    peak,
  }
}

function finiteNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function sumDefined(first?: number, second?: number) {
  if (first === undefined && second === undefined) return undefined
  return (first ?? 0) + (second ?? 0)
}

function booleanSetting(value: unknown) {
  return typeof value === 'boolean' ? value : undefined
}

function classifyOutputDevice(sinkId: MonitorAudioContext['sinkId']) {
  if (sinkId === '') return 'system-default'
  if (typeof sinkId === 'string') return 'explicit-device'
  if (sinkId && typeof sinkId === 'object') return 'explicit-device'
  return 'unknown'
}
