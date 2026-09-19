import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

const [fixtureArg, profileArg] = process.argv.slice(2)
if (!fixtureArg || !profileArg) {
  throw new Error('Usage: node scripts/create-queue-history-seed.mjs <fixture-directory> <profile-directory>')
}

const fixtureRoot = path.resolve(fixtureArg)
const profileRoot = path.resolve(profileArg)
const sources = [
  {
    id: 'queue-history-fixture-audio',
    title: 'Queue History Audio Fixture',
    format: 'mp3',
    sourcePath: path.join(fixtureRoot, 'qa-tone.mp3'),
  },
  {
    id: 'queue-history-fixture-video',
    title: 'Queue History Video Fixture',
    format: 'mp4',
    sourcePath: path.join(fixtureRoot, 'qa-video.mp4'),
  },
]

for (const source of sources) await access(source.sourcePath)
await rm(profileRoot, { recursive: true, force: true })
await mkdir(profileRoot, { recursive: true })

const songs = sources.map((source, index) => ({
  ...source,
  artist: 'QA Fixture',
  sourceUrl: '',
  addedAt: `2026-01-01T00:00:0${index}.000Z`,
  lyrics: [],
  lyricLanguage: {
    languageCode: 'und',
    languageName: 'Unknown',
    languageSource: 'legacy',
  },
  languageCode: 'und',
  languageName: 'Unknown',
  languageSource: 'legacy',
  processingStage: 'idle',
  processingProgress: 0,
}))

await writeFile(path.join(profileRoot, 'library.json'), `${JSON.stringify(songs, null, 2)}\n`)
await writeFile(path.join(profileRoot, 'playlists.json'), `${JSON.stringify({
  schemaVersion: 1,
  selectedPlaylistId: 'queue',
  playlists: [],
}, null, 2)}\n`)

const check = JSON.parse(await readFile(path.join(profileRoot, 'library.json'), 'utf8'))
if (check.length !== 2) throw new Error('Queue/History seed did not contain two songs.')
process.stdout.write(`${JSON.stringify({ fixtureRoot, profileRoot, songs: check.map(({ id, sourcePath }) => ({ id, sourcePath })) }, null, 2)}\n`)
