import { execFile, spawn } from 'node:child_process'
import { cp, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { sendCommand } from './control.mjs'

const execFileAsync = promisify(execFile)
const args = parseArgs(process.argv.slice(2))
const executable = path.resolve(args.app)
const outputRoot = path.resolve(args.output)
const profile = path.join(outputRoot, 'profile')
const modes = ['original', 'enhanced', 'vocal', 'instrumental']
const cases = []
let child

function parseArgs(values) {
  const parsed = {}
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (value === '--app') parsed.app = values[++index]
    else if (value === '--electron-entry') parsed.electronEntry = values[++index]
    else if (value === '--profile') parsed.profile = values[++index]
    else if (value === '--output') parsed.output = values[++index]
    else throw new Error(`Unknown argument: ${value}`)
  }
  if (!parsed.app || !parsed.profile || !parsed.output) {
    throw new Error('--app, --profile, and --output are required.')
  }
  return parsed
}

function record(id, passed, evidence, details) {
  cases.push({
    id,
    status: passed ? 'passed' : 'failed',
    evidence,
    ...(details === undefined ? {} : { details }),
  })
  console.log(`${passed ? 'PASS' : 'FAIL'} ${id}: ${evidence}`)
}

async function waitFor(check, description, timeoutMs = 10_000) {
  const started = Date.now()
  let lastError
  while (Date.now() - started < timeoutMs) {
    try {
      const result = await check()
      if (result) return result
    } catch (error) {
      lastError = error
    }
    await delay(50)
  }
  throw new Error(`${description} not observed.${lastError ? ` ${lastError.message}` : ''}`)
}

function ui(uiAction, selector, uiValue) {
  return sendCommand({ action: 'ui', uiAction, selector, uiValue })
}

async function snapshot(selector) {
  return ui('snapshot', selector)
}

async function position() {
  return Number((await snapshot('[data-testid="playback-seek"]')).value)
}

async function mediaState() {
  return (await snapshot('audio')).media
}

async function diagnostics() {
  return sendCommand({ action: 'diagnostics' })
}

async function waitForMode(mode) {
  return waitFor(async () => {
    const state = await snapshot(`[data-testid="mode-${mode}"]`)
    return state.className.includes('active') ? state : undefined
  }, `${mode} mode`)
}

async function setMode(mode) {
  await ui('click', `[data-testid="mode-${mode}"]`)
  await waitForMode(mode)
}

async function setPlaying(playing) {
  const expected = playing ? 'Pause' : 'Play'
  const current = await snapshot('[data-testid="playback-toggle"]')
  if (current.ariaLabel !== expected) await ui('click', '[data-testid="playback-toggle"]')
  await waitFor(async () => {
    const state = await snapshot('[data-testid="playback-toggle"]')
    return state.ariaLabel === expected ? state : undefined
  }, `${expected} playback state`)
}

function parseClock(value) {
  const [minutes, seconds] = value.split(':').map(Number)
  return minutes * 60 + seconds
}

async function stopApp() {
  if (!child || child.exitCode !== null) return
  const pid = child.pid
  await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-Command',
    `$process = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($process) { $null = $process.CloseMainWindow(); $process.WaitForExit(5000) }`,
  ])
  if (child.exitCode === null) {
    await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`,
    ])
  }
}

async function listeningPorts(pid) {
  const script = `
$ids = @(${pid})
do {
  $next = @(Get-CimInstance Win32_Process | Where-Object {
    $ids -contains $_.ParentProcessId -and $ids -notcontains $_.ProcessId
  } | Select-Object -ExpandProperty ProcessId)
  $ids += $next
} while ($next.Count -gt 0)
@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object {
  $ids -contains $_.OwningProcess
} | Select-Object LocalAddress, LocalPort, OwningProcess) | ConvertTo-Json -Compress
`
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded])
  return stdout.trim() ? JSON.parse(stdout) : []
}

async function main() {
  await mkdir(outputRoot, { recursive: true })
  await cp(path.resolve(args.profile), profile, { recursive: true })
  try {
    await sendCommand({ action: 'status' }, { timeoutMs: 500 })
    throw new Error('A pre-existing Karaoke Studio automation pipe is active.')
  } catch (error) {
    if (error.message === 'A pre-existing Karaoke Studio automation pipe is active.') throw error
  }
  const launchArgs = [`--user-data-dir=${profile}`, '--enable-private-automation']
  if (args.electronEntry) launchArgs.unshift(path.resolve(args.electronEntry))
  child = spawn(executable, launchArgs, {
    cwd: path.dirname(executable),
    stdio: 'ignore',
  })
  const status = await waitFor(
    () => sendCommand({ action: 'status' }, { timeoutMs: 500 }),
    'private automation pipe',
    30_000,
  )
  const ports = await listeningPorts(child.pid)
  record('private-no-port', ports.length === 0, `Process tree listening TCP endpoints: ${ports.length}.`)

  const song = status.songs.find((candidate) =>
    modes.every((mode) => candidate.versions[mode]))
  if (!song) throw new Error('No song with all four modes is available in the supplied profile.')
  await ui('click', `[data-testid="song-row"][data-song-id="${song.id}"]`)
  await waitFor(async () => {
    const state = await sendCommand({ action: 'status' })
    return state.playback?.songId === song.id ? state : undefined
  }, 'processed song selection')
  await delay(1_000)
  await waitFor(async () => {
    const duration = parseClock((await snapshot('.timeline span:last-child')).text)
    return duration > 0 ? duration : undefined
  }, 'selected song metadata')

  const playingEvidence = []
  await setMode('original')
  await setPlaying(true)
  await waitFor(async () => (await position()) >= 0.6, 'natural playback progress')
  for (const mode of ['enhanced', 'vocal', 'instrumental', 'original']) {
    const before = await position()
    await setMode(mode)
    await delay(300)
    const after = await position()
    const state = await snapshot('[data-testid="playback-toggle"]')
    const media = await mediaState()
    const controller = (await sendCommand({ action: 'status' })).playback
    const delta = after - before
    const passed = state.ariaLabel === 'Pause' && delta >= -0.12 && delta <= 0.45
    playingEvidence.push({
      passed,
      text: `${mode}: ${before.toFixed(2)}s→${after.toFixed(2)}s, ${state.ariaLabel}`
        + (passed ? '' : `, media=${JSON.stringify(media)}, controller=${JSON.stringify(controller)}`),
    })
  }
  await setPlaying(false)
  record('playing-switches',
    playingEvidence.every((item) => item.passed),
    `${playingEvidence.map((item) => item.text).join('; ')}. Allowed timestamp delta -0.12s..+0.45s; playback must remain active.`)

  const pausedEvidence = []
  let pausedPassed = true
  for (const mode of modes) {
    const before = await position()
    await setMode(mode)
    await delay(300)
    const after = await position()
    const state = await snapshot('[data-testid="playback-toggle"]')
    const delta = Math.abs(after - before)
    pausedPassed &&= state.ariaLabel === 'Play' && delta <= 0.12
    pausedEvidence.push(`${mode}: ${before.toFixed(2)}s→${after.toFixed(2)}s, ${state.ariaLabel}`)
  }
  record('paused-switches', pausedPassed,
    `${pausedEvidence.join('; ')}. Allowed absolute timestamp delta ≤0.12s; playback must remain paused.`)

  const nearEndTrace = new Map()
  const observeNearEnd = async (label) => {
    const [media, state] = await Promise.all([
      mediaState(),
      sendCommand({ action: 'status' }),
    ])
    for (const event of media.eventSequence ?? []) {
      nearEndTrace.set(event.sequence, event)
    }
    return {
      label,
      observedAt: new Date().toISOString(),
      media,
      playback: state.playback,
    }
  }

  const mediaBeforeOriginal = await mediaState()
  const generationBeforeOriginal = mediaBeforeOriginal.sourceGeneration
  await setMode('original')
  const originalReady = await waitFor(async () => {
    const [media, state] = await Promise.all([
      mediaState(),
      sendCommand({ action: 'status' }),
    ])
    return media.mode === 'original'
      && media.sourceGeneration > generationBeforeOriginal
      && media.currentSrc !== mediaBeforeOriginal.currentSrc
      && media.eventSequence.some((event) =>
        event.sourceGeneration === media.sourceGeneration && event.event === 'media:canplay')
      && media.status === 'paused'
      && state.playback?.mode === 'original'
      && Math.abs(state.playback.duration - media.duration) <= 0.01
      && Number.isFinite(media.duration)
      && media.duration > 0
      ? { media, playback: state.playback }
      : undefined
  }, 'original media readiness')
  const originalSettled = await waitFor(async () => {
    const first = await observeNearEnd('original-duration-sample')
    await delay(150)
    const second = await observeNearEnd('original-duration-reported')
    return second.media.mode === 'original'
      && second.media.sourceGeneration === originalReady.media.sourceGeneration
      && Math.abs(second.media.duration - first.media.duration) <= 0.01
      && Math.abs(second.playback.duration - second.media.duration) <= 0.01
      ? second
      : undefined
  }, 'stable original reported duration')
  const targetRatio = 0.999
  const initialReportedDuration = originalSettled.playback.duration
  const discoveryTarget = Math.max(0, initialReportedDuration * targetRatio)
  await ui('set-value', '[data-testid="playback-seek"]', String(discoveryTarget))
  await waitFor(async () => {
    const observation = await observeNearEnd('duration-discovery-target-observed')
    return observation.media.currentTime >= discoveryTarget - 0.12 ? observation : undefined
  }, 'initial duration-relative probe')
  const durationObserved = await waitFor(async () => {
    const first = await observeNearEnd('actual-duration-sample')
    await delay(150)
    const second = await observeNearEnd('actual-duration-reported')
    return Number.isFinite(second.media.duration)
      && second.media.duration > 0
      && Math.abs(second.media.duration - first.media.duration) <= 0.01
      && Math.abs(second.playback.duration - second.media.duration) <= 0.01
      ? second
      : undefined
  }, 'actual reported original duration')
  const originalDuration = durationObserved.playback.duration
  const terminalRunway = Math.min(2, Math.max(0.5, originalDuration * (1 - targetRatio)))
  const requestedTarget = Math.max(0, originalDuration - terminalRunway)
  const requestedRatio = originalDuration > 0 ? requestedTarget / originalDuration : 0
  await ui('set-value', '[data-testid="playback-seek"]', String(requestedTarget))
  const seekObserved = await waitFor(async () => {
    const observation = await observeNearEnd('original-target-observed')
    return observation.media.currentTime >= requestedTarget - 0.12 ? observation : undefined
  }, 'duration-relative near-end target')
  await setPlaying(true)
  const playingObserved = await observeNearEnd('near-end-play-requested')
  const originalGeneration = playingObserved.media.sourceGeneration
  await setMode('instrumental')
  const replacementObserved = await waitFor(async () => {
    const observation = await observeNearEnd('replacement-target-observed')
    const replacementDuration = observation.media.duration
    if (
      observation.media.mode !== 'instrumental'
      || observation.media.sourceGeneration <= originalGeneration
      || observation.media.currentSrc === playingObserved.media.currentSrc
      || !observation.media.eventSequence.some((event) =>
        event.sourceGeneration === observation.media.sourceGeneration && event.event === 'media:canplay')
      || !Number.isFinite(replacementDuration)
      || replacementDuration <= 0
      || observation.playback?.mode !== 'instrumental'
      || Math.abs(observation.playback.duration - replacementDuration) > 0.01
    ) return undefined
    const expectedTarget = Math.min(requestedTarget, replacementDuration)
    return Math.abs(observation.media.currentTime - expectedTarget) <= 0.2
      ? { ...observation, expectedTarget }
      : undefined
  }, 'replacement duration clamp')
  const terminal = await waitFor(async () => {
    const observation = await observeNearEnd('terminal-observed')
    const { media, playback } = observation
    const atDuration = Number.isFinite(media.duration)
      && Math.abs(media.currentTime - media.duration) <= 0.1
    return playback?.status === 'ended'
      && media.paused
      && !media.playingIntent
      && playback.playingIntent === false
      && atDuration
      ? observation
      : undefined
  }, 'strict terminal ended state', 15_000)
  const nearEndDiagnostics = await diagnostics()
  const replacementDuration = replacementObserved.media.duration
  const clamped = requestedTarget > replacementDuration
  const nearEndDetails = {
    targetRatio: requestedRatio,
    terminalRunway,
    discoveryTargetRatio: targetRatio,
    initialReportedDuration,
    requestedTarget,
    observedTarget: seekObserved.media.currentTime,
    originalDuration,
    replacement: {
      mode: 'instrumental',
      duration: replacementDuration,
      durationChanged: Math.abs(replacementDuration - originalDuration) > 0.01,
      clampRequired: clamped,
      expectedTarget: replacementObserved.expectedTarget,
      observedTarget: replacementObserved.media.currentTime,
    },
    observations: [seekObserved, playingObserved, replacementObserved, terminal].map((item) => ({
      label: item.label,
      observedAt: item.observedAt,
      media: {
        currentTime: item.media.currentTime,
        duration: item.media.duration,
        paused: item.media.paused,
        ended: item.media.ended,
        playingIntent: item.media.playingIntent,
        mode: item.media.mode,
        status: item.media.status,
      },
      playback: item.playback,
    })),
    eventSequence: [...nearEndTrace.values()].sort((left, right) => left.sequence - right.sequence),
    terminalOutcome: {
      status: terminal.playback.status,
      currentTime: terminal.media.currentTime,
      duration: terminal.media.duration,
      paused: terminal.media.paused,
      mediaEnded: terminal.media.ended,
      playingIntent: terminal.media.playingIntent,
      controllerPlayingIntent: terminal.playback.playingIntent,
    },
    rendererErrors: nearEndDiagnostics.rendererErrors,
  }
  const nearEndPassed = terminal.playback.status === 'ended'
    && terminal.media.paused
    && !terminal.media.playingIntent
    && terminal.playback.playingIntent === false
    && Math.abs(terminal.media.currentTime - terminal.media.duration) <= 0.1
    && nearEndDiagnostics.rendererErrorCount === 0
  record('near-end-clamp', nearEndPassed,
    `Requested ${(requestedRatio * 100).toFixed(3)}% target ${requestedTarget.toFixed(3)}s of ${originalDuration.toFixed(3)}s `
    + `(${terminalRunway.toFixed(3)}s terminal runway); `
    + `observed ${seekObserved.media.currentTime.toFixed(3)}s; replacement ${replacementObserved.media.currentTime.toFixed(3)}s/${replacementDuration.toFixed(3)}s`
    + `${clamped ? ' (clamped)' : ''}; terminal=${terminal.playback.status} at ${terminal.media.currentTime.toFixed(3)}s, `
    + `paused=${terminal.media.paused}, playingIntent=${terminal.media.playingIntent}; renderer exceptions=${nearEndDiagnostics.rendererErrorCount}.`,
    nearEndDetails)

  const rapidSequence = Array.from({ length: 12 }, (_, index) => modes[index % modes.length])
  rapidSequence.push('vocal')
  for (const mode of rapidSequence) {
    await sendCommand({ action: 'control', value: { action: 'mode', value: mode } })
  }
  await waitForMode('vocal')
  await delay(250)
  const rapidStates = Object.fromEntries(await Promise.all(modes.map(async (mode) => [
    mode,
    (await snapshot(`[data-testid="mode-${mode}"]`)).className.includes('active'),
  ])))
  const finalDiagnostics = await diagnostics()
  record('rapid-final-mode',
    rapidStates.vocal
      && Object.entries(rapidStates).filter(([, active]) => active).length === 1
      && finalDiagnostics.rendererErrorCount === 0,
    `13 no-delay requests ended with vocal requested; active states=${JSON.stringify(rapidStates)}; `
    + `renderer exceptions=${finalDiagnostics.rendererErrorCount}.`)

  const report = {
    verdict: cases.every((item) => item.status === 'passed')
      && finalDiagnostics.rendererErrorCount === 0 ? 'APPROVE' : 'REJECT',
    generatedAt: new Date().toISOString(),
    executable,
    sourceProfile: path.resolve(args.profile),
    rendererDiagnostics: finalDiagnostics,
    cases,
  }
  const reportPath = path.join(outputRoot, 'report.json')
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`${report.verdict}: ${cases.filter((item) => item.status === 'passed').length}/${cases.length} gates passed.`)
  console.log(`Evidence: ${reportPath}`)
  process.exitCode = report.verdict === 'APPROVE' ? 0 : 1
}

try {
  await main()
} catch (error) {
  console.error(`REJECT: ${error instanceof Error ? error.stack : String(error)}`)
  process.exitCode = 1
} finally {
  await stopApp()
}
