import assert from 'node:assert/strict'
import {
  claimRetry,
  deliverableIssues,
  enhancedSummary,
  modeAvailability,
  retryActivity,
} from '../src/processingUx.ts'

let checks = 0
function equal(actual, expected, message) {
  assert.deepEqual(actual, expected, message)
  checks += 1
}
function check(value, message) {
  assert.ok(value, message)
  checks += 1
}

const ids = [
  'original', 'source-preparation', 'demucs', 'stem-vocals', 'stem-drums', 'stem-bass',
  'stem-other', 'instrumental', 'vocal', 'enhanced', 'whisper-transcription', 'lyrics',
]
const outcomes = Object.fromEntries(ids.map((id) => [id, {
  id,
  state: 'ready',
  artifacts: [],
  updatedAt: '2026-09-18T00:00:00.000Z',
}]))
outcomes.enhanced = {
  ...outcomes.enhanced,
  state: 'failed',
  failure: {
    component: 'enhanced',
    code: 'execution-failed',
    message: 'Final loudness validation exceeded the peak ceiling.',
    retryable: true,
    occurredAt: '2026-09-18T00:00:01.000Z',
  },
}
outcomes.lyrics = {
  ...outcomes.lyrics,
  state: 'blocked',
  blockedBy: ['whisper-transcription'],
}
const song = {
  id: 'partial-song',
  title: 'Partial song',
  artist: 'QA',
  sourcePath: 'song.mp3',
  sourceUrl: 'karaoke://media/song/original',
  instrumentalUrl: 'karaoke://media/song/instrumental',
  vocalUrl: 'karaoke://media/song/vocal',
  lyrics: [],
  lyricLanguage: { languageCode: 'und', languageName: 'Unknown', languageSource: 'legacy' },
  languageCode: 'und',
  languageName: 'Unknown',
  languageSource: 'legacy',
  format: 'mp3',
  addedAt: '2026-09-18T00:00:00.000Z',
  processingStage: 'partial',
  processingProgress: 82,
  deliverables: { schemaVersion: 1, outcomes },
}

const issues = deliverableIssues(song)
equal(issues.length, 2, 'failed and blocked outcomes are both visible')
equal(issues[0].component, 'enhanced', 'the exact failed component is retained')
equal(issues[0].reason, 'Final loudness validation exceeded the peak ceiling.',
  'the concise backend failure reason is retained')
equal(issues[0].retryable, true, 'retryability follows backend metadata')
equal(issues[1].state, 'blocked', 'dependency-blocked work is distinct from failure')
check(issues[1].reason.includes('Lyrics transcription'), 'blocked reason names its dependency')

equal(modeAvailability(song, 'original').available, true, 'Original remains available')
equal(modeAvailability(song, 'instrumental').available, true, 'Instrumental remains available')
equal(modeAvailability(song, 'vocal').available, true, 'Vocal remains available')
equal(modeAvailability(song, 'enhanced').available, false, 'only failed Enhanced is unavailable')
check(modeAvailability(song, 'enhanced').reason.includes('peak ceiling'),
  'disabled mode exposes its exact reason')

const lyricsOnly = structuredClone(song)
lyricsOnly.enhancedUrl = 'karaoke://media/song/enhanced'
lyricsOnly.deliverables.outcomes.enhanced = {
  ...outcomes.original,
  id: 'enhanced',
  diagnostics: {
    standard: 'EBU R128',
    targetIntegratedLufs: -16,
    truePeakCeilingDbtp: -1.5,
    vocal: { integratedLufs: -22, truePeakDbtp: -5, loudnessRangeLu: 4, thresholdLufs: -31 },
    instrumental: { integratedLufs: -24, truePeakDbtp: -6, loudnessRangeLu: 5, thresholdLufs: -32 },
    premix: { integratedLufs: -18, truePeakDbtp: -2, loudnessRangeLu: 5, thresholdLufs: -28 },
    output: { integratedLufs: -16.1, truePeakDbtp: -1.6, loudnessRangeLu: 5, thresholdLufs: -26 },
    vocalGainDb: 2,
    instrumentalGainDb: 1,
    vocalFilters: ['highpass'],
    instrumentalFilters: [],
    masterFilter: 'loudnorm',
    cleanupApplied: false,
    caveat: 'Loudness balancing does not remove separation artifacts.',
  },
}
lyricsOnly.deliverables.outcomes.lyrics = {
  ...outcomes.lyrics,
  state: 'failed',
  blockedBy: undefined,
  failure: {
    component: 'lyrics',
    code: 'execution-failed',
    message: 'No timed lyric lines were detected.',
    retryable: true,
    occurredAt: '2026-09-18T00:00:02.000Z',
  },
}
equal(modeAvailability(lyricsOnly, 'enhanced').available, true,
  'a lyrics-only failure does not disable Enhanced audio')
equal(deliverableIssues(lyricsOnly).find((issue) => issue.component === 'lyrics')?.retryable, true,
  'lyrics expose their own retry action')
const summary = enhancedSummary(lyricsOnly)
check(summary.measurements.includes('-16.1 LUFS'), 'Enhanced summary exposes measured output')
check(summary.adjustments.includes('Vocal +2.0 dB'), 'Enhanced summary exposes applied adjustment')
check(summary.caveat.includes('does not remove'), 'Enhanced summary preserves honest caveat')

const pending = new Set()
equal(claimRetry(pending, song.id, 'enhanced'), true, 'first retry click is accepted')
equal(claimRetry(pending, song.id, 'enhanced'), false, 'duplicate retry click is coalesced')
equal(claimRetry(pending, song.id, 'lyrics'), true, 'a distinct component retry remains independent')
equal(retryActivity(song, 'enhanced', true), 'Requesting…', 'locally pending retry is disabled')
song.processingStage = 'queued'
song.processingDetails = {
  schemaVersion: 1,
  operation: 'retry',
  queuePosition: 2,
  startedAt: '2026-09-18T00:00:03.000Z',
  updatedAt: '2026-09-18T00:00:03.000Z',
  items: [],
}
equal(retryActivity(song, 'enhanced', false), 'Queued #2', 'targeted retry shows FIFO position')

console.log(`PASS processing UI: ${checks} deterministic checks.`)
