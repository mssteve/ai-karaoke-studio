import { execFile, spawn } from 'node:child_process'
import { access, copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { sendCommand } from './control.mjs'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageVersion = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8')).version
const timestamp = new Date().toISOString().replaceAll(':', '-')
const options = parseArgs(process.argv.slice(2))
const outputRoot = path.resolve(options.output ?? path.join(projectRoot, 'scripts', 'qa-artifacts', timestamp))
const profileRoot = path.join(outputRoot, 'profiles')
const executable = path.resolve(options.app)
const fixturePaths = options.fixtures.map((value) => path.resolve(value))
const cases = []
const execFileAsync = promisify(execFile)
let child

function parseArgs(args) {
  const parsed = { fixtures: [], process: false, keepOpen: false }
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (value === '--fixture') parsed.fixtures.push(args[++index])
    else if (value === '--app') parsed.app = args[++index]
    else if (value === '--output') parsed.output = args[++index]
    else if (value === '--process') parsed.process = true
    else if (value === '--keep-open') parsed.keepOpen = true
    else throw new Error(`Unknown argument: ${value}`)
  }
  if (!parsed.app) throw new Error('--app must identify the packaged Karaoke Studio executable.')
  if (!parsed.process) throw new Error('--process is required; packaged QA cannot skip AI gates.')
  if (!parsed.fixtures.length) {
    parsed.fixtures = [
      path.join(projectRoot, 'scripts', 'qa-artifacts', 'fixtures', 'qa-tone.mp3'),
      path.join(projectRoot, 'scripts', 'qa-artifacts', 'fixtures', 'qa-video.mp4'),
    ]
  }
  return parsed
}

function record(id, passed, evidence) {
  cases.push({ id, status: passed ? 'passed' : 'failed', evidence })
  console.log(`${passed ? 'PASS' : 'FAIL'} ${id}: ${evidence}`)
}

async function waitForPipe(timeoutMs = 30_000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      return await sendCommand({ action: 'status' }, { timeoutMs: 1_000 })
    } catch {
      await delay(250)
    }
  }
  throw new Error(`Named pipe was not ready after ${timeoutMs} ms.`)
}

async function expectPipeClosed(timeoutMs = 1_500) {
  try {
    await sendCommand({ action: 'status' }, { timeoutMs })
    return false
  } catch {
    return true
  }
}

async function startApp(profileName, privateAutomation) {
  await access(executable)
  const args = [`--user-data-dir=${path.join(profileRoot, profileName)}`]
  if (privateAutomation) args.push('--enable-private-automation')
  child = spawn(executable, args, { cwd: projectRoot, stdio: 'ignore' })
  child.on('error', (error) => console.error(`Application process error: ${error.message}`))
  if (privateAutomation) return waitForPipe()
  await delay(4_000)
  if (child.exitCode !== null) throw new Error(`Packaged application exited with code ${child.exitCode}.`)
  return undefined
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
    await delay(100)
  }
  throw new Error(`${description} was not observed within ${timeoutMs} ms.${lastError ? ` ${lastError.message}` : ''}`)
}

function renderedUi(uiAction, selector, uiValue) {
  return sendCommand({ action: 'ui', uiAction, selector, uiValue })
}

async function processTreeListeningPorts(rootPid) {
  const script = `
$rootPid = ${rootPid}
$ids = @($rootPid)
do {
  $next = @(Get-CimInstance Win32_Process | Where-Object {
    $ids -contains $_.ParentProcessId -and $ids -notcontains $_.ProcessId
  } | Select-Object -ExpandProperty ProcessId)
  $ids += $next
} while ($next.Count -gt 0)
$listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object {
  $ids -contains $_.OwningProcess
} | Select-Object LocalAddress, LocalPort, OwningProcess)
$listeners | ConvertTo-Json -Compress
`
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded])
  const text = stdout.trim()
  if (!text) return []
  const parsed = JSON.parse(text)
  return Array.isArray(parsed) ? parsed : [parsed]
}

async function selectNativeDialogFiles(rootPid, files) {
  const filePayload = Buffer.from(JSON.stringify(files), 'utf8').toString('base64')
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$rootPid = ${rootPid}
$paths = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${filePayload}')) | ConvertFrom-Json
$ids = @($rootPid)
do {
  $next = @(Get-CimInstance Win32_Process | Where-Object {
    $ids -contains $_.ParentProcessId -and $ids -notcontains $_.ProcessId
  } | Select-Object -ExpandProperty ProcessId)
  $ids += $next
} while ($next.Count -gt 0)
$deadline = [DateTime]::UtcNow.AddSeconds(30)
$dialog = $null
while (-not $dialog -and [DateTime]::UtcNow -lt $deadline) {
  $windows = [Windows.Automation.AutomationElement]::RootElement.FindAll(
    [Windows.Automation.TreeScope]::Descendants,
    [Windows.Automation.Condition]::TrueCondition
  )
  foreach ($window in $windows) {
    if ($window.Current.Name -eq 'Add songs to Karaoke Studio' -and $window.Current.ControlType -eq [Windows.Automation.ControlType]::Window -and $ids -contains $window.Current.ProcessId) {
      $dialog = $window
      break
    }
  }
  if (-not $dialog) { Start-Sleep -Milliseconds 100 }
}
if (-not $dialog) { throw 'The native Add songs file dialog did not appear.' }
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class NativeDialogFocus {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int command);
}
'@
$selection = [string]$paths[0]
$handle = [IntPtr]$dialog.Current.NativeWindowHandle
if ($handle -eq [IntPtr]::Zero) { throw 'The native Add songs dialog has no window handle.' }
$null = [NativeDialogFocus]::ShowWindow($handle, 5)
$null = [NativeDialogFocus]::BringWindowToTop($handle)
$null = [NativeDialogFocus]::SetForegroundWindow($handle)
Start-Sleep -Milliseconds 200
[Windows.Forms.SendKeys]::SendWait('%n')
Start-Sleep -Milliseconds 100
[Windows.Forms.SendKeys]::SendWait($selection)
[Windows.Forms.SendKeys]::SendWait('{ENTER}')
[PSCustomObject]@{
  dialog = $dialog.Current.Name
  processId = $dialog.Current.ProcessId
  selected = @($paths)
} | ConvertTo-Json -Compress
`
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded], {
    timeout: 40_000,
  })
  return JSON.parse(stdout.trim())
}

async function stopApp() {
  if (!child || child.exitCode !== null) return
  const rootPid = child.pid
  await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-Command',
    `$process = Get-Process -Id ${rootPid} -ErrorAction SilentlyContinue; if ($process) { $null = $process.CloseMainWindow(); $process.WaitForExit(5000) }`,
  ])
  if (child.exitCode === null) {
    await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `$rootPid=${rootPid}; $ids=@($rootPid); do { $next=@(Get-CimInstance Win32_Process | Where-Object { $ids -contains $_.ParentProcessId -and $ids -notcontains $_.ProcessId } | Select-Object -ExpandProperty ProcessId); $ids += $next } while ($next.Count -gt 0); [array]::Reverse($ids); foreach ($id in $ids) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }`,
    ])
  }
  await delay(1_000)
  child = undefined
}

async function capture(name) {
  const result = await sendCommand({ action: 'screenshot' })
  const destination = path.join(outputRoot, `${name}.png`)
  await copyFile(result.path, destination)
  const info = await stat(destination)
  if (info.size < 10_000 || result.size.width < 1060 || result.size.height < 700) {
    throw new Error(`Screenshot was unexpectedly small (${result.size.width}x${result.size.height}, ${info.size} bytes).`)
  }
  return {
    path: destination,
    evidence: `${result.size.width}x${result.size.height}, ${info.size} bytes, ${destination}`,
  }
}

async function expectFailure(id, command, pattern) {
  try {
    await sendCommand(command)
    record(id, false, 'Command unexpectedly succeeded.')
  } catch (error) {
    record(id, pattern.test(error.message), error.message)
  }
}

async function importThroughNativeDialog(files, expectedCount) {
  const click = renderedUi('click', '[data-testid="add-songs"]')
  const dialogEvidence = await selectNativeDialogFiles(child.pid, files)
  await click
  const status = await waitFor(async () => {
    const next = await sendCommand({ action: 'status' })
    return next.songs.length === expectedCount ? next : undefined
  }, 'Native Add songs import', 30_000)
  return { status, dialogEvidence }
}

async function main() {
  await mkdir(profileRoot, { recursive: true })
  for (const fixture of fixturePaths) await access(fixture)
  if (!await expectPipeClosed()) throw new Error('A pre-existing Karaoke Studio automation pipe is active.')

  await startApp('normal', false)
  const normalPipeClosed = await expectPipeClosed()
  const normalListeners = await processTreeListeningPorts(child.pid)
  record('packaged-default-no-automation', normalPipeClosed,
    'A normal packaged launch did not create or answer the private named pipe.')
  record('normal-no-listening-network-port', normalListeners.length === 0,
    `Normal packaged process tree had ${normalListeners.length} listening TCP endpoints.`)
  await stopApp()

  let status = await startApp('automation', true)
  const enabledListeners = await processTreeListeningPorts(child.pid)
  record('packaged-explicit-automation', Boolean(status?.window),
    'The packaged app answered the named pipe only with --enable-private-automation.')
  record('automation-no-listening-network-port', enabledListeners.length === 0,
    `Automation-enabled process tree had ${enabledListeners.length} listening TCP endpoints; automation uses a named pipe.`)
  record('startup-ui', status.window?.visible === true && status.window.url === 'karaoke://app/index.html',
    `Window visible=${status.window?.visible}, URL=${status.window?.url}, title=${status.window?.title}.`)
  record('secure-bridge', status.bridgeExpected === true,
    `Sandboxed packaged window reports bridgeExpected=${status.bridgeExpected}.`)
  const startupShot = await capture('01-startup')

  const mp3Import = await importThroughNativeDialog([fixturePaths[0]], 1)
  const mp4Import = await importThroughNativeDialog([fixturePaths[1]], 2)
  status = mp4Import.status
  const imported = status.songs
  const importedPaths = new Set(imported.map((song) => song.sourcePath.toLowerCase()))
  record('native-dialog-import',
    fixturePaths.every((fixture) => importedPaths.has(fixture.toLowerCase())),
    `Rendered Add Songs opened "${mp3Import.dialogEvidence.dialog}" and selected the MP3 and MP4 fixtures through two real common-dialog interactions. ${startupShot.evidence}`)

  const duplicateImport = await importThroughNativeDialog([fixturePaths[0]], imported.length)
  record('duplicate-import', duplicateImport.status.songs.length === imported.length,
    `A second real common-dialog selection kept the library count at ${imported.length}.`)

  const selected = imported.find((song) => song.sourcePath.toLowerCase() === fixturePaths[0].toLowerCase())
  if (!selected) throw new Error('The primary fixture was not returned by the native import.')
  await stopApp()
  status = await startApp('automation', true)
  record('library-persistence', status.songs.length === imported.length,
    `Library contained ${status.songs.length} songs after packaged restart (expected ${imported.length}).`)

  const beforeSelection = await capture('02-before-selection')
  const selectedRowSelector = `[data-testid="song-row"][data-song-id="${selected.id}"]`
  await renderedUi('click', selectedRowSelector)
  const selectedRow = await waitFor(async () => {
    const state = await renderedUi('snapshot', selectedRowSelector)
    return state.ariaSelected === 'true' ? state : undefined
  }, 'Rendered song selection')
  const selectedShot = await capture('03-selected')
  const selectionChanged = !Buffer.from(await readFile(beforeSelection.path))
    .equals(Buffer.from(await readFile(selectedShot.path)))
  record('select-song', selectionChanged && selectedRow.ariaSelected === 'true',
    `Clicked song row ${selected.id}; selection and rendered pixels changed. ${selectedShot.evidence}`)

  await renderedUi('click', '[data-testid="mode-original"]')
  await renderedUi('set-value', '[data-testid="playback-seek"]', '1')
  await renderedUi('click', '[data-testid="playback-toggle"]')
  await waitFor(async () => {
    const state = await renderedUi('snapshot', '[data-testid="playback-toggle"]')
    return state.ariaLabel === 'Pause' ? state : undefined
  }, 'Rendered play control')
  await delay(750)
  await renderedUi('click', '[data-testid="playback-toggle"]')
  const pausedState = await waitFor(async () => {
    const state = await renderedUi('snapshot', '[data-testid="playback-toggle"]')
    return state.ariaLabel === 'Play' ? state : undefined
  }, 'Rendered pause control')
  const playbackShot = await capture('04-playback')
  record('original-playback', pausedState.ariaLabel === 'Play',
    `Rendered original play and pause controls updated their state. ${playbackShot.evidence}`)

  try {
    const processed = await sendCommand({ action: 'process', songId: selected.id }, { timeoutMs: 3_600_000 })
    const outputs = ['instrumentalPath', 'vocalPath', 'enhancedPath'].filter((key) => processed[key])
    const orderedLyrics = processed.lyrics.every((line, index, lines) =>
      line.start >= 0 && line.end > line.start && (index === 0 || line.start >= lines[index - 1].start))
    record('ai-processing', outputs.length === 3, `Packaged AI produced ${outputs.join(', ') || 'no derived outputs'}.`)
    record('lyrics-sync', processed.lyrics.length > 0 && orderedLyrics,
      `${processed.lyrics.length} ordered timed lyric lines returned.`)
    await stopApp()
    await startApp('automation', true)
    await renderedUi('click', selectedRowSelector)
    const modeImages = []
    for (const mode of ['enhanced', 'vocal', 'instrumental', 'original']) {
      await renderedUi('click', `[data-testid="mode-${mode}"]`)
      await delay(250)
      modeImages.push(await capture(`05-mode-${mode}`))
    }
    const distinctModes = new Set(await Promise.all(modeImages.map(async (image) =>
      Buffer.from(await readFile(image.path)).toString('base64')))).size
    record('four-modes', distinctModes === 4,
      `Enhanced, vocal, instrumental, and original controls rendered distinct states; ${modeImages.map((item) => item.path).join(', ')}.`)
  } catch (error) {
    record('ai-processing', false, error.message)
    record('lyrics-sync', false, 'AI processing did not produce timed lyrics.')
    record('four-modes', false, 'AI processing did not make all four modes available.')
  }

  await expectFailure('failure-unsupported-format', { action: 'add', paths: [path.join(projectRoot, 'package.json')] }, /Unsupported song format/)
  await expectFailure('failure-missing-song', { action: 'process', songId: 'missing-song' }, /not found/)
  const diagnostics = await sendCommand({ action: 'diagnostics' })
  await sendCommand({ action: 'control', value: { action: 'select', value: 'missing-song' } })
  await delay(500)
  const diagnosticLog = path.join(diagnostics.path, 'karaoke-studio.log')
  const diagnosticText = await readFile(diagnosticLog, 'utf8')
  record('error-diagnostics', diagnosticText.includes('Automation could not select the requested song'),
    `Injected renderer failure was recorded in ${diagnosticLog}.`)

  const sourceInfo = await stat(selected.sourcePath)
  await renderedUi('click', `${selectedRowSelector} [data-testid="remove-song"]`)
  const afterRemoval = await waitFor(async () => {
    const next = await sendCommand({ action: 'status' })
    return !next.songs.some((song) => song.id === selected.id) ? next : undefined
  }, 'Rendered remove control')
  record('remove-song', !afterRemoval.songs.some((song) => song.id === selected.id) && sourceInfo.isFile(),
    `Entry removed and source fixture remains at ${selected.sourcePath}.`)
  await capture('06-final')

  for (const [id, artifact] of [
    ['windows-installer', path.join(projectRoot, 'release', `Karaoke Studio-Setup-${packageVersion}.exe`)],
    ['store-package', path.join(projectRoot, 'release', `Karaoke Studio-Setup-${packageVersion}.appx`)],
    ['release-provenance', path.join(projectRoot, 'release', 'provenance.json')],
    ['release-hashes', path.join(projectRoot, 'release', 'SHA256SUMS.txt')],
  ]) {
    try {
      const info = await stat(artifact)
      record(id, info.size > 0, `${artifact} is ${info.size} bytes.`)
    } catch (error) {
      record(id, false, error.message)
    }
  }

  const report = {
    verdict: cases.every((item) => item.status === 'passed') ? 'APPROVE' : 'REJECT',
    generatedAt: new Date().toISOString(),
    executable,
    fixturePaths,
    cases,
    screenshots: (await readdirSafe(outputRoot)).filter((value) => value.endsWith('.png')),
  }
  const reportPath = path.join(outputRoot, 'report.json')
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`${report.verdict}: ${cases.filter((item) => item.status === 'passed').length}/${cases.length} gates passed.`)
  console.log(`Evidence: ${reportPath}`)
  process.exitCode = report.verdict === 'APPROVE' ? 0 : 1
}

async function readdirSafe(directory) {
  const { readdir } = await import('node:fs/promises')
  return readdir(directory)
}

try {
  await main()
} catch (error) {
  console.error(`REJECT: ${error instanceof Error ? error.stack : String(error)}`)
  process.exitCode = 1
} finally {
  if (!options.keepOpen) await stopApp()
}
