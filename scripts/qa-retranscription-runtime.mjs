import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { commandFromArgs, sendCommand, timeoutForCommand } from './control.mjs'

const execFileAsync = promisify(execFile)
const args = parseArgs(process.argv.slice(2))
const executable = path.resolve(args.app)
const sourceProfile = path.resolve(args.profile)
const outputRoot = path.resolve(args.output)
const profile = path.join(outputRoot, 'profile')
const libraryPath = path.join(profile, 'library.json')
const cases = []
let child

function parseArgs(values) {
  const parsed = {}
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] === '--app') parsed.app = values[++index]
    else if (values[index] === '--profile') parsed.profile = values[++index]
    else if (values[index] === '--output') parsed.output = values[++index]
    else throw new Error(`Unknown argument: ${values[index]}`)
  }
  if (!parsed.app || !parsed.profile || !parsed.output) {
    throw new Error('--app, --profile, and --output are required.')
  }
  return parsed
}

function record(id, passed, evidence, details) {
  cases.push({ id, status: passed ? 'passed' : 'failed', evidence, details })
  console.log(`${passed ? 'PASS' : 'FAIL'} ${id}: ${evidence}`)
}

async function waitFor(check, description, timeoutMs = 30_000) {
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
  throw new Error(`${description} not observed.${lastError ? ` ${lastError.message}` : ''}`)
}

async function sha256(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex')
}

async function sourceManifest(library) {
  return Promise.all(library.map(async (song) => {
    const info = await stat(song.sourcePath)
    return {
      songId: song.id,
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
  await delay(500)
}

async function startApp() {
  child = spawn(executable, [`--user-data-dir=${profile}`, '--enable-private-automation'], {
    cwd: path.dirname(executable),
    stdio: 'ignore',
  })
  return waitFor(
    () => sendCommand({ action: 'status' }, { timeoutMs: 750 }),
    'private automation pipe',
  )
}

async function main() {
  await mkdir(outputRoot, { recursive: true })
  await cp(sourceProfile, profile, { recursive: true })
  const library = JSON.parse(await readFile(libraryPath, 'utf8'))
  const song = library.find((candidate) =>
    candidate.languageCode === 'zh'
    && candidate.instrumentalPath
    && candidate.vocalPath
    && candidate.enhancedPath)
  if (!song) throw new Error('A processed Chinese song is required.')
  const sourcesBefore = await sourceManifest(library)
  const transcriptPath = path.join(profile, 'processed', song.id, 'lyrics.json')
  const originalTranscript = JSON.parse(await readFile(transcriptPath, 'utf8'))

  song.languageCode = 'und'
  song.languageName = 'Unknown'
  song.languageSource = 'legacy'
  song.lyricLanguage = {
    languageCode: 'und',
    languageName: 'Unknown',
    languageSource: 'legacy',
  }
  delete originalTranscript.language
  delete originalTranscript.languageCode
  delete originalTranscript.languageName
  delete originalTranscript.languageSource
  await writeFile(libraryPath, `${JSON.stringify(library, null, 2)}\n`)
  await writeFile(transcriptPath, `${JSON.stringify(originalTranscript, null, 2)}\n`)

  let status = await startApp()
  const ports = await listeningPorts(child.pid)
  record('explicit-automation-zero-tcp', ports.length === 0,
    `Explicit private automation started with ${ports.length} listening TCP endpoints.`, ports)
  const initial = status.playback?.songId === song.id
    ? status.playback
    : await waitFor(async () => {
      await sendCommand({ action: 'control', value: { action: 'select', value: song.id } })
      const next = await sendCommand({ action: 'status' })
      return next.playback?.songId === song.id ? next.playback : undefined
    }, 'legacy song selection')
  record('legacy-start-state',
    initial.lyricLanguage?.languageCode === 'und' && initial.lyricLanguage?.languageSource === 'legacy',
    `Initial language=${initial.lyricLanguage?.languageCode}/${initial.lyricLanguage?.languageSource}.`,
    initial.lyricLanguage)

  const retranscriptionCommand = commandFromArgs(['retranscribe', song.id])
  const retranscribed = await sendCommand(retranscriptionCommand, {
    timeoutMs: timeoutForCommand(retranscriptionCommand),
  })
  const persistedLibrary = JSON.parse(await readFile(libraryPath, 'utf8'))
  const persistedSong = persistedLibrary.find((candidate) => candidate.id === song.id)
  const persistedTranscript = JSON.parse(await readFile(transcriptPath, 'utf8'))
  const hasUnicode = persistedTranscript.lines.some((line) => /[^\u0000-\u007f]/.test(line.text))
  const persisted = persistedSong?.languageCode === 'zh'
    && persistedSong?.languageName === 'Chinese'
    && persistedSong?.lyricLanguage?.languageCode === 'zh'
    && persistedTranscript.languageCode === 'zh'
    && persistedTranscript.languageName === 'Chinese'
    && persistedTranscript.lines.length > 0
    && hasUnicode
  record('real-retranscription-persisted', persisted,
    `Library=${persistedSong?.languageName} (${persistedSong?.languageCode}); transcript=${persistedTranscript.languageName} `
    + `(${persistedTranscript.languageCode}), timed lines=${persistedTranscript.lines.length}, Unicode=${hasUnicode}.`,
    { returned: retranscribed, library: persistedSong, transcript: persistedTranscript })

  const diagnosticsBeforeRestart = await sendCommand({ action: 'diagnostics' })
  await stopApp()
  status = await startApp()
  await sendCommand({ action: 'control', value: { action: 'select', value: song.id } })
  const restarted = await waitFor(async () => {
    const next = await sendCommand({ action: 'status' })
    return next.playback?.songId === song.id
      && next.playback.lyricLanguage?.languageCode === 'zh'
      ? next.playback
      : undefined
  }, 'restarted Chinese metadata')
  record('restart-retains-language-and-lyrics',
    restarted.lyricLanguage?.languageName === 'Chinese'
      && restarted.activeLyricText === persistedTranscript.lines[0].text,
    `Restarted language=${restarted.lyricLanguage?.languageName} (${restarted.lyricLanguage?.languageCode}); `
    + `first timed lyric matches=${restarted.activeLyricText === persistedTranscript.lines[0].text}.`,
    restarted)

  const diagnosticsAfterRestart = await sendCommand({ action: 'diagnostics' })
  record('zero-renderer-errors',
    diagnosticsBeforeRestart.rendererErrorCount === 0 && diagnosticsAfterRestart.rendererErrorCount === 0,
    `Renderer exceptions before/after restart=${diagnosticsBeforeRestart.rendererErrorCount}/${diagnosticsAfterRestart.rendererErrorCount}.`,
    { before: diagnosticsBeforeRestart, after: diagnosticsAfterRestart })
  const sourcesAfter = await sourceManifest(persistedLibrary)
  record('source-files-unchanged', JSON.stringify(sourcesBefore) === JSON.stringify(sourcesAfter),
    `${sourcesAfter.length} source files retained hashes, sizes, and timestamps.`,
    { before: sourcesBefore, after: sourcesAfter })

  const report = {
    verdict: cases.every((item) => item.status === 'passed') ? 'APPROVE' : 'REJECT',
    generatedAt: new Date().toISOString(),
    executable,
    sourceProfile,
    isolatedProfile: profile,
    songId: song.id,
    cases,
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
