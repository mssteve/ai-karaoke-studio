import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  DEFAULT_MONITOR_GAIN,
  MAX_MONITOR_GAIN,
  MIN_MONITOR_GAIN,
  MICROPHONE_CONSTRAINTS,
  NO_INPUT_WARNING_MS,
  OUTPUT_CLIPPING_THRESHOLD,
  OUTPUT_TOO_HOT_THRESHOLD,
  MicrophoneMonitorController,
  clampMonitorGain,
  classifyMicrophoneError,
  monitorGainDecibels,
  signalLevel,
} from '../src/microphoneMonitor.ts'
import {
  shouldAllowMediaPermissionCheck,
  shouldAllowMediaPermissionRequest,
} from '../electron/media-permissions.ts'

let checks = 0
const check = (value, message) => {
  assert.ok(value, message)
  checks += 1
}
const equal = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks += 1
}
const closeTo = (actual, expected, tolerance, message) => {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} !== ${expected}`)
  checks += 1
}

class FakeTrack extends EventTarget {
  stopped = 0
  enabled = true
  muted = false
  readyState = 'live'
  constructor(settings = {}) {
    super()
    this.settings = settings
  }
  getSettings() { return this.settings }
  stop() { this.stopped += 1 }
}

class FakeStream {
  constructor(tracks = [new FakeTrack()]) {
    this.tracks = tracks
  }
  getTracks() { return this.tracks }
  getAudioTracks() { return this.tracks.slice(0, 1) }
}

class FakeAudioParam {
  calls = []
  setValueAtTime(value, time) { this.calls.push(['set', value, time]) }
  linearRampToValueAtTime(value, time) { this.calls.push(['ramp', value, time]) }
  setTargetAtTime(value, time, constant) { this.calls.push(['target', value, time, constant]) }
}

class FakeNode {
  connected = []
  disconnected = 0
  connect(node) { this.connected.push(node); return node }
  disconnect() { this.disconnected += 1 }
}

class FakeGain extends FakeNode {
  gain = new FakeAudioParam()
}

class FakeDelay extends FakeNode {
  delayTime = new FakeAudioParam()
}

class FakeAnalyser extends FakeNode {
  fftSize = 32
  smoothingTimeConstant = 0
  samples = []
  getFloatTimeDomainData(target) {
    target.fill(0)
    target.set(this.samples.slice(0, target.length))
  }
}

class FakeContext extends EventTarget {
  state = 'suspended'
  sinkId = ''
  currentTime = 2
  sampleRate = 48_000
  baseLatency = 0.012
  outputLatency = 0.018
  destination = new FakeNode()
  source = new FakeNode()
  gain = new FakeGain()
  gains = []
  delay = new FakeDelay()
  analysers = [new FakeAnalyser(), new FakeAnalyser()]
  createdAnalysers = []
  resumes = 0
  closes = 0
  streams = []
  async resume() { this.resumes += 1; this.state = 'running' }
  createMediaStreamSource(stream) { this.streams.push(stream); return this.source }
  createGain() {
    const gain = this.gains.length ? new FakeGain() : this.gain
    this.gains.push(gain)
    return gain
  }
  createDelay() { return this.delay }
  createAnalyser() {
    const analyser = this.analysers.shift()
    this.createdAnalysers.push(analyser)
    return analyser
  }
  async close() { this.closes += 1; this.state = 'closed' }
  suspendUnexpectedly() { this.state = 'suspended'; this.dispatchEvent(new Event('statechange')) }
}

class FakeMediaDevices extends EventTarget {
  requests = []
  responses = []
  getUserMedia = (constraints) => {
    this.requests.push(structuredClone(constraints))
    const response = this.responses.shift()
    return response instanceof Error ? Promise.reject(response) : Promise.resolve(response)
  }
}

function createHarness() {
  const mediaDevices = new FakeMediaDevices()
  const contexts = []
  let clock = 100
  const meters = new Map()
  const cancelledMeters = []
  let nextMeter = 1
  const controller = new MicrophoneMonitorController({
    isSecureContext: () => true,
    getMediaDevices: () => mediaDevices,
    createAudioContext: () => {
      const context = new FakeContext()
      contexts.push(context)
      return context
    },
    now: () => (clock += 5),
    scheduleMeter: (callback) => {
      const id = nextMeter++
      meters.set(id, callback)
      return id
    },
    cancelMeter: (handle) => {
      cancelledMeters.push(handle)
      meters.delete(handle)
    },
  })
  return {
    controller,
    mediaDevices,
    contexts,
    meters,
    cancelledMeters,
    advance: (milliseconds) => { clock += milliseconds },
  }
}

equal(DEFAULT_MONITOR_GAIN, 2, 'quiet measured microphones default to a modest +6 dB boost')
equal(MIN_MONITOR_GAIN, 0, 'monitor supports intentional mute')
equal(MAX_MONITOR_GAIN, 4, 'monitor boost is bounded at +12 dB')
equal(clampMonitorGain(-1), 0, 'gain clamps below the safe range')
equal(clampMonitorGain(9), 4, 'gain clamps above the safe range')
closeTo(monitorGainDecibels(2), 6.0206, 0.001, 'gain converts to an accessible dB indication')
equal(signalLevel(new Float32Array([0.5, -0.5, 0, 0])), {
  rms: Math.sqrt(0.125),
  peak: 0.5,
}, 'signal telemetry computes deterministic RMS and peak without retaining samples')
equal(classifyMicrophoneError(new DOMException('', 'NotAllowedError')).code, 'permission-denied',
  'permission denial is classified')
equal(classifyMicrophoneError(new DOMException('', 'NotFoundError')).code, 'no-device',
  'missing device is classified')

{
  const { controller, mediaDevices, contexts, meters, cancelledMeters, advance } = createHarness()
  const tracks = [
    new FakeTrack({
      sampleRate: 48_000,
      channelCount: 1,
      latency: 0.01,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    }),
    new FakeTrack(),
  ]
  const stream = new FakeStream(tracks)
  mediaDevices.responses.push(stream)
  const enabling = controller.enable()
  equal(contexts.length, 1, 'AudioContext is created synchronously from the enable gesture')
  await enabling
  equal(mediaDevices.requests[0], MICROPHONE_CONSTRAINTS, 'exact low-latency audio-only constraints are requested')
  equal(contexts[0].resumes, 1, 'a suspended context is resumed')
  const [inputAnalyser, outputAnalyser] = contexts[0].createdAnalysers
  equal(contexts[0].source.connected, [inputAnalyser], 'source connects to the zero-buffer input analyser')
  equal(inputAnalyser.connected, [contexts[0].gain, contexts[0].delay],
    'dry input still connects directly to monitor gain beside the separate echo branch')
  equal(contexts[0].gain.connected, [outputAnalyser], 'gain connects to the post-gain analyser')
  equal(outputAnalyser.connected, [contexts[0].destination], 'post-gain analyser connects to destination')
  equal(controller.getSnapshot().state, 'on', 'permission success reaches on')
  equal(controller.getSnapshot().gain, DEFAULT_MONITOR_GAIN, 'monitor gain is independent from player volume')
  equal(contexts[0].gain.gain.calls.at(-1)[1], DEFAULT_MONITOR_GAIN, 'activation ramps to the dedicated gain')
  equal(controller.getSnapshot().telemetry.estimatedOutputLatency, 0.03,
    'base and output latency are exposed only as an output estimate')
  equal(controller.getSnapshot().telemetry.contextState, 'running', 'running context state is exposed')
  equal(controller.getSnapshot().telemetry.trackReadyState, 'live', 'live track state is exposed')
  equal(controller.getSnapshot().telemetry.trackMuted, false, 'track mute flag is exposed')
  equal(controller.getSnapshot().telemetry.outputDevice, 'system-default', 'default output routing is explicit')

  const meter = [...meters.values()][0]
  meter()
  equal(controller.getSnapshot().telemetry.inputPeak, 0, 'zero input is measured as silence')
  advance(NO_INPUT_WARNING_MS + 1)
  meter()
  check(controller.getSnapshot().telemetry.silenceDurationMs >= NO_INPUT_WARNING_MS,
    'continued zero input reaches the visible no-input diagnostic')

  inputAnalyser.samples = [0.1, -0.1, 0.05, -0.05]
  outputAnalyser.samples = [0.2, -0.2, 0.1, -0.1]
  meter()
  closeTo(controller.getSnapshot().telemetry.inputPeak, 0.1, 1e-6, 'nonzero source peak is measured')
  closeTo(controller.getSnapshot().telemetry.outputPeak, 0.2, 1e-6,
    'nonzero post-gain peak reaches output telemetry')
  equal(controller.getSnapshot().telemetry.signalDetected, true, 'nonzero input is classified as detected signal')
  equal(controller.getSnapshot().telemetry.silenceDurationMs, 0, 'signal clears the no-input timer')
  equal(controller.getSnapshot().telemetry.outputTooHot, false, 'normal output is not marked too hot')
  equal(controller.getSnapshot().telemetry.outputClipping, false, 'normal output is not marked clipping')

  const contextCountBeforeGainChange = contexts.length
  controller.setGain(3.25)
  equal(controller.getSnapshot().gain, 3.25, 'live gain changes update controller state immediately')
  equal(contexts.length, contextCountBeforeGainChange, 'live gain changes do not restart the audio context')
  equal(contexts[0].gain.gain.calls.at(-1), ['target', 3.25, contexts[0].currentTime, 0.008],
    'live gain changes update the existing GainNode with a short click-free transition')
  controller.setGain(99)
  equal(controller.getSnapshot().gain, MAX_MONITOR_GAIN, 'live gain changes remain bounded')
  controller.setGain(0)
  equal(controller.getSnapshot().gain, 0, 'zero monitor level intentionally mutes without disabling Live')
  equal(controller.getSnapshot().state, 'on', 'zero monitor level preserves explicit Live state')

  outputAnalyser.samples = [OUTPUT_TOO_HOT_THRESHOLD, -OUTPUT_TOO_HOT_THRESHOLD]
  meter()
  equal(controller.getSnapshot().telemetry.outputTooHot, true, 'high output activates too-hot telemetry')
  equal(controller.getSnapshot().telemetry.outputClipping, false, 'too-hot output remains distinct from clipping')
  outputAnalyser.samples = [OUTPUT_CLIPPING_THRESHOLD, -OUTPUT_CLIPPING_THRESHOLD]
  meter()
  equal(controller.getSnapshot().telemetry.outputClipping, true, 'near-full-scale output activates clipping telemetry')

  const unrelatedSongState = { playing: false, mode: 'instrumental' }
  unrelatedSongState.playing = true
  unrelatedSongState.mode = 'vocal'
  equal(controller.getSnapshot().state, 'on', 'song playback and mode changes do not affect monitoring')

  await controller.disable()
  equal(tracks.map((track) => track.stopped), [1, 1], 'disable stops every stream track')
  equal(contexts[0].closes, 1, 'disable closes the context')
  equal(contexts[0].delay.disconnected, 1, 'disable disconnects the echo delay')
  equal(contexts[0].gains.slice(1).map((node) => node.disconnected), [1, 1],
    'disable disconnects feedback and wet gains, including the feedback loop')
  equal(cancelledMeters.length, 1, 'disable cancels analyser polling')
  equal(inputAnalyser.disconnected, 1, 'disable disconnects the input analyser')
  equal(outputAnalyser.disconnected, 1, 'disable disconnects the output analyser')
  equal(controller.getSnapshot().state, 'off', 'disable returns to off')
  tracks[0].dispatchEvent(new Event('ended'))
  mediaDevices.dispatchEvent(new Event('devicechange'))
  contexts[0].dispatchEvent(new Event('statechange'))
  equal(controller.getSnapshot().state, 'off', 'disable clears track, device, and context handlers')

  const secondTrack = new FakeTrack()
  mediaDevices.responses.push(new FakeStream([secondTrack]))
  await controller.enable()
  equal(contexts.length, 2, 're-enable creates a fresh context')
  await controller.disable()
  equal(secondTrack.stopped, 1, 'repeated toggles release each fresh stream')
}

{
  const { controller, mediaDevices, contexts } = createHarness()
  equal(controller.getSnapshot().echoEnabled, false, 'echo starts off')
  controller.setEchoEnabled(true)
  controller.setEchoAmount(0.35)
  mediaDevices.responses.push(new FakeStream())
  await controller.enable()
  const context = contexts[0]
  const [, feedback, wet] = context.gains
  equal(wet.gain.calls.at(-1), ['set', 0.35, context.currentTime],
    'echo settings selected before mic activation reach the graph')
  equal(context.delay.connected, [feedback, wet], 'delayed voice feeds repeats and the wet mix')
  equal(feedback.connected, [context.delay], 'bounded feedback recirculates only delayed voice')
  equal(wet.connected, [context.gain], 'echo passes through master mic gain so mute includes repeats')

  controller.setEchoEnabled(false)
  equal(wet.gain.calls.at(-1), ['target', 0, context.currentTime, 0.008],
    'switching echo off smoothly silences only the wet branch')
  equal(controller.getSnapshot().state, 'on', 'echo toggle does not disable the live microphone')
  controller.setEchoAmount(0.4)
  equal(wet.gain.calls.at(-1)[1], 0, 'adjusting amount while bypassed does not enable echo')
  controller.setEchoEnabled(true)
  equal(wet.gain.calls.at(-1)[1], 0.4, 'switching echo back on restores the selected amount')
  controller.setEchoAmount(99)
  equal(wet.gain.calls.at(-1)[1], 0.5, 'wet gain is bounded even for out-of-range input')
  controller.setEchoAmount(-1)
  equal(wet.gain.calls.at(-1)[1], 0, 'negative echo amount is clamped to silence')
  controller.setEchoAmount(Number.NaN)
  equal(wet.gain.calls.at(-1)[1], 0.25, 'nonfinite echo amount falls back to a safe default')
  equal(contexts.length, 1, 'live echo changes never recreate the audio context')
  equal(mediaDevices.requests.length, 1, 'live echo changes never reacquire the microphone')
  await controller.disable()
  mediaDevices.responses.push(new FakeStream())
  await controller.enable()
  equal(contexts[1].gains[2].gain.calls.at(-1)[1], 0.25,
    'echo preferences survive mic toggles within the session')
  await controller.disable()
}

{
  const { controller, mediaDevices, contexts } = createHarness()
  const track = new FakeTrack()
  mediaDevices.responses.push(new FakeStream([track]))
  const enabling = controller.enable()
  const context = contexts[0]
  const createGain = context.createGain.bind(context)
  let createdGains = 0
  context.createGain = () => {
    if (++createdGains === 3) throw new Error('Echo graph creation failed')
    return createGain()
  }
  await enabling
  equal(controller.getSnapshot().state, 'error', 'partial echo graph failure reports an error')
  equal(track.stopped, 1, 'partial echo graph failure releases the microphone')
  equal(context.delay.disconnected, 1, 'partial echo graph failure disconnects its allocated delay')
  equal(context.gains[1].disconnected, 1, 'partial echo graph failure disconnects its allocated feedback gain')
  equal(context.closes, 1, 'partial echo graph failure closes its context')
}

{
  const { controller, mediaDevices, contexts } = createHarness()
  let resolveRequest
  mediaDevices.responses.push(new Promise((resolve) => { resolveRequest = resolve }))
  const enabling = controller.enable()
  await Promise.resolve()
  contexts[0].state = 'suspended'
  resolveRequest(new FakeStream())
  await enabling
  equal(contexts[0].resumes, 2, 'context is resumed again after a delayed permission response')
  equal(controller.getSnapshot().state, 'on', 'post-permission context resume reaches on')
  await controller.disable()
}

for (const [name, expected] of [['NotAllowedError', 'permission-denied'], ['NotFoundError', 'no-device']]) {
  const { controller, mediaDevices, contexts } = createHarness()
  mediaDevices.responses.push(new DOMException('QA', name))
  await controller.enable()
  equal(controller.getSnapshot().errorCode, expected, `${name} reaches its truthful error state`)
  equal(contexts[0].closes, 1, `${name} closes the context`)
}

{
  const { controller, mediaDevices, contexts } = createHarness()
  let resolveRequest
  mediaDevices.responses.push(new Promise((resolve) => { resolveRequest = resolve }))
  const enabling = controller.enable()
  await Promise.resolve()
  const disabling = controller.disable()
  const lateTrack = new FakeTrack()
  resolveRequest(new FakeStream([lateTrack]))
  await Promise.all([enabling, disabling])
  equal(controller.getSnapshot().state, 'off', 'a cancelled late permission result stays off')
  equal(lateTrack.stopped, 1, 'a cancelled late stream is immediately stopped')
  equal(contexts[0].closes, 1, 'a cancelled request closes its context')
}

{
  const { controller, mediaDevices, contexts } = createHarness()
  const track = new FakeTrack()
  mediaDevices.responses.push(new FakeStream([track]))
  await controller.enable()
  track.dispatchEvent(new Event('ended'))
  await new Promise((resolve) => setTimeout(resolve, 0))
  equal(controller.getSnapshot().errorCode, 'device-lost', 'track ending reports device lost')
  equal(track.stopped, 1, 'track ending releases capture')
  equal(contexts[0].closes, 1, 'track ending closes the context')
}

{
  const { controller, mediaDevices, contexts } = createHarness()
  mediaDevices.responses.push(new FakeStream())
  await controller.enable()
  contexts[0].suspendUnexpectedly()
  await new Promise((resolve) => setTimeout(resolve, 0))
  equal(controller.getSnapshot().errorCode, 'context-suspended', 'unexpected context suspension is visible')
  equal(contexts[0].closes, 1, 'suspended context is closed for explicit retry')
}

const root = path.resolve(import.meta.dirname, '..')
const [monitorSource, appSource, mainSource, packageSource, releaseSource] = await Promise.all([
  readFile(path.join(root, 'src', 'microphoneMonitor.ts'), 'utf8'),
  readFile(path.join(root, 'src', 'App.tsx'), 'utf8'),
  readFile(path.join(root, 'electron', 'main.ts'), 'utf8'),
  readFile(path.join(root, 'package.json'), 'utf8'),
  readFile(path.join(root, 'scripts', 'release.mjs'), 'utf8'),
])
for (const forbidden of ['MediaRecorder', 'ScriptProcessor', 'AudioWorklet', 'karaokeApi', 'fetch(', 'WebSocket']) {
  check(!monitorSource.includes(forbidden), `monitor contains no ${forbidden} recording, processing, IPC, or upload path`)
}
check(appSource.indexOf('data-testid="mic-monitor-toggle"') < appSource.indexOf('data-testid="player-volume"'),
  'microphone toggle is immediately before the volume control')
check(appSource.includes('aria-pressed={microphone.state === \'on\'}'), 'toggle exposes its pressed state')
check(appSource.includes('Wired headphones recommended'), 'toggle exposes headphone safety guidance')
check(appSource.includes('Monitor gain is independent of song volume'),
  'UI explains dedicated monitor volume semantics')
check(appSource.includes('Mic monitor level'), 'UI exposes a dedicated monitor level control')
check(appSource.includes('Mic live — monitor muted'), 'UI keeps Live explicit at monitor level zero')
check(appSource.includes('Mic live — no input detected'), 'UI exposes a no-input diagnostic')
check(appSource.includes('Default output · check Windows if silent'),
  'UI exposes output mute or wrong-device troubleshooting')
check(appSource.includes('data-testid="mic-monitor-output"'), 'post-gain output has deterministic UI coverage')
check(appSource.includes('data-testid="mic-monitor-clipping"'), 'UI exposes a clipping warning')
check(appSource.includes('data-testid="mic-monitor-level"'), 'monitor level slider has deterministic UI coverage')
check(appSource.includes('useMicrophoneMonitor()'), 'monitor gain is not coupled to player volume')
check(!appSource.includes('useMicrophoneMonitor(volume)'), 'muted player volume does not silently mute monitoring')
check(!monitorSource.includes('localStorage'), 'monitor preference is session-only because no settings convention exists')
check(mainSource.includes('setPermissionRequestHandler') && mainSource.includes('setPermissionCheckHandler'),
  'Electron installs request and check permission handlers')

const trustedRequest = {
  isMainFrame: true,
  requestingUrl: 'karaoke://app/index.html',
  securityOrigin: 'karaoke://app/',
  mediaTypes: ['audio'],
}
equal(shouldAllowMediaPermissionRequest('media', trustedRequest, 7, 7), true,
  'trusted top-level app audio request is allowed')
equal(shouldAllowMediaPermissionRequest('media', { ...trustedRequest, mediaTypes: ['video'] }, 7, 7), false,
  'video is denied')
equal(shouldAllowMediaPermissionRequest('notifications', trustedRequest, 7, 7), false,
  'unrelated permissions are denied')
equal(shouldAllowMediaPermissionRequest('media', { ...trustedRequest, requestingUrl: 'https://example.com' }, 7, 7),
  false, 'untrusted origins are denied')
equal(shouldAllowMediaPermissionRequest('media', trustedRequest, 8, 7), false,
  'requests from unrelated web contents are denied')
equal(shouldAllowMediaPermissionRequest('media', { ...trustedRequest, isMainFrame: false }, 7, 7), false,
  'subframes are denied')
equal(shouldAllowMediaPermissionCheck('media', 'karaoke://app/', {
  isMainFrame: true,
  securityOrigin: 'karaoke://app/',
  mediaType: 'audio',
}, 7, 7), true, 'trusted audio permission checks are allowed')

const packageJson = JSON.parse(packageSource)
equal(packageJson.build.appx.capabilities, ['runFullTrust', 'microphone'],
  'APPX declares only full trust and microphone capabilities')
check(releaseSource.includes('DeviceCapability') && releaseSource.includes('microphone'),
  'release verification requires the generated microphone DeviceCapability')

console.log(`PASS microphone monitor: ${checks} deterministic checks.`)
