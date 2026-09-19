import { execFile, spawn } from 'node:child_process'
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { sendCommand } from './control.mjs'

const execFileAsync = promisify(execFile)
const modes = ['original', 'enhanced', 'vocal', 'instrumental']
const args = parseArgs(process.argv.slice(2))
const executable = path.resolve(args.app)
const dataRoot = path.resolve(args.data)
const outputRoot = path.resolve(args.output)
const libraryPath = path.join(dataRoot, 'library.json')
const logPath = path.join(dataRoot, 'logs', 'karaoke-studio.log')
const cases = []
const observations = []
const screenshots = []
let child
let logOffset = 0

function parseArgs(values) {
  const localAppData = process.env.LOCALAPPDATA
  const appData = process.env.APPDATA
  const parsed = {
    app: path.join(localAppData, 'Programs', 'Karaoke Studio', 'Karaoke Studio.exe'),
    data: path.join(appData, 'karaoke-studio'),
    output: path.join('scripts', 'qa-artifacts', `current-installed-playback-${new Date().toISOString().replaceAll(':', '-')}`),
  }
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (value === '--app') parsed.app = values[++index]
    else if (value === '--data') parsed.data = values[++index]
    else if (value === '--output') parsed.output = values[++index]
    else if (value === '--electron-entry') parsed.electronEntry = values[++index]
    else if (value === '--attach-pid') parsed.attachPid = Number(values[++index])
    else throw new Error(`Unknown argument: ${value}`)
  }
  return parsed
}

function record(id, passed, evidence, details = undefined) {
  cases.push({ id, status: passed ? 'passed' : 'failed', evidence, details })
  console.log(`${passed ? 'PASS' : 'FAIL'} ${id}: ${evidence}`)
}

async function attempt(id, run) {
  try {
    await run()
  } catch (error) {
    record(id, false, error instanceof Error ? error.message : String(error))
  }
}

async function waitFor(check, description, timeoutMs = 12_000) {
  const started = Date.now()
  let lastError
  while (Date.now() - started < timeoutMs) {
    try {
      const result = await check()
      if (result) return result
    } catch (error) {
      lastError = error
    }
    await delay(75)
  }
  throw new Error(`${description} not observed${lastError ? `: ${lastError.message}` : ''}.`)
}

function ui(uiAction, selector, uiValue) {
  return sendCommand({ action: 'ui', uiAction, selector, uiValue })
}

function snapshot(selector) {
  return ui('snapshot', selector)
}

async function position() {
  const playback = (await sendCommand({ action: 'status' })).playback
  if (Number.isFinite(playback?.currentTime)) return playback.currentTime
  return Number((await snapshot('[data-testid="playback-seek"]')).value)
}

async function duration() {
  const playback = (await sendCommand({ action: 'status' })).playback
  if (Number.isFinite(playback?.duration) && playback.duration > 0) return playback.duration
  const value = (await snapshot('.timeline span:last-child')).text
  const [minutes, seconds] = value.split(':').map(Number)
  return minutes * 60 + seconds
}

async function activeLyric() {
  const playback = (await sendCommand({ action: 'status' })).playback
  if (Number.isInteger(playback?.activeLyricIndex) && playback.activeLyricIndex >= 0) {
    return {
      index: playback.activeLyricIndex,
      text: playback.activeLyricText,
      start: playback.activeLyricStart,
    }
  }
  try {
    return await snapshot('.lyric-line[aria-current="true"]')
  } catch {
    return undefined
  }
}

async function visibleError() {
  const state = await snapshot('[role="alert"], body')
  return state.className.includes('error-toast') ? state.text : undefined
}

async function setMode(mode) {
  await sendCommand({ action: 'control', value: { action: 'mode', value: mode } })
  return waitFor(async () => {
    const state = await snapshot(`[data-testid="mode-${mode}"]`)
    return state.className.includes('active') ? state : undefined
  }, `${mode} mode`)
}

async function setPlaying(playing) {
  const expected = playing ? 'Pause' : 'Play'
  const state = await snapshot('[data-testid="playback-toggle"]')
  if (state.ariaLabel !== expected) {
    await sendCommand({ action: 'control', value: { action: playing ? 'play' : 'pause' } })
  }
  return waitFor(async () => {
    const current = await snapshot('[data-testid="playback-toggle"]')
    return current.ariaLabel === expected ? current : undefined
  }, `${expected} control state`)
}

async function seek(seconds) {
  await sendCommand({ action: 'control', value: { action: 'seek', value: seconds } })
  return waitFor(async () => {
    const current = await position()
    return Math.abs(current - seconds) <= 0.35 ? current : undefined
  }, `seek to ${seconds.toFixed(2)} seconds`, 3_000)
}

async function selectSong(id) {
  await sendCommand({ action: 'control', value: { action: 'select', value: id } })
  await waitFor(async () => {
    const row = await snapshot(`[data-testid="song-row"][data-song-id="${id}"]`)
    return row.ariaSelected === 'true' ? row : undefined
  }, `song ${id} selection`)
  await waitFor(async () => await duration() > 0, `song ${id} duration`)
}

async function takeScreenshot(name) {
  const result = await sendCommand({ action: 'screenshot' })
  const extension = path.extname(result.path) || '.png'
  const destination = path.join(outputRoot, `${name}${extension}`)
  await copyFile(result.path, destination)
  screenshots.push({ name, source: result.path, path: destination })
}

async function sha256(filePath) {
  const content = await readFile(filePath)
  return createHash('sha256').update(content).digest('hex')
}

async function sourceManifest(library) {
  return Promise.all(library.map(async (song) => {
    const info = await stat(song.sourcePath)
    return {
      songId: song.id,
      title: song.title,
      path: song.sourcePath,
      bytes: info.size,
      modifiedAt: info.mtime.toISOString(),
      sha256: await sha256(song.sourcePath),
    }
  }))
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
  if (!stdout.trim()) return []
  const parsed = JSON.parse(stdout)
  return Array.isArray(parsed) ? parsed : [parsed]
}

async function stopApp() {
  if (!child || child.exitCode !== null) return
  const pid = child.pid
  await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-Command',
    `$process = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($process) { $null = $process.CloseMainWindow(); $process.WaitForExit(5000) }`,
  ]).catch(() => undefined)
  if (child.exitCode === null) {
    await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`,
    ]).catch(() => undefined)
  }
}

function expectedLyric(song, time) {
  const index = song.lyrics.findIndex((line) => time >= line.start && time < line.end)
  return index < 0 ? undefined : { index, ...song.lyrics[index] }
}

async function main() {
  await mkdir(outputRoot, { recursive: true })
  const library = JSON.parse(await readFile(libraryPath, 'utf8'))
  const processedSongs = library.filter((song) =>
    modes.every((mode) => mode === 'original' ? song.sourcePath : song[`${mode}Path`]))
  const sourcesBefore = await sourceManifest(library)
  logOffset = (await stat(logPath).catch(() => ({ size: 0 }))).size

  let status
  if (Number.isInteger(args.attachPid) && args.attachPid > 0) {
    status = await sendCommand({ action: 'status' })
  } else {
    try {
      await sendCommand({ action: 'status' }, { timeoutMs: 500 })
      throw new Error('A private automation instance is already running; close it before this controlled run.')
    } catch (error) {
      if (error.message.includes('already running')) throw error
    }

    const launchArgs = ['--enable-private-automation']
    if (args.electronEntry) launchArgs.unshift(path.resolve(args.electronEntry))
    child = spawn(executable, launchArgs, {
      cwd: args.electronEntry ? process.cwd() : path.dirname(executable),
      stdio: 'ignore',
    })
    status = await waitFor(
      () => sendCommand({ action: 'status' }, { timeoutMs: 750 }),
      'private named pipe',
      30_000,
    )
  }
  record(
    'two-current-processed-songs',
    processedSongs.length === 2 && status.songs.length === 2,
    `Current library has ${status.songs.length} songs; ${processedSongs.length} have all four modes.`,
  )
  if (processedSongs.length < 2) throw new Error('Two fully processed songs are required.')

  const testedPid = args.attachPid ?? child.pid
  const ports = await listeningPorts(testedPid)
  record('zero-tcp-listeners', ports.length === 0, `App process tree has ${ports.length} listening TCP endpoints.`, ports)

  const primary = processedSongs[0]
  const secondary = processedSongs[1]
  await selectSong(primary.id)
  await takeScreenshot('01-baseline-selected')

  await attempt('four-modes-advance-without-media-error', async () => {
    const modeEvidence = []
    await setMode('original')
    await setPlaying(true)
    await waitFor(async () => await position() >= 0.5, 'initial playback advance')
    for (const mode of modes) {
      const beforeSwitch = await position()
      await setMode(mode)
      await delay(450)
      const first = await position()
      await delay(850)
      const second = await position()
      const toggle = await snapshot('[data-testid="playback-toggle"]')
      const playback = (await sendCommand({ action: 'status' })).playback
      const error = await visibleError()
      const mediaStateOk = !playback || playback.status === 'playing'
      const mediaOk = toggle.ariaLabel === 'Pause' && mediaStateOk && !error && second > first + 0.25
      modeEvidence.push({
        mode,
        beforeSwitch,
        first,
        second,
        mediaOk,
        mediaStatus: playback?.status ?? 'inferred-playing',
        toggle: toggle.ariaLabel,
        error,
      })
    }
    await setPlaying(false)
    record(
      'four-modes-advance-without-media-error',
      modeEvidence.every((item) => item.mediaOk),
      modeEvidence.map((item) =>
        `${item.mode} ${item.first.toFixed(2)}→${item.second.toFixed(2)}s, media=${item.mediaStatus}, control=${item.toggle}, error=${item.error ?? 'none'}`).join('; '),
      modeEvidence,
    )
    await takeScreenshot(modeEvidence.every((item) => item.mediaOk)
      ? '02-four-modes-pass'
      : '02-four-modes-failure')
  })

  await attempt('play-pause-resume-contract', async () => {
    await setMode('original')
    await setPlaying(true)
    await delay(900)
    const playingAt = await position()
    await setPlaying(false)
    const pausedAt = await position()
    await delay(1100)
    const frozenAt = await position()
    await setPlaying(true)
    await delay(900)
    const resumedAt = await position()
    await setPlaying(false)
    const passed = Math.abs(frozenAt - pausedAt) <= 0.12
      && resumedAt > frozenAt + 0.35
    record(
      'play-pause-resume-contract',
      passed,
      `Paused ${pausedAt.toFixed(2)}→${frozenAt.toFixed(2)}s; resumed to ${resumedAt.toFixed(2)}s from the same point.`,
      { playingAt, pausedAt, frozenAt, resumedAt },
    )
  })

  await attempt('slider-seek-and-progress-ratio', async () => {
    const total = await duration()
    const target = Math.min(42, Math.max(5, total * 0.3))
    await setPlaying(false)
    let pipeSeek
    try {
      pipeSeek = await seek(target)
    } catch {
      pipeSeek = await position()
    }
    await ui('set-value', '[data-testid="playback-seek"]', String(target))
    await delay(500)
    const landedPaused = await position()
    await delay(700)
    const heldPaused = await position()
    await setPlaying(true)
    await delay(1000)
    const continued = await position()
    const renderedSlider = Number((await snapshot('[data-testid="playback-seek"]')).value)
    const currentLabel = (await snapshot('.timeline span:first-child')).text
    const [minutes, seconds] = currentLabel.split(':').map(Number)
    const labelSeconds = minutes * 60 + seconds
    const ratioAtSeek = landedPaused / total
    const ratioAfter = continued / total
    const passed = Math.abs(pipeSeek - target) <= 0.35
      && Math.abs(landedPaused - target) <= 0.35
      && Math.abs(heldPaused - landedPaused) <= 0.12
      && continued > heldPaused + 0.35
      && Math.abs(renderedSlider - continued) <= 0.2
      && Math.abs(continued - labelSeconds) < 1.05
      && ratioAfter > ratioAtSeek
      && ratioAfter <= 1.01
    await setPlaying(false)
    record(
      'slider-seek-and-progress-ratio',
      passed,
      `Pipe seek=${pipeSeek.toFixed(2)}s, rendered seek=${landedPaused.toFixed(2)}s for ${target.toFixed(2)}s; paused=${heldPaused.toFixed(2)}s; current=${continued.toFixed(2)}s, slider=${renderedSlider.toFixed(2)}s; ratio ${ratioAtSeek.toFixed(4)}→${ratioAfter.toFixed(4)}.`,
      { total, target, pipeSeek, landedPaused, heldPaused, continued, renderedSlider, labelSeconds, ratioAtSeek, ratioAfter },
    )
    await takeScreenshot(passed ? '03-slider-pass' : '03-slider-failure')
  })

  await attempt('switching-continuity-and-rapid-stress', async () => {
    await setMode('original')
    await setPlaying(true)
    await waitFor(async () => await position() >= 2, 'pre-switch playback advance')
    const sequence = Array.from({ length: 24 }, (_, index) => modes[index % modes.length])
    const continuity = []
    for (const mode of sequence) {
      const before = await position()
      await sendCommand({ action: 'control', value: { action: 'mode', value: mode } })
      await delay(90)
      const after = await position()
      const targetDuration = await duration()
      const clampedTarget = Math.min(before, targetDuration)
      continuity.push({
        mode,
        before,
        after,
        targetDuration,
        resetToZero: clampedTarget > 1 && after < 0.5,
      })
    }
    await setMode('instrumental')
    const settled = await position()
    await delay(1200)
    const advanced = await position()
    const toggle = await snapshot('[data-testid="playback-toggle"]')
    const playback = (await sendCommand({ action: 'status' })).playback
    const error = await visibleError()
    const passed = continuity.every((item) => !item.resetToZero)
      && advanced > settled + 0.35
      && toggle.ariaLabel === 'Pause'
      && (!playback || playback.status === 'playing')
      && !error
    await takeScreenshot(passed ? '04-rapid-switch-pass' : '04-rapid-switch-failure')
    await setPlaying(false)
    record(
      'switching-continuity-and-rapid-stress',
      passed,
      `24 rapid switches; zero resets=${continuity.filter((item) => item.resetToZero).length}; settled ${settled.toFixed(2)}→${advanced.toFixed(2)}s; media=${playback?.status ?? 'inferred-playing'}; control=${toggle.ariaLabel}; error=${error ?? 'none'}.`,
      { continuity, settled, advanced, mediaStatus: playback?.status, toggle: toggle.ariaLabel, error },
    )
  })

  await attempt('lyrics-match-timestamps-and-advance', async () => {
    await selectSong(secondary.id)
    await setPlaying(false)
    const usableBoundary = 1
    const line = secondary.lyrics[usableBoundary]
    const beforeTime = 0
    const expectedBefore = expectedLyric(secondary, beforeTime)
    const activeBefore = await activeLyric()
    await setPlaying(true)
    await waitFor(async () => await position() >= line.start + 0.4, 'first lyric boundary advance', 20_000)
    const afterTime = await position()
    const expectedAfter = expectedLyric(secondary, afterTime)
    const activeAfter = await activeLyric()
    await setPlaying(false)
    const beforeMatches = expectedBefore
      && activeBefore?.text.includes(expectedBefore.text)
      && (activeBefore.index === undefined || activeBefore.index === expectedBefore.index)
    const afterMatches = expectedAfter
      && activeAfter?.text.includes(expectedAfter.text)
      && (activeAfter.index === undefined || activeAfter.index === expectedAfter.index)
    const passed = Boolean(beforeMatches && afterMatches && expectedBefore.index !== expectedAfter.index)
    await takeScreenshot(passed ? '05-lyrics-pass' : '05-lyrics-failure')
    record(
      'lyrics-match-timestamps-and-advance',
      passed,
      `At ${beforeTime.toFixed(2)}s expected "${expectedBefore?.text}", saw "${activeBefore?.text ?? 'none'}"; at ${afterTime.toFixed(2)}s expected "${expectedAfter?.text}", saw "${activeAfter?.text ?? 'none'}".`,
      { beforeTime, afterTime, expectedBefore, expectedAfter, activeBefore, activeAfter },
    )
  })

  await attempt('song-selection-resets-selected-song-only', async () => {
    await selectSong(primary.id)
    await setPlaying(true)
    await waitFor(async () => await position() >= 1.2, 'first song playback before selection')
    await setPlaying(false)
    const primaryBefore = await position()
    await selectSong(secondary.id)
    const secondaryStart = await position()
    const selectedSecondary = (await snapshot(`[data-testid="song-row"][data-song-id="${secondary.id}"]`)).ariaSelected
    const passed = primaryBefore >= 1.15 && secondaryStart <= 0.35 && selectedSecondary === 'true'
    record(
      'song-selection-resets-selected-song-only',
      passed,
      `First song was at ${primaryBefore.toFixed(2)}s; newly selected second song started at ${secondaryStart.toFixed(2)}s.`,
      { primaryBefore, secondaryStart, selectedSecondary },
    )
  })

  const sourcesAfter = await sourceManifest(library)
  const sourceFilesUnchanged = sourcesBefore.every((before, index) =>
    before.sha256 === sourcesAfter[index].sha256
    && before.bytes === sourcesAfter[index].bytes
    && before.modifiedAt === sourcesAfter[index].modifiedAt)
  record(
    'source-files-unchanged',
    sourceFilesUnchanged,
    `${sourcesBefore.length} source files retained identical hashes, sizes, and modification times.`,
    { before: sourcesBefore, after: sourcesAfter },
  )

  observations.push({
    id: 'source-lyric-quality',
    evidence: library.map((song) => ({
      title: song.title,
      lyricLines: song.lyrics.length,
      zeroLengthLines: song.lyrics.filter((line) => line.end <= line.start).length,
      overlappingLines: song.lyrics.filter((line, index) =>
        index > 0 && line.start < song.lyrics[index - 1].end).length,
    })),
  })

  await stopApp()
  child = undefined
  const log = await readFile(logPath).catch(() => Buffer.alloc(0))
  const runLog = log.subarray(Math.min(logOffset, log.length)).toString('utf8')
  await writeFile(path.join(outputRoot, 'app-run.log'), runLog)
  const report = {
    verdict: cases.every((item) => item.status === 'passed') ? 'APPROVE' : 'REJECT',
    generatedAt: new Date().toISOString(),
    executable,
    electronEntry: args.electronEntry ? path.resolve(args.electronEntry) : undefined,
    testedPid,
    attachedToExistingProcess: Boolean(args.attachPid),
    dataRoot,
    namedPipe: '\\\\.\\pipe\\karaoke-studio-control',
    songs: processedSongs.map(({ id, title, sourcePath }) => ({ id, title, sourcePath })),
    cases,
    observations,
    screenshots,
  }
  await writeFile(path.join(outputRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(`${report.verdict}: ${cases.filter((item) => item.status === 'passed').length}/${cases.length} gates passed.`)
  console.log(`Evidence: ${path.join(outputRoot, 'report.json')}`)
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
