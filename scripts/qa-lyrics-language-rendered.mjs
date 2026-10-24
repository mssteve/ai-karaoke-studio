import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { sendCommand } from './control.mjs'
import {
  defaultAppSettings,
  editorTextFromInput,
  editorTextFromSong,
  frenchCopy,
  hasUsableLyricLines,
  lyricsEditorStatusMessage,
  manualLyricsProtectedMessage,
  normalizeAppSettings,
  playlistDisplayName,
  recognitionLanguageOptions,
  recognitionLanguages,
  reduceLyricsEditor,
  replaceEditorSelection,
  stableRendererErrors,
  translate,
  translateJoined,
} from '../src/i18n.ts'

const sources = {
  app: await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
  api: await readFile(new URL('../src/api.ts', import.meta.url), 'utf8'),
  types: await readFile(new URL('../src/types.ts', import.meta.url), 'utf8'),
  styles: await readFile(new URL('../src/styles.css', import.meta.url), 'utf8'),
}

let checks = 0
function check(value, message) {
  assert.ok(value, message)
  checks += 1
}
function includes(source, text, message) {
  check(source.includes(text), message ?? `Missing ${text}`)
}

const requiredEnglish = [
  'Extract with local AI',
  'Refresh lyrics & language',
  manualLyricsProtectedMessage,
  'Lyrics are busy with local processing.',
  'Lyric revision conflict.',
]
for (const text of requiredEnglish) {
  includes(sources.app, text, `English copy missing from renderer: ${text}`)
  assert.equal(translate('en', text), text)
  assert.notEqual(translate('fr', text), text, `French translation missing for ${text}`)
  checks += 2
}

for (const testId of [
  'edit-lyrics',
  'lyrics-editor',
  'lyrics-editor-text',
  'lyrics-editor-update',
  'ui-locale',
  'ui-locale-en',
  'ui-locale-fr',
  'recognition-language-mode',
  'recognition-language-code',
]) {
  includes(sources.app, `data-testid="${testId}"`)
}

includes(sources.app, 'aria-modal="true"')
includes(sources.app, "event.key === 'Escape'")
includes(sources.app, 'expectedRevision: snapshot.expectedRevision')
includes(sources.app, "type: 'confirm-discard'")
includes(sources.app, "type: 'keep-editing'")
includes(sources.app, 'updateLyrics({')
includes(sources.app, 'getSettings()')
includes(sources.api, 'updateLyrics: unavailable')
includes(sources.api, 'getSettings: unavailable')
includes(sources.api, 'updateSettings: unavailable')
includes(sources.types, 'updateLyrics: (request: UpdateLyricsRequest) => Promise<UpdateLyricsResult>')
includes(sources.types, 'getSettings: () => Promise<AppSettings>')
includes(sources.types, 'updateSettings: (request: UpdateAppSettingsRequest) => Promise<AppSettings>')
includes(sources.types, "lyricTextSource: LyricTextSource")
includes(sources.types, "lyricRematchStatus: LyricRematchStatus")
includes(sources.styles, '.lyrics-editor')
includes(sources.styles, '.locale-switch')
check(!/overwrite lyrics/i.test(sources.app), 'Renderer must not offer an AI overwrite action')
check(!sources.app.includes('>Overwrite'), 'Renderer must not render an Overwrite button')

const submit = sources.app.slice(
  sources.app.indexOf('async function submitLyricsUpdate'),
  sources.app.indexOf('function toggleMicrophoneMonitor'),
)
check(!submit.includes('setMode('), 'Lyrics update must not change playback mode')
check(!submit.includes('seekTo('), 'Lyrics update must not seek')
check(!submit.includes('setPlaylists('), 'Lyrics update must not change the queue')
check(!submit.includes('setSelectedId('), 'Lyrics update must not change selection')
check(submit.includes('submittedText: snapshot.text'), 'Successful save must keep the submitted editor text')
check(!submit.includes('text: result.song'), 'Save result must not copy server lyric text into the editor')

const localeHandler = sources.app.slice(
  sources.app.indexOf('data-testid="ui-locale"'),
  sources.app.indexOf('data-testid="ui-locale"') + 700,
)
check(localeHandler.includes("uiLocale: 'en'") && localeHandler.includes("uiLocale: 'fr'"), 'Locale switch persists both languages')
check(!localeHandler.includes('languageCode'), 'Interface language switch must not write song language metadata')
check(!localeHandler.includes('setSongs'), 'Interface language switch must not rewrite songs')

const staticCalls = [...sources.app.matchAll(/t\('([^'\\]*(?:\\.[^'\\]*)*)'\)/g)].map((match) => match[1])
const missingFrench = [...new Set(staticCalls)].filter((text) => !frenchCopy[text] && translate('fr', text) === text)
assert.deepEqual(missingFrench, [], `Untranslated renderer strings: ${missingFrench.join(' | ')}`)
checks += 1

assert.deepEqual(defaultAppSettings, {
  schemaVersion: 1,
  uiLocale: 'en',
  recognitionLanguageMode: 'auto',
  recognitionLanguageCode: 'en',
})
checks += 1
assert.equal(normalizeAppSettings(defaultAppSettings).uiLocale, 'en')
assert.throws(() => normalizeAppSettings({ ...defaultAppSettings, uiLocale: 'de' }), /Unsupported interface language/)
assert.throws(() => normalizeAppSettings({ ...defaultAppSettings, recognitionLanguageCode: 'english' }), /Unsupported recognition language/)
checks += 3

const codes = recognitionLanguages.map((language) => language.code)
check(codes.includes('en') && codes.includes('fr'), 'Recognition list includes English and French')
check(codes.length >= 90, `Expected Whisper multilingual coverage, got ${codes.length}`)
check(new Set(codes).size === codes.length, 'Recognition language codes must be unique')
const options = recognitionLanguageOptions('fr', 'zz')
check(options[0].code === 'en' && options[1].code === 'fr', 'English and French stay pinned')
check(options.some((language) => language.code === 'zz' && language.unsupported), 'Unknown saved code is visible but not a free-text field')
check(!sources.app.includes('recognition-language-custom'), 'No arbitrary recognition code field')
checks += 1

const song = {
  lyrics: [{ text: 'Première ligne' }, { text: 'Deuxième ligne' }],
}
assert.equal(editorTextFromSong(song), 'Première ligne\nDeuxième ligne')
const rawEditorText = '[ar:QA]\r\n\r\n[00:01.00]Première ligne\r\n[00:02.00]Deuxième ligne\r\n'
assert.equal(editorTextFromSong({ ...song, lyricEditorText: rawEditorText }), rawEditorText)
assert.equal(editorTextFromSong({ ...song, lyricEditorText: '' }), '', 'Present empty text does not fall back')
assert.equal(editorTextFromInput(rawEditorText, rawEditorText.replace(/\r\n/g, '\n')), rawEditorText)
assert.equal(editorTextFromInput(rawEditorText, rawEditorText.replace(/\r\n/g, '\n').replace('Première', 'Nouvelle')),
  rawEditorText.replace('Première', 'Nouvelle'), 'A small textarea edit retains CRLF and raw LRC')
assert.equal(editorTextFromInput('one\r\ntwo\nthree\r\n', 'one\ntoo\nthree\n'), 'one\r\ntoo\nthree\r\n',
  'Untouched mixed newline conventions are retained')
assert.equal(editorTextFromInput('one\r\ntwo', 'one\nnew\ntwo'), 'one\r\nnew\r\ntwo',
  'Typed newlines follow the saved newline convention')
assert.equal(replaceEditorSelection('one\r\ntwo', 4, 7, 'new\r\n\r\ntext'), 'one\r\nnew\r\n\r\ntext',
  'Pasted text retains its literal newlines and uses textarea selection offsets')
assert.equal(hasUsableLyricLines('   \n\t'), false)
assert.equal(hasUsableLyricLines('[00:01.00]Bonjour'), true)
checks += 10

const first = { songId: 'song-a', songTitle: 'Chanson A', text: 'ligne A', revision: 3 }
const second = { songId: 'song-b', songTitle: 'Chanson B', text: 'ligne B', revision: 1 }
let draft = reduceLyricsEditor(null, { type: 'open', song: first })
assert.equal(draft?.text, 'ligne A')
draft = reduceLyricsEditor(draft, { type: 'edit', text: 'ligne A\najout' })
const switched = reduceLyricsEditor(draft, { type: 'song-changed', song: second })
assert.equal(switched?.text, 'ligne A\najout')
assert.equal(switched?.songId, 'song-a')
assert.equal(switched?.discardPrompt, true)
assert.equal(switched?.pendingSwitch?.songId, 'song-b')
const kept = reduceLyricsEditor(switched, { type: 'keep-editing' })
assert.equal(kept?.text, 'ligne A\najout')
assert.equal(kept?.pendingSwitch, undefined)
const discarded = reduceLyricsEditor(switched, { type: 'confirm-discard' })
assert.equal(discarded?.songId, 'song-b')
assert.equal(discarded?.text, 'ligne B')
checks += 8

let clean = reduceLyricsEditor(null, { type: 'open', song: first })
clean = reduceLyricsEditor(clean, { type: 'song-changed', song: second })
assert.equal(clean?.songId, 'song-b')
assert.equal(clean?.text, 'ligne B')
checks += 2

let same = reduceLyricsEditor(null, { type: 'open', song: first })
same = reduceLyricsEditor(same, { type: 'edit', text: 'texte édité' })
same = reduceLyricsEditor(same, {
  type: 'song-changed',
  song: { ...first, text: 'texte IA', revision: 9 },
})
assert.equal(same?.text, 'texte édité')
assert.equal(same?.expectedRevision, 3)
checks += 2

let saving = reduceLyricsEditor(null, { type: 'open', song: first })
saving = reduceLyricsEditor(saving, { type: 'edit', text: 'nouveau texte' })
saving = reduceLyricsEditor(saving, { type: 'save-start', saveId: 4 })
assert.equal(reduceLyricsEditor(saving, { type: 'edit', text: 'trop tard' })?.text, 'nouveau texte')
saving = reduceLyricsEditor(saving, { type: 'song-changed', song: second })
const stale = reduceLyricsEditor(saving, {
  type: 'save-result',
  saveId: 3,
  songId: 'song-a',
  ok: true,
  submittedText: 'ancien',
  revision: 1,
  rematch: 'queued',
})
assert.equal(stale?.text, 'nouveau texte')
assert.equal(stale?.saving, true)
const wrongSong = reduceLyricsEditor(saving, {
  type: 'save-result',
  saveId: 4,
  songId: 'song-b',
  ok: true,
  submittedText: 'nouveau texte',
  revision: 8,
  rematch: 'queued',
})
assert.equal(wrongSong?.songId, 'song-a')
const saved = reduceLyricsEditor(saving, {
  type: 'save-result',
  saveId: 4,
  songId: 'song-a',
  ok: true,
  submittedText: 'nouveau texte',
  revision: 8,
  rematch: 'queued',
})
assert.equal(saved?.songId, 'song-b', 'Completed save follows a song switch without copying server text')
assert.equal(saved?.text, 'ligne B')
checks += 6

let closed = reduceLyricsEditor(null, { type: 'open', song: first })
closed = reduceLyricsEditor(closed, { type: 'save-start', saveId: 2 })
closed = reduceLyricsEditor(closed, { type: 'request-close' })
assert.equal(closed?.closeRequested, true)
assert.equal(reduceLyricsEditor(closed, {
  type: 'save-result',
  saveId: 2,
  songId: 'song-a',
  ok: true,
  submittedText: 'ligne A',
  revision: 4,
  rematch: 'skipped',
}), null)
checks += 2

let conflict = reduceLyricsEditor(null, { type: 'open', song: first })
conflict = reduceLyricsEditor(conflict, { type: 'edit', text: 'brouillon' })
conflict = reduceLyricsEditor(conflict, { type: 'save-start', saveId: 6 })
conflict = reduceLyricsEditor(conflict, {
  type: 'save-result',
  saveId: 6,
  songId: 'song-a',
  ok: false,
  submittedText: 'brouillon',
  conflict: true,
  detail: 'Lyric revision conflict.',
})
assert.equal(conflict?.text, 'brouillon')
assert.equal(conflict?.conflict, true)
assert.equal(reduceLyricsEditor(conflict, { type: 'request-close' })?.discardPrompt, true)
assert.equal(reduceLyricsEditor(conflict, { type: 'confirm-discard' }), null)
checks += 4

const status = lyricsEditorStatusMessage({
  draft: {
    ...first,
    songId: first.songId,
    songTitle: first.songTitle,
    text: 'brouillon',
    baselineText: 'ligne A',
    expectedRevision: 3,
    saving: false,
    saveId: 0,
    discardPrompt: false,
    conflict: true,
    closeRequested: false,
    saveState: 'failed',
    saveDetail: 'Lyric revision conflict.',
  },
  busy: false,
})
assert.equal(status, 'Lyric revision conflict.')
assert.notEqual(translate('fr', status), status)
for (const error of stableRendererErrors) assert.notEqual(translate('fr', error), error)
checks += 1 + stableRendererErrors.length

const editorBlock = sources.app.slice(sources.app.indexOf('className="playlist-dialog lyrics-editor"'), sources.app.indexOf('lyrics-editor-update') + 400)
includes(editorBlock, 'data-testid="lyrics-editor-text"')
includes(editorBlock, 'data-testid="lyrics-editor-update"')
includes(editorBlock, "t('Update')")
includes(editorBlock, 'aria-modal="true"')
check(editorBlock.indexOf('lyrics-editor-text') < editorBlock.indexOf('lyrics-editor-update'), 'Editor renders the multiline input before Update')

check(sources.app.includes("event.key !== 'Tab'"), 'Lyrics editor traps Tab while open')

let queuedDraft = reduceLyricsEditor(null, { type: 'open', song: first })
queuedDraft = reduceLyricsEditor(queuedDraft, { type: 'save-start', saveId: 1 })
queuedDraft = reduceLyricsEditor(queuedDraft, {
  type: 'save-result', saveId: 1, songId: first.songId, ok: true,
  submittedText: first.text, revision: 4, rematch: 'queued',
})
const currentRematch = { draft: queuedDraft, busy: false, songId: first.songId, songRevision: 4 }
assert.match(lyricsEditorStatusMessage({ ...currentRematch, songRematchStatus: 'pending' }), /queued/)
assert.match(lyricsEditorStatusMessage({ ...currentRematch, songRematchStatus: 'failed' }), /failed.*text and existing timing were kept/)
assert.match(lyricsEditorStatusMessage({ ...currentRematch, songRematchStatus: 'complete' }), /complete/)
assert.match(lyricsEditorStatusMessage({ ...currentRematch, songRevision: 3, songRematchStatus: 'failed' }), /queued/)
assert.match(lyricsEditorStatusMessage({ ...currentRematch, songId: second.songId, songRematchStatus: 'complete' }), /queued/)
const unsavedDraft = reduceLyricsEditor(queuedDraft, { type: 'edit', text: 'unsaved text' })
assert.doesNotMatch(lyricsEditorStatusMessage({ ...currentRematch, draft: unsavedDraft, songRematchStatus: 'complete' }), /complete|queued/)
checks += 6

const dynamicMessages = [
  ['Detecting lyric language sample 1 of 4', 'Détection de la langue des paroles, échantillon 1 sur 4', 'whisper-transcription'],
  ['Demucs processed chunk 2 of 10', 'Demucs a traité le segment 2 sur 10', 'demucs'],
  ['Separation audio: FFmpeg processed 1.0s of 8.0s', 'Audio de séparation : FFmpeg a traité 1.0 s sur 8.0 s', 'source-preparation'],
  ['Transcription audio: FFmpeg is processing audio', 'Audio de transcription : FFmpeg traite l’audio', 'source-preparation'],
  ['FFmpeg processed 8.0s', 'FFmpeg a traité 8.0 s', 'instrumental'],
  ['Loading Whisper model: model.onnx', 'Chargement du modèle Whisper : model.onnx', 'whisper-model'],
  ['Transcribing 8.0s of audio; Whisper does not expose chunk completion', 'Transcription de 8.0 s d’audio ; Whisper n’indique pas la progression des segments', 'whisper-transcription'],
  ['Whisper completed 12 timed word segments', 'Whisper a terminé 12 segments de mots synchronisés', 'whisper-transcription'],
  ['Whisper transcription is usable with fallback timing on 2 line(s)', 'La transcription Whisper est utilisable avec une synchronisation de repli sur 2 ligne(s)', 'whisper-transcription'],
  ['2 timed lyric lines are committed', '2 lignes de paroles synchronisées sont enregistrées', 'lyrics'],
  ['vocals stem is validated', 'La piste voix est validée', 'demucs'],
  ['Vocal measured -20.0 LUFS, -2.0 dBTP', 'Voix mesurée à -20.0 LUFS, -2.0 dBTP', 'enhanced'],
  ['Balance selected: Vocal 1.0 dB, Instrumental -2.0 dB; mild measured-noise cleanup enabled', 'Équilibre choisi : voix 1.0 dB, instrumentale -2.0 dB ; nettoyage léger du bruit mesuré activé', 'enhanced'],
  ['Applying two-pass -16 LUFS / -1.5 dBTP master', 'Application du mastering en deux passes à -16 LUFS / -1.5 dBTP', 'enhanced'],
  ['Premix loudness was -40.0 LUFS; normalization was skipped to avoid amplifying silence or noise.', 'Le volume du prémix était de -40.0 LUFS ; la normalisation a été ignorée pour éviter d’amplifier le silence ou le bruit.', 'enhanced'],
  ['Enhanced ready: silent LUFS, no finite dBTP', 'Version améliorée prête : silencieux LUFS, non fini dBTP', 'enhanced'],
  ['Generated output is empty or invalid: Queue.wav', 'La sortie générée est vide ou invalide : Queue.wav', 'vocal'],
  ['Demucs did not produce the drums stem.', 'Demucs n’a pas produit la piste batterie.', 'demucs'],
  ['Enhanced true peak -1.00 dBTP exceeds the -1.5 dBTP ceiling tolerance.', 'La crête réelle de la version améliorée à -1.00 dBTP dépasse la tolérance du plafond de -1.5 dBTP.', 'enhanced'],
  ['Final library commit failed: EPERM\nC:\\QA\\History.json', 'L’enregistrement final de la bibliothèque a échoué : EPERM\nC:\\QA\\History.json', 'lyrics'],
  ['All four audio versions and timed lyrics are ready', 'Les quatre versions audio et les paroles synchronisées sont prêtes', 'lyrics'],
]
for (const [english, french] of dynamicMessages) {
  assert.equal(translate('fr', english), french)
  assert.equal(translate('en', english), english)
  assert.equal(translateJoined('fr', `${english} · 40%`), `${french} · 40 %`)
  checks += 3
}
const rawDiagnostic = 'FFmpeg: Invalid data found\nC:\\QA\\Queue.wav\nHistory · user text'
assert.equal(translate('fr', `Timing rematch failed. Your edited text was kept: ${rawDiagnostic}`),
  `La resynchronisation a échoué. Votre texte modifié a été conservé : ${rawDiagnostic}`)
assert.equal(translate('fr', rawDiagnostic), rawDiagnostic)
assert.equal(playlistDisplayName('fr', { kind: 'queue', name: 'Queue' }), 'File d’attente')
assert.equal(playlistDisplayName('fr', { kind: 'history', name: 'History' }), 'Historique')
assert.equal(playlistDisplayName('fr', { kind: 'playlist', name: 'Queue' }), 'Queue')
assert.equal(playlistDisplayName('fr', { kind: 'playlist', name: 'History' }), 'History')
checks += 6

console.log(`PASS lyrics-language-rendered: ${checks} source and state checks`)

if (process.argv.includes('--rendered') || process.argv.includes('--playlists-rendered')) {
  await runRendered()
}

async function runRendered() {
  const execFileAsync = promisify(execFile)
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const executable = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe')
  const entry = path.join(root, 'dist-electron', 'main.js')
  const output = path.join(root, 'scripts', 'qa-artifacts', `lyrics-language-rendered-${process.pid}-${Date.now()}`)
  const profile = path.join(output, 'profile')
  const appData = path.join(output, 'appdata')
  const localAppData = path.join(output, 'localappdata')
  const edited = '[ar:QA Fixture]\r\n\r\n[00:01.00]Edited première line  \r\n[00:02.50]Edited second line\r\n\r\n'
  const revised = edited.replace('première', 'nouvelle')
  const textareaValue = (text) => text.replace(/\r\n?/g, '\n')
  const isolatedEnv = { ...process.env, APPDATA: appData, LOCALAPPDATA: localAppData }
  const cases = []
  let debugPort
  let launchSequence = 0
  let child
  let stderr = ''

  function record(id, evidence) {
    cases.push({ id, status: 'passed', evidence })
    console.log(`PASS rendered ${id}`)
  }

  async function stop() {
    const launched = child
    child = undefined
    const pid = launched?.pid
    if (!Number.isInteger(pid)) return
    page.close()
    if (launched.exitCode !== null || launched.signalCode !== null) return
    const exited = launched.exitCode !== null || launched.signalCode !== null
      ? Promise.resolve()
      : new Promise((resolve) => launched.once('exit', resolve))
    await execFileAsync('powershell.exe', ['-NoProfile', '-Command',
      `$root=${pid}; $all=Get-CimInstance Win32_Process; $ids=New-Object System.Collections.Generic.List[int]; `
      + 'function Add-Children([int]$parent){ foreach($p in $all | Where-Object { $_.ParentProcessId -eq $parent }){ '
      + 'Add-Children $p.ProcessId; [void]$ids.Add($p.ProcessId) } }; Add-Children $root; [void]$ids.Add($root); '
      + 'foreach($id in $ids){ Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }'])
    let timer
    try {
      await Promise.race([exited, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Electron ${pid} did not exit`)), 15_000)
      })])
    } finally {
      clearTimeout(timer)
    }
  }

  async function start() {
    launchSequence += 1
    process.env.KARAOKE_AUTOMATION_PIPE = `\\\\.\\pipe\\karaoke-studio-lyrics-language-${process.pid}-${launchSequence}`
    await rm(path.join(profile, 'DevToolsActivePort'), { force: true })
    child = spawn(executable, [
      entry, `--user-data-dir=${profile}`, '--enable-private-automation', '--remote-debugging-port=0',
    ], { cwd: root, env: { ...isolatedEnv, KARAOKE_AUTOMATION_PIPE: process.env.KARAOKE_AUTOMATION_PIPE },
      stdio: ['ignore', 'ignore', 'pipe'] })
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString() })
    if (!Number.isInteger(child.pid)) throw new Error('Electron did not provide a process ID.')
    await waitFor(async () => {
      if (child.exitCode !== null) throw new Error(`Electron exited with ${child.exitCode}`)
      const port = Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split(/\r?\n/)[0])
      return Number.isInteger(port) && port > 0 ? port : undefined
    }, 'debugger port').then((port) => { debugPort = port })
    await waitFor(() => sendCommand({ action: 'status' }, { timeoutMs: 500 }).catch(() => undefined), 'automation pipe')
    await page.connect()
  }

  class PageSession {
    constructor() {
      this.seq = 0
      this.pending = new Map()
      this.ws = undefined
      this.onEvent = undefined
      this.interceptError = undefined
    }
    close() {
      this.ws?.close()
      this.ws = undefined
      for (const waiter of this.pending.values()) waiter.reject(new Error('Debugger session closed'))
      this.pending.clear()
    }
    async connect() {
      const started = Date.now()
      let last = ''
      while (Date.now() - started < 30_000) {
        try {
          const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()
          const page = list.find((target) => target.type === 'page' && String(target.url).includes('karaoke://'))
            ?? list.find((target) => target.type === 'page')
          if (page?.webSocketDebuggerUrl) {
            this.close()
            this.ws = new WebSocket(page.webSocketDebuggerUrl)
            await new Promise((resolve, reject) => {
              this.ws.addEventListener('open', resolve, { once: true })
              this.ws.addEventListener('error', reject, { once: true })
            })
            this.ws.addEventListener('message', (event) => {
              const message = JSON.parse(String(event.data))
              if (message.method) {
                Promise.resolve(this.onEvent?.(message)).catch((error) => { this.interceptError = error })
                return
              }
              const waiter = this.pending.get(message.id)
              if (!waiter) return
              this.pending.delete(message.id)
              if (message.error) waiter.reject(new Error(message.error.message))
              else waiter.resolve(message.result)
            })
            const connected = this.ws
            this.ws.addEventListener('close', () => { if (this.ws === connected) this.ws = undefined })
            await this.send('Network.enable')
            await this.send('Network.setCacheDisabled', { cacheDisabled: true })
            return
          }
          last = JSON.stringify(list.map((target) => target.url))
        } catch (error) {
          last = error.message
        }
        await delay(100)
      }
      throw new Error(`Debugger page was not ready. ${last}`)
    }
    async send(method, params = {}) {
      if (this.interceptError) throw this.interceptError
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) await this.connect()
      const id = ++this.seq
      const result = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(id)
          reject(new Error(`Debugger ${method} timed out`))
        }, 15_000)
        this.pending.set(id, {
          resolve: (value) => { clearTimeout(timer); resolve(value) },
          reject: (error) => { clearTimeout(timer); reject(error) },
        })
      })
      this.ws.send(JSON.stringify({ id, method, params }))
      return result
    }
    async evaluate(expression) {
      const result = await this.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      })
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
      }
      return result.result?.value
    }
  }

  async function waitFor(check, description, timeout = 20_000) {
    const started = Date.now()
    let lastError
    while (Date.now() - started < timeout) {
      try {
        const result = await check()
        if (result) return result
      } catch (error) {
        lastError = error
        if (String(error.message).includes('WebSocket') || String(error.message).includes('not found')) {
          await page.connect().catch(() => undefined)
        }
      }
      await delay(80)
    }
    throw new Error(`${description} not observed.${lastError ? ` ${lastError.message}` : ''}`)
  }

  const page = new PageSession()

  async function capture(name) {
    const shot = await page.send('Page.captureScreenshot', { format: 'png' })
    const bytes = Buffer.from(shot.data, 'base64')
    assert.ok(bytes.length > 10_000, `Screenshot ${name} was empty`)
    assert.equal(bytes.subarray(1, 4).toString(), 'PNG', `Screenshot ${name} was not PNG`)
    await writeFile(path.join(output, `${name}.png`), bytes)
  }

  async function instrumentRenderer({ delaySettings = false, failSettings = false } = {}) {
    let intercepted = false
    page.onEvent = async ({ method, params }) => {
      if (method !== 'Fetch.requestPaused') return
      const { requestId } = params
      const response = await page.send('Fetch.getResponseBody', { requestId })
      const source = response.base64Encoded ? Buffer.from(response.body, 'base64').toString() : response.body
      if (!source.includes('window.karaoke??')) {
        await page.send('Fetch.continueRequest', { requestId })
        return
      }
      assert.equal(source.split('window.karaoke??').length - 1, 1, 'One renderer bridge adapter is expected')
      const adapter = `
        window.__qa = { writes: [], cursorCalls: [], archiveCalls: [], deferredUpdates: [], delaySettings: ${delaySettings}, failSettings: ${failSettings} };
        window.__qaBridge = {
          ...window.karaoke,
          setPlaylistCursor: async request => {
            window.__qa.cursorCalls.push(request);
            const saved = await window.karaoke.setPlaylistCursor(request);
            if (!window.__qa.delayCursor) return saved;
            return new Promise(resolve => {
              window.__qa.releaseCursor = () => { window.__qa.releaseCursor = undefined; resolve(saved); };
            });
          },
          archiveQueueEntry: async request => {
            window.__qa.archiveCalls.push(request);
            const saved = await window.karaoke.archiveQueueEntry(request);
            if (!window.__qa.delayArchive) return saved;
            return new Promise(resolve => {
              window.__qa.releaseArchive = () => { window.__qa.releaseArchive = undefined; resolve(saved); };
            });
          },
          getSettings: () => window.karaoke.getSettings().then(value => {
            if (window.__qa.failSettings) throw new Error('QA settings read failure');
            if (!window.__qa.delaySettings) return value;
            return new Promise(resolve => { window.__qa.releaseSettings = () => resolve(value); });
          }),
          updateSettings: async patch => {
            window.__qa.writes.push(patch);
            if (window.__qa.failSave) { window.__qa.failSave = false; throw new Error('QA settings save failure'); }
            const saved = await window.karaoke.updateSettings(patch);
            if (!window.__qa.delaySave) return saved;
            return new Promise(resolve => { window.__qa.releaseSave = () => resolve(saved); });
          },
          updateLyrics: async request => {
            const result = await window.karaoke.updateLyrics(request);
            if (!window.__qa.delayLyricsAck) return result;
            return new Promise(resolve => { window.__qa.releaseLyricsAck = () => resolve(result); });
          },
          onProcessUpdate: callback => {
            window.__qa.processUpdate = callback;
            return window.karaoke.onProcessUpdate(update => {
              if (window.__qa.holdRematch && ['failed', 'complete'].includes(update.song?.lyricRematchStatus)) {
                window.__qa.deferredUpdates.push(update);
              } else callback(update);
            });
          },
        };
      `
      await page.send('Fetch.fulfillRequest', {
        requestId, responseCode: 200,
        responseHeaders: [
          { name: 'Content-Type', value: 'application/javascript' },
          { name: 'Cache-Control', value: 'no-store' },
        ],
        body: Buffer.from(adapter + source.replace('window.karaoke??', 'window.__qaBridge??')).toString('base64'),
      })
      intercepted = true
    }
    await page.send('Fetch.enable', { patterns: [{ urlPattern: '*assets/*.js', requestStage: 'Response' }] })
    await page.send('Page.reload', { ignoreCache: true })
    await waitFor(async () => {
      if (page.interceptError) throw page.interceptError
      return intercepted && await page.evaluate(`Boolean(window.__qa?.processUpdate)
        && document.querySelectorAll('[data-testid="song-row"]').length >= 2`)
    }, 'instrumented real renderer')
    await page.send('Fetch.disable')
    page.onEvent = undefined
  }
  const song = (id, title, lines) => ({
    id,
    title,
    artist: 'QA Fixture',
    sourcePath: path.join(profile, `${id}.mp3`),
    sourceUrl: '',
    format: 'mp3',
    addedAt: '2026-10-23T12:00:00.000Z',
    duration: 8,
    lyrics: lines,
    lyricLanguage: { languageCode: 'en', languageName: 'English', languageSource: 'detected' },
    languageCode: 'en',
    languageName: 'English',
    languageSource: 'detected',
    lyricTextSource: 'engine',
    lyricsRevision: 2,
    lyricTimingMethod: 'whisper-grouped',
    lyricRematchStatus: 'none',
    processingStage: 'idle',
    processingProgress: 0,
  })
  const fixtureSongs = [
    song('lyrics-edit-fixture', 'Lyrics Edit Fixture', [
      { text: 'Saved first line', start: 0, end: 1.2 },
      { text: 'Saved second line', start: 1.2, end: 2.4 },
    ]),
    song('lyrics-edit-other', 'Other Fixture', [
      { text: 'Other saved line', start: 0, end: 1 },
    ]),
  ]
  fixtureSongs[0].instrumentalPath = fixtureSongs[0].sourcePath

  async function setSelect(testId, value) {
    await page.evaluate(`(() => {
      const element = document.querySelector('[data-testid="${testId}"]')
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(element, ${JSON.stringify(value)})
      element.dispatchEvent(new Event('change', { bubbles: true }))
    })()`)
  }

  async function setEditorText(text) {
    await page.evaluate(`(() => {
      const element = document.querySelector('[data-testid="lyrics-editor-text"]')
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(element, ${JSON.stringify(text)})
      element.dispatchEvent(new Event('input', { bubbles: true }))
    })()`)
  }

  async function clickRendered(selector, clickCount) {
    const point = await page.evaluate(`(() => {
      const button = document.querySelector(${JSON.stringify(selector)})
      button.scrollIntoView({ block: 'center' })
      const rect = button.getBoundingClientRect()
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    })()`)
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', buttons: 1, clickCount, ...point })
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, clickCount, ...point })
  }

  async function clickPlaylistEntry(entryId, clickCount) {
    await clickRendered(`[data-testid="playlist-entry-${entryId}"]`, clickCount)
  }

  async function runQueueTransportRegressions() {
    const seed = await page.evaluate(`(async () => {
      let store = await window.karaoke.getPlaylists()
      for (const playlistId of ['queue', 'history']) {
        const playlist = store.playlists.find(item => item.id === playlistId)
        store = await window.karaoke.clearPlaylist({ playlistId, expectedUpdatedAt: playlist.updatedAt })
      }
      for (const songId of ['lyrics-edit-fixture', 'lyrics-edit-fixture', 'lyrics-edit-other']) {
        const queue = store.playlists.find(item => item.id === 'queue')
        store = await window.karaoke.addSongToPlaylist({ playlistId: queue.id, songId, expectedUpdatedAt: queue.updatedAt })
      }
      await window.karaoke.selectPlaylist({ playlistId: 'queue' })
      return store.playlists.find(item => item.id === 'queue').entries
    })()`)
    assert.equal(new Set(seed.map(entry => entry.id)).size, 3, 'Duplicate songs retain distinct entry identities')
    await instrumentRenderer()
    await waitFor(async () => page.evaluate(`document.querySelectorAll('[data-testid="song-row"]').length === 2`), 'queue fixture library ready')
    await page.evaluate(`document.querySelector('[data-testid="nav-playlists"]').click()`)
    await waitFor(async () => page.evaluate(`Boolean(document.querySelector('[data-testid="playlist-entry-${seed[0].id}"]'))`), 'seeded Queue rendered')
    await clickPlaylistEntry(seed[0].id, 1)
    await clickPlaylistEntry(seed[0].id, 2)
    await waitFor(async () => {
      const status = await sendCommand({ action: 'status' })
      return status.playlists.currentEntryId === seed[0].id && status.playback.status === 'playing'
        && status.playback.currentTime > 0.15 ? status : undefined
    }, 'Queue first duplicate actually playing')

    async function advanced(archivedCount, nextEntry) {
      return waitFor(async () => {
        const status = await sendCommand({ action: 'status' })
        const queue = status.playlists.playlists.find(item => item.kind === 'queue')
        const history = status.playlists.playlists.find(item => item.kind === 'history')
        if (queue.entries.length !== seed.length - archivedCount || history.entries.length !== archivedCount
          || status.playlists.currentEntryId !== nextEntry.id || status.playback.songId !== nextEntry.songId
          || status.playback.status !== 'playing' || status.playback.currentTime <= 0.15) return undefined
        assert.deepEqual(queue.entries.map(entry => entry.id), seed.slice(archivedCount).map(entry => entry.id))
        assert.deepEqual(history.entries.map(entry => entry.id), seed.slice(0, archivedCount).reverse().map(entry => entry.id))
        const media = await page.evaluate(`({ paused: document.querySelector('audio').paused,
          time: document.querySelector('audio').currentTime, error: document.querySelector('audio').error?.code })`)
        assert.equal(media.paused, false)
        assert.equal(media.error, undefined)
        assert.equal(status.playback.playingIntent, true)
        assert.equal(status.playlists.activePlaylistId, 'queue')
        assert.equal(await page.evaluate('Boolean(document.querySelector(".error-toast"))'), false)
        return { queue: queue.entries, history: history.entries, playback: status.playback, media }
      }, `Queue archives ${archivedCount} exactly once and actually plays ${nextEntry.id}`)
    }

    await page.evaluate(`document.querySelector('[data-testid="playback-next"]').click()`)
    record('queue-manual-next-archives-once-and-plays-duplicate', await advanced(1, seed[1]))
    await capture('queue-manual-next')

    async function seekNearEnd() {
      const duration = await waitFor(async () => page.evaluate(`(() => {
        const audio = document.querySelector('audio')
        return audio.readyState >= 3 && Number.isFinite(audio.duration) && audio.duration > 1 ? audio.duration : 0
      })()`), 'actual playable duration before near-end seek')
      const runway = Math.min(2, Math.max(0.5, duration * 0.15))
      const target = duration - runway
      await sendCommand({ action: 'ui', uiAction: 'set-value', selector: '[data-testid="playback-seek"]', uiValue: String(target) })
      const observed = await waitFor(async () => page.evaluate(`(() => {
        const audio = document.querySelector('audio')
        return audio.currentTime >= ${target - 0.2} && audio.currentTime < audio.duration
          ? { time: audio.currentTime, duration: audio.duration, paused: audio.paused } : undefined
      })()`), 'rendered duration-relative seek applied')
      assert.equal(observed.paused, false)
      return { duration, runway, target, observed }
    }

    const naturalSeek = await seekNearEnd()
    record('queue-natural-end-archives-once-and-autoplays', { seek: naturalSeek, ...await advanced(2, seed[2]) })
    await capture('queue-natural-end')
    const finalSeek = await seekNearEnd()
    const terminal = await waitFor(async () => {
      const status = await sendCommand({ action: 'status' })
      const queue = status.playlists.playlists.find(item => item.kind === 'queue')
      const history = status.playlists.playlists.find(item => item.kind === 'history')
      const media = await page.evaluate(`(() => {
        const audio = document.querySelector('audio')
        return { ended: audio.ended, paused: audio.paused, time: audio.currentTime, duration: audio.duration,
          intent: audio.dataset.playbackIntent, error: audio.error?.code }
      })()`)
      if (queue.entries.length || history.entries.length !== 3 || status.playlists.activePlaylistId
        || status.playlists.currentEntryId || status.playback.status !== 'ended'
        || status.playback.playingIntent || !media.ended || !media.paused || media.intent !== 'false') return undefined
      assert.deepEqual(history.entries.map(entry => entry.id), seed.toReversed().map(entry => entry.id))
      assert.ok(Math.abs(media.time - media.duration) < 0.1, 'Final Queue entry reaches actual terminal duration')
      assert.equal(media.error, undefined)
      return { queue: queue.entries, history: history.entries, playback: status.playback, media }
    }, 'final Queue archives once and reaches terminal ended without wrapping')
    record('queue-final-natural-end-is-terminal', { seek: finalSeek, ...terminal })
    await capture('queue-final-ended')
    assert.deepEqual((await sendCommand({ action: 'diagnostics' })).rendererErrors, [], 'Queue transport has no renderer errors')
  }

  async function runPlaylistMutationRegressions() {
    const seed = await page.evaluate(`(async () => {
      let store = await window.karaoke.createPlaylist({ name: 'Mutation transport QA' })
      const namedId = store.playlists.at(-1).id
      for (const playlistId of ['queue', namedId]) {
        for (const songId of ['lyrics-edit-fixture', 'lyrics-edit-fixture', 'lyrics-edit-other']) {
          const playlist = store.playlists.find(item => item.id === playlistId)
          store = await window.karaoke.addSongToPlaylist({ playlistId, songId, expectedUpdatedAt: playlist.updatedAt })
        }
      }
      return { store, namedId }
    })()`)
    await instrumentRenderer()
    await waitFor(async () => page.evaluate(`document.querySelectorAll('[data-testid="song-row"]').length === 2`), 'mutation fixture library ready')
    await page.evaluate(`document.querySelector('[data-testid="nav-playlists"]').click()`)

    async function openPlaylist(id) {
      await page.evaluate(`document.querySelector('[data-testid="playlist-${id}"]').click()`)
      await waitFor(async () => (await sendCommand({ action: 'status' })).playlists.selectedPlaylistId === id, `playlist ${id} open`)
    }
    async function selectedEntry(entry, playing = false) {
      return waitFor(async () => {
        const status = await sendCommand({ action: 'status' })
        const audio = await page.evaluate(`({ paused: document.querySelector('audio').paused,
          time: document.querySelector('audio').currentTime, ready: document.querySelector('audio').readyState })`)
        return status.playlists.currentEntryId === entry.id && status.playback.songId === entry.songId
          && status.playback.status === (playing ? 'playing' : 'paused')
          && status.playback.playingIntent === playing && audio.paused === !playing && audio.ready >= 3
          && (!playing || audio.time > 0.15) ? { status, audio } : undefined
      }, `entry ${entry.id} ${playing ? 'actually playing' : 'selected paused'}`)
    }
    async function delayCursor(entry) {
      await page.evaluate('window.__qa.releaseCursor = undefined; window.__qa.delayCursor = true')
      await clickPlaylistEntry(entry.id, 1)
      await waitFor(async () => page.evaluate('Boolean(window.__qa.releaseCursor)'), 'real cursor mutation committed with acknowledgement held')
      await clickPlaylistEntry(entry.id, 2)
    }
    async function releaseCursor() {
      await page.evaluate('window.__qa.delayCursor = false; window.__qa.releaseCursor()')
    }
    async function resetCursor(id) {
      await page.evaluate(`(async () => {
        const store = await window.karaoke.getPlaylists()
        const playlist = store.playlists.find(item => item.id === ${JSON.stringify(id)})
        await window.karaoke.setPlaylistCursor({ playlistId: playlist.id, expectedUpdatedAt: playlist.updatedAt })
      })()`)
      await openPlaylist(id)
    }
    const named = seed.store.playlists.find(item => item.id === seed.namedId)
    await openPlaylist(named.id)
    await clickPlaylistEntry(named.entries[0].id, 1)
    await selectedEntry(named.entries[0])
    await page.evaluate(`document.querySelector('[data-testid="playlist-remove-${named.entries[0].id}"]').click()`)
    const removed = await selectedEntry(named.entries[1])
    assert.deepEqual(removed.status.playlists.playlists.find(item => item.id === named.id).entries.map(entry => entry.id),
      named.entries.slice(1).map(entry => entry.id))
    record('paused-remove-activates-fresh-surviving-duplicate', { removed: named.entries[0].id, selected: named.entries[1].id })

    await page.evaluate(`document.querySelector('[data-testid="playback-next"]').click()`)
    await selectedEntry(named.entries[2], true)
    await page.evaluate(`document.querySelector('[data-testid="playback-previous"]').click()`)
    await selectedEntry(named.entries[1], true)
    record('named-next-and-previous-use-current-store', { next: named.entries[2].id, previous: named.entries[1].id })
    await page.evaluate(`document.querySelector('[data-testid="playlist-remove-${named.entries[1].id}"]').click()`)
    await waitFor(async () => {
      const status = await sendCommand({ action: 'status' })
      return !status.playlists.currentEntryId && status.playlists.activePlaylistId === named.id
        && status.playback.status === 'playing' && status.playlists.playlists.find(item => item.id === named.id).entries.length === 1
    }, 'playing removal detaches without interrupting media')
    const duration = await page.evaluate(`document.querySelector('audio').duration`)
    const runway = Math.min(2, Math.max(0.5, duration * 0.15))
    await sendCommand({ action: 'ui', uiAction: 'set-value', selector: '[data-testid="playback-seek"]', uiValue: String(duration - runway) })
    const detached = await selectedEntry(named.entries[2], true)
    assert.equal(detached.status.playlists.playlists.find(item => item.id === 'history').entries.length, 3,
      'Named-list removal and natural advance do not archive into History')
    record('playing-remove-advances-to-surviving-entry', { entryId: named.entries[2].id, duration, runway })
    await sendCommand({ action: 'control', value: { action: 'pause' } })

    const queue = seed.store.playlists.find(item => item.id === 'queue')
    await openPlaylist('queue')
    await clickPlaylistEntry(queue.entries[0].id, 1)
    await selectedEntry(queue.entries[0])
    await page.evaluate('window.__qa.delayArchive = true')
    await page.evaluate(`document.querySelector('[data-testid="playback-next"]').click()`)
    await waitFor(async () => page.evaluate('Boolean(window.__qa.releaseArchive)'), 'real archive committed before delayed acknowledgement')
    await page.evaluate(`document.querySelector('[data-testid="playback-next"]').click()`)
    assert.equal(await page.evaluate('window.__qa.archiveCalls.length'), 1, 'Repeated Next shares the in-flight archive')
    await page.evaluate(`document.querySelector('[data-testid="nav-library"]').click()`)
    await clickRendered('[data-testid="song-row"][data-song-id="lyrics-edit-other"]', 1)
    await clickRendered('[data-testid="song-row"][data-song-id="lyrics-edit-other"]', 2)
    await waitFor(async () => {
      const status = await sendCommand({ action: 'status' })
      return !status.playlists.activePlaylistId && status.playback.songId === 'lyrics-edit-other'
        && status.playback.status === 'playing' && status.playback.currentTime > 0.15
    }, 'newer Library double-click plays while old archive acknowledgement is held')
    await page.evaluate('window.__qa.delayArchive = false; window.__qa.releaseArchive()')
    const lateArchive = await waitFor(async () => {
      const status = await sendCommand({ action: 'status' })
      return status.playlists.playlists.find(item => item.id === 'queue').entries.length === 2
        && !status.playlists.activePlaylistId && status.playback.songId === 'lyrics-edit-other'
        && status.playback.status === 'playing' && status.playback.currentTime > 0.3 ? status : undefined
    }, 'late archive cannot select old Queue or pause newer Library playback')
    assert.equal(lateArchive.playlists.playlists.find(item => item.id === 'history').entries
      .filter(entry => entry.id === queue.entries[0].id).length, 1)
    record('repeated-next-and-late-archive-preserve-newer-intent', { archivedOnce: queue.entries[0].id, playback: lateArchive.playback })
    await sendCommand({ action: 'control', value: { action: 'pause' } })

    await page.evaluate(`document.querySelector('[data-testid="nav-playlists"]').click()`)
    await openPlaylist('queue')
    await delayCursor(queue.entries[2])
    await page.evaluate(`document.querySelector('[data-testid="playlist-remove-${queue.entries[2].id}"]').click()`)
    await releaseCursor()
    const removedPending = await waitFor(async () => {
      const status = await sendCommand({ action: 'status' })
      const queue = status.playlists.playlists.find(item => item.id === 'queue')
      return queue.entries.length === 1 && !status.playlists.activePlaylistId && !status.playlists.currentEntryId
        && status.playback.status === 'paused' && !status.playback.playingIntent ? status : undefined
    }, 'remove after delayed cursor does not start the removed target')
    assert.deepEqual(removedPending.playlists.playlists.find(item => item.id === 'queue').entries.map(entry => entry.id),
      [queue.entries[1].id])
    record('remove-after-delayed-cursor-does-not-resurrect', { removedId: queue.entries[2].id })
    await resetCursor('queue')
    await delayCursor(queue.entries[1])
    await page.evaluate(`document.querySelector('[data-testid="playlist-clear"]').click()`)
    await waitFor(async () => page.evaluate(`Boolean(document.querySelector('[data-testid="playlist-clear-confirm"]'))`), 'rendered clear confirmation')
    await page.evaluate(`document.querySelector('[data-testid="playlist-clear-confirm"]').click()`)
    await releaseCursor()
    const cleared = await waitFor(async () => {
      const status = await sendCommand({ action: 'status' })
      return !status.playlists.playlists.find(item => item.id === 'queue').entries.length
        && !status.playlists.activePlaylistId && !status.playlists.currentEntryId
        && status.playback.status === 'paused' && !status.playback.playingIntent ? status : undefined
    }, 'clear after delayed cursor leaves no resurrected selection or playback')
    assert.equal(await page.evaluate('document.querySelector("audio").paused'), true)
    record('clear-after-delayed-cursor-does-not-resurrect', cleared.playlists)

    await openPlaylist(named.id)
    await resetCursor(named.id)
    await delayCursor(named.entries[2])
    await page.evaluate(`[...document.querySelectorAll('.playlist-heading button')].find(button => button.textContent === 'Delete').click()`)
    await waitFor(async () => page.evaluate(`Boolean(document.querySelector('[aria-labelledby="playlist-delete-title"]'))`), 'rendered delete confirmation')
    await page.evaluate(`document.querySelector('[aria-labelledby="playlist-delete-title"] .danger-button').click()`)
    await releaseCursor()
    await waitFor(async () => {
      const status = await sendCommand({ action: 'status' })
      return !status.playlists.playlists.some(item => item.id === named.id) && !status.playlists.activePlaylistId
        && !status.playlists.currentEntryId && status.playback.status === 'paused' && !status.playback.playingIntent
    }, 'delete after delayed cursor cannot recreate playlist or start removed target')
    record('delete-after-delayed-cursor-does-not-resurrect', { deletedId: named.id })
    assert.deepEqual((await sendCommand({ action: 'diagnostics' })).rendererErrors, [])

    const external = await page.evaluate(`(async () => {
      let store = await window.karaoke.getPlaylists()
      for (const songId of ['lyrics-edit-fixture', 'lyrics-edit-other']) {
        const queue = store.playlists.find(item => item.id === 'queue')
        store = await window.karaoke.addSongToPlaylist({ playlistId: queue.id, songId, expectedUpdatedAt: queue.updatedAt })
      }
      return store.playlists.find(item => item.id === 'queue')
    })()`)
    await openPlaylist('queue')
    await page.evaluate(`(async () => {
      const store = await window.karaoke.getPlaylists()
      const queue = store.playlists.find(item => item.id === 'queue')
      await window.karaoke.addSongToPlaylist({ playlistId: queue.id, songId: 'lyrics-edit-fixture', expectedUpdatedAt: queue.updatedAt })
    })()`)
    await clickPlaylistEntry(external.entries[1].id, 1)
    await waitFor(async () => page.evaluate(`document.querySelector('.error-toast')?.textContent.includes('The playlist changed. Refresh and try again.')`), 'legitimate external stale mutation is visibly rejected')
    const diagnostics = await sendCommand({ action: 'diagnostics' })
    assert.equal(diagnostics.rendererErrors.length, 1)
    assert.equal(diagnostics.rendererErrors[0].message, 'Renderer exception: Unable to select the playlist entry')
    assert.match(diagnostics.rendererErrors[0].detail, /The playlist changed\. Refresh and try again\./)
    await page.evaluate('document.querySelector(".error-toast").click()')
    await openPlaylist('queue')
    await clickPlaylistEntry(external.entries[1].id, 1)
    await selectedEntry(external.entries[1])
    record('external-stale-cursor-rejects-and-operation-chain-recovers', { expectedErrors: diagnostics.rendererErrors })
    await page.evaluate(`(async () => {
      const store = await window.karaoke.getPlaylists()
      const queue = store.playlists.find(item => item.id === 'queue')
      await window.karaoke.clearPlaylist({ playlistId: queue.id, expectedUpdatedAt: queue.updatedAt })
    })()`)
    await clickPlaylistEntry(external.entries[1].id, 1)
    await waitFor(async () => page.evaluate(`document.querySelector('.error-toast')?.textContent.includes('The playlist changed. Refresh and try again.')`), 'already-current cursor still validates an external clear')
    const clearedDiagnostics = await sendCommand({ action: 'diagnostics' })
    assert.equal(clearedDiagnostics.rendererErrors.length, 2)
    assert.equal(clearedDiagnostics.rendererErrors[1].message, 'Renderer exception: Unable to select the playlist entry')
    assert.match(clearedDiagnostics.rendererErrors[1].detail, /The playlist changed\. Refresh and try again\./)
    assert.equal(await page.evaluate('document.querySelector("audio").paused'), true)
    record('external-clear-rejects-already-current-cursor', { expectedErrors: clearedDiagnostics.rendererErrors })
    await page.evaluate('document.querySelector(".error-toast").click()')
    await openPlaylist('queue')
    await capture('playlist-mutation-recovery')
    assert.deepEqual((await sendCommand({ action: 'diagnostics' })).rendererErrors, clearedDiagnostics.rendererErrors)
    await page.evaluate(`(async () => {
      let store = await window.karaoke.getPlaylists()
      for (const playlistId of ['queue', 'history']) {
        const playlist = store.playlists.find(item => item.id === playlistId)
        store = await window.karaoke.clearPlaylist({ playlistId, expectedUpdatedAt: playlist.updatedAt })
      }
    })()`)
    await stop()
    await start()
    await waitFor(async () => page.evaluate(`document.querySelectorAll('[data-testid="song-row"]').length === 2`), 'fresh renderer after deliberately rejected external mutation')
  }

  async function runPlaylistClickRegressions() {
    const seed = await page.evaluate(`(async () => {
      let store = await window.karaoke.createPlaylist({ name: 'Playlist click QA' })
      const namedId = store.playlists.at(-1).id
      const songIds = ['lyrics-edit-fixture', 'lyrics-edit-fixture', 'lyrics-edit-other']
      for (const songId of songIds) {
        const queue = store.playlists.find(playlist => playlist.id === 'queue')
        store = await window.karaoke.addSongToPlaylist({
          playlistId: queue.id, songId, expectedUpdatedAt: queue.updatedAt,
        })
        const updated = store.playlists.find(playlist => playlist.id === 'queue')
        store = await window.karaoke.archiveQueueEntry({
          playlistId: updated.id, entryId: updated.entries[0].id, expectedUpdatedAt: updated.updatedAt,
        })
      }
      for (const playlistId of ['queue', namedId]) {
        for (const songId of songIds) {
          const playlist = store.playlists.find(item => item.id === playlistId)
          store = await window.karaoke.addSongToPlaylist({ playlistId, songId, expectedUpdatedAt: playlist.updatedAt })
        }
      }
      return { store, namedId }
    })()`)
    await instrumentRenderer()
    for (const playlistId of ['queue', seed.namedId, 'history']) {
      const playlist = seed.store.playlists.find((item) => item.id === playlistId)
      const [first, second, third] = playlist.entries
      await page.evaluate(`document.querySelector('[data-testid="nav-playlists"]').click()`)
      await page.evaluate(`document.querySelector('[data-testid="playlist-${playlistId}"]').click()`)
      await waitFor(async () => (await sendCommand({ action: 'status' })).playlists.selectedPlaylistId === playlistId,
        `${playlist.kind} selected`)
      await clickPlaylistEntry(first.id, 1)
      const selected = await waitFor(async () => {
        const value = await sendCommand({ action: 'status' })
        return value.playlists.currentEntryId === first.id && value.playback.songId === first.songId
          && value.playback.status === 'paused' ? value : undefined
      }, `${playlist.kind} single click selects without playback`)
      assert.equal(selected.playback.playingIntent, false)
      assert.equal(await page.evaluate('document.querySelector("audio").paused'), true)
      record(`playlist-${playlist.kind}-single-select`, { entryId: first.id, songId: first.songId })

      await page.evaluate('window.__qa.cursorCalls = []; window.__qa.delayCursor = true')
      await clickPlaylistEntry(second.id, 1)
      await waitFor(async () => page.evaluate('Boolean(window.__qa.releaseCursor)'), 'delayed first-click cursor request')
      await clickPlaylistEntry(second.id, 2)
      assert.equal(await page.evaluate('window.__qa.cursorCalls.length'), 1,
        'The double click shares the first click’s pending cursor write')
      await page.evaluate('window.__qa.delayCursor = false; window.__qa.releaseCursor()')
      const playing = await waitFor(async () => {
        const value = await sendCommand({ action: 'status' })
        return value.playlists.currentEntryId === second.id && value.playback.songId === second.songId
          && value.playback.status === 'playing' && value.playback.currentTime > 0.15 ? value : undefined
      }, `${playlist.kind} delayed double click selects and plays`)
      assert.equal(playing.playlists.activePlaylistId, playlistId)
      assert.equal(playing.playlists.transitionCount, selected.playlists.transitionCount + 1,
        'The delayed single-click acknowledgement cannot pause or reset the double-click playback')
      assert.equal(playing.playback.playingIntent, true)
      const media = await page.evaluate('({ paused: document.querySelector("audio").paused, time: document.querySelector("audio").currentTime })')
      assert.equal(media.paused, false)
      assert.ok(media.time > 0)
      assert.equal(await page.evaluate('Boolean(document.querySelector(".error-toast"))'), false)
      record(`playlist-${playlist.kind}-delayed-double-play`, {
        entryId: second.id, songId: second.songId, cursorWrites: await page.evaluate('window.__qa.cursorCalls.length'), media,
      })

      await sendCommand({ action: 'control', value: { action: 'pause' } })
      await clickPlaylistEntry(third.id, 1)
      await clickPlaylistEntry(third.id, 2)
      await waitFor(async () => {
        const value = await sendCommand({ action: 'status' })
        return value.playlists.currentEntryId === third.id && value.playback.songId === third.songId
          && value.playback.status === 'playing' ? value : undefined
      }, `${playlist.kind} normal double click plays another entry`)
      assert.equal(await page.evaluate('Boolean(document.querySelector(".error-toast"))'), false)
      await capture(`playlist-${playlist.kind}-double-play`)
      record(`playlist-${playlist.kind}-double-play`, { entryId: third.id, songId: third.songId })
      await sendCommand({ action: 'control', value: { action: 'pause' } })
    }
    await page.evaluate(`(async () => {
      let store = await window.karaoke.getPlaylists()
      for (const playlistId of ['queue', 'history']) {
        const playlist = store.playlists.find(item => item.id === playlistId)
        store = await window.karaoke.clearPlaylist({ playlistId, expectedUpdatedAt: playlist.updatedAt })
      }
      const named = store.playlists.find(item => item.id === ${JSON.stringify(seed.namedId)})
      await window.karaoke.deletePlaylist({ playlistId: named.id, expectedUpdatedAt: named.updatedAt })
      await window.karaoke.selectPlaylist({ playlistId: 'queue' })
    })()`)
    await instrumentRenderer()
    await waitFor(async () => page.evaluate(`document.querySelector('audio')?.readyState >= 3
      && document.querySelector('.now-playing h2')?.textContent === 'Lyrics Edit Fixture'`), 'library restored after playlist click regressions')
  }

  async function runRevisionRegressions() {
    const settingsPath = path.join(profile, 'settings.json')
    const readSettings = async () => JSON.parse(await readFile(settingsPath, 'utf8'))
    const settingsControls = ['ui-locale-en', 'ui-locale-fr', 'recognition-language-mode', 'recognition-language-code']
    await page.evaluate(`window.karaoke.updateSettings({ uiLocale: 'en', recognitionLanguageMode: 'manual', recognitionLanguageCode: 'ru' })`)
    const settingsBefore = await readSettings()
    await instrumentRenderer({ delaySettings: true })
    await waitFor(async () => page.evaluate('Boolean(window.__qa.releaseSettings)'), 'delayed authoritative settings read')
    for (const testId of settingsControls) {
      assert.equal(await page.evaluate(`document.querySelector('[data-testid="${testId}"]').disabled`), true)
    }
    await page.evaluate(`document.querySelector('[data-testid="ui-locale-fr"]').click()`)
    await setSelect('recognition-language-mode', 'auto')
    assert.deepEqual(await page.evaluate('window.__qa.writes'), [], 'An early click/change must never write defaults')
    assert.deepEqual(await readSettings(), { ...defaultAppSettings, recognitionLanguageMode: 'manual', recognitionLanguageCode: 'ru' })
    await capture('delayed-settings-controls')
    await page.evaluate('window.__qa.releaseSettings()')
    await waitFor(async () => page.evaluate(`document.querySelector('[data-testid="recognition-language-code"]').value === 'ru'
      && !document.querySelector('[data-testid="ui-locale-fr"]').disabled`), 'authoritative manual Russian hydration')
    await page.evaluate(`window.__qa.delaySave = true; document.querySelector('[data-testid="ui-locale-fr"]').click()`)
    await waitFor(async () => page.evaluate('Boolean(window.__qa.releaseSave) && document.documentElement.lang === "fr"'), 'responsive optimistic locale save')
    await setSelect('recognition-language-code', 'en')
    assert.deepEqual(await page.evaluate('window.__qa.writes'), [{ uiLocale: 'fr' }], 'Only the intended patch is sent; concurrent disabled changes are ignored')
    await page.evaluate('window.__qa.delaySave = false; window.__qa.releaseSave()')
    await waitFor(async () => page.evaluate(`!document.querySelector('[data-testid="ui-locale-en"]').disabled`), 'saved settings controls')
    assert.deepEqual(await readSettings(), { ...defaultAppSettings, uiLocale: 'fr', recognitionLanguageMode: 'manual', recognitionLanguageCode: 'ru' })
    record('delayed-hydration-preserves-manual-russian', {
      before: settingsBefore, after: await readSettings(), writePatches: await page.evaluate('window.__qa.writes'),
      earlyClickWhileHydrating: 'disabled; no write',
    })

    await page.evaluate(`window.__qa.failSave = true; document.querySelector('[data-testid="ui-locale-en"]').click()`)
    await waitFor(async () => page.evaluate(`document.documentElement.lang === 'fr'
      && document.querySelector('.error-toast')?.textContent.includes('Impossible d’enregistrer les réglages d’interface')`), 'failed preference save rollback and visible error')
    assert.equal((await readSettings()).recognitionLanguageCode, 'ru')
    assert.equal((await readSettings()).uiLocale, 'fr')
    await capture('settings-save-failure')
    await page.evaluate('document.querySelector(".error-toast").click()')
    // An independent writer can change a field that this renderer has not reloaded.
    await page.evaluate(`window.karaoke.updateSettings({ recognitionLanguageCode: 'ar' })`)
    await page.evaluate(`document.querySelector('[data-testid="ui-locale-en"]').click()`)
    await waitFor(async () => page.evaluate(`document.documentElement.lang === 'en'
      && document.querySelector('[data-testid="recognition-language-code"]').value === 'ar'
      && !document.querySelector('[data-testid="ui-locale-fr"]').disabled`), 'authoritative partial save composition')
    assert.equal((await readSettings()).recognitionLanguageCode, 'ar')
    record('failed-and-independent-settings-saves', 'Failed save rolls back visibly; a stale renderer locale patch preserves another writer’s recognition code')

    await instrumentRenderer({ failSettings: true })
    await waitFor(async () => page.evaluate(`document.documentElement.lang === 'en'
      && document.querySelector('.error-toast')?.textContent.includes('Unable to load interface settings: QA settings read failure')`), 'English fallback settings failure visibility')
    for (const testId of settingsControls) {
      assert.equal(await page.evaluate(`document.querySelector('[data-testid="${testId}"]').disabled`), true)
    }
    assert.equal((await readSettings()).recognitionLanguageCode, 'ar')
    await capture('settings-load-failure-english-fallback')
    record('settings-read-failure-is-safe-and-visible', 'English fallback reports read failure and leaves persisted preferences untouched')
    await page.evaluate(`window.karaoke.updateSettings({ uiLocale: 'fr', recognitionLanguageMode: 'manual', recognitionLanguageCode: 'ru' })`)
    await instrumentRenderer()

    const invalidVocal = path.join(profile, 'qa-invalid-rematch-vocal.wav')
    await writeFile(invalidVocal, Buffer.alloc(200))
    const failureSong = {
      ...fixtureSongs[1], id: 'rematch-failure-fixture', title: 'Queue / History / Demucs',
      artist: 'Unable to load this audio version', vocalPath: invalidVocal, lyrics: fixtureSongs[0].lyrics,
    }
    const persistedLibrary = JSON.parse(await readFile(path.join(profile, 'library.json'), 'utf8'))
    await sendCommand({ action: 'inject-library', songs: [...persistedLibrary, failureSong] })
    await instrumentRenderer()
    await waitFor(async () => page.evaluate(`document.documentElement.lang === 'fr'
      && !document.querySelector('[data-testid="ui-locale-fr"]').disabled`), 'French revision regression renderer')
    await page.evaluate(`document.querySelector('[data-testid="song-row"][data-song-id="rematch-failure-fixture"]').click()`)
    await waitFor(async () => (await sendCommand({ action: 'status' })).playback?.songId === failureSong.id, 'real rematch fixture selection')
    await page.evaluate(`window.__qa.holdRematch = true; document.querySelector('[data-testid="edit-lyrics"]').click()`)
    await waitFor(async () => page.evaluate(`Boolean(document.querySelector('[data-testid="lyrics-editor-text"]'))`), 'failure editor')
    const failedText = 'Edited text retained\nSecond edited line'
    await setEditorText(failedText)
    await page.evaluate(`document.querySelector('[data-testid="lyrics-editor-update"]').click()`)
    await waitFor(async () => page.evaluate(`document.querySelector('[data-testid="lyrics-editor-status"]')?.textContent.includes('La resynchronisation est en file')`), 'queued save acknowledgement while modal stays open')
    const failurePath = path.join(profile, 'processed', failureSong.id, 'lyrics.json')
    const failedDocument = await waitFor(async () => {
      const document = JSON.parse(await readFile(failurePath, 'utf8'))
      return document.rematch.status === 'failed' ? document : undefined
    }, 'real FFmpeg rematch failure persistence')
    assert.equal(failedDocument.text, failedText)
    assert.deepEqual(failedDocument.lines.map(({ start, end }) => [start, end]), [[0, 1.2], [1.2, 2.4]])
    await waitFor(async () => page.evaluate('window.__qa.deferredUpdates.length > 0'), 'terminal backend publication')
    await page.evaluate(`window.__qa.holdRematch = false; window.__qa.deferredUpdates.splice(0).forEach(window.__qa.processUpdate)`)
    const failedStatus = await waitFor(async () => {
      const text = await page.evaluate(`document.querySelector('[data-testid="lyrics-editor-status"]')?.textContent ?? ''`)
      return text.includes('La resynchronisation a échoué') ? text : undefined
    }, 'open modal observes real failed rematch')
    assert.match(failedStatus, /texte modifié et la synchronisation existante ont été conservés/)
    assert.doesNotMatch(failedStatus, /est en file|Timing rematch failed|Lyric timing rematch failed|Saved lyric text and timing were retained/)
    assert.equal(await page.evaluate(`document.querySelector('[data-testid="lyrics-editor-status"]').getAttribute('role')`), 'alert')
    assert.equal(await page.evaluate(`document.querySelector('[data-testid="lyrics-editor-text"]').value`), failedText)
    const failureLayout = await page.evaluate(`(() => {
      const status = document.querySelector('[data-testid="lyrics-editor-status"]')
      const button = document.querySelector('[data-testid="lyrics-editor-update"]').getBoundingClientRect()
      return { statusScrolls: status.scrollHeight > status.clientHeight,
        actionsVisible: button.top >= 0 && button.bottom <= innerHeight }
    })()`)
    assert.deepEqual(failureLayout, { statusScrolls: true, actionsVisible: true }, 'Long raw diagnostics scroll without hiding editor actions')
    await capture('open-editor-rematch-failed')
    record('open-editor-real-rematch-failure', {
      backendStatus: failedDocument.rematch.status, revision: failedDocument.revision,
      savedText: failedDocument.text, retainedLines: failedDocument.lines, modalStatus: failedStatus, layout: failureLayout,
    })

    const secondText = failedText.replace('Second', 'Another')
    await page.evaluate('window.__qa.delayLyricsAck = true')
    await setEditorText(secondText)
    await page.evaluate(`document.querySelector('[data-testid="lyrics-editor-update"]').click()`)
    await waitFor(async () => {
      const document = JSON.parse(await readFile(failurePath, 'utf8'))
      return document.revision === failedDocument.revision + 1 && document.rematch.status === 'failed'
    }, 'second revision failed before acknowledgement')
    await waitFor(async () => page.evaluate(`Boolean(window.__qa.releaseLyricsAck)
      && document.querySelector('[data-testid="lyrics-rematch-status"]')?.textContent.includes('a échoué')`), 'fast rematch terminal event before save acknowledgement')
    await page.evaluate('window.__qa.delayLyricsAck = false; window.__qa.releaseLyricsAck()')
    await waitFor(async () => page.evaluate(`!document.querySelector('[data-testid="lyrics-editor-text"]').disabled
      && document.querySelector('[data-testid="lyrics-editor-status"]')?.textContent.includes('La resynchronisation a échoué')`), 'late save acknowledgement does not mask a terminal failure')
    record('terminal-rematch-before-save-ack', 'Delayed real save acknowledgement cannot overwrite the already-published failed revision')

    const backendSong = await page.evaluate(`window.karaoke.getLibrary().then(songs => songs.find(song => song.id === 'rematch-failure-fixture'))`)
    const rematchUpdate = (status) => ({
      songId: backendSong.id, stage: backendSong.processingStage, progress: backendSong.processingProgress,
      message: '', song: { ...backendSong, lyricRematchStatus: status },
    })
    await page.evaluate(`window.__qa.processUpdate(${JSON.stringify(rematchUpdate('pending'))})`)
    await waitFor(async () => page.evaluate(`document.querySelector('[data-testid="lyrics-editor-status"]')?.textContent.includes('est en file')`), 'same-revision pending transition')
    await page.evaluate(`window.__qa.processUpdate(${JSON.stringify(rematchUpdate('complete'))})`)
    await waitFor(async () => page.evaluate(`document.querySelector('[data-testid="lyrics-editor-status"]')?.textContent.includes('Resynchronisation terminée. Le texte modifié a été conservé.')`), 'open modal complete transition')
    assert.equal(await page.evaluate(`document.querySelector('[data-testid="lyrics-editor-text"]').value`), secondText)
    assert.equal(await page.evaluate(`document.querySelector('[data-testid="lyrics-editor-status"]').getAttribute('role')`), 'status')
    await capture('open-editor-rematch-complete')
    record('open-editor-complete-transition', 'Same-revision completion event through the live renderer subscription replaces queued status without changing the draft')
    await setEditorText('Unsaved draft must not inherit success')
    await page.evaluate(`window.__qa.processUpdate(${JSON.stringify(rematchUpdate('complete'))})`)
    assert.doesNotMatch(await page.evaluate(`document.querySelector('[data-testid="lyrics-editor-status"]').textContent`), /terminée|est en file/)
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await waitFor(async () => page.evaluate(`document.activeElement?.matches('[data-testid="lyrics-editor-discard"]')`), 'dirty Escape focuses discard')
    await page.evaluate(`document.querySelector('[data-testid="lyrics-editor-discard"]').click()`)
    await waitFor(async () => page.evaluate(`!document.querySelector('[data-testid="lyrics-editor"]')`), 'discard closes modal')
    record('rematch-success-does-not-mask-unsaved-draft', 'Editing clears saved acknowledgement; terminal result is tied to the saved revision/text')

    const ownedFailure = `Lyric timing rematch failed: ${rawDiagnostic}. Saved lyric text and timing were retained. Whisper cannot force-align provided text.`
    await page.evaluate(`window.__qa.processUpdate(${JSON.stringify({
      ...rematchUpdate('failed'), song: { ...backendSong, lyricRematchStatus: 'failed', lyricRematchMessage: ownedFailure },
    })})`)
    const multiline = await waitFor(async () => {
      const text = await page.evaluate(`document.querySelector('[data-testid="lyrics-rematch-status"]')?.textContent`)
      return text?.includes(rawDiagnostic) ? text : undefined
    }, 'rendered multiline rematch diagnostic update')
    assert.ok(multiline.includes(rawDiagnostic), 'Multiline OS/engine diagnostic payload is unchanged')
    assert.ok(multiline.includes('Le texte et la synchronisation enregistrés ont été conservés'))
    assert.doesNotMatch(multiline, /Timing rematch failed|Lyric timing rematch failed|Saved lyric text/)
    await capture('multiline-rematch-diagnostic')
    record('multiline-owned-wrapper-preserves-diagnostics', 'Both application-owned wrappers translate while raw path, engine text and line breaks remain exact')

    const startedAt = new Date().toISOString()
    for (const [english, french, itemId] of dynamicMessages) {
      const rootItemId = itemId === 'whisper-transcription' ? 'whisper-model' : itemId
      const items = [{ id: itemId, label: itemId === 'demucs' ? 'Demucs separation' : 'Whisper transcription',
        status: 'active', progress: 40, message: english }]
      if (rootItemId !== itemId) items.unshift({ id: rootItemId, label: 'Whisper model', status: 'complete', message: english })
      const messageUpdate = {
        songId: backendSong.id, stage: 'transcribing', progress: 40, message: english,
        details: { operation: 'process', startedAt, updatedAt: new Date().toISOString(), activeItem: itemId,
          items },
      }
      await page.evaluate(`window.__qa.processUpdate(${JSON.stringify(messageUpdate)})`)
      await waitFor(async () => page.evaluate(`document.querySelector('[data-testid="processing-action"]')?.textContent === ${JSON.stringify(french)}`), `rendered dynamic message: ${english}`)
      assert.equal(await page.evaluate(`document.querySelector('[data-testid="processing-overall"]').textContent`), '40 %')
      const detail = await page.evaluate(`document.querySelector('[data-testid="processing-item-${rootItemId}"] small')?.textContent`)
      assert.ok(detail?.startsWith(french), `Checklist detail translates the actual dynamic family: ${english}; received ${detail}`)
      if (rootItemId !== itemId) {
        assert.ok((await page.evaluate(`document.querySelector('[data-testid="processing-item-${rootItemId}"] .processing-children [title]')?.title`))?.startsWith(french))
      }
      assert.equal(await page.evaluate(`document.querySelector('.now-playing h2').textContent`), failureSong.title)
      assert.equal(await page.evaluate(`document.querySelector('.now-playing p').textContent`), failureSong.artist)
      if (itemId === 'demucs' && english.startsWith('Demucs processed')) await capture('french-dynamic-progress')
    }
    record('french-actual-processing-message-families', `${dynamicMessages.length} emitted processing/progress/error families render in French; metadata stays untouched`)

    await page.evaluate(`document.querySelector('audio').dispatchEvent(new Event('error'))`)
    await waitFor(async () => page.evaluate(`document.querySelector('.error-toast')?.textContent === 'Impossible de charger cette version audio : Erreur multimédia inconnue'`), 'renderer-owned playback error translation')
    await capture('french-playback-error')
    await page.evaluate(`document.querySelector('.error-toast').click()`)
    record('french-renderer-playback-error', 'Actual playback-controller error handler renders a French application-owned prefix')

    const playlistsBefore = JSON.parse(await readFile(path.join(profile, 'playlists.json'), 'utf8'))
    await page.evaluate(`document.querySelector('[data-testid="nav-playlists"]').click()`)
    await waitFor(async () => page.evaluate(`document.querySelector('[data-testid="playlist-queue"] span')?.textContent === 'File d’attente'`), 'French system playlist tabs')
    assert.equal(await page.evaluate(`document.querySelector('[data-testid="playlist-history"] span').textContent`), 'Historique')
    await page.evaluate(`document.querySelector('[data-testid="playlist-queue"]').click()`)
    await waitFor(async () => page.evaluate(`document.querySelector('.playlist-heading h2')?.textContent === 'File d’attente'`), 'French Queue heading')
    await page.evaluate(`document.querySelector('[data-testid="playlist-clear"]').click()`)
    await waitFor(async () => page.evaluate(`document.querySelector('#playlist-clear-title')?.textContent === 'Vider File d’attente ?'`), 'French system clear confirmation')
    await page.evaluate(`document.querySelector('[aria-label="Annuler le vidage de la liste"]').click()`)
    await page.evaluate(`document.querySelector('[data-testid="playlist-history"]').click()`)
    await waitFor(async () => page.evaluate(`document.querySelector('.playlist-heading h2')?.textContent === 'Historique'`), 'French History heading')
    for (const name of ['Queue', 'History']) {
      const id = `qa-user-${name.toLowerCase()}`
      assert.equal(await page.evaluate(`document.querySelector('[data-testid="playlist-${id}"] span').textContent`), name)
      await page.evaluate(`document.querySelector('[data-testid="playlist-${id}"]').click()`)
      await waitFor(async () => page.evaluate(`document.querySelector('.playlist-heading h2')?.textContent === ${JSON.stringify(name)}`), `user playlist ${name} remains literal`)
    }
    await capture('french-system-and-user-playlists')
    await page.evaluate(`document.querySelector('[data-testid="nav-library"]').click()`)
    await page.evaluate(`document.querySelector('[data-testid="song-menu-rematch-failure-fixture"]').click()`)
    await waitFor(async () => page.evaluate(`document.querySelector('[data-testid="add-to-playlist-queue"]')?.textContent === 'File d’attente'`), 'French system plus menu')
    assert.equal(await page.evaluate(`document.querySelector('[data-testid="add-to-playlist-qa-user-queue"]').textContent`), 'Queue')
    assert.equal(await page.evaluate(`document.querySelector('[data-testid="add-to-playlist-qa-user-history"]').textContent`), 'History')
    await capture('french-plus-menu')
    await page.evaluate(`document.querySelector('[data-testid="add-to-playlist-qa-user-queue"]').click()`)
    await waitFor(async () => page.evaluate(`document.querySelector('.notice-toast')?.textContent === 'Ajouté à Queue.'`), 'user playlist Queue notice stays literal')
    await page.evaluate(`document.querySelector('[data-testid="ui-locale-en"]').click()`)
    await waitFor(async () => page.evaluate(`document.querySelector('.notice-toast')?.textContent === 'Added to Queue.'
      && !document.querySelector('[data-testid="ui-locale-fr"]').disabled`), 'playlist notification updates with locale')
    await page.evaluate(`document.querySelector('[data-testid="ui-locale-fr"]').click()`)
    await waitFor(async () => page.evaluate(`document.documentElement.lang === 'fr'
      && !document.querySelector('[data-testid="ui-locale-en"]').disabled`), 'French locale restored after notification regression')
    const playlistsAfter = JSON.parse(await readFile(path.join(profile, 'playlists.json'), 'utf8'))
    assert.deepEqual(playlistsAfter.playlists.map(({ id, kind, name }) => ({ id, kind, name })),
      playlistsBefore.playlists.map(({ id, kind, name }) => ({ id, kind, name })), 'Localization never rewrites stored playlist names')
    record('french-system-playlists-by-kind-only', 'System Queue/History tabs, headings and plus menu translate; literal user Queue/History names and all stored names remain unchanged')
  }

  try {
    await rm(profile, { recursive: true, force: true })
    await mkdir(output, { recursive: true })
    await mkdir(profile, { recursive: true })
    await mkdir(appData, { recursive: true })
    await mkdir(localAppData, { recursive: true })
    const fixtureRoot = path.join(output, 'fixtures')
    await execFileAsync(process.execPath, [path.join(root, 'scripts', 'create-qa-fixtures.mjs'), fixtureRoot])
    for (const fixture of fixtureSongs) await copyFile(path.join(fixtureRoot, 'qa-tone.mp3'), fixture.sourcePath)
    await start()
    await sendCommand({ action: 'inject-library', songs: fixtureSongs })
    await page.connect()
    await waitFor(async () => {
      const text = await page.evaluate('document.body?.innerText ?? ""')
      return text.includes('Lyrics Edit Fixture') && text.includes('Extract with local AI') ? text : undefined
    }, 'rendered library')
    await waitFor(async () => page.evaluate('document.querySelector("audio")?.readyState >= 3'), 'playable generated source')
    await runQueueTransportRegressions()
    await runPlaylistMutationRegressions()
    await runPlaylistClickRegressions()
    if (process.argv.includes('--playlists-rendered')) {
      const diagnostics = await sendCommand({ action: 'diagnostics' })
      assert.deepEqual(diagnostics.rendererErrors, [])
      await writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'passed', cases,
        rendererErrors: diagnostics.rendererErrors }, null, 2))
      console.log(`PASS playlists-rendered: ${cases.length} rendered gates; evidence ${output}`)
      return
    }
    await page.evaluate(`document.querySelector('[data-testid="song-menu-lyrics-edit-other"]').click()`)
    await waitFor(async () => page.evaluate(`Boolean(document.querySelector('[data-testid="add-to-playlist-queue"]'))`), 'real queue plus menu')
    await page.evaluate(`document.querySelector('[data-testid="add-to-playlist-queue"]').click()`)
    await waitFor(async () => (await sendCommand({ action: 'status' })).playlists.playlists.find((item) => item.kind === 'queue')?.entries.length === 1, 'populated queue before lyrics save')
    await page.evaluate(`document.querySelector('[data-testid="edit-lyrics"]').click()`)
    await waitFor(async () => page.evaluate(`document.activeElement?.matches('[data-testid="lyrics-editor-text"]')`), 'editor initial focus')
    await page.evaluate(`(() => {
      const buttons = document.querySelector('[data-testid="lyrics-editor"]').querySelectorAll('button:not([disabled]),textarea')
      buttons[buttons.length - 1].focus()
    })()`)
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
    assert.equal(await page.evaluate(`document.activeElement === document.querySelector('[data-testid="lyrics-editor"] button')`), true)
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await waitFor(async () => page.evaluate(`!document.querySelector('[data-testid="lyrics-editor"]') && document.activeElement?.matches('[data-testid="edit-lyrics"]')`), 'Escape returns focus to Edit')
    record('modal-keyboard-focus-and-trap', 'Native CDP Tab wraps and clean Escape restores Edit focus')

    await sendCommand({ action: 'control', value: { action: 'mode', value: 'instrumental' } })
    await waitFor(async () => page.evaluate('document.querySelector("audio")?.readyState >= 3 && document.querySelector("audio")?.dataset.playbackMode === "instrumental"'), 'generated instrumental fixture')
    await sendCommand({ action: 'control', value: { action: 'play' } })
    const before = await waitFor(async () => {
      const status = await sendCommand({ action: 'status' })
      return status.playback?.status === 'playing' && status.playback.currentTime >= 0.25 ? status : undefined
    }, 'actual generated-fixture playback')
    const mediaBefore = await page.evaluate('document.querySelector("audio").currentTime')
    assert.equal(before.playback?.songId, 'lyrics-edit-fixture')
    assert.equal(before.playback?.mode, 'instrumental')
    assert.equal(before.playlists.playlists.find((item) => item.kind === 'queue')?.entries.length, 1)

    await page.evaluate(`document.querySelector('[data-testid="edit-lyrics"]').click()`)
    await waitFor(async () => page.evaluate(`Boolean(document.querySelector('[data-testid="lyrics-editor-text"]'))`), 'lyrics editor')
    const loaded = await page.evaluate(`document.querySelector('[data-testid="lyrics-editor-text"]').value`)
    assert.equal(loaded, 'Saved first line\nSaved second line')
    await page.evaluate(`(() => {
      const element = document.querySelector('[data-testid="lyrics-editor-text"]')
      element.focus()
      element.select()
      const clipboardData = new DataTransfer()
      clipboardData.setData('text/plain', ${JSON.stringify(edited)})
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))
    })()`)
    // Untrusted clipboard events cannot insert text; CDP supplies the native input.
    await page.send('Input.insertText', { text: textareaValue(edited) })
    await waitFor(async () => (await page.evaluate(`document.querySelector('[data-testid="lyrics-editor-text"]').value`))
      === textareaValue(edited), 'pasted raw LRC in rendered textarea')
    await page.evaluate(`document.querySelector('[data-testid="lyrics-editor-update"]').click()`)
    await waitFor(async () => {
      const status = await page.evaluate(`document.querySelector('[data-testid="lyrics-editor-status"]')?.textContent ?? ''`)
      return status.includes('Lyrics saved') ? status : undefined
    }, 'saved lyrics status')
    const kept = await page.evaluate(`document.querySelector('[data-testid="lyrics-editor-text"]').value`)
    assert.equal(kept, textareaValue(edited), 'Textarea shows all LRC and blank lines (DOM values normalize CRLF)')
    const documentPath = path.join(profile, 'processed', 'lyrics-edit-fixture', 'lyrics.json')
    const persisted = await waitFor(async () => {
      try {
        const parsed = JSON.parse(await readFile(documentPath, 'utf8'))
        return parsed.text === edited ? parsed : undefined
      } catch {
        return undefined
      }
    }, 'persisted lyrics document')
    assert.equal(persisted.text, edited)
    assert.equal(persisted.source, 'user')
    const after = await waitFor(async () => {
      const status = await sendCommand({ action: 'status' })
      return status.playback?.activeLyricText?.startsWith('Edited ')
        && status.playback.currentTime > before.playback.currentTime + 0.1 ? status : undefined
    }, 'playback uses only the timed lyric wording')
    assert.equal(after.playback?.songId, before.playback.songId)
    assert.equal(after.playback?.mode, before.playback.mode)
    assert.equal(after.playback?.status, 'playing')
    assert.equal(after.playback?.playingIntent, before.playback.playingIntent)
    assert.deepEqual(after.playlists.playlists.find((item) => item.kind === 'queue'),
      before.playlists.playlists.find((item) => item.kind === 'queue'))
    const mediaAfter = await page.evaluate('({ time: document.querySelector("audio").currentTime, paused: document.querySelector("audio").paused, error: document.querySelector("audio").error?.code })')
    assert.ok(mediaAfter.time > mediaBefore + 0.1, 'Actual audio currentTime advances across the lyrics save')
    assert.equal(mediaAfter.paused, false)
    assert.equal(mediaAfter.error, undefined)
    record('save-preserves-live-playback-mode-and-queue', {
      mediaBefore, mediaAfter, mode: after.playback.mode,
      queueEntries: after.playlists.playlists.find((item) => item.kind === 'queue').entries,
    })
    await sendCommand({ action: 'control', value: { action: 'pause' } })
    assert.equal(after.playback?.lyricLanguage?.languageCode, 'en')
    const protectedNote = await page.evaluate(`document.querySelector('[data-testid="lyrics-protected"]')?.textContent ?? ''`)
    assert.match(protectedNote, /Manual lyrics are protected from AI text replacement/)
    const extractDisabled = await page.evaluate(`document.querySelector('.ai-action')?.disabled === true`)
    assert.equal(extractDisabled, true)
    const overwrite = await page.evaluate(`document.body.innerText.includes('Overwrite')`)
    assert.equal(overwrite, false)

    await page.evaluate(`document.querySelector('[aria-label="Cancel lyrics edit"]').click()`)
    await waitFor(async () => page.evaluate(`!document.querySelector('[data-testid="lyrics-editor"]')`), 'saved editor closed')
    await page.evaluate(`document.querySelector('[data-testid="edit-lyrics"]').click()`)
    await waitFor(async () => (await page.evaluate(`document.querySelector('[data-testid="lyrics-editor-text"]')?.value`))
      === textareaValue(edited), 'reopened editor retains blank lines and explicit LRC')
    await page.evaluate(`(() => {
      const element = document.querySelector('[data-testid="lyrics-editor-text"]')
      const start = element.value.indexOf('première')
      element.focus()
      element.setSelectionRange(start, start + 'première'.length)
    })()`)
    await page.send('Input.insertText', { text: 'nouvelle' })
    await page.evaluate(`document.querySelector('[data-testid="lyrics-editor-update"]').click()`)
    await waitFor(async () => {
      const parsed = JSON.parse(await readFile(documentPath, 'utf8'))
      return parsed.text === revised && parsed.revision === persisted.revision + 1 ? parsed : undefined
    }, 'small rendered edit preserves exact CRLF, blank lines, trailing spaces, and LRC')
    const revisedLibrary = JSON.parse(await readFile(path.join(profile, 'library.json'), 'utf8'))
    assert.equal(revisedLibrary.find((item) => item.id === 'lyrics-edit-fixture').lyricEditorText, revised)

    await page.evaluate(`document.querySelector('[data-testid="lyrics-editor-text"]') && (() => {
      const element = document.querySelector('[data-testid="lyrics-editor-text"]')
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      setter.call(element, 'Unsaved draft line')
      element.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await page.evaluate(`document.querySelector('[data-testid="song-row"][data-song-id="lyrics-edit-other"]').click()`)
    await waitFor(async () => {
      const prompt = await page.evaluate(`document.querySelector('[data-testid="lyrics-editor-status"]')?.textContent ?? ''`)
      return prompt.includes('Discard unsaved') ? prompt : undefined
    }, 'discard prompt')
    await waitFor(async () => page.evaluate(`document.activeElement?.matches('[data-testid="lyrics-editor-discard"]')`), 'dirty draft discard focus')
    await page.evaluate(`[...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Keep editing').click()`)
    const retained = await page.evaluate(`document.querySelector('[data-testid="lyrics-editor-text"]').value`)
    assert.equal(retained, 'Unsaved draft line')
    await page.evaluate(`document.querySelector('[data-testid="song-row"][data-song-id="lyrics-edit-other"]').click()`)
    await waitFor(async () => page.evaluate(`Boolean(document.querySelector('[data-testid="lyrics-editor-discard"]'))`), 'discard button')
    await page.evaluate(`document.querySelector('[data-testid="lyrics-editor-discard"]').click()`)
    const switched = await waitFor(async () => {
      const value = await page.evaluate(`document.querySelector('[data-testid="lyrics-editor-text"]')?.value ?? ''`)
      return value === 'Other saved line' ? value : undefined
    }, 'editor retarget after discard')
    assert.equal(switched, 'Other saved line')
    await page.evaluate(`[...document.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === 'Cancel lyrics edit')?.click()`)
    await waitFor(async () => page.evaluate(`!document.querySelector('[data-testid="lyrics-editor"]')`), 'editor closed')

    await page.evaluate(`document.querySelector('[data-testid="ui-locale-fr"]').click()`)
    await waitFor(async () => {
      const lang = await page.evaluate('document.documentElement.lang')
      const text = await page.evaluate('document.body.innerText')
      return lang === 'fr' && text.includes('Bibliothèque') ? text : undefined
    }, 'French interface')
    assert.equal(await page.evaluate(`document.querySelector('.notice-toast')?.textContent`), 'Ajouté à File d’attente.',
      'A system playlist notification is localized by kind even when the interface changes after adding')
    await page.evaluate(`(() => {
      const mode = document.querySelector('[data-testid="recognition-language-mode"]')
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
      setter.call(mode, 'manual')
      mode.dispatchEvent(new Event('change', { bubbles: true }))
    })()`)
    await waitFor(async () => {
      const disabled = await page.evaluate(`document.querySelector('[data-testid="recognition-language-code"]').disabled`)
      return disabled === false ? true : undefined
    }, 'manual recognition language enabled')
    await page.evaluate(`(() => {
      const code = document.querySelector('[data-testid="recognition-language-code"]')
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
      setter.call(code, 'fr')
      code.dispatchEvent(new Event('change', { bubbles: true }))
    })()`)
    const settingsPath = path.join(profile, 'settings.json')
    const savedSettings = await waitFor(async () => {
      const parsed = JSON.parse(await readFile(settingsPath, 'utf8'))
      return parsed.uiLocale === 'fr' && parsed.recognitionLanguageMode === 'manual' && parsed.recognitionLanguageCode === 'fr'
        ? parsed : undefined
    }, 'persisted interface and recognition settings')
    assert.equal(savedSettings.schemaVersion, 1)
    await capture('french-recognition')
    const initialDiagnostics = await sendCommand({ action: 'diagnostics' })
    assert.deepEqual(initialDiagnostics.rendererErrors, [], 'Generated playable media and normal edits produce no renderer errors')

    const playlistSeed = await page.evaluate('window.karaoke.getPlaylists()')
    await stop()
    const legacyLibrary = JSON.parse(await readFile(path.join(profile, 'library.json'), 'utf8'))
    delete legacyLibrary.find((item) => item.id === 'lyrics-edit-fixture').lyricEditorText
    await writeFile(path.join(profile, 'library.json'), JSON.stringify(legacyLibrary), 'utf8')
    for (const name of ['Queue', 'History']) {
      playlistSeed.playlists.push({ id: `qa-user-${name.toLowerCase()}`, name, kind: 'playlist', entries: [],
        createdAt: '2026-10-23T00:00:00.000Z', updatedAt: '2026-10-23T00:00:00.000Z' })
    }
    await writeFile(path.join(profile, 'playlists.json'), JSON.stringify(playlistSeed), 'utf8')
    await start()
    await waitFor(async () => {
      const lang = await page.evaluate('document.documentElement.lang')
      const mode = await page.evaluate(`document.querySelector('[data-testid="recognition-language-mode"]')?.value`)
      const code = await page.evaluate(`document.querySelector('[data-testid="recognition-language-code"]')?.value`)
      return lang === 'fr' && mode === 'manual' && code === 'fr' ? true : undefined
    }, 'restored French interface and manual recognition')
    const library = JSON.parse(await readFile(path.join(profile, 'library.json'), 'utf8'))
    const restored = library.find((item) => item.id === 'lyrics-edit-fixture')
    assert.equal(restored.languageCode, 'en')
    assert.equal(restored.lyricLanguage.languageCode, 'en')
    assert.equal(restored.lyricEditorText, revised, 'Restart hydrates exact text from lyrics.json for older libraries')
    await page.evaluate(`document.querySelector('[data-testid="song-row"][data-song-id="lyrics-edit-fixture"]').click()`)
    await page.evaluate(`document.querySelector('[data-testid="edit-lyrics"]').click()`)
    await waitFor(async () => (await page.evaluate(`document.querySelector('[data-testid="lyrics-editor-text"]')?.value`))
      === textareaValue(revised), 'restarted rendered editor restores exact LRC layout')
    await page.evaluate(`document.querySelector('[data-testid="lyrics-editor-update"]').click()`)
    await waitFor(async () => {
      const parsed = JSON.parse(await readFile(documentPath, 'utf8'))
      return parsed.text === revised && parsed.revision === restored.lyricsRevision + 1 ? parsed : undefined
    }, 'unchanged update after restart round-trips exact CRLF source')
    record('exact-text-reopen-and-restart', 'CRLF, LRC, blank lines, trailing spaces, small edits and legacy lyrics.json hydration round-trip')
    record('independent-recognition-and-locale-persistence', 'French interface/manual French recognition survive restart; saved song language remains English')

    await runRevisionRegressions()
    await capture('final-french-renderer')
    const diagnostics = await sendCommand({ action: 'diagnostics' })
    assert.deepEqual(diagnostics.rendererErrors.map((item) => ({ message: item.message, detail: item.detail })), [
      { message: 'Renderer exception: Unable to save interface settings', detail: 'QA settings save failure' },
      { message: 'Renderer exception: Unable to load interface settings', detail: 'QA settings read failure' },
      { message: 'Renderer exception: Unable to load this audio version', detail: 'Unknown media error' },
    ], 'Only deliberately injected settings failures are reported; no unexpected renderer/screenshot/media errors')
    await writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'passed', cases,
      rendererErrors: diagnostics.rendererErrors, limitations: [
        'Generated media only; real IPC, persistence, FFmpeg failure and playback.',
        'Completion/progress events injected at the renderer subscription; no AI inference or quality claim.',
      ] }, null, 2))
    console.log(`PASS lyrics-language-rendered: ${cases.length} rendered gates; evidence ${output}`)
  } catch (error) {
    const status = await sendCommand({ action: 'status' }, { timeoutMs: 1000 }).catch(reason => ({ unavailable: reason.message }))
    const media = await page.evaluate(`(() => {
      const audio = document.querySelector('audio')
      return audio ? { ended: audio.ended, paused: audio.paused, time: audio.currentTime, duration: audio.duration,
        intent: audio.dataset.playbackIntent, trace: audio.dataset.playbackTrace, error: audio.error?.code } : undefined
    })()`).catch(reason => ({ unavailable: reason.message }))
    await writeFile(path.join(output, 'report.json'), JSON.stringify({ status: 'failed', cases, error: error.stack, snapshot: { status, media } }, null, 2))
    console.error(`FAIL rendered evidence ${output}`)
    console.error(stderr.slice(-4000))
    throw error
  } finally {
    await stop()
  }
}
