import assert from 'node:assert/strict'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  commitTimingRematch,
  lyricsDocumentFromSong,
  normalizeLyricOwnership,
  parseEditedLyrics,
  parseLyricsDocument,
  preserveLyricTiming,
  protectUserLyrics,
  reapplyLyricsDocument,
  replaceTextFile,
  shouldResumePendingRematch,
  updateSavedLyrics,
} from '../dist-electron/lyric-update.js'

const root = path.resolve('scripts', 'qa-artifacts', `lyric-update-${process.pid}`)
let checks = 0
const equal = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks += 1
}
const check = (value, message) => {
  assert.ok(value, message)
  checks += 1
}
const rejects = (action, pattern, message) => {
  assert.throws(action, pattern, message)
  checks += 1
}
const rejectsAsync = async (action, pattern, message) => {
  await assert.rejects(action, pattern, message)
  checks += 1
}

function song(overrides = {}) {
  return {
    id: 'song-1',
    title: 'Demo',
    artist: 'Unknown artist',
    sourcePath: 'C:\\music\\demo.mp3',
    sourceUrl: 'karaoke://media/song-1/original',
    format: 'mp3',
    addedAt: '2026-10-23T00:00:00.000Z',
    duration: 30,
    lyrics: [
      { text: 'alpha bravo', start: 0, end: 10 },
      { text: 'charlie delta', start: 10, end: 20 },
    ],
    lyricLanguage: { languageCode: 'en', languageName: 'English', languageSource: 'detected' },
    lyricTextSource: 'engine',
    lyricsRevision: 2,
    lyricTimingMethod: 'whisper-grouped',
    lyricRematchStatus: 'none',
    languageCode: 'en',
    languageName: 'English',
    languageSource: 'detected',
    processingStage: 'complete',
    processingProgress: 100,
    ...overrides,
  }
}

equal(normalizeLyricOwnership({}), {
  lyricTextSource: 'engine',
  lyricsRevision: 0,
  lyricTimingMethod: 'whisper-grouped',
  lyricRematchStatus: 'none',
  lyricRematchMessage: undefined,
}, 'legacy songs default to engine-owned Whisper timing')
check(!shouldResumePendingRematch(normalizeLyricOwnership({})),
  'legacy songs do not resume a rematch')

equal(parseEditedLyrics('one\r\ntwo\n').lines, ['one', 'two'],
  'plain text keeps one nonempty line and its original line breaks in the source text')
equal(parseEditedLyrics('[ar:Ada]\n[00:01.00]Hello\n[00:02.50]World').lines, ['Hello', 'World'],
  'complete LRC metadata is ignored and lyric text is preserved without timestamps')
rejects(() => parseEditedLyrics('   \n'), /Edited lyrics are empty\./, 'empty edits are rejected')
rejects(() => parseEditedLyrics('[ar:Ada]\n[ti:Title]\n'), /Edited lyrics contain no usable lines\./,
  'metadata-only edits are rejected')
rejects(() => parseEditedLyrics('[00:01.00]Hello\nplain line'), /LRC timestamps are incomplete or invalid\./,
  'mixed LRC and plain text is rejected')
rejects(() => parseEditedLyrics('[00:1]Hello'), /LRC timestamps are incomplete or invalid\./,
  'partial LRC timestamps are rejected')
for (const malformed of [
  '[00:01.00]Hello <00:02.00',
  '[1234:00]Hello',
  '[00:01.00]Hello <1234:02.00>world',
  '[00:01.00]Hello <00:99.00>world',
  '[00:01.00]Hello [00:02.00',
  '[00:01.00]Hello <00:2.00>world',
  '[00:01.00]Hello < 00:02.00>world',
  '[00:01.00]Hello <:02.00>world',
  '[offset:bad]\n[00:01.00]Hello',
  '[-01:00]Hello',
  '[00:01.00]Hello <-00:02.00>world',
]) {
  rejects(() => parseEditedLyrics(malformed), /LRC timestamps are incomplete or invalid\./,
    `malformed timestamp-like syntax is rejected: ${malformed}`)
}
equal(parseEditedLyrics('[Chorus]\nI love you <3').lines, ['[Chorus]', 'I love you <3'],
  'ordinary bracket text and a heart are valid plain lyrics')
equal(parseEditedLyrics('[offset:-100]\n[00:01.00]Hello [Chorus] <00:02.00>world <3').lines,
  ['Hello [Chorus] world <3'], 'word tags are stripped without rejecting legitimate bracketed lyric text')
equal(parseEditedLyrics('[offset:+100]\n[00:00.00]\n[00:01.00]Hello').lines, ['Hello'],
  'valid signed offsets and empty timed lines are accepted without inventing lyric text')
rejects(() => preserveLyricTiming(['a', 'b', 'c'], [{ text: 'old', start: 0, end: 0.1 }], 30),
  /Edited lyrics cannot fit a 40ms timeline\./, 'a span smaller than 40ms per line is rejected')

equal(preserveLyricTiming(['alpha', 'beta'], song().lyrics, 30), [
  { text: 'alpha', start: 0, end: 10 },
  { text: 'beta', start: 10, end: 20 },
], 'an identical line count copies timing exactly')
equal(preserveLyricTiming(['a', 'b c', 'd e f'], song().lyrics, 30), [
  { text: 'a', start: 0, end: 3.333 },
  { text: 'b c', start: 3.333, end: 10 },
  { text: 'd e f', start: 10, end: 20 },
], 'a changed line count distributes the prior span by word weight')
equal(preserveLyricTiming(['one', 'two'], [], undefined), [
  { text: 'one', start: 0, end: 0.04 },
  { text: 'two', start: 0.04, end: 0.08 },
], 'absent prior lyrics and duration use the 40ms floor without claiming alignment')
equal(preserveLyricTiming(['one', 'two'], [], 1), [
  { text: 'one', start: 0, end: 0.5 },
  { text: 'two', start: 0.5, end: 1 },
], 'absent prior lyrics use a known duration')

const files = new Map()
const library = new Map()
const store = () => ({
  isBusy: () => false,
  readSong: (id) => library.get(id),
  writeSong: async (next) => library.set(next.id, structuredClone(next)),
  readLyrics: async (id) => files.get(id) ?? null,
  writeLyrics: async (id, contents) => files.set(id, contents),
  deleteLyrics: async (id) => files.delete(id),
  hasVocals: async () => true,
  recognizeWords: async () => [],
})

library.set('song-1', song())
const saved = await updateSavedLyrics(store(), {
  songId: 'song-1',
  text: 'alpha bravo\ncharlie delta echo',
  expectedRevision: 2,
})
equal(saved.rematch, 'queued', 'vocals queue a timing rematch')
equal(saved.song.lyricTextSource, 'user', 'an edit protects the lyric text as user-owned')
equal(saved.song.lyricsRevision, 3, 'an edit bumps the lyric revision')
equal(saved.song.lyricTimingMethod, 'preserved-line-times', 'the initial edit preserves timing before rematch')
equal(saved.song.lyricEditorText, 'alpha bravo\ncharlie delta echo', 'save returns exact editor text')
const persisted = parseLyricsDocument(JSON.parse(files.get('song-1')))
equal(persisted.text, 'alpha bravo\ncharlie delta echo', 'lyrics.json preserves the submitted text')
equal(persisted.referenceLines.map((line) => line.text), ['alpha bravo', 'charlie delta'],
  'the previous timing reference is retained')

const reloaded = song({ lyrics: [], lyricTextSource: 'engine', lyricsRevision: 0 })
reapplyLyricsDocument(reloaded, persisted)
equal(reloaded.lyrics.map((line) => line.text), saved.song.lyrics.map((line) => line.text),
  'reload reapplies lyrics.json as the source of truth')
equal(reloaded.lyricTextSource, 'user', 'reload restores manual ownership')
equal(reloaded.lyricsRevision, 3, 'reload restores the lyric revision')
equal(reloaded.lyricEditorText, persisted.text, 'reload restores the exact editor text')
check(shouldResumePendingRematch(reloaded), 'a pending rematch survives restart')

await rejectsAsync(() => updateSavedLyrics(store(), {
  songId: 'song-1',
  text: 'replacement',
  expectedRevision: 2,
}), /Lyric revision conflict\./, 'a stale revision does not write')
equal(files.get('song-1'), JSON.stringify(persisted, null, 2) + '\n',
  'a revision conflict leaves lyrics.json unchanged')

const busy = store()
busy.isBusy = () => true
await rejectsAsync(() => updateSavedLyrics(busy, { songId: 'song-1', text: 'nope', expectedRevision: 3 }),
  /Lyrics are busy with local processing\./, 'a busy song scheduler rejects the edit')
equal(library.get('song-1').lyricsRevision, 3, 'a busy rejection does not bump the revision')

const protectedSong = song({ lyricTextSource: 'user', lyrics: [{ text: 'keep me', start: 0, end: 1 }] })
check(protectUserLyrics(protectedSong), 'user-owned lyrics are protected')
const before = structuredClone(protectedSong)
const { applyEngineGuard } = {
  applyEngineGuard(target, transcript) {
    if (protectUserLyrics(target)) return false
    target.lyrics = transcript.lines
    return true
  },
}
check(applyEngineGuard(protectedSong, { lines: [{ text: 'engine', start: 0, end: 1 }] }) === false,
  'ordinary engine transcript application cannot replace user text')
equal(protectedSong, before, 'protected user text and timing stay unchanged')

const skippedStore = store()
skippedStore.hasVocals = async () => false
library.set('song-1', song({ lyricTextSource: 'user', lyricsRevision: 3, lyrics: saved.song.lyrics }))
const skipped = await updateSavedLyrics(skippedStore, { songId: 'song-1', text: 'only line' })
equal(skipped.rematch, 'skipped', 'missing vocals skip rematch')
equal(skipped.song.lyricRematchStatus, 'skipped', 'skipped rematch is persisted')

const rematchSong = song({
  lyricEditorText: 'stale editor text',
  lyricTextSource: 'user',
  lyricsRevision: 4,
  lyricTimingMethod: 'preserved-line-times',
  lyrics: [
    { text: 'alpha bravo', start: 0, end: 5 },
    { text: 'unmatched line', start: 5, end: 9 },
  ],
})
library.set('song-1', rematchSong)
const rematchText = '[ar:QA]\r\n\r\n[00:01.00]alpha bravo\r\n[00:05.00]unmatched line\r\n\r\n'
files.set('song-1', `${JSON.stringify({
  text: rematchText,
  lines: rematchSong.lyrics,
  source: 'user',
  revision: 4,
  timingMethod: 'preserved-line-times',
  rematch: { status: 'pending' },
}, null, 2)}\n`)
const rematchDeps = store()
rematchDeps.recognizeWords = async () => [
  { text: 'alpha', start: 1, end: 1.4 },
  { text: 'bravo', start: 1.4, end: 2 },
]
const committed = await commitTimingRematch(rematchDeps, 'song-1', 4)
equal(committed, 'committed', 'ordered word matches commit timing only')
const rematched = parseLyricsDocument(JSON.parse(files.get('song-1')))
equal(rematched.lines[0], { text: 'alpha bravo', start: 1, end: 2 },
  'matched user text takes the ASR word span and is not regrouped')
equal(rematched.lines[1], { text: 'unmatched line', start: 5, end: 9 },
  'mismatched text retains its previous timing')
equal(rematched.text, rematchText, 'rematch never replaces exact user text')
equal(library.get('song-1').lyricEditorText, rematchText, 'rematch refreshes the editor from the source document')
equal(lyricsDocumentFromSong(library.get('song-1')).text, rematchText,
  'rebuilding a protected document retains raw text instead of flattening timed lines')
equal(lyricsDocumentFromSong(song()).text, 'alpha bravo\ncharlie delta',
  'legacy songs without editor text still rebuild from their timed lines')
check(rematched.rematch.message.includes('Whisper cannot force-align provided text'),
  'rematch does not claim forced alignment')

files.set('song-1', `${JSON.stringify({ ...rematched, revision: 5, rematch: { status: 'pending' } }, null, 2)}\n`)
library.set('song-1', song({
  ...library.get('song-1'),
  lyricsRevision: 5,
  lyrics: rematched.lines,
}))
const staleDeps = store()
staleDeps.recognizeWords = async () => {
  library.get('song-1').lyricsRevision = 6
  return [{ text: 'alpha', start: 3, end: 4 }]
}
equal(await commitTimingRematch(staleDeps, 'song-1', 5), 'stale',
  'a newer edit makes rematch completion stale')
equal(parseLyricsDocument(JSON.parse(files.get('song-1'))).lines[0].start, 1,
  'stale rematch completion cannot overwrite newer timing')

const missingDeps = store()
missingDeps.readSong = () => undefined
equal(await commitTimingRematch(missingDeps, 'song-1', 6), 'missing',
  'deleting the song prevents a stale rematch write')

const failedSong = song({
  lyricTextSource: 'user',
  lyricsRevision: 7,
  lyrics: [{ text: 'kept text', start: 0, end: 1 }],
})
library.set('song-1', failedSong)
const failedRaw = `${JSON.stringify({
  text: 'kept text',
  lines: failedSong.lyrics,
  source: 'user',
  revision: 7,
  timingMethod: 'preserved-line-times',
  rematch: { status: 'pending' },
}, null, 2)}\n`
files.set('song-1', failedRaw)
const failedDeps = store()
failedDeps.recognizeWords = async () => {
  throw new Error('whisper failed')
}
equal(await commitTimingRematch(failedDeps, 'song-1', 7), 'failed',
  'an ASR failure is reported without discarding the edit')
equal(library.get('song-1').lyrics, failedSong.lyrics, 'failed rematch retains saved timing')
equal(parseLyricsDocument(JSON.parse(files.get('song-1'))).lines[0].text, 'kept text',
  'failed rematch retains saved text')
equal(library.get('song-1').lyricRematchStatus, 'failed', 'failed rematch status is explicit')

const noWords = store()
library.set('song-1', song({
  lyricTextSource: 'user',
  lyricsRevision: 8,
  lyrics: [{ text: 'still here', start: 2, end: 4 }],
}))
files.set('song-1', `${JSON.stringify({
  text: 'still here',
  lines: library.get('song-1').lyrics,
  source: 'user',
  revision: 8,
  sourceText: true,
  timingMethod: 'preserved-line-times',
  rematch: { status: 'pending' },
}, null, 2)}\n`)
noWords.recognizeWords = async () => []
equal(await commitTimingRematch(noWords, 'song-1', 8), 'committed',
  'missing ASR words still complete honestly')
equal(parseLyricsDocument(JSON.parse(files.get('song-1'))).lines[0], { text: 'still here', start: 2, end: 4 },
  'missing ASR words retain the previous timing')

const diskRoot = path.join(root, 'reload')
await rm(diskRoot, { recursive: true, force: true })
await mkdir(diskRoot, { recursive: true })
const diskFile = path.join(diskRoot, 'lyrics.json')
const diskLibrary = path.join(diskRoot, 'library.json')
await writeFile(diskFile, files.get('song-1'), 'utf8')
await writeFile(diskLibrary, JSON.stringify([library.get('song-1')]), 'utf8')
const diskSong = JSON.parse(await readFile(diskLibrary, 'utf8'))[0]
reapplyLyricsDocument(diskSong, parseLyricsDocument(JSON.parse(await readFile(diskFile, 'utf8'))))
equal(diskSong.lyricTextSource, 'user', 'disk reload keeps manual text ownership')
equal(diskSong.lyrics[0].text, 'still here', 'disk reload keeps the saved lyric text')
const rollback = store()
library.set('song-1', song({ lyricsRevision: 1, lyricTextSource: 'engine' }))
files.set('song-1', '{"text":"old","lines":[{"text":"old","start":0,"end":1}]}\n')
const previousBytes = files.get('song-1')
rollback.writeSong = async () => {
  throw new Error('disk full')
}
await rejectsAsync(() => updateSavedLyrics(rollback, { songId: 'song-1', text: 'new line' }),
  /Lyric library save failed: disk full\. lyrics\.json was restored\./,
  'a library save failure restores lyrics.json and reports the failure')
equal(files.get('song-1'), previousBytes, 'restored lyrics.json matches the previous bytes')
equal(library.get('song-1').lyricsRevision, 1, 'a failed library save does not publish the new revision')

const failureRoot = path.join(root, 'failure-injection')
await mkdir(failureRoot, { recursive: true })
for (const point of ['first-lyric-write', 'library-write', 'all-lyric-writes', 'all-writes']) {
  const target = path.join(failureRoot, `${point}.json`)
  const retained = song({
    lyricTextSource: 'user', lyricsRevision: 20, lyricRematchStatus: 'pending',
    lyricTimingMethod: 'preserved-line-times', lyrics: [{ text: 'Привет мир!', start: 0, end: 10 }],
  })
  const originalDocument = { text: '[00:01.00]Привет мир!\r\n', lines: retained.lyrics,
    source: 'user', revision: 20, timingMethod: 'preserved-line-times', rematch: { status: 'pending' } }
  retained.lyricEditorText = originalDocument.text
  await replaceTextFile(target, JSON.stringify(originalDocument))
  library.set('song-1', retained)
  let writes = 0
  let songWrites = 0
  let published
  const diskDeps = {
    readSong: (id) => library.get(id),
    readLyrics: async () => readFile(target, 'utf8'),
    writeLyrics: async (_id, raw) => {
      writes += 1
      if ((point === 'first-lyric-write' && writes === 1) || point.startsWith('all-')) {
        throw Object.assign(new Error('injected lyric sharing violation'), { code: 'EBUSY' })
      }
      await replaceTextFile(target, raw)
    },
    writeSong: async (next) => {
      songWrites += 1
      if ((point === 'library-write' && songWrites === 1) || point === 'all-writes') {
        throw new Error('injected library failure')
      }
      library.set(next.id, structuredClone(next))
    },
    publishFailure: (failed) => {
      published = structuredClone(failed)
      library.get(failed.id).lyricRematchStatus = failed.lyricRematchStatus
      library.get(failed.id).lyricRematchMessage = failed.lyricRematchMessage
    },
    recognizeWords: async () => [{ text: 'Привет мир', start: 3, end: 5 }],
  }
  if (point.startsWith('all-')) {
    await rejectsAsync(() => commitTimingRematch(diskDeps, 'song-1', 20),
      /injected lyric sharing violation.*Failure status could not be fully persisted/,
      `${point} surfaces the original and failure-persistence errors`)
  } else {
    equal(await commitTimingRematch(diskDeps, 'song-1', 20), 'failed',
      `${point} is explicitly failed even after recognition succeeds`)
  }
  const document = JSON.parse(await readFile(target, 'utf8'))
  equal(document.text, originalDocument.text, `${point} retains exact raw text`)
  equal(document.lines, retained.lyrics, `${point} retains previous disk timing`)
  equal(library.get('song-1').lyrics, retained.lyrics, `${point} retains previous in-memory timing`)
  equal(library.get('song-1').lyricEditorText, originalDocument.text, `${point} retains exact in-memory editor text`)
  equal(library.get('song-1').lyricRematchStatus, 'failed', `${point} never strands in-memory pending status`)
  equal(published.lyricRematchStatus, 'failed', `${point} publishes failure even if persistence fails`)
  if (!point.startsWith('all-')) {
    equal(document.rematch.status, 'failed', `${point} failed status survives lyrics-file reload`)
  }
}

await rm(root, { recursive: true, force: true })

console.log(`PASS lyric update: ${checks} deterministic checks.`)
