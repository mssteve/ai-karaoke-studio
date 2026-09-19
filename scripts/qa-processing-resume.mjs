import assert from 'node:assert/strict'
import {
  blockedByFailure,
  componentFailure,
  computeRetryPlan,
  createDeliverableStore,
  deliverableIds,
  normalizeComponentFailure,
  computeMergedRetryPlan,
  normalizeDeliverableStore,
  reconcileArtifactOutcome,
} from '../dist-electron/processing-domain.js'
import { ProcessingProgress } from '../dist-electron/processing-progress.js'
import { ProcessingScheduler } from '../dist-electron/processing-scheduler.js'
import { mergeProcessUpdate } from '../src/processingUi.ts'

let checks = 0
const check = (condition, message) => {
  assert.ok(condition, message)
  checks += 1
}
const equal = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks += 1
}

const allReady = new Set(deliverableIds)
equal(
  computeRetryPlan('lyrics', allReady),
  ['whisper-transcription', 'lyrics'],
  'lyrics retry must reuse audio and rerun only transcription/finalization',
)
equal(computeRetryPlan('enhanced', allReady), ['enhanced'], 'enhanced retry must be isolated')
equal(
  computeMergedRetryPlan(['lyrics', 'enhanced'], allReady),
  ['enhanced', 'whisper-transcription', 'lyrics'],
  'same-song component requests must merge into one dependency-ordered plan',
)
equal(
  computeRetryPlan('stem-vocals', allReady),
  [
    'demucs', 'stem-vocals', 'stem-drums', 'stem-bass', 'stem-other',
    'instrumental', 'vocal', 'enhanced', 'whisper-transcription', 'lyrics',
  ],
  'a bad stem must rerun separation and affected descendants',
)
equal(
  computeRetryPlan('source-preparation', allReady),
  [
    'source-preparation', 'demucs', 'stem-vocals', 'stem-drums', 'stem-bass',
    'stem-other', 'instrumental', 'vocal', 'enhanced', 'whisper-transcription', 'lyrics',
  ],
  'source preparation retry must rebuild its dependent chain',
)

const withoutVocal = new Set([...allReady].filter((id) => id !== 'vocal'))
equal(
  computeRetryPlan('lyrics', withoutVocal),
  ['vocal', 'enhanced', 'whisper-transcription', 'lyrics'],
  'lyrics retry must rebuild only a missing vocal dependency and affected outputs',
)

const legacy = normalizeDeliverableStore(undefined, 1_000)
check(deliverableIds.every((id) => legacy.outcomes[id].state === 'missing'),
  'legacy songs must receive a complete missing-state store')
equal(normalizeComponentFailure({ component: 'unknown' }), undefined,
  'malformed legacy failure metadata must be discarded')

const artifact = {
  path: 'C:\\media\\vocal.m4a',
  size: 1234,
  modifiedAt: 42,
  validatedAt: new Date(2_000).toISOString(),
}
const valid = reconcileArtifactOutcome(legacy.outcomes.vocal, [artifact], 2_000)
equal(valid.state, 'ready', 'freshly validated artifacts must become ready')
equal(valid.artifacts, [artifact], 'validated fingerprints must persist')

const invalid = reconcileArtifactOutcome(valid, undefined, 3_000)
equal(invalid.state, 'failed', 'stale ready metadata must be invalidated when the artifact is absent')
equal(invalid.failure?.code, 'invalid-artifact', 'artifact invalidation must be precise')
const preserved = createDeliverableStore(3_100)
preserved.outcomes.vocal = { ...valid, id: 'vocal' }
preserved.outcomes.enhanced = { ...invalid, id: 'enhanced' }
equal(preserved.outcomes.vocal.state, 'ready',
  'invalidating enhanced output must preserve its valid vocal dependency')
equal(
  computeRetryPlan('enhanced', new Set(['original', 'source-preparation', 'demucs',
    'stem-vocals', 'stem-drums', 'stem-bass', 'stem-other', 'instrumental', 'vocal'])),
  ['enhanced'],
  'retry planning must stop at valid dependency boundaries',
)

const persisted = createDeliverableStore(4_000)
persisted.outcomes.original = reconcileArtifactOutcome(persisted.outcomes.original, [artifact], 4_100)
persisted.outcomes.vocal = reconcileArtifactOutcome(persisted.outcomes.vocal, [artifact], 4_200)
persisted.outcomes.lyrics = {
  ...persisted.outcomes.lyrics,
  state: 'failed',
  failure: componentFailure('lyrics', 'Whisper returned no lines', {}, 4_300),
}
const restarted = normalizeDeliverableStore(JSON.parse(JSON.stringify(persisted)), 5_000)
equal(restarted.outcomes.original.state, 'ready', 'partial success must survive restart')
equal(restarted.outcomes.vocal.state, 'ready', 'playable vocal state must survive restart')
equal(restarted.outcomes.lyrics.failure?.component, 'lyrics', 'exact failure must survive restart')
equal(componentFailure('whisper-transcription', 'model load failed').component, 'whisper-transcription',
  'Whisper model-loading failures must normalize to the retryable transcription deliverable')
equal(componentFailure('stem-other', 'missing stem').component, 'stem-other',
  'missing Demucs stems must retain their exact component')

const partialSong = {
  id: 'partial',
  title: 'Partial',
  artist: 'QA',
  sourcePath: 'C:\\music\\source.mp3',
  sourceUrl: 'karaoke://media/partial/original',
  format: 'mp3',
  addedAt: new Date(0).toISOString(),
  instrumentalPath: 'C:\\processed\\instrumental.m4a',
  instrumentalUrl: 'karaoke://media/partial/instrumental',
  vocalPath: 'C:\\processed\\vocal.m4a',
  vocalUrl: 'karaoke://media/partial/vocal',
  lyrics: [],
  lyricLanguage: { languageCode: 'und', languageName: 'Unknown', languageSource: 'legacy' },
  languageCode: 'und',
  languageName: 'Unknown',
  languageSource: 'legacy',
  processingStage: 'enhancing',
  processingProgress: 80,
  deliverables: persisted,
}
const failedUpdate = {
  songId: partialSong.id,
  stage: 'error',
  progress: 80,
  message: 'Enhanced mix failed',
  failure: componentFailure('enhanced', 'Enhanced mix failed'),
  song: { ...partialSong, processingStage: 'error', processingMessage: 'Enhanced mix failed' },
}
const partialAfterFailure = mergeProcessUpdate(partialSong, failedUpdate)
equal(partialAfterFailure.instrumentalUrl, partialSong.instrumentalUrl,
  'a later failure must not hide a playable instrumental output')
equal(partialAfterFailure.vocalUrl, partialSong.vocalUrl,
  'a later failure must not hide a playable vocal output')

const stemPlan = computeRetryPlan('stem-bass', allReady)
const blocked = blockedByFailure(stemPlan, 'demucs')
equal(blocked['stem-bass'], ['demucs'], 'failed separation must block the requested stem')
check(blocked.instrumental?.includes('stem-bass'), 'blocked stems must propagate to instrumental')
check(blocked.enhanced?.includes('instrumental'), 'blocked instrumental must propagate to enhanced')
check(blocked.lyrics?.includes('whisper-transcription'), 'blocked transcription must propagate to lyrics')

const tracker = new ProcessingProgress('song', 'retry', 10_000)
for (const id of [
  'original', 'source-preparation', 'demucs', 'stem-vocals', 'stem-drums',
  'stem-bass', 'stem-other', 'instrumental', 'vocal', 'enhanced',
  'whisper-model', 'whisper-transcription', 'lyrics',
]) {
  tracker.update(id, 'complete', { now: 10_100 })
}
check(tracker.snapshot().progress < 100, 'progress must remain below 100 before persistence commit')
equal(tracker.complete('committed', 10_200).progress, 100, 'progress reaches 100 only at final commit')

const scheduler = new ProcessingScheduler(1)
let release
let starts = 0
const first = scheduler.enqueue({
  key: 'song:lyrics',
  run: async () => {
    starts += 1
    await new Promise((resolve) => { release = resolve })
    return 'done'
  },
})
const duplicate = scheduler.enqueue({
  key: 'song:lyrics',
  run: async () => {
    starts += 100
    return 'wrong'
  },
})
equal(first, duplicate, 'duplicate component retries must coalesce')
await new Promise((resolve) => setImmediate(resolve))
equal(starts, 1, 'only one duplicate retry may enter the FIFO slot')
release()
equal(await first, 'done', 'coalesced retry must resolve normally')

console.log(`PASS resumable processing: ${checks} deterministic checks.`)
