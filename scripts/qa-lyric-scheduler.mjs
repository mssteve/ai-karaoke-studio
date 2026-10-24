import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as vm from 'node:vm'

if (!vm.SourceTextModule) {
  const child = spawnSync(process.execPath,
    ['--experimental-vm-modules', fileURLToPath(import.meta.url)], { stdio: 'inherit' })
  process.exit(child.status ?? 1)
}

const root = path.resolve('scripts', 'qa-artifacts', `lyric-scheduler-${process.pid}`)
const mainUrl = pathToFileURL(path.resolve('dist-electron', 'main.js')).href
const handlers = new Map()
const publications = []
const diagnostics = []
let ready
let pauseRead
let lyricWriteFailure
let checks = 0
const equal = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks += 1
}
const rejects = async (action, pattern, message) => {
  await assert.rejects(action, pattern, message)
  checks += 1
}
const deferred = () => {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}
const invoke = (channel, value) => handlers.get(channel)({}, value)
const processListeners = new Map(['uncaughtException', 'unhandledRejection'].map(
  (event) => [event, process.listeners(event)],
))
const electron = {
  app: {
    isPackaged: true,
    getPath: () => root,
    getVersion: () => 'qa',
    requestSingleInstanceLock: () => true,
    whenReady: () => ({ then: (callback) => { ready = callback } }),
    on() {},
    quit() {},
  },
  BrowserWindow: class {},
  dialog: {},
  ipcMain: { handle: (channel, callback) => handlers.set(channel, callback), on() {} },
  net: {},
  protocol: { registerSchemesAsPrivileged() {}, handle() {} },
  session: { defaultSession: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } },
  shell: {},
}

await fs.mkdir(root, { recursive: true })
const helper = await import('../dist-electron/lyric-update.js')
// Only desktop startup and expensive AI entrypoints are replaced. IPC handlers,
// scheduler, edit locks, publication, and both persistence paths execute unchanged.
const source = await fs.readFile(fileURLToPath(mainUrl), 'utf8')
const main = new vm.SourceTextModule(`${source}
export const qa = {
  seed: (songs) => { library = songs },
  song: (id) => library.find((song) => song.id === id),
  jobs: () => [...songProcessingPromises.values()],
  pending: (id) => pendingProcessingTargets.has(id),
  snapshot: () => processingScheduler.snapshot(),
  reload: loadLibrary,
  inspect: inspectDeliverables,
  normalize: normalizeSong,
  apply: applyTranscript,
  resume: resumePendingLyricRematches,
  configure: (pipeline, recognition, vocals = true) => {
    executeResumableProcessing = pipeline;
    recognizeRematchWords = recognition;
    songHasVocals = async () => vocals;
    createWindow = async () => { mainWindow = { webContents: { send: (_channel, update) => qaPublish(update) } } };
  },
};
`, {
  identifier: mainUrl,
  initializeImportMeta: (meta) => { meta.url = mainUrl },
  importModuleDynamically: (specifier) => import(new URL(specifier, mainUrl).href),
})
const modules = new Map()
await main.link(async (specifier) => {
  if (modules.has(specifier)) return modules.get(specifier)
  let exports
  if (specifier === 'electron') exports = electron
  else if (specifier === './logger.js') {
    exports = { getDiagnosticsPath: () => path.join(root, 'logs'),
      logDiagnostic: (...args) => diagnostics.push(args) }
  } else if (specifier === 'node:fs/promises') {
    exports = { ...fs, readFile: async (target, ...args) => {
      const contents = await fs.readFile(target, ...args)
      if (pauseRead && path.basename(String(target)) === 'lyrics.json') {
        const pause = pauseRead
        pauseRead = undefined
        pause.entered.resolve()
        await pause.release.promise
      }
      return contents
    } }
  } else if (specifier === './lyric-update.js') {
    exports = { ...helper, replaceTextFile: async (target, contents) => {
      if (lyricWriteFailure && path.basename(target) === 'lyrics.json') {
        const status = JSON.parse(contents).rematch?.status
        if (lyricWriteFailure === 'all' || status === 'complete') {
          if (lyricWriteFailure === 'once') lyricWriteFailure = undefined
          throw Object.assign(new Error('injected runtime sharing violation'), { code: 'EBUSY' })
        }
      }
      return helper.replaceTextFile(target, contents)
    } }
  } else exports = await import(specifier.startsWith('.') ? new URL(specifier, mainUrl).href : specifier)
  const module = new vm.SyntheticModule(Object.keys(exports), function () {
    for (const [key, value] of Object.entries(exports)) this.setExport(key, value)
  })
  modules.set(specifier, module)
  return module
})

// A global callback is confined to the test process; no product test API is added.
globalThis.qaPublish = (update) => publications.push(structuredClone(update))
try {
  await main.evaluate()
  const { qa } = main.namespace
  let pipelineGate
  let pipelineEntered
  let recognitionGate
  let failPipeline = false
  let pipelines = 0
  let recognitions = 0
  const pipelineBatches = []
  const pipeline = async (id, targets) => {
    pipelines += 1
    pipelineBatches.push(targets)
    const song = qa.song(id)
    song.processingStage = 'transcribing'
    pipelineEntered?.resolve()
    if (pipelineGate) await pipelineGate.promise
    if (failPipeline) throw new Error('injected pipeline failure')
    song.processingStage = 'complete'
    return structuredClone(song)
  }
  const recognize = async () => {
    recognitions += 1
    if (recognitionGate) await recognitionGate.promise
    return [{ text: 'Привет', start: 3, end: 4 }, { text: 'мир', start: 4, end: 5 }]
  }
  qa.configure(pipeline, recognize)
  await ready()

  const fixture = (id, overrides = {}) => ({
    id, title: 'QA', artist: 'QA', sourcePath: path.join(root, 'fixture.mp3'), sourceUrl: '',
    format: 'mp3', addedAt: '2026-10-23T00:00:00.000Z', duration: 20,
    lyrics: [{ text: 'old words', start: 0, end: 10 }],
    languageCode: 'ru', languageName: 'Russian', languageSource: 'detected',
    lyricLanguage: { languageCode: 'ru', languageName: 'Russian', languageSource: 'detected' },
    lyricTextSource: 'engine', lyricsRevision: 0, lyricTimingMethod: 'whisper-grouped',
    lyricRematchStatus: 'none', processingStage: 'complete', processingProgress: 100, ...overrides,
  })
  const idle = (id) => {
    equal(qa.snapshot(), { active: 0, queued: 0, total: 0 }, 'scheduler releases its serial slot')
    equal(qa.jobs().length, 0, 'terminal promises are cleaned')
    equal(qa.pending(id), false, 'no pending targets are stranded')
  }

  // Edit -> rematch -> process: incompatible work rejects rather than resolving
  // with the rematch promise and silently skipping the requested pipeline.
  qa.seed([fixture('rematch-first')])
  recognitionGate = deferred()
  const saved = await invoke('lyrics:update', { songId: 'rematch-first', text: 'Привет мир!', expectedRevision: 0 })
  equal(saved.rematch, 'queued', 'actual lyric IPC queues recognition')
  const [rematch] = qa.jobs()
  await rejects(async () => invoke('ai:process', 'rematch-first'), /busy.*Retry/,
    'processing during a rematch explicitly rejects instead of succeeding without work')
  await rejects(() => invoke('ai:retry-deliverable', { songId: 'rematch-first', component: 'library-save' }),
    /busy.*Retry/, 'a library-save job cannot coalesce with rematch')
  equal(pipelines, 0, 'rejected processing requests do not execute or add targets')
  recognitionGate.resolve()
  await rematch
  equal(qa.song('rematch-first').lyrics, [{ text: 'Привет мир!', start: 3, end: 5 }],
    'actual rematch writes fresh Unicode timing without replacing user punctuation')
  idle('rematch-first')
  await invoke('ai:process', 'rematch-first')
  equal(pipelines, 1, 'retrying processing after rematch really executes the requested pipeline')
  idle('rematch-first')

  // Pause the real lyric-file read while the edit owns the lock.
  qa.seed([fixture('edit-first')])
  const target = path.join(root, 'processed', 'edit-first', 'lyrics.json')
  await helper.replaceTextFile(target, JSON.stringify({ text: 'old words', lines: qa.song('edit-first').lyrics }))
  const pause = { entered: deferred(), release: deferred() }
  pauseRead = pause
  recognitionGate = deferred()
  const editing = invoke('lyrics:update', { songId: 'edit-first', text: 'Привет мир!', expectedRevision: 0 })
  await pause.entered.promise
  await rejects(async () => invoke('ai:process', 'edit-first'), /busy.*Retry/,
    'processing honors the edit lock while a lyric-file read is paused')
  await rejects(() => invoke('ai:retry-deliverable', { songId: 'edit-first', component: 'library-save' }),
    /busy.*Retry/, 'library-save retry also honors the edit lock')
  equal(pipelines, 1, 'no active pipeline status can be overwritten by a stale edit snapshot')
  pause.release.resolve()
  await editing
  const editRematch = qa.jobs()[0]
  recognitionGate.resolve()
  await editRematch
  equal(recognitions, 2, 'both accepted edits perform recognition, never an unrelated job')
  equal(qa.song('edit-first').lyricRematchStatus, 'complete', 'the paused edit cannot strand pending rematch')
  idle('edit-first')

  // Processing first still rejects edits, merges same-kind pending targets, and
  // releases the job on failure so an explicit retry can execute.
  qa.seed([fixture('process-first')])
  pipelineGate = deferred()
  pipelineEntered = deferred()
  const processing = invoke('ai:process', 'process-first')
  await pipelineEntered.promise
  await rejects(() => invoke('lyrics:update', { songId: 'process-first', text: 'new' }), /Lyrics are busy/,
    'an edit cannot overwrite an active processing snapshot')
  const sameKind = invoke('ai:retranscribe', 'process-first')
  equal(sameKind, processing, 'same-kind requests retain the established shared terminal promise')
  pipelineGate.resolve()
  await processing
  equal(pipelineBatches.slice(-2), [['original'], ['lyrics']], 'same-kind targets are actually drained')
  idle('process-first')
  pipelineGate = undefined
  failPipeline = true
  await rejects(async () => invoke('ai:process', 'process-first'), /injected pipeline failure/,
    'pipeline failures reach callers')
  idle('process-first')
  failPipeline = false
  await invoke('ai:process', 'process-first')
  idle('process-first')

  qa.seed([fixture('retry-preflight')])
  const preflightTarget = path.join(root, 'processed', 'retry-preflight', 'lyrics.json')
  await helper.replaceTextFile(preflightTarget, JSON.stringify({
    text: 'old words', lines: qa.song('retry-preflight').lyrics,
    languageCode: 'ru', languageName: 'Russian', source: 'engine', revision: 0,
  }))
  const preflightPause = { entered: deferred(), release: deferred() }
  pauseRead = preflightPause
  const retrying = invoke('ai:retry-deliverable', { songId: 'retry-preflight', component: 'enhanced' })
  await preflightPause.entered.promise
  await rejects(() => invoke('lyrics:update', { songId: 'retry-preflight', text: 'new words' }),
    /Lyrics are busy/, 'retry preflight cannot reapply stale lyrics over a concurrent edit')
  await rejects(async () => invoke('ai:process', 'retry-preflight'), /busy.*Retry/,
    'processing also respects the preflight mutation reservation')
  preflightPause.release.resolve()
  await retrying
  idle('retry-preflight')

  for (const failure of ['once', 'all']) {
    const id = `write-failure-${failure}`
    qa.seed([fixture(id)])
    recognitionGate = deferred()
    await invoke('lyrics:update', { songId: id, text: '[00:01.00]Привет мир!\r\n' })
    const job = qa.jobs()[0]
    lyricWriteFailure = failure
    recognitionGate.resolve()
    if (failure === 'all') {
      await rejects(() => job, /Failure status could not be fully persisted/,
        'persistent lyric-write failure rejects with the original persistence failure')
    } else await job
    lyricWriteFailure = undefined
    equal(qa.song(id).lyricRematchStatus, 'failed', 'runtime failure never leaves the library pending')
    equal(qa.song(id).lyrics, [{ text: 'Привет мир!', start: 0, end: 10 }],
      'runtime failure retains saved wording and old timing')
    equal(publications.some((update) => update.songId === id && update.song?.lyricRematchStatus === 'failed'),
      true, 'actual main-process publication surfaces persistence failure')
    const disk = JSON.parse(await fs.readFile(path.join(root, 'library.json'), 'utf8'))
    equal(disk[0].lyricRematchStatus, 'failed', 'library failure status is durable even when lyrics.json cannot be written')
    idle(id)
  }
  equal(diagnostics.some((entry) => entry[1].includes('Lyric timing rematch failed')), true,
    'unrecoverable persistence failure is also diagnosed')

  const id = 'resume-no-vocals'
  qa.seed([fixture(id, { lyricTextSource: 'user', lyricsRevision: 1, lyricRematchStatus: 'pending',
    lyrics: [{ text: 'Привет мир!', start: 0, end: 10 }] })])
  const rawText = '[ar:QA]\r\n[00:01.00]Привет мир!\r\n\r\n'
  const resumeTarget = path.join(root, 'processed', id, 'lyrics.json')
  await helper.replaceTextFile(resumeTarget, JSON.stringify({
    text: rawText, lines: qa.song(id).lyrics, source: 'user', revision: 1, rematch: { status: 'pending' },
  }))
  qa.configure(pipeline, recognize, false)
  await qa.resume()
  equal(JSON.parse(await fs.readFile(resumeTarget, 'utf8')).text, rawText,
    'restart without vocals preserves raw LRC rather than flattening the document')
  equal(qa.song(id).lyricEditorText, rawText, 'skipped restart rematch restores exact editor text')

  const beforeSettings = await fs.readFile(path.join(root, 'library.json'), 'utf8')
  for (let iteration = 0; iteration < 10; iteration += 1) {
    await invoke('settings:set', { uiLocale: 'en', recognitionLanguageMode: 'auto', recognitionLanguageCode: 'en' })
    await Promise.all([
      invoke('settings:set', { uiLocale: 'fr' }),
      invoke('settings:set', { recognitionLanguageMode: 'manual', recognitionLanguageCode: 'ru' }),
    ])
    equal(invoke('settings:get'), {
      schemaVersion: 1, uiLocale: 'fr', recognitionLanguageMode: 'manual', recognitionLanguageCode: 'ru',
    }, 'actual settings IPC composes concurrent independent updates')
    equal(JSON.parse(await fs.readFile(path.join(root, 'settings.json'), 'utf8')), invoke('settings:get'),
      'main-process settings and the durable file agree')
  }
  equal(await fs.readFile(path.join(root, 'library.json'), 'utf8'), beforeSettings,
    'recognition and locale settings never rewrite song data')

  const editorId = 'exact-editor-text'
  const exactText = '[ar:QA]\r\n\r\n[00:01.00]Привет мир!  \r\n[00:05.00]Encore <3\r\n\r\n'
  qa.seed([fixture(editorId, { lyricEditorText: 'obsolete editor text' })])
  const exactSaved = await invoke('lyrics:update', { songId: editorId, text: exactText, expectedRevision: 0 })
  equal(exactSaved.song.lyricEditorText, exactText, 'real edit IPC returns exact CRLF, blank lines, and LRC')
  equal(exactSaved.song.lyrics.map((line) => line.text), ['Привет мир!  ', 'Encore <3'],
    'playback receives only timed wording, not the raw LRC source')
  const editorFile = path.join(root, 'processed', editorId, 'lyrics.json')
  equal(JSON.parse(await fs.readFile(editorFile, 'utf8')).text, exactText, 'real edit writes exact lyrics.json text')
  const persistedLibrary = JSON.parse(await fs.readFile(path.join(root, 'library.json'), 'utf8'))
  equal(persistedLibrary[0].lyricEditorText, exactText, 'real edit persists the additive Song contract')
  delete persistedLibrary[0].lyricEditorText
  await fs.writeFile(path.join(root, 'library.json'), JSON.stringify(persistedLibrary))
  qa.seed([])
  await qa.reload()
  equal(qa.song(editorId).lyricEditorText, exactText,
    'real startup restores exact editor text from lyrics.json for pre-contract libraries')
  qa.song(editorId).lyricEditorText = 'outdated cache'
  await qa.inspect(qa.song(editorId))
  equal(qa.song(editorId).lyricEditorText, exactText, 'deliverable inspection replaces stale cached editor text')
  const protectedBefore = structuredClone(qa.song(editorId))
  const engineTranscript = {
    text: 'New engine transcript\r\n', lines: [{ text: 'New engine transcript', start: 2, end: 4 }],
    languageCode: 'en', languageName: 'English',
  }
  qa.apply(qa.song(editorId), engineTranscript)
  equal(qa.song(editorId), protectedBefore, 'engine application cannot replace manual editor text or timed lyrics')
  const engineSong = fixture('engine-editor', { lyricEditorText: 'old engine text' })
  qa.apply(engineSong, engineTranscript)
  equal(engineSong.lyricEditorText, engineTranscript.text, 'fresh engine application cannot leave editor text stale')
  equal(engineSong.lyricsRevision, 1, 'fresh engine application preserves its existing revision increment')
  equal(qa.normalize(fixture('invalid-editor', { lyricEditorText: 123 })).lyricEditorText, undefined,
    'Song normalization rejects nonstring optional editor text')
  equal(qa.normalize(fixture('legacy-editor')).lyricEditorText, undefined,
    'legacy engine songs keep the timed-line fallback')

  const atomicUrl = pathToFileURL(path.resolve('dist-electron', 'atomic-file.js')).href
  for (const mode of ['transient', 'permanent', 'cleanup-failure']) {
    const directory = path.join(root, `atomic-${mode}`)
    await fs.mkdir(directory)
    const target = path.join(directory, 'settings.json')
    await fs.writeFile(target, '{"old":true}')
    let attempts = 0
    const delays = []
    const atomic = new vm.SourceTextModule(await fs.readFile(fileURLToPath(atomicUrl), 'utf8'), {
      identifier: atomicUrl,
    })
    await atomic.link(async (specifier) => {
      let exports = await import(specifier)
      if (specifier === 'node:fs/promises') {
        exports = { ...exports, rename: async (from, to) => {
          attempts += 1
          equal(JSON.parse(await fs.readFile(target, 'utf8')), { old: true },
            'a blocked atomic replacement always keeps the old file readable')
          if (mode !== 'transient' || attempts < 3) {
            throw Object.assign(new Error('injected atomic sharing violation'), { code: 'EPERM' })
          }
          return fs.rename(from, to)
        }, rm: async (...args) => {
          if (mode === 'cleanup-failure') throw new Error('injected cleanup failure')
          return fs.rm(...args)
        } }
      } else if (specifier === 'node:timers/promises') {
        exports = { ...exports, setTimeout: async (milliseconds) => { delays.push(milliseconds) } }
      }
      return new vm.SyntheticModule(Object.keys(exports), function () {
        for (const [key, value] of Object.entries(exports)) this.setExport(key, value)
      })
    })
    await atomic.evaluate()
    if (mode === 'transient') {
      await atomic.namespace.replaceTextFile(target, '{"new":true}')
      equal(attempts, 3, 'bounded sharing retry eventually replaces the target')
      equal(delays, [10, 20], 'transient rename retry backs off')
      equal(JSON.parse(await fs.readFile(target, 'utf8')), { new: true },
        'the replacement becomes visible only when complete')
    } else {
      await rejects(() => atomic.namespace.replaceTextFile(target, '{"new":true}'),
        mode === 'cleanup-failure'
          ? /injected atomic sharing violation.*injected cleanup failure/
          : /injected atomic sharing violation/,
        'atomic save never masks its original failure, including cleanup failure')
      equal(attempts, 8, 'persistent sharing failures stop after a bounded retry budget')
      equal(JSON.parse(await fs.readFile(target, 'utf8')), { old: true },
        'a failed replacement never removes or corrupts the prior settings')
    }
    if (mode !== 'cleanup-failure') {
      equal(await fs.readdir(directory), ['settings.json'], 'atomic save cleans unique new files')
    }
  }
  console.log(`PASS lyric scheduler IPC: ${checks} runtime checks (AI/desktop mocked, real filesystem).`)
} finally {
  delete globalThis.qaPublish
  for (const [event, previous] of processListeners) {
    for (const listener of process.listeners(event)) {
      if (!previous.includes(listener)) process.removeListener(event, listener)
    }
  }
  await fs.rm(root, { recursive: true, force: true })
}
