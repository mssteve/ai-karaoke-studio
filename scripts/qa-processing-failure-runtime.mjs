import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { sendCommand } from './control.mjs'
import { verifyLocalElectronEntry } from './local-electron-entry.mjs'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'

const [appArg, entryArg, fixtureArg, outputArg] = process.argv.slice(2)
if (!appArg || !entryArg || !fixtureArg || !outputArg) {
  throw new Error('Usage: node scripts/qa-processing-failure-runtime.mjs <electron> <entry> <fixture> <output>')
}

const executable = path.resolve(appArg)
const entry = path.resolve(entryArg)
const fixture = path.resolve(fixtureArg)
const output = path.resolve(outputArg)
const profile = path.join(output, 'profile')
process.env.KARAOKE_AUTOMATION_PIPE = `\\\\.\\pipe\\karaoke-studio-processing-runtime-${process.pid}`
const cases = []
let assertions = 0
let child

function check(value, message) {
  assert.ok(value, message)
  assertions += 1
}

async function waitFor(checkValue, description, timeoutMs = 30_000) {
  const started = Date.now()
  let lastError
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await checkValue()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await delay(100)
  }
  throw new Error(`${description} not observed${lastError ? `: ${lastError.message}` : ''}`)
}

const command = (value, timeoutMs = 120_000) => sendCommand(value, { timeoutMs })
const song = (status, id) => status.songs.find((candidate) => candidate.id === id)

async function start() {
  await verifyLocalElectronEntry(executable, entry)
  child = spawn(executable, [
    entry,
    `--user-data-dir=${profile}`,
    '--enable-private-automation',
    '--enable-private-qa-hooks',
  ], { cwd: path.dirname(executable), stdio: 'ignore' })
  return waitFor(() => command({ action: 'status' }, 750), 'application startup')
}

async function stop() {
  if (!child || child.exitCode !== null) return
  child.kill()
  await waitFor(() => child.exitCode !== null, 'application shutdown', 8_000).catch(() => undefined)
  child = undefined
  await delay(250)
}

async function createProfile() {
  await rm(output, { recursive: true, force: true })
  await mkdir(profile, { recursive: true })
  const templates = path.join(output, 'templates')
  await mkdir(templates, { recursive: true })
  const sourceTemplate = path.join(templates, 'source.wav')
  const speechTemplate = path.join(templates, 'speech.wav')
  const outputTemplate = path.join(templates, 'output.m4a')
  for (const [target, args] of [
    [sourceTemplate, ['-vn', '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le']],
    [speechTemplate, ['-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le']],
    [outputTemplate, ['-vn', '-ar', '44100', '-ac', '2', '-c:a', 'aac', '-b:a', '128k']],
  ]) {
    const generated = spawnSync(ffmpegInstaller.path, ['-y', '-i', fixture, ...args, target], {
      windowsHide: true,
      encoding: 'utf8',
    })
    if (generated.status !== 0) throw new Error(generated.stderr)
  }
  const ids = [
    'source-target', 'source-next',
    'demucs-target', 'demucs-next',
    'stem-target', 'stem-next',
    'whisper-target', 'whisper-next',
    'enhanced-target', 'enhanced-next',
    'save-target', 'save-next',
  ]
  const songs = []
  for (const id of ids) {
    const root = path.join(profile, 'processed', id)
    const stems = path.join(root, 'stems')
    await mkdir(stems, { recursive: true })
    await copyFile(sourceTemplate, path.join(root, 'source.wav'))
    await copyFile(speechTemplate, path.join(root, 'speech.wav'))
    for (const target of [
      path.join(stems, 'vocals.wav'),
      path.join(stems, 'drums.wav'),
      path.join(stems, 'bass.wav'),
      path.join(stems, 'other.wav'),
    ]) await copyFile(sourceTemplate, target)
    for (const target of [
      path.join(root, 'instrumental.m4a'),
      path.join(root, 'vocal.m4a'),
      path.join(root, 'enhanced.m4a'),
    ]) await copyFile(outputTemplate, target)
    await writeFile(path.join(root, 'lyrics.json'), JSON.stringify({
      text: 'QA lyric',
      languageCode: 'en',
      languageName: 'English',
      languageSource: 'detected',
      lines: [{ text: 'QA lyric', start: 0, end: 1 }],
    }), 'utf8')
    songs.push({
      id,
      title: id,
      artist: 'Runtime QA',
      sourcePath: fixture,
      sourceUrl: '',
      format: 'mp3',
      addedAt: new Date().toISOString(),
      instrumentalPath: path.join(root, 'instrumental.m4a'),
      vocalPath: path.join(root, 'vocal.m4a'),
      enhancedPath: path.join(root, 'enhanced.m4a'),
      lyrics: [{ text: 'QA lyric', start: 0, end: 1 }],
      lyricLanguage: { languageCode: 'en', languageName: 'English', languageSource: 'detected' },
      languageCode: 'en',
      languageName: 'English',
      languageSource: 'detected',
      processingStage: 'complete',
      processingProgress: 100,
    })
  }
  await writeFile(path.join(profile, 'library.json'), JSON.stringify(songs, null, 2), 'utf8')
  await writeFile(path.join(profile, 'playlists.json'), JSON.stringify({
    schemaVersion: 1,
    selectedPlaylistId: 'queue',
    playlists: [],
  }), 'utf8')
}

async function removeTargetArtifact(point, id) {
  const root = path.join(profile, 'processed', id)
  if (point === 'source-preparation') {
    await rm(path.join(root, 'source.wav'), { force: true })
    await rm(path.join(root, 'speech.wav'), { force: true })
  } else if (point === 'demucs') {
    await Promise.all(['vocals', 'drums', 'bass', 'other']
      .map((stem) => rm(path.join(root, 'stems', `${stem}.wav`), { force: true })))
  } else if (point === 'stem-other') {
    await rm(path.join(root, 'stems', 'other.wav'), { force: true })
  } else if (point === 'whisper-transcription') {
    await rm(path.join(root, 'lyrics.json'), { force: true })
  } else {
    await rm(path.join(root, 'enhanced.m4a'), { force: true })
  }
}

async function runScenario({
  id,
  point,
  retryComponent,
  expectedFailure,
  readySiblings,
  normalizationFixture = false,
}) {
  const target = `${id}-target`
  const next = `${id}-next`
  console.log(`Running processing failure scenario: ${id}`)
  await removeTargetArtifact(point, target)
  await removeTargetArtifact('enhanced', next)
  await command({
    action: 'qa-configure',
    songId: target,
    failurePoint: normalizationFixture ? undefined : point,
    failureMessage: id === 'demucs'
      ? "Cannot read properties of undefined (reading 'length')"
      : undefined,
    enabled: true,
    transcriptFixture: normalizationFixture ? 'invalid' : undefined,
  })

  const targetAttempt = command({ action: 'retry', songId: target, component: retryComponent })
    .then(() => undefined, (error) => error)
  await delay(50)
  const nextAttempt = command({ action: 'retry', songId: next, component: 'enhanced' })
  const failure = await targetAttempt
  check(failure instanceof Error && failure.message.includes(
    normalizationFixture
      ? 'no nonempty lyric fragments'
      : id === 'demucs'
        ? "Cannot read properties of undefined (reading 'length')"
        : `QA injected ${point} failure`,
  ), `${id}: exact failure must reach the runtime caller`)
  await nextAttempt

  let status = await command({ action: 'status' })
  let failed = song(status, target)
  const continued = song(status, next)
  check(failed.failure?.component === expectedFailure, `${id}: exact failure component`)
  check(failed.stage === 'partial',
    `${id}: failed job with playable outputs must expose terminal partial state`)
  check(status.activeJobs.length === 0, `${id}: failed job must release the serial slot`)
  check(continued.versions.enhanced && continued.stage === 'complete',
    `${id}: the next queued job must continue to success`)
  for (const sibling of readySiblings) {
    check(failed.versions[sibling], `${id}: successful ${sibling} output remains usable`)
  }
  if (point === 'save-library') {
    check(failed.progress < 100, `${id}: durable save failure must remain below 100`)
    check(failed.deliverables.outcomes.enhanced.state === 'ready',
      `${id}: completed processing work must survive the save failure`)
  } else {
    check(failed.deliverables.outcomes[retryComponent].state === 'failed',
      `${id}: only the targeted retry component is failed`)
  }
  await command({
    action: 'ui',
    uiAction: 'click',
    selector: `[data-testid="song-row"][data-song-id="${target}"]`,
  })
  const retryControl = await waitFor(async () => {
    const result = await command({
      action: 'ui',
      uiAction: 'exists',
      selector: `[data-testid="retry-${expectedFailure}"]`,
    })
    return result.exists ? result : undefined
  }, `${id} retry control`)
  check(retryControl.exists, `${id}: rendered retry targets the exact failed component`)

  await stop()
  if (id === 'demucs') {
    const libraryPath = path.join(profile, 'library.json')
    const persisted = JSON.parse(await readFile(libraryPath, 'utf8'))
    const stale = persisted.find((candidate) => candidate.id === target)
    stale.deliverables.outcomes.demucs = {
      ...stale.deliverables.outcomes.demucs,
      state: 'missing',
      failure: undefined,
    }
    await writeFile(libraryPath, JSON.stringify(persisted, null, 2), 'utf8')
  }
  await start()
  status = await command({ action: 'status' })
  failed = song(status, target)
  check(failed.failure?.component === expectedFailure, `${id}: exact failure persists after restart`)
  for (const sibling of readySiblings) {
    check(failed.versions[sibling], `${id}: ${sibling} remains usable after restart`)
  }

  await command({
    action: 'qa-configure',
    enabled: true,
    transcriptFixture: normalizationFixture ? 'corrected' : undefined,
  })
  if (id === 'demucs') {
    await command({
      action: 'ui',
      uiAction: 'click',
      selector: `[data-testid="song-row"][data-song-id="${target}"]`,
    })
    const beforeRetry = await command({
      action: 'ui',
      uiAction: 'snapshot',
      selector: '[data-testid="retry-demucs"]',
    })
    check(beforeRetry.disabled === false && beforeRetry.text === 'Try again',
      `${id}: installed persisted shape renders an enabled Try again action`)
    await command({
      action: 'ui',
      uiAction: 'click',
      selector: '[data-testid="retry-demucs"]',
    })
    await command({
      action: 'ui',
      uiAction: 'click',
      selector: '[data-testid="retry-demucs"]',
    }).catch(() => undefined)
    const queued = await waitFor(async () => {
      const current = await command({ action: 'status' })
      const targetSong = song(current, target)
      return current.activeJobs.length === 1
        && ['queued', 'preparing', 'separating', 'enhancing', 'transcribing'].includes(targetSong.stage)
        ? current
        : undefined
    }, `${id} rendered retry queue`)
    check(queued.activeJobs.length === 1,
      `${id}: duplicate rendered clicks coalesce into one queued/active job`)
    const retryControl = await command({
      action: 'ui',
      uiAction: 'snapshot',
      selector: '[data-testid="retry-demucs"]',
    }).catch(() => undefined)
    check(!retryControl || retryControl.disabled === true,
      `${id}: retry action disables or disappears immediately after queueing`)
    await waitFor(async () => {
      const current = await command({ action: 'status' })
      return song(current, target)?.stage === 'complete' ? current : undefined
    }, `${id} corrected rendered retry completion`, 180_000)
  } else {
    await command({ action: 'retry', songId: target, component: expectedFailure }, 180_000)
  }
  status = await command({ action: 'status' })
  const recovered = song(status, target)
  check(!recovered.failure, `${id}: failure removal permits recovery`)
  check(recovered.stage === 'complete', `${id}: targeted retry eventually completes`)
  if (normalizationFixture) {
    await command({ action: 'qa-configure', enabled: true, transcriptFixture: 'fallback' })
    await command({ action: 'retranscribe', songId: target }, 180_000)
    status = await command({ action: 'status' })
    const degraded = song(status, target)
    check(degraded.deliverables.outcomes['whisper-transcription'].diagnostics?.fallbackUsed === true,
      `${id}: fallback timing diagnostics must persist`)
    await command({
      action: 'ui',
      uiAction: 'click',
      selector: `[data-testid="song-row"][data-song-id="${target}"]`,
    })
    const warning = await waitFor(async () => {
      const result = await command({
        action: 'ui',
        uiAction: 'exists',
        selector: '[data-testid="lyrics-timing-warning"]',
      })
      return result.exists ? result : undefined
    }, `${id} fallback timing disclosure`)
    check(warning.exists, `${id}: rendered lyrics UI must disclose fallback timing`)
  }
  cases.push({
    id,
    point,
    component: expectedFailure,
    status: 'passed',
    persistedStage: failed.stage,
    recoveredStage: recovered.stage,
    nextJob: continued.stage,
  })
}

async function main() {
  await stat(fixture)
  await createProfile()
  try {
    await start()
    const initial = await command({ action: 'status' })
    for (const candidate of initial.songs) {
      check(candidate.versions.instrumental && candidate.versions.vocal && candidate.versions.enhanced,
        `${candidate.id}: seeded sibling outputs must validate before injection`)
    }
    await runScenario({
      id: 'source',
      point: 'source-preparation',
      retryComponent: 'source-preparation',
      expectedFailure: 'source-preparation',
      readySiblings: ['instrumental', 'vocal', 'enhanced'],
    })
    await runScenario({
      id: 'demucs',
      point: 'demucs',
      retryComponent: 'demucs',
      expectedFailure: 'demucs',
      readySiblings: ['instrumental', 'vocal', 'enhanced'],
    })
    await runScenario({
      id: 'stem',
      point: 'stem-other',
      retryComponent: 'stem-other',
      expectedFailure: 'stem-other',
      readySiblings: ['instrumental', 'vocal', 'enhanced'],
    })
    await runScenario({
      id: 'whisper',
      point: 'whisper-transcription',
      retryComponent: 'whisper-transcription',
      expectedFailure: 'whisper-transcription',
      readySiblings: ['instrumental', 'vocal', 'enhanced'],
      normalizationFixture: true,
    })
    await runScenario({
      id: 'enhanced',
      point: 'enhanced',
      retryComponent: 'enhanced',
      expectedFailure: 'enhanced',
      readySiblings: ['instrumental', 'vocal'],
    })
    await runScenario({
      id: 'save',
      point: 'save-library',
      retryComponent: 'enhanced',
      expectedFailure: 'library-save',
      readySiblings: ['instrumental', 'vocal', 'enhanced'],
    })
    const diagnostics = await command({ action: 'diagnostics' })
    check(diagnostics.rendererErrorCount === 0, 'runtime suite must leave renderer diagnostics clean')
  } finally {
    await stop()
  }
  const report = {
    verdict: cases.length === 6 ? 'APPROVE' : 'REJECT',
    generatedAt: new Date().toISOString(),
    assertions,
    cases,
    profile,
    qaHooks: {
      requiredFlags: ['--enable-private-automation', '--enable-private-qa-hooks'],
      fixtureAi: true,
    },
  }
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2), 'utf8')
  console.log(`${report.verdict}: ${cases.length}/6 runtime failure scenarios, ${assertions} assertions.`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
