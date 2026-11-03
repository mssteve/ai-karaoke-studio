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
  process.env.KARAOKE_AUTOMATION_PIPE = `\\\\.\\pipe\\karaoke-studio-mic-rendered-${process.pid}`
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
  const group = await sendCommand({
    action: 'ui',
    uiAction: 'exists',
    selector: '.mic-button-group[role="group"] > [data-testid="mic-echo-toggle"]:nth-child(2)',
  })
  const settings = await sendCommand({
    action: 'ui',
    uiAction: 'exists',
    selector: '.mic-button-group > [data-testid="audio-controls-toggle"]:nth-child(3):last-child',
  })
  if (!group.exists || !settings.exists) throw new Error('Audio controls are not a compact three-button group.')
  const panelOpen = async () => (await sendCommand({
    action: 'ui',
    uiAction: 'exists',
    selector: '#audio-controls-panel:popover-open',
  })).exists
  const togglePanel = () => sendCommand({
    action: 'ui',
    uiAction: 'click',
    selector: '[data-testid="audio-controls-toggle"]',
  })
  if (await panelOpen()) throw new Error('Audio settings must start collapsed.')
  await togglePanel()
  if (!await panelOpen()) throw new Error('Audio settings button did not open the panel.')
  const level = await sendCommand({
    action: 'ui',
    uiAction: 'snapshot',
    selector: '[data-testid="mic-monitor-level"]',
  })
  if (level.value !== '2' || level.min !== '0' || level.max !== '4' || level.step !== '0.05') {
    throw new Error(`Unexpected microphone level control: ${JSON.stringify(level)}`)
  }
  const echoState = () => sendCommand({
    action: 'ui',
    uiAction: 'snapshot',
    selector: '[data-testid="mic-monitor-state"]',
  })
  const echoToggle = () => sendCommand({
    action: 'ui',
    uiAction: 'click',
    selector: '[data-testid="mic-echo-toggle"]',
  })
  if ((await echoState()).dataset?.echoEnabled !== 'false') throw new Error('Echo must default to off.')
  const echoAmount = await sendCommand({
    action: 'ui',
    uiAction: 'snapshot',
    selector: '[data-testid="mic-echo-amount"]',
  })
  if (!echoAmount.disabled) throw new Error('Echo amount must be disabled while echo is off.')
  await echoToggle()
  await sendCommand({
    action: 'ui',
    uiAction: 'set-value',
    selector: '[data-testid="mic-echo-amount"]',
    uiValue: '0.4',
  })
  if ((await echoState()).dataset?.echoEnabled !== 'true'
    || (await echoState()).dataset?.echoAmount !== '0.400') {
    throw new Error('Echo toggle or amount did not update renderer state.')
  }
  await echoToggle()
  const echoOff = await echoState()
  if (echoOff.dataset?.echoEnabled !== 'false' || echoOff.dataset?.echoAmount !== '0.400') {
    throw new Error('Echo bypass did not preserve the selected amount.')
  }
  await sendCommand({
    action: 'ui',
    uiAction: 'set-value',
    selector: '[data-testid="mic-monitor-level"]',
    uiValue: '4',
  })
  const maximum = await sendCommand({
    action: 'ui',
    uiAction: 'snapshot',
    selector: '[data-testid="mic-monitor-state"]',
  })
  if (maximum.dataset?.monitorGain !== '4.000') {
    throw new Error(`Maximum microphone level did not update live state: ${JSON.stringify(maximum)}`)
  }
  await sendCommand({
    action: 'ui',
    uiAction: 'set-value',
    selector: '[data-testid="mic-monitor-level"]',
    uiValue: '2',
  })
  await sendCommand({
    action: 'ui',
    uiAction: 'set-value',
    selector: '[data-testid="player-volume"]',
    uiValue: '0.6',
  })
  const expandedCapture = await sendCommand({ action: 'screenshot' })
  await copyFile(expandedCapture.path, path.join(output, 'audio-controls-expanded.png'))
  await sendCommand({
    action: 'ui',
    uiAction: 'click',
    selector: '.audio-controls-heading button',
  })
  if (await panelOpen()) throw new Error('Close did not collapse audio settings.')
  await togglePanel()
  const restoredVolume = await sendCommand({
    action: 'ui',
    uiAction: 'snapshot',
    selector: '[data-testid="player-volume"]',
  })
  const restored = await echoState()
  if (restoredVolume.value !== '0.6' || restored.dataset?.echoAmount !== '0.400'
    || restored.dataset?.monitorGain !== '2.000' || restored.dataset?.echoEnabled !== 'false') {
    throw new Error('Collapsing audio settings changed the audio settings.')
  }
  await togglePanel()
  if (await panelOpen()) throw new Error('Settings button did not toggle the panel closed.')
  const capture = await sendCommand({ action: 'screenshot' })
  const screenshot = path.join(output, 'microphone-monitor-off.png')
  await copyFile(capture.path, screenshot)
  if ((await stat(screenshot)).size === 0) throw new Error('Rendered screenshot is empty.')
  const diagnostics = await sendCommand({ action: 'diagnostics' })
  if (diagnostics.rendererErrorCount !== 0) {
    throw new Error(`Renderer diagnostics contain ${diagnostics.rendererErrorCount} errors.`)
  }
  console.log(`PASS rendered audio controls: compact group, collapsed panel, adjustable levels/echo, preserved settings, screenshot ${screenshot}`)
} finally {
  if (child && child.exitCode === null) {
    child.kill()
    await waitFor(() => child.exitCode !== null, 'application shutdown', 8_000).catch(() => undefined)
  }
}
