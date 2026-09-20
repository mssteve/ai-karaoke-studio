import { spawn } from 'node:child_process'
import { copyFile, mkdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { sendCommand } from './control.mjs'
import { verifyLocalElectronEntry } from './local-electron-entry.mjs'

const output = path.resolve(process.argv[2] ?? 'scripts/qa-artifacts/microphone-monitor-rendered')
const executable = path.resolve('node_modules/electron/dist/electron.exe')
const entry = path.resolve('dist-electron/main.js')
const profile = path.join(output, 'profile')
let child

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
  await mkdir(profile, { recursive: true })
  await verifyLocalElectronEntry(executable, entry)
  child = spawn(executable, [entry, `--user-data-dir=${profile}`, '--enable-private-automation'], {
    cwd: path.dirname(executable),
    stdio: 'ignore',
  })
  await waitFor(() => sendCommand({ action: 'status' }, { timeoutMs: 750 }), 'application startup')
  const snapshot = await waitFor(async () => {
    const value = await sendCommand({
      action: 'ui',
      uiAction: 'snapshot',
      selector: '[data-testid="mic-monitor-toggle"]',
    })
    return value.ariaLabel ? value : undefined
  }, 'microphone control')
  if (snapshot.ariaLabel !== 'Turn microphone monitor on') {
    throw new Error(`Unexpected microphone label: ${snapshot.ariaLabel}`)
  }
  const first = await sendCommand({
    action: 'ui',
    uiAction: 'exists',
    selector: '.player-output-controls > .mic-monitor:first-child',
  })
  const second = await sendCommand({
    action: 'ui',
    uiAction: 'exists',
    selector: '.player-output-controls > .volume:nth-child(2)',
  })
  if (!first.exists || !second.exists) throw new Error('Microphone control is not immediately beside volume.')
  const capture = await sendCommand({ action: 'screenshot' })
  const screenshot = path.join(output, 'microphone-monitor-off.png')
  await copyFile(capture.path, screenshot)
  if ((await stat(screenshot)).size === 0) throw new Error('Rendered screenshot is empty.')
  const diagnostics = await sendCommand({ action: 'diagnostics' })
  if (diagnostics.rendererErrorCount !== 0) {
    throw new Error(`Renderer diagnostics contain ${diagnostics.rendererErrorCount} errors.`)
  }
  console.log(`PASS rendered microphone monitor: accessible off state, adjacent placement, screenshot ${screenshot}`)
} finally {
  if (child && child.exitCode === null) {
    child.kill()
    await waitFor(() => child.exitCode !== null, 'application shutdown', 8_000).catch(() => undefined)
  }
}
