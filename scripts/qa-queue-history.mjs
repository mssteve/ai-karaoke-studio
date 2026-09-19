import { spawn } from 'node:child_process'
import { copyFile, cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { sendCommand } from './control.mjs'

const [appArg, entryArg, profileArg, outputArg] = process.argv.slice(2)
if (!appArg || !entryArg || !profileArg || !outputArg) {
  throw new Error('Usage: node scripts/qa-queue-history.mjs <electron.exe> <main.js> <profile> <output>')
}

const executable = path.resolve(appArg)
const entry = path.resolve(entryArg)
const sourceProfile = path.resolve(profileArg)
const output = path.resolve(outputArg)
const profile = path.join(output, 'profile')
const cases = []
const screenshots = []
let child

function record(id, passed, evidence, details) {
  cases.push({ id, status: passed ? 'passed' : 'failed', evidence, details })
  console.log(`${passed ? 'PASS' : 'FAIL'} ${id}: ${evidence}`)
}

async function waitFor(check, description, timeoutMs = 12_000) {
  const started = Date.now()
  let lastError
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await check()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await delay(100)
  }
  throw new Error(`${description} not observed${lastError ? `: ${lastError.message}` : ''}`)
}

const ui = (uiAction, selector, uiValue) =>
  sendCommand({ action: 'ui', uiAction, selector, uiValue })
const click = (selector) => ui('click', selector)
const snapshot = (selector) => ui('snapshot', selector)
const exists = (selector) => ui('exists', selector)
const status = () => sendCommand({ action: 'status' })
const playlists = (value) => value.playlists.playlists
const playlist = (value, id) => playlists(value).find((item) => item.id === id)
const songIds = (value, id) => playlist(value, id)?.entries.map((item) => item.songId) ?? []

async function screenshot(name) {
  const destination = path.join(output, `${name}.png`)
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const result = await sendCommand({ action: 'screenshot' })
    await copyFile(result.path, destination)
    const bytes = (await stat(destination)).size
    if (bytes) {
      screenshots.push({ name, path: destination, bytes })
      return
    }
    await delay(250)
  }
  throw new Error(`Screenshot ${name} was empty after 5 attempts`)
}

async function start() {
  child = spawn(executable, [entry, `--user-data-dir=${profile}`, '--enable-private-automation'], {
    cwd: path.dirname(executable),
    stdio: 'ignore',
  })
  const value = await waitFor(() => sendCommand({ action: 'status' }, { timeoutMs: 750 }),
    'application startup', 30_000)
  await waitFor(async () => (await exists('[data-testid="nav-library"]')).exists,
    'renderer initialization', 30_000)
  return value
}

async function stop() {
  if (!child || child.exitCode !== null) return
  child.kill()
  await waitFor(() => child.exitCode !== null, 'application shutdown', 8_000).catch(() => undefined)
  child = undefined
}

async function openMenu(songId) {
  await click('[data-testid="nav-library"]')
  await waitFor(async () => (await exists(`[data-testid="song-menu-${songId}"]`)).exists,
    `Library song control ${songId}`)
  await click(`[data-testid="song-menu-${songId}"]`)
  await delay(300)
}

async function addSong(songId, playlistId) {
  await openMenu(songId)
  await click(`[data-testid="add-to-playlist-${playlistId}"]`)
  return waitFor(async () => {
    const value = await status()
    return songIds(value, playlistId).at(-1) === songId ? value : undefined
  }, `song insertion into ${playlistId}`)
}

async function selectPlaylist(id) {
  await click('[data-testid="nav-playlists"]')
  await click(`[data-testid="playlist-${id}"]`)
  return waitFor(async () => {
    const value = await status()
    return value.playlists.selectedPlaylistId === id ? value : undefined
  }, `playlist ${id} selection`)
}

async function selectEntry(entry) {
  await click(`[data-testid="playlist-entry-${entry.id}"]`)
  return waitFor(async () => {
    const value = await status()
    return value.playlists.currentEntryId === entry.id ? value : undefined
  }, `entry ${entry.id} selection`)
}

async function seekNearEnd() {
  const media = await waitFor(async () => {
    const value = await snapshot('audio')
    return value.media?.duration > 1 ? value.media : undefined
  }, 'media duration')
  await ui('set-value', '[data-testid="playback-seek"]', String(Math.max(0, media.duration - 1.5)))
  await delay(300)
  const toggle = await snapshot('[data-testid="playback-toggle"]')
  if (toggle.ariaLabel === 'Play') await click('[data-testid="playback-toggle"]')
}

async function main() {
  await rm(output, { recursive: true, force: true })
  await mkdir(output, { recursive: true })
  await cp(sourceProfile, profile, { recursive: true, force: true })
  const library = JSON.parse(await readFile(path.join(profile, 'library.json'), 'utf8'))
  const songs = library.slice(0, 2)
  if (songs.length !== 2) throw new Error('Two songs are required')
  const now = new Date().toISOString()
  await writeFile(path.join(profile, 'playlists.json'), JSON.stringify({
    schemaVersion: 1,
    selectedPlaylistId: 'queue',
    playlists: [
      { id: 'queue', name: 'Queue', kind: 'queue', entries: [], createdAt: now, updatedAt: now },
      { id: 'legacy-user', name: 'Legacy User', kind: 'playlist', entries: [], createdAt: now, updatedAt: now },
    ],
  }, null, 2))

  try {
    let value = await start()
    const initialKinds = playlists(value).map((item) => `${item.id}:${item.kind}`)
    record('history-migration', initialKinds.length === 3
      && initialKinds.includes('history:history')
      && initialKinds.includes('queue:queue') && initialKinds.includes('legacy-user:playlist')
      && playlist(value, 'queue').entries.length === 0
      && playlist(value, 'history').entries.length === 0
      && playlist(value, 'legacy-user').entries.length === 0,
    `Loaded ${initialKinds.join(', ')} from a store without History.`)

    const previous = await snapshot('[data-testid="playback-previous"]')
    const play = await snapshot('[data-testid="playback-toggle"]')
    const next = await snapshot('[data-testid="playback-next"]')
    record('playback-control-placement', previous.ariaLabel === 'Previous song'
      && play.ariaLabel === 'Play' && next.ariaLabel === 'Next song',
    `Rendered footer controls are ordered Previous (${previous.ariaLabel}), Play (${play.ariaLabel}), Next (${next.ariaLabel}).`)

    await openMenu(songs[0].id)
    const menu = await snapshot('[role="menu"]')
    await screenshot('plus-menu-rendered')
    await click('[data-testid="add-to-playlist-queue"]')
    value = await waitFor(async () => songIds(await status(), 'queue').length === 1 ? status() : undefined,
      'first Queue insertion')
    await addSong(songs[1].id, 'queue')
    await addSong(songs[0].id, 'legacy-user')
    record('ordinary-target-insertion', menu.text.includes('Queue')
      && menu.text.includes('Legacy User')
      && menu.text.includes('New playlist')
      && !menu.text.includes('History')
      && songIds(await status(), 'queue').join(',') === `${songs[0].id},${songs[1].id}`
      && songIds(await status(), 'legacy-user').join(',') === songs[0].id,
    'Rendered plus menu omitted History and insertion succeeded for Queue and the migrated user playlist.')

    value = await selectPlaylist('queue')
    const first = playlist(value, 'queue').entries[0]
    const second = playlist(value, 'queue').entries[1]
    await selectEntry(first)
    await seekNearEnd()
    const advanced = await waitFor(async () => {
      const candidate = await status()
      return candidate.playlists.currentEntryId === second.id
        && candidate.playback?.status === 'playing'
        && candidate.playback?.currentTime < 2
        && songIds(candidate, 'history')[0] === first.songId
        && playlist(candidate, 'history').entries[0]?.id === first.id
        && !playlist(candidate, 'queue').entries.some((item) => item.id === first.id)
        ? candidate : undefined
    }, 'natural Queue archival and advance', 15_000)
    record('natural-end-atomic-history', songIds(advanced, 'queue').join(',') === second.songId
      && songIds(advanced, 'history').join(',') === first.songId,
    'Natural completion removed the first Queue entry, prepended it to History, and auto-played the next Queue entry.')

    await click('[data-testid="playback-next"]')
    value = await waitFor(async () => {
      const candidate = await status()
      return playlist(candidate, 'queue').entries.length === 0
        && songIds(candidate, 'history').join(',') === `${second.songId},${first.songId}`
        && playlist(candidate, 'history').entries[0]?.id === second.id
        && playlist(candidate, 'history').entries.filter((item) => item.id === second.id).length === 1
        ? candidate : undefined
    }, 'manual Next archival')
    record('next-atomic-history', true,
      'Next removed the active Queue entry and prepended it to newest-first History.')

    await addSong(songs[0].id, 'queue')
    value = await selectPlaylist('history')
    const newest = playlist(value, 'history').entries[0]
    const older = playlist(value, 'history').entries[1]
    await selectEntry(newest)
    await click('[data-testid="playback-previous"]')
    const olderState = await waitFor(async () => {
      const candidate = await status()
      return candidate.playlists.currentEntryId === older.id ? candidate : undefined
    }, 'History Previous navigation')
    await click('[data-testid="playback-next"]')
    const newerState = await waitFor(async () => {
      const candidate = await status()
      return candidate.playlists.currentEntryId === newest.id ? candidate : undefined
    }, 'History Next navigation')
    await click('[data-testid="playback-next"]')
    const queueState = await waitFor(async () => {
      const candidate = await status()
      return candidate.playlists.activePlaylistId === 'queue'
        && candidate.playlists.currentEntryId === playlist(candidate, 'queue').entries[0]?.id ? candidate : undefined
    }, 'History to Queue navigation')
    record('queue-history-navigation', olderState.playlists.activePlaylistId === 'history'
      && newerState.playlists.activePlaylistId === 'history'
      && queueState.playlists.activePlaylistId === 'queue',
    'Previous moved to older History, Next moved to newer History, and Next from newest History returned to Queue.')
    await screenshot('history-navigation')

    const beforeRestart = await status()
    await stop()
    value = await start()
    record('history-persistence', songIds(value, 'history').join(',') === songIds(beforeRestart, 'history').join(',')
      && songIds(value, 'queue').join(',') === songIds(beforeRestart, 'queue').join(','),
    `Restart preserved History (${songIds(value, 'history').length}) and Queue (${songIds(value, 'queue').length}) entries.`)

    const diagnostics = await sendCommand({ action: 'diagnostics' })
    record('renderer-clean', diagnostics.rendererErrorCount === 0,
      `Runtime recorded ${diagnostics.rendererErrorCount} renderer errors.`, diagnostics.rendererErrors)
  } finally {
    await stop()
  }

  const passed = cases.filter((item) => item.status === 'passed').length
  const report = {
    verdict: passed === cases.length ? 'APPROVE' : 'REJECT',
    generatedAt: new Date().toISOString(),
    executable,
    electronEntry: entry,
    isolatedProfile: profile,
    cases,
    screenshots,
  }
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2))
  console.log(`${report.verdict}: ${passed}/${cases.length} gates passed.`)
  if (report.verdict !== 'APPROVE') process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
