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
  contextSampleRate?: number
  baseLatency?: number
  outputLatency?: number
  estimatedOutputLatency?: number
  trackSampleRate?: number
  trackChannelCount?: number
  trackLatency?: number
  echoCancellation?: boolean
  noiseSuppression?: boolean
  autoGainControl?: boolean
  startToActiveMs?: number
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

export const MAX_MONITOR_GAIN = 0.25

type MonitorAudioContext = AudioContext & { outputLatency?: number }

interface MicrophoneMonitorDependencies {
  isSecureContext: () => boolean
  getMediaDevices: () => MediaDevices | undefined
  createAudioContext: () => MonitorAudioContext
  now: () => number
}

const defaultDependencies: MicrophoneMonitorDependencies = {
  isSecureContext: () => window.isSecureContext,
  getMediaDevices: () => navigator.mediaDevices,
  createAudioContext: () => new AudioContext({ latencyHint: 'interactive' }),
  now: () => performance.now(),
}

export function monitorGainForPlayerVolume(volume: number) {
  return Math.max(0, Math.min(1, volume)) * MAX_MONITOR_GAIN
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
    gain: monitorGainForPlayerVolume(0.82),
    telemetry: {},
  }
  private listeners = new Set<(snapshot: MicrophoneMonitorSnapshot) => void>()
  private generation = 0
  private stream?: MediaStream
  private context?: MonitorAudioContext
  private source?: MediaStreamAudioSourceNode
  private gainNode?: GainNode
  private mediaDevices?: MediaDevices
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

  setPlayerVolume(volume: number) {
    const gain = monitorGainForPlayerVolume(volume)
    this.update({ gain })
    if (this.gainNode && this.context) {
      this.gainNode.gain.setTargetAtTime(gain, this.context.currentTime, 0.015)
    }
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

      source = context.createMediaStreamSource(stream)
      gainNode = context.createGain()
      gainNode.gain.setValueAtTime(0, context.currentTime)
      source.connect(gainNode)
      gainNode.connect(context.destination)
      gainNode.gain.linearRampToValueAtTime(this.snapshot.gain, context.currentTime + 0.015)

      this.stream = stream
      this.source = source
      this.gainNode = gainNode
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
          contextSampleRate: finiteNumber(context.sampleRate),
          baseLatency,
          outputLatency,
          estimatedOutputLatency: sumDefined(baseLatency, outputLatency),
          trackSampleRate: finiteNumber(settings.sampleRate),
          trackChannelCount: finiteNumber(settings.channelCount),
          trackLatency: finiteNumber(settings.latency),
          echoCancellation: booleanSetting(settings.echoCancellation),
          noiseSuppression: booleanSetting(settings.noiseSuppression),
          autoGainControl: booleanSetting(settings.autoGainControl),
          startToActiveMs: Math.max(0, this.dependencies.now() - startedAt),
        },
      })
    } catch (reason) {
      if (this.context === context) this.context = undefined
      await this.releaseLocal(stream, context, source, gainNode)
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
    this.mediaDevices = undefined
    this.contextStateHandler = undefined
    this.deviceChangeHandler = undefined
    this.trackEndHandlers.clear()
    await this.releaseLocal(stream, context, source, gainNode)
  }

  private async releaseLocal(
    stream?: MediaStream,
    context?: MonitorAudioContext,
    source?: MediaStreamAudioSourceNode,
    gainNode?: GainNode,
  ) {
    try {
      if (gainNode && context) gainNode.gain.setValueAtTime(0, context.currentTime)
    } catch {}
    try { source?.disconnect() } catch {}
    try { gainNode?.disconnect() } catch {}
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
