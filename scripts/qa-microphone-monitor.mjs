import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  MAX_MONITOR_GAIN,
  MICROPHONE_CONSTRAINTS,
  MicrophoneMonitorController,
  classifyMicrophoneError,
  monitorGainForPlayerVolume,
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

class FakeTrack extends EventTarget {
  stopped = 0
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

class FakeContext extends EventTarget {
  state = 'suspended'
  currentTime = 2
  sampleRate = 48_000
  baseLatency = 0.012
  outputLatency = 0.018
  destination = new FakeNode()
  source = new FakeNode()
  gain = new FakeGain()
  resumes = 0
  closes = 0
  streams = []
  async resume() { this.resumes += 1; this.state = 'running' }
  createMediaStreamSource(stream) { this.streams.push(stream); return this.source }
  createGain() { return this.gain }
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
  const controller = new MicrophoneMonitorController({
    isSecureContext: () => true,
    getMediaDevices: () => mediaDevices,
    createAudioContext: () => {
      const context = new FakeContext()
      contexts.push(context)
      return context
    },
    now: () => (clock += 5),
  })
  return { controller, mediaDevices, contexts }
}

equal(monitorGainForPlayerVolume(1), MAX_MONITOR_GAIN, 'monitor gain is capped at the safe -12 dB baseline')
equal(monitorGainForPlayerVolume(0.5), 0.125, 'player volume predictably scales monitor gain')
equal(classifyMicrophoneError(new DOMException('', 'NotAllowedError')).code, 'permission-denied',
  'permission denial is classified')
equal(classifyMicrophoneError(new DOMException('', 'NotFoundError')).code, 'no-device',
  'missing device is classified')

{
  const { controller, mediaDevices, contexts } = createHarness()
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
  equal(contexts[0].source.connected, [contexts[0].gain], 'source connects directly to the gain node')
  equal(contexts[0].gain.connected, [contexts[0].destination], 'gain connects directly to destination')
  equal(controller.getSnapshot().state, 'on', 'permission success reaches on')
  equal(controller.getSnapshot().telemetry.estimatedOutputLatency, 0.03,
    'base and output latency are exposed only as an output estimate')
  controller.setPlayerVolume(0.4)
  equal(controller.getSnapshot().gain, 0.1, 'volume updates monitor gain')
  equal(contexts[0].gain.gain.calls.at(-1)[0], 'target', 'live gain changes use a short smoothing target')

  const unrelatedSongState = { playing: false, mode: 'instrumental' }
  unrelatedSongState.playing = true
  unrelatedSongState.mode = 'vocal'
  equal(controller.getSnapshot().state, 'on', 'song playback and mode changes do not affect monitoring')

  await controller.disable()
  equal(tracks.map((track) => track.stopped), [1, 1], 'disable stops every stream track')
  equal(contexts[0].closes, 1, 'disable closes the context')
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
