import assert from 'node:assert/strict'
import { ProcessingProgress } from '../dist-electron/processing-progress.js'
import {
  formatProcessingElapsed,
  mergeProcessUpdate,
  processingItemDetail,
  processingStatusLabels,
} from '../src/processingUi.ts'

function collect(tracker, updates) {
  return updates.map(([id, status, options]) => tracker.update(id, status, options))
}

const full = new ProcessingProgress('full-song', 'full', 1_000)
const queued = full.queued(3, 1_050)
assert.equal(queued.stage, 'queued')
assert.equal(queued.details.queuePosition, 3)
assert.equal(queued.details.items.every((item) => item.status === 'pending'), true)
const fullUpdates = collect(full, [
  ['original', 'complete', { now: 1_100 }],
  ['source-preparation', 'active', { progress: 20, now: 1_200 }],
  ['source-preparation', 'active', { progress: 10, now: 1_300 }],
  ['source-preparation', 'indeterminate', { now: 1_400 }],
  ['source-preparation', 'complete', { now: 1_500 }],
  ['demucs', 'active', { progress: 25, now: 1_600 }],
  ['demucs', 'active', { progress: 75, now: 1_700 }],
  ['demucs', 'complete', { now: 1_800 }],
  ['stem-vocals', 'complete', { now: 1_900 }],
  ['stem-drums', 'complete', { now: 2_000 }],
  ['stem-bass', 'complete', { now: 2_100 }],
  ['stem-other', 'complete', { now: 2_200 }],
  ['instrumental', 'complete', { now: 2_300 }],
  ['vocal', 'complete', { now: 2_400 }],
  ['enhanced', 'complete', { now: 2_500 }],
  ['whisper-model', 'complete', { now: 2_600 }],
  ['whisper-transcription', 'indeterminate', { now: 2_700 }],
  ['whisper-transcription', 'complete', { now: 2_800 }],
  ['lyrics', 'complete', { now: 2_900 }],
])
assert.equal(fullUpdates[0].details.queuePosition, undefined)

for (let index = 1; index < fullUpdates.length; index += 1) {
  assert.ok(
    fullUpdates[index].progress >= fullUpdates[index - 1].progress,
    `overall progress regressed at update ${index}`,
  )
}
assert.ok(fullUpdates.at(-1).progress < 100, 'required deliverables must not produce 100 before final commit')
const completed = full.complete('committed', 3_000)
assert.equal(completed.progress, 100)
assert.equal(completed.stage, 'complete')
assert.equal(completed.details.activeItem, undefined)
const persistenceFailure = full.fail('lyrics', 'library save failed', 3_100)
assert.equal(persistenceFailure.stage, 'error')
assert.ok(persistenceFailure.progress < 100, 'a persistence failure after completion must publish below 100')
assert.equal(
  persistenceFailure.details.items.find((item) => item.id === 'lyrics').status,
  'error',
  'a completed component must become failed when its durable commit fails',
)

const coveredIds = new Set(completed.details.items.map((item) => item.id))
for (const id of [
  'source-preparation',
  'demucs',
  'stem-vocals',
  'stem-drums',
  'stem-bass',
  'stem-other',
  'original',
  'instrumental',
  'vocal',
  'enhanced',
  'whisper-model',
  'whisper-transcription',
  'lyrics',
]) {
  assert.ok(coveredIds.has(id), `missing required progress item ${id}`)
}

const failed = new ProcessingProgress('failed-song', 'full', 4_000)
failed.update('original', 'complete', { now: 4_100 })
failed.update('source-preparation', 'complete', { now: 4_200 })
const beforeFailure = failed.update('demucs', 'active', { progress: 40, now: 4_300 })
const failure = failed.fail('demucs', 'model failed', 4_400)
assert.equal(failure.stage, 'error')
assert.equal(failure.progress, beforeFailure.progress)
assert.equal(failure.details.items.find((item) => item.id === 'demucs').error, 'model failed')

const lyrics = new ProcessingProgress('lyrics-song', 'lyrics', 5_000)
lyrics.update('source-preparation', 'complete', { now: 5_100 })
lyrics.update('whisper-model', 'indeterminate', { now: 5_200 })
const indeterminate = lyrics.update('whisper-transcription', 'indeterminate', { now: 5_300 })
const heartbeat = lyrics.heartbeat(10_300)
assert.equal(indeterminate.details.activeItem, 'whisper-transcription')
assert.equal(indeterminate.details.items.find((item) => item.id === 'whisper-transcription').progress, undefined)
assert.ok(indeterminate.details.items.find((item) => item.id === 'whisper-transcription').elapsedMs >= 0)
assert.equal(heartbeat.progress, indeterminate.progress)
assert.equal(heartbeat.details.items.find((item) => item.id === 'whisper-transcription').elapsedMs, 5_000)

const baseSong = {
  id: 'renderer-song',
  title: 'Renderer song',
  artist: 'QA',
  sourcePath: 'song.mp3',
  sourceUrl: 'karaoke://media/song.mp3',
  format: 'mp3',
  addedAt: new Date(0).toISOString(),
  lyrics: [],
  lyricLanguage: { languageCode: 'und', languageName: 'Unknown', languageSource: 'legacy' },
  languageCode: 'und',
  languageName: 'Unknown',
  languageSource: 'legacy',
  processingStage: 'idle',
  processingProgress: 0,
}
const rendererTracker = new ProcessingProgress(baseSong.id, 'full', 20_000)
const rendererFirst = rendererTracker.update('source-preparation', 'active', {
  progress: 60,
  message: 'FFmpeg processed 12.0s of 20.0s',
  now: 21_000,
})
const renderedSong = mergeProcessUpdate(baseSong, rendererFirst)
const stale = structuredClone(rendererFirst)
stale.progress = 2
stale.details.updatedAt = new Date(20_500).toISOString()
const staleResult = mergeProcessUpdate(renderedSong, stale)
assert.equal(staleResult, renderedSong, 'renderer must reject an older event from the same processing run')

const sameRunRegression = structuredClone(rendererFirst)
sameRunRegression.progress = 1
sameRunRegression.details.updatedAt = new Date(21_500).toISOString()
assert.equal(
  mergeProcessUpdate(renderedSong, sameRunRegression).processingProgress,
  rendererFirst.progress,
  'renderer must not visually regress overall progress within one run',
)

const retryTracker = new ProcessingProgress(baseSong.id, 'full', 30_000)
const retry = retryTracker.update('source-preparation', 'active', {
  progress: 0,
  message: 'Preparing studio-quality separation audio',
  now: 30_100,
})
const retrySong = mergeProcessUpdate(renderedSong, retry)
assert.equal(
  retrySong.processingProgress,
  retry.progress,
  'a newer processing run may reset its own progress',
)
assert.equal(
  mergeProcessUpdate(retrySong, rendererFirst),
  retrySong,
  'a late event from an older processing run must be ignored',
)

const activeItem = rendererFirst.details.items.find((item) => item.id === 'source-preparation')
assert.match(processingItemDetail(activeItem), /12\.0s of 20\.0s · 60%/)
assert.equal(processingStatusLabels.pending, 'Queued')
assert.equal(processingStatusLabels.error, 'Failed')
assert.equal(formatProcessingElapsed(125_000), '2m 05s elapsed')
assert.match(
  processingItemDetail(heartbeat.details.items.find((item) => item.id === 'whisper-transcription')),
  /5s elapsed/,
)

console.log('PASS processing progress: backend contract and renderer monotonic/status presentation.')
