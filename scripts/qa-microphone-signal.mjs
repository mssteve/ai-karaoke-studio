import { spawn } from 'node:child_process'
import { copyFile, cp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { sendCommand } from './control.mjs'
import { verifyLocalElectronEntry } from './local-electron-entry.mjs'

const SIGNAL_THRESHOLD = 0.001
const DEFAULT_MONITOR_GAIN = 2
const MAX_SAFE_MONITOR_GAIN = 4
const FIXED_ATTENUATION_BASELINE = 0.35
const output = path.resolve(process.argv[2] ?? 'scripts/qa-artifacts/microphone-signal')
const executable = path.resolve('node_modules/electron/dist/electron.exe')
const entry = path.resolve('dist-electron/main.js')
const profile = path.join(output, 'profile')
const queueSeedProfile = path.resolve('scripts/qa-artifacts/queue-history-seed/profile')
let child

const safeHeadphones = process.env.KARAOKE_MIC_SAFE_HEADPHONES === '1'
const lowDurationTelemetry = process.env.KARAOKE_MIC_LOW_DURATION_TELEMETRY === '1'
if (!safeHeadphones && !lowDurationTelemetry) {
  throw new Error(
    'Real microphone signal QA requires confirmed wired headphones or an explicitly accepted short telemetry run. '
    + 'Set KARAOKE_MIC_SAFE_HEADPHONES=1 after verifying headphones, or '
    + 'KARAOKE_MIC_LOW_DURATION_TELEMETRY=1 for objective low-duration telemetry without an audibility claim.',
  )
}

async function waitFor(check, description, timeoutMs = 30_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await check()
      if (value) return value
    } catch {}
    await delay(100)
  }
  throw new Error(`${description} was not observed`)
}

try {
  await rm(output, { recursive: true, force: true })
  await mkdir(output, { recursive: true })
  try {
    await cp(queueSeedProfile, profile, { recursive: true })
  } catch {
    await mkdir(profile, { recursive: true })
  }
  await verifyLocalElectronEntry(executable, entry)
  process.env.KARAOKE_AUTOMATION_PIPE = `\\\\.\\pipe\\karaoke-studio-mic-signal-${process.pid}`
  child = spawn(executable, [entry, `--user-data-dir=${profile}`, '--enable-private-automation'], {
    cwd: path.dirname(executable),
    stdio: 'ignore',
    env: process.env,
  })
  await waitFor(() => sendCommand({ action: 'status' }, { timeoutMs: 750 }), 'application startup')
  const firstSong = await sendCommand({
    action: 'ui',
    uiAction: 'exists',
    selector: '[data-testid="song-row"]',
  })
  if (firstSong.exists) {
    await sendCommand({ action: 'ui', uiAction: 'click', selector: '[data-testid="song-row"]' })
    await waitFor(async () => {
      const control = await sendCommand({
        action: 'ui',
        uiAction: 'snapshot',
        selector: '[data-testid="playback-toggle"]',
      })
      return control.disabled ? undefined : control
    }, 'selected song playback control')
    await sendCommand({ action: 'ui', uiAction: 'click', selector: '[data-testid="playback-toggle"]' })
    await waitFor(async () => {
      const audio = await sendCommand({ action: 'ui', uiAction: 'snapshot', selector: 'audio' })
      return audio.media && !audio.media.paused ? audio : undefined
    }, 'concurrent music playback')
  }
  await sendCommand({
    action: 'ui',
    uiAction: 'set-value',
    selector: '[data-testid="player-volume"]',
    uiValue: '0',
  })
  await sendCommand({
    action: 'ui',
    uiAction: 'click',
    selector: '[data-testid="mic-monitor-toggle"]',
  })
  await waitFor(async () => {
    const snapshot = await sendCommand({
      action: 'ui',
      uiAction: 'snapshot',
      selector: '[data-testid="mic-monitor-state"]',
    })
    return snapshot.dataset?.contextState === 'running' ? snapshot : undefined
  }, 'running microphone graph')

  async function measure() {
    const samples = []
    for (let index = 0; index < 4; index += 1) {
      const snapshot = await sendCommand({
        action: 'ui',
        uiAction: 'snapshot',
        selector: '[data-testid="mic-monitor-state"]',
      })
      samples.push({
        inputRms: Number(snapshot.dataset.inputRms),
        inputPeak: Number(snapshot.dataset.inputPeak),
        outputRms: Number(snapshot.dataset.outputRms),
        outputPeak: Number(snapshot.dataset.outputPeak),
      })
      await delay(100)
    }
    const maximum = (key) => Math.max(...samples.map((sample) => sample[key]))
    return {
      inputRmsMax: maximum('inputRms'),
      inputPeakMax: maximum('inputPeak'),
      outputRmsMax: maximum('outputRms'),
      outputPeakMax: maximum('outputPeak'),
    }
  }
  const defaultLevel = await measure()
  const detectedCapture = await sendCommand({ action: 'screenshot' })
  const detectedScreenshot = path.join(output, 'microphone-signal-detected.png')
  await copyFile(detectedCapture.path, detectedScreenshot)
  await sendCommand({
    action: 'ui',
    uiAction: 'set-value',
    selector: '[data-testid="mic-monitor-level"]',
    uiValue: String(MAX_SAFE_MONITOR_GAIN),
  })
  await delay(150)
  const maximumLevel = await measure()
  await sendCommand({
    action: 'ui',
    uiAction: 'set-value',
    selector: '[data-testid="mic-monitor-level"]',
    uiValue: '0',
  })
  await delay(250)
  const mutedMonitor = await measure()
  const mutedState = await sendCommand({
    action: 'ui',
    uiAction: 'snapshot',
    selector: '[data-testid="mic-monitor-state"]',
  })
  await sendCommand({
    action: 'ui',
    uiAction: 'set-value',
    selector: '[data-testid="mic-monitor-level"]',
    uiValue: String(DEFAULT_MONITOR_GAIN),
  })
  await delay(150)
  await sendCommand({
    action: 'ui',
    uiAction: 'set-value',
    selector: '[data-testid="player-volume"]',
    uiValue: '0.82',
  })
  const concurrentMusicLevel = await measure()
  const status = await sendCommand({ action: 'status' })
  const finalState = await sendCommand({
    action: 'ui',
    uiAction: 'snapshot',
    selector: '[data-testid="mic-monitor-state"]',
  })
  const measurements = {
    contextState: finalState.dataset.contextState,
    contextSampleRate: Number(finalState.dataset.contextSampleRate),
    trackState: finalState.dataset.trackState,
    trackMuted: finalState.dataset.trackMuted === 'true',
    trackEnabled: finalState.dataset.trackEnabled === 'true',
    trackSampleRate: Number(finalState.dataset.trackSampleRate),
    trackChannelCount: Number(finalState.dataset.trackChannelCount),
    trackLatency: Number(finalState.dataset.trackLatency),
    echoCancellation: finalState.dataset.echoCancellation === 'true',
    noiseSuppression: finalState.dataset.noiseSuppression === 'true',
    autoGainControl: finalState.dataset.autoGainControl === 'true',
    baseLatency: Number(finalState.dataset.baseLatency),
    outputLatency: Number(finalState.dataset.outputLatency),
    monitorGain: Number(finalState.dataset.monitorGain),
    outputDevice: finalState.dataset.outputDevice,
    defaultLevel,
    maximumLevel,
    mutedMonitor,
    concurrentMusicLevel,
    webContentsAudioMuted: status.window.audioMuted,
    webContentsCurrentlyAudible: status.window.currentlyAudible,
  }
  if (defaultLevel.inputPeakMax < SIGNAL_THRESHOLD
    || maximumLevel.inputPeakMax <= 0
    || defaultLevel.outputPeakMax <= 0
    || maximumLevel.outputPeakMax <= 0) {
    throw new Error(`No nonzero default-microphone signal reached the output graph: ${JSON.stringify(measurements)}`)
  }
  if (measurements.trackMuted || !measurements.trackEnabled
    || measurements.trackState !== 'live' || measurements.contextState !== 'running') {
    throw new Error(`Microphone graph was not live: ${JSON.stringify(measurements)}`)
  }
  if (measurements.monitorGain !== DEFAULT_MONITOR_GAIN) {
    throw new Error(`Monitor did not return to the ${DEFAULT_MONITOR_GAIN} default: ${measurements.monitorGain}.`)
  }
  if (measurements.outputDevice !== 'system-default') {
    throw new Error(`Monitor did not use the system default output: ${measurements.outputDevice}.`)
  }
  if (measurements.webContentsAudioMuted) {
    throw new Error('Electron webContents audio output is muted.')
  }
  for (const [phase, expectedGain] of [
    [defaultLevel, DEFAULT_MONITOR_GAIN],
    [maximumLevel, MAX_SAFE_MONITOR_GAIN],
    [concurrentMusicLevel, DEFAULT_MONITOR_GAIN],
  ]) {
    const ratio = phase.inputPeakMax > 0 ? phase.outputPeakMax / phase.inputPeakMax : 0
    if (Math.abs(ratio - expectedGain) > 0.08) {
      throw new Error(`Post-gain signal ratio ${ratio} did not match monitor gain ${expectedGain}.`)
    }
  }
  if (defaultLevel.outputPeakMax <= defaultLevel.inputPeakMax * FIXED_ATTENUATION_BASELINE * 2) {
    throw new Error('Default monitor output was not meaningfully above the rejected 0.35 attenuation result.')
  }
  if (maximumLevel.outputPeakMax >= 0.98) {
    throw new Error(`Maximum boost clipped during the measured speech window: ${maximumLevel.outputPeakMax}.`)
  }
  if (mutedMonitor.outputPeakMax > 0.0001 || mutedState.dataset.monitorGain !== '0.000'
    || mutedState.dataset.contextState !== 'running') {
    throw new Error(`Level zero did not mute while retaining Live state: ${JSON.stringify({ mutedMonitor, mutedState })}`)
  }
  const phaseGainDelta = Math.abs(
    (defaultLevel.outputPeakMax / defaultLevel.inputPeakMax)
    - (concurrentMusicLevel.outputPeakMax / concurrentMusicLevel.inputPeakMax),
  )
  if (phaseGainDelta > 0.08) {
    throw new Error(`Song-volume changes altered microphone monitor gain by ${phaseGainDelta}.`)
  }
  const mediaState = firstSong.exists
    ? await sendCommand({ action: 'ui', uiAction: 'snapshot', selector: 'audio' })
    : undefined
  if (firstSong.exists && mediaState.media?.paused) {
    throw new Error(`Music was not playing concurrently with microphone monitoring: ${JSON.stringify(mediaState.media)}`)
  }

  const capture = await sendCommand({ action: 'screenshot' })
  const screenshot = path.join(output, 'microphone-signal-live.png')
  await copyFile(capture.path, screenshot)
  if ((await stat(screenshot)).size === 0) throw new Error('Rendered screenshot is empty.')
  await sendCommand({
    action: 'ui',
    uiAction: 'click',
    selector: '[data-testid="mic-monitor-toggle"]',
  })
  const off = await waitFor(async () => {
    const snapshot = await sendCommand({
      action: 'ui',
      uiAction: 'snapshot',
      selector: '[data-testid="mic-monitor-toggle"]',
    })
    return snapshot.ariaLabel === 'Turn microphone monitor on' ? snapshot : undefined
  }, 'microphone cleanup')
  const diagnostics = await sendCommand({ action: 'diagnostics' })
  const report = {
    verdict: diagnostics.rendererErrorCount === 0 && off ? 'PASS' : 'FAIL',
    generatedAt: new Date().toISOString(),
    measurements,
    screenshots: [
      path.relative(process.cwd(), detectedScreenshot),
      path.relative(process.cwd(), screenshot),
    ],
    rendererErrorCount: diagnostics.rendererErrorCount,
    concurrentMusic: mediaState?.media,
    privacy: 'Only aggregate RMS/peak values were observed; no audio samples were recorded or persisted.',
    safetyMode: safeHeadphones ? 'confirmed-wired-headphones' : 'low-duration-objective-telemetry',
    audibility: 'Graph/output activity only; physical audibility and feedback acceptance require a human check.',
  }
  await writeFile(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(`PASS default microphone signal: ${JSON.stringify(measurements)}`)
} finally {
  if (child && child.exitCode === null) {
    child.kill()
    await waitFor(() => child.exitCode !== null, 'application shutdown', 8_000).catch(() => undefined)
  }
}
