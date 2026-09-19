import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const [fixtureArg, profileArg] = process.argv.slice(2)
if (!fixtureArg || !profileArg) {
  throw new Error('Usage: node scripts/create-processing-ui-seed.mjs <fixture> <profile>')
}

const fixture = path.resolve(fixtureArg)
const profile = path.resolve(profileArg)
await stat(fixture)
await rm(profile, { recursive: true, force: true })
await mkdir(profile, { recursive: true })

const deliverableIds = [
  'original', 'source-preparation', 'demucs', 'stem-vocals', 'stem-drums', 'stem-bass',
  'stem-other', 'instrumental', 'vocal', 'enhanced', 'whisper-transcription', 'lyrics',
]
const now = '2026-09-18T12:00:00.000Z'
const baseOutcomes = () => Object.fromEntries(deliverableIds.map((id) => [id, {
  id,
  state: 'missing',
  artifacts: [],
  updatedAt: now,
}]))
const failure = (component, message) => ({
  component,
  code: 'execution-failed',
  message,
  retryable: true,
  occurredAt: now,
})
const diagnostics = {
  standard: 'EBU R128',
  targetIntegratedLufs: -16,
  truePeakCeilingDbtp: -1.5,
  vocal: { integratedLufs: -21.8, truePeakDbtp: -4.6, loudnessRangeLu: 3.7, thresholdLufs: -31 },
  instrumental: { integratedLufs: -23.7, truePeakDbtp: -5.9, loudnessRangeLu: 4.5, thresholdLufs: -33 },
  premix: { integratedLufs: -18.3, truePeakDbtp: -2.2, loudnessRangeLu: 4.1, thresholdLufs: -29 },
  output: { integratedLufs: -16.1, truePeakDbtp: -1.6, loudnessRangeLu: 4.2, thresholdLufs: -27 },
  vocalGainDb: 1.8,
  instrumentalGainDb: 0.7,
  vocalFilters: ['highpass', 'lowpass', 'acompressor'],
  instrumentalFilters: [],
  masterFilter: 'loudnorm',
  cleanupApplied: false,
  caveat: 'Auto-balancing improves level consistency but cannot restore separation artifacts.',
}

async function createSong(id, title, failedComponent) {
  const root = path.join(profile, 'processed', id)
  const stems = path.join(root, 'stems')
  await mkdir(stems, { recursive: true })
  for (const target of [
    path.join(root, 'source.wav'),
    path.join(root, 'speech.wav'),
    path.join(stems, 'vocals.wav'),
    path.join(stems, 'drums.wav'),
    path.join(stems, 'bass.wav'),
    path.join(stems, 'other.wav'),
    path.join(root, 'instrumental.m4a'),
    path.join(root, 'vocal.m4a'),
    ...(failedComponent === 'enhanced' ? [] : [path.join(root, 'enhanced.m4a')]),
  ]) await copyFile(fixture, target)

  const transcript = failedComponent === 'lyrics'
    ? { text: '', languageCode: 'en', languageName: 'English', lines: [] }
    : {
        text: 'Fixture lyric',
        languageCode: 'en',
        languageName: 'English',
        languageSource: 'detected',
        lines: [{ text: 'Fixture lyric', start: 0, end: 1 }],
      }
  await writeFile(path.join(root, 'lyrics.json'), `${JSON.stringify(transcript, null, 2)}\n`)

  const outcomes = baseOutcomes()
  const failed = failure(
    failedComponent,
    failedComponent === 'lyrics'
      ? 'No timed lyric lines were detected.'
      : 'Final loudness validation exceeded the peak ceiling.',
  )
  outcomes[failedComponent] = {
    ...outcomes[failedComponent],
    state: 'failed',
    failure: failed,
  }
  if (failedComponent !== 'enhanced') outcomes.enhanced.diagnostics = diagnostics
  return {
    id,
    title,
    artist: 'QA Fixture',
    sourcePath: fixture,
    sourceUrl: '',
    format: 'mp3',
    addedAt: now,
    instrumentalPath: path.join(root, 'instrumental.m4a'),
    vocalPath: path.join(root, 'vocal.m4a'),
    enhancedPath: failedComponent === 'enhanced' ? undefined : path.join(root, 'enhanced.m4a'),
    lyrics: failedComponent === 'lyrics' ? [] : transcript.lines,
    lyricLanguage: {
      languageCode: 'en',
      languageName: 'English',
      languageSource: 'detected',
    },
    languageCode: 'en',
    languageName: 'English',
    languageSource: 'detected',
    processingStage: 'partial',
    processingProgress: 88,
    processingMessage: failed.message,
    deliverables: { schemaVersion: 1, outcomes },
    processingFailure: failed,
  }
}

const songs = [
  await createSong('lyrics-failure', 'Lyrics Failure Fixture', 'lyrics'),
  await createSong('enhanced-failure', 'Enhanced Failure Fixture', 'enhanced'),
]
await writeFile(path.join(profile, 'library.json'), `${JSON.stringify(songs, null, 2)}\n`)
await writeFile(path.join(profile, 'fixture-library.json'), `${JSON.stringify(songs, null, 2)}\n`)
await writeFile(path.join(profile, 'playlists.json'), `${JSON.stringify({
  schemaVersion: 1,
  selectedPlaylistId: 'queue',
  playlists: [],
}, null, 2)}\n`)

const saved = JSON.parse(await readFile(path.join(profile, 'library.json'), 'utf8'))
if (saved.length !== 2) throw new Error('Processing UI seed was not written.')
console.log(`Created processing UI profile with ${saved.length} songs at ${profile}.`)
