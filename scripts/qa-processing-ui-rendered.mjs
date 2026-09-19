import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { sendCommand } from './control.mjs'
import { verifyLocalElectronEntry } from './local-electron-entry.mjs'

const [appArg, entryArg, profileArg, outputArg] = process.argv.slice(2)
if (!appArg || !entryArg || !profileArg || !outputArg) {
  throw new Error('Usage: node scripts/qa-processing-ui-rendered.mjs <electron> <entry> <profile> <output>')
}
const executable = path.resolve(appArg)
const entry = path.resolve(entryArg)
const profile = path.resolve(profileArg)
const output = path.resolve(outputArg)
const execFileAsync = promisify(execFile)
const cases = []
let child
let launchSequence = 0

function record(id, passed, evidence) {
  cases.push({ id, status: passed ? 'passed' : 'failed', evidence })
  console.log(`${passed ? 'PASS' : 'FAIL'} ${id}: ${evidence}`)
}
async function waitFor(check, description, timeout = 15_000) {
  const started = Date.now()
  let lastError
  while (Date.now() - started < timeout) {
    try {
      const result = await check()
      if (result) return result
    } catch (error) {
      lastError = error
    }
    await delay(75)
  }
  throw new Error(`${description} not observed.${lastError ? ` ${lastError.message}` : ''}`)
}
const ui = (uiAction, selector) => sendCommand({ action: 'ui', uiAction, selector })
const snapshot = async (selector) => {
  try {
    return await ui('snapshot', selector)
  } catch (error) {
    throw new Error(`Unable to snapshot ${selector}: ${error.message}`)
  }
}
async function capture(name) {
  const shot = await sendCommand({ action: 'screenshot' })
  assert.equal(shot.renderedState?.readyState, 'complete')
  assert.equal(shot.renderedState?.visible, true)
  assert.ok(shot.renderedState?.rootChildren > 0)
  assert.ok(shot.bytes > 10_000)
  const target = path.join(output, `${name}.png`)
  await copyFile(shot.path, target)
  const file = await stat(target)
  assert.ok(file.size > 10_000)
  return target
}
async function start(dataRoot = profile) {
  launchSequence += 1
  process.env.KARAOKE_AUTOMATION_PIPE =
    `\\\\.\\pipe\\karaoke-studio-processing-ui-${process.pid}-${launchSequence}`
  const launched = spawn(executable, [entry, `--user-data-dir=${dataRoot}`, '--enable-private-automation'], {
    cwd: path.dirname(entry),
    stdio: 'ignore',
  })
  child = launched
  if (!Number.isInteger(launched.pid)) {
    child = undefined
    throw new Error('Electron did not provide a process ID.')
  }
  await Promise.race([
    waitFor(() => sendCommand({ action: 'status' }, { timeoutMs: 500 }), 'automation pipe', 30_000),
    new Promise((_, reject) => {
      launched.once('error', reject)
      launched.once('exit', (code, signal) => {
        reject(new Error(`Electron exited before automation startup (code=${code}, signal=${signal}).`))
      })
    }),
  ]).catch(async (error) => {
    if (child === launched) await stop()
    throw error
  })
}
async function stop() {
  if (!child) return
  const pid = child.pid
  if (!Number.isInteger(pid)) {
    child = undefined
    return
  }
  await execFileAsync('powershell.exe', ['-NoProfile', '-Command',
    `$root=${pid}; $all=Get-CimInstance Win32_Process; $ids=[System.Collections.Generic.List[int]]::new(); `
    + `function Add-Children([int]$parent){ foreach($p in $all | Where-Object ParentProcessId -eq $parent){ `
    + `Add-Children $p.ProcessId; $ids.Add($p.ProcessId) } }; Add-Children $root; $ids.Add($root); `
    + `foreach($id in $ids){ Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }`])
  child = undefined
  await delay(250)
}
await mkdir(output, { recursive: true })
try {
  await verifyLocalElectronEntry(executable, entry)
  await start()
  const fixtureSongs = JSON.parse(await readFile(path.join(profile, 'fixture-library.json'), 'utf8'))
  await sendCommand({ action: 'inject-library', songs: fixtureSongs })

  await waitFor(async () => {
    const body = await snapshot('body')
    return body.text.includes('Lyrics Failure Fixture') && body.text.includes('Try again') ? body : undefined
  }, 'injected processing UI fixture')
  const lyricsRetry = await snapshot('[data-testid="retry-lyrics"]')
  const enhancedMode = await snapshot('[data-testid="mode-enhanced"]')
  const summary = await snapshot('[data-testid="enhanced-summary"]')
  record('lyrics-own-retry', lyricsRetry.text === 'Try again',
    `Lyrics panel action: "${lyricsRetry.text}".`)
  record('lyrics-failure-keeps-audio', !enhancedMode.disabled,
    `Enhanced remained ${enhancedMode.disabled ? 'disabled' : 'enabled'} during lyrics-only failure.`)
  record('enhanced-summary-rendered', /Auto-balanced|auto-balanced/i.test(summary.text)
    && /LUFS/.test(summary.text) && /cannot restore/.test(summary.text),
  summary.text)
  const lyricsEvidence = await capture('lyrics-partial-success')

  await ui('click', '[data-testid="song-row"][data-song-id="enhanced-failure"]')
  await waitFor(async () => (await sendCommand({ action: 'status' })).playback?.songId === 'enhanced-failure',
    'Enhanced failure selection')
  const unavailableEnhanced = await snapshot('[data-testid="mode-enhanced"]')
  const unavailableReason = await snapshot('#mode-enhanced-reason')
  const original = await snapshot('[data-testid="mode-original"]')
  const vocal = await snapshot('[data-testid="mode-vocal"]')
  const instrumental = await snapshot('[data-testid="mode-instrumental"]')
  const retryEnhanced = await snapshot('[data-testid="retry-enhanced"]')
  record('enhanced-only-mode-disable', unavailableEnhanced.disabled && !original.disabled
    && !vocal.disabled && !instrumental.disabled,
  `Disabled states: Original=${original.disabled}, Enhanced=${unavailableEnhanced.disabled}, Vocal=${vocal.disabled}, Instrumental=${instrumental.disabled}.`)
  record('enhanced-reason-and-retry', /peak ceiling/.test(unavailableReason.text)
    && retryEnhanced.text === 'Try again',
  `${unavailableReason.text}; action="${retryEnhanced.text}".`)
  const enhancedEvidence = await capture('enhanced-only-failure')

  await ui('click', '[data-testid="song-row"][data-song-id="installed-demucs-failure"]')
  await waitFor(async () => (await sendCommand({ action: 'status' })).playback?.songId === 'installed-demucs-failure',
    'installed Demucs failure selection')
  const demucsRetry = await snapshot('[data-testid="retry-demucs"]')
  record('installed-demucs-retry-enabled', demucsRetry.text === 'Try again' && !demucsRetry.disabled,
    `Installed-shape Demucs action="${demucsRetry.text}", disabled=${demucsRetry.disabled}.`)

  await ui('click', '[data-testid="playback-toggle"]')
  await waitFor(async () => (await sendCommand({ action: 'status' })).playback?.status === 'playing',
    'initial playback')
  await sendCommand({ action: 'control', value: { action: 'seek', value: 0.5 } })
  await ui('click', '[data-testid="song-row"][data-song-id="lyrics-failure"]')
  const single = await waitFor(async () => {
    const state = (await sendCommand({ action: 'status' })).playback
    return state?.songId === 'lyrics-failure' && state.mode === 'original' && state.status === 'paused'
      && state.currentTime <= 0.05 ? state : undefined
  }, 'single-click paused selection')
  record('single-click-selects-paused', single.currentTime <= 0.05,
    `Single click selected Original paused at ${single.currentTime.toFixed(3)}s.`)

  await ui('click', '[data-testid="playback-toggle"]')
  await waitFor(async () => (await sendCommand({ action: 'status' })).playback?.currentTime >= 0.25,
    'playback before double click')
  await ui('double-click', '[data-testid="song-row"][data-song-id="lyrics-failure"]')
  const doubled = await waitFor(async () => {
    const state = (await sendCommand({ action: 'status' })).playback
    return state?.songId === 'lyrics-failure' && state.mode === 'original'
      && state.status === 'playing' && state.currentTime < 0.25 ? state : undefined
  }, 'double-click restart')
  record('double-click-restarts-original', doubled.currentTime < 0.25,
    `Double click restarted Original and played from ${doubled.currentTime.toFixed(3)}s.`)

  await ui('click', '[data-testid="playback-toggle"]')
  await ui('double-click', '[data-testid="song-menu-lyrics-failure"]')
  await delay(250)
  const afterControl = (await sendCommand({ action: 'status' })).playback
  record('row-control-double-click-isolated', afterControl.status === 'paused',
    `Double-clicking the plus control left playback ${afterControl.status}.`)

  const diagnostics = await sendCommand({ action: 'diagnostics' })
  record('renderer-clean', diagnostics.rendererErrorCount === 0,
    `Renderer errors: ${diagnostics.rendererErrorCount}.`)
  const report = {
    verdict: cases.every((item) => item.status === 'passed') ? 'APPROVE' : 'REJECT',
    cases,
    screenshots: [lyricsEvidence, enhancedEvidence],
  }
  await writeFile(path.join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  if (report.verdict !== 'APPROVE') process.exitCode = 1
} finally {
  await stop()
}
