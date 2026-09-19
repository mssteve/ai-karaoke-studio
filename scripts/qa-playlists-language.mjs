import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { cp, copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { sendCommand } from './control.mjs'

const execFileAsync = promisify(execFile)
const args = parseArgs(process.argv.slice(2))
const executable = path.resolve(args.app)
const sourceProfile = path.resolve(args.profile)
const outputRoot = path.resolve(args.output)
const profile = path.join(outputRoot, 'profile')
const libraryPath = path.join(profile, 'library.json')
const logPath = path.join(profile, 'logs', 'karaoke-studio.log')
const cases = []
const screenshots = []
let child
let testedPid
let logOffset = 0

function parseArgs(values) {
  const parsed = {}
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (value === '--app') parsed.app = values[++index]
    else if (value === '--electron-entry') parsed.electronEntry = values[++index]
    else if (value === '--profile') parsed.profile = values[++index]
    else if (value === '--output') parsed.output = values[++index]
    else throw new Error(`Unknown argument: ${value}`)
  }
  if (!parsed.app || !parsed.profile || !parsed.output) {
    throw new Error('--app, --profile, and --output are required.')
  }
  return parsed
}

function record(id, passed, evidence, details) {
  cases.push({ id, status: passed ? 'passed' : 'failed', evidence, details })
  console.log(`${passed ? 'PASS' : 'FAIL'} ${id}: ${evidence}`)
}

async function attempt(id, run) {
  try {
    await run()
  } catch (error) {
    record(id, false, error instanceof Error ? error.message : String(error))
  }
}

async function waitFor(check, description, timeoutMs = 10_000) {
  const started = Date.now()
  let lastError
  while (Date.now() - started < timeoutMs) {
    try {
      const result = await check()
      if (result) return result
    } catch (error) {
      lastError = error
    }
    await delay(75)
  }
  throw new Error(`${description} not observed${lastError ? `: ${lastError.message}` : ''}.`)
}

function ui(uiAction, selector, uiValue) {
  return sendCommand({ action: 'ui', uiAction, selector, uiValue })
}

function snapshot(selector) {
  return ui('snapshot', selector)
}

function clickTestId(id) {
  return ui('click', `[data-testid="${id}"]`)
}

async function screenshot(name) {
  await delay(250)
  let destination
  for (let attemptIndex = 0; attemptIndex < 3; attemptIndex += 1) {
    const result = await sendCommand({ action: 'screenshot' })
    destination = path.join(outputRoot, `${name}${path.extname(result.path) || '.png'}`)
    await copyFile(result.path, destination)
    if ((await stat(destination)).size > 0) {
      screenshots.push({ name, path: destination })
      return
    }
    await delay(500)
  }
  throw new Error(`Screenshot ${name} was empty after three attempts.`)
}

async function status() {
  return sendCommand({ action: 'status' })
}

function playlistState(value) {
  const root = value.playlistState ?? value.playlists ?? value.playlist ?? {}
  const store = root.store ?? root
  const playlists = Array.isArray(store.playlists) ? store.playlists : []
  return {
    ...root,
    selectedPlaylistId: root.selectedPlaylistId ?? store.selectedPlaylistId,
    playlists,
  }
}

function getPlaylist(value, id) {
  return playlistState(value).playlists.find((playlist) => playlist.id === id)
}

function entryIds(playlist) {
  return (playlist?.entries ?? []).map((entry) => entry.id)
}

function songIds(playlist) {
  return (playlist?.entries ?? []).map((entry) => entry.songId)
}

function playback(value) {
  return value.playback ?? {}
}

function selectedSongId(value) {
  return playback(value).songId ?? value.selectedSongId
}

function currentTime(value) {
  return Number(playback(value).currentTime ?? 0)
}

function currentEntryId(value) {
  const state = playlistState(value)
  return state.currentEntryId
    ?? getPlaylist(value, state.selectedPlaylistId)?.currentEntryId
    ?? playback(value).playlistEntryId
}

function transitionReason(value) {
  const state = playlistState(value)
  return state.transitionReason ?? state.lastTransitionReason ?? playback(value).transitionReason
}

function queueRevision(value) {
  const state = playlistState(value)
  return Number(state.queueRevision ?? state.revision ?? 0)
}

function transitionCount(value) {
  const state = playlistState(value)
  return Number(state.transitionCount ?? playback(value).playlist?.transitionCount ?? 0)
}

function lyricLanguage(value) {
  const state = playlistState(value)
  return state.lyricLanguage ?? playback(value).lyricLanguage ?? {
    languageCode: playback(value).languageCode,
    languageName: playback(value).languageName,
    songId: playback(value).lyricSongId ?? playback(value).songId,
  }
}

async function position() {
  const value = await status()
  if (Number.isFinite(playback(value).currentTime)) return currentTime(value)
  return Number((await snapshot('[data-testid="playback-seek"]')).value)
}

async function duration() {
  const value = await status()
  if (Number.isFinite(playback(value).duration) && playback(value).duration > 0) {
    return Number(playback(value).duration)
  }
  const text = (await snapshot('.timeline span:last-child')).text
  const [minutes, seconds] = text.split(':').map(Number)
  return minutes * 60 + seconds
}

async function setPlaying(playing) {
  const label = playing ? 'Pause' : 'Play'
  const toggle = await snapshot('[data-testid="playback-toggle"]')
  if (toggle.ariaLabel !== label) await clickTestId('playback-toggle')
  return waitFor(async () => {
    const state = await snapshot('[data-testid="playback-toggle"]')
    return state.ariaLabel === label ? state : undefined
  }, `${label} playback control`)
}

async function setMode(mode) {
  await waitFor(async () => {
    const button = await snapshot(`[data-testid="mode-${mode}"]`)
    return !button.disabled ? button : undefined
  }, `${mode} mode control enabled`)
  await clickTestId(`mode-${mode}`)
  await waitFor(async () => {
    const button = await snapshot(`[data-testid="mode-${mode}"]`)
    return button.className.includes('active') ? button : undefined
  }, `${mode} mode control active`)
  return waitFor(async () => {
    const value = await status()
    return playback(value).mode === mode ? value : undefined
  }, `${mode} playback mode`)
}

async function seek(seconds) {
  await ui('set-value', '[data-testid="playback-seek"]', String(seconds))
  return waitFor(async () => {
    const actual = await position()
    return Math.abs(actual - seconds) <= 0.35 ? { actual } : undefined
  }, `seek to ${seconds.toFixed(2)} seconds`, 4_000)
}

async function selectLibrarySong(songId) {
  await clickTestId('nav-library')
  await ui('click', `[data-testid="song-row"][data-song-id="${songId}"]`)
  return waitFor(async () => {
    const value = await status()
    return selectedSongId(value) === songId ? value : undefined
  }, `library song ${songId}`)
}

async function openSongMenu(songId) {
  await clickTestId(`song-menu-${songId}`)
  return waitFor(
    () => snapshot('[role="menu"]'),
    `song menu for ${songId}`,
  )
}

async function addSongToPlaylist(songId, playlistId) {
  await clickTestId('nav-library')
  await openSongMenu(songId)
  await clickTestId(`add-to-playlist-${playlistId}`)
  return waitFor(async () => {
    const value = await status()
    const playlist = getPlaylist(value, playlistId)
    return songIds(playlist).at(-1) === songId ? value : undefined
  }, `song appended to ${playlistId}`)
}

async function createPlaylistForSong(songId, name) {
  await clickTestId('nav-library')
  await openSongMenu(songId)
  await clickTestId('new-playlist')
  await ui('set-value', '[data-testid="playlist-name"]', name)
  await clickTestId('playlist-create-confirm')
  return waitFor(async () => {
    const value = await status()
    const playlist = playlistState(value).playlists.find((candidate) => candidate.name === name)
    return playlist && songIds(playlist).at(-1) === songId ? { value, playlist } : undefined
  }, `playlist ${name} creation`)
}

async function selectPlaylistView(playlistId) {
  await clickTestId('nav-playlists')
  await clickTestId(`playlist-${playlistId}`)
  return waitFor(async () => {
    const value = await status()
    return playlistState(value).selectedPlaylistId === playlistId ? value : undefined
  }, `playlist ${playlistId} view`)
}

async function selectPlaylistEntry(entryId, songId) {
  await clickTestId(`playlist-entry-${entryId}`)
  const selected = await waitFor(async () => {
    const value = await status()
    return currentEntryId(value) === entryId && selectedSongId(value) === songId ? value : undefined
  }, `playlist entry ${entryId}`)
  await waitFor(async () => (await duration()) > 0, `playlist entry ${entryId} media duration`)
  await delay(500)
  return selected
}

async function sha256(filePath) {
  return createHash('sha256').update(await readFile(filePath)).digest('hex')
}

async function sourceManifest(library) {
  return Promise.all(library.map(async (song) => {
    const info = await stat(song.sourcePath)
    return {
      songId: song.id,
      path: song.sourcePath,
      bytes: info.size,
      modifiedAt: info.mtime.toISOString(),
      sha256: await sha256(song.sourcePath),
    }
  }))
}

async function listeningPorts(pid) {
  const script = `
$ids = @(${pid})
do {
  $next = @(Get-CimInstance Win32_Process | Where-Object {
    $ids -contains $_.ParentProcessId -and $ids -notcontains $_.ProcessId
  } | Select-Object -ExpandProperty ProcessId)
  $ids += $next
} while ($next.Count -gt 0)
@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object {
  $ids -contains $_.OwningProcess
} | Select-Object LocalAddress, LocalPort, OwningProcess) | ConvertTo-Json -Compress
`
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-EncodedCommand', encoded])
  if (!stdout.trim()) return []
  const parsed = JSON.parse(stdout)
  return Array.isArray(parsed) ? parsed : [parsed]
}

async function startApp() {
  try {
    await sendCommand({ action: 'status' }, { timeoutMs: 500 })
    throw new Error('A pre-existing Karaoke Studio automation pipe is active.')
  } catch (error) {
    if (error.message === 'A pre-existing Karaoke Studio automation pipe is active.') throw error
  }
  const launchArgs = [`--user-data-dir=${profile}`, '--enable-private-automation']
  if (args.electronEntry) launchArgs.unshift(path.resolve(args.electronEntry))
  child = spawn(executable, launchArgs, {
    cwd: path.dirname(executable),
    stdio: 'ignore',
  })
  testedPid = child.pid
  return waitFor(
    () => sendCommand({ action: 'status' }, { timeoutMs: 750 }),
    'explicit-flag private automation pipe',
    30_000,
  )
}

async function stopApp() {
  if (!child || child.exitCode !== null) return
  const pid = child.pid
  await execFileAsync('powershell.exe', [
    '-NoProfile',
    '-Command',
    `$process = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($process) { $null = $process.CloseMainWindow(); $process.WaitForExit(5000) }`,
  ]).catch(() => undefined)
  if (child.exitCode === null) {
    await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-Command',
      `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`,
    ]).catch(() => undefined)
  }
  child = undefined
}

function lyricAt(song, time, mediaDuration) {
  const index = song.lyrics.findIndex((line, lineIndex) =>
    time >= line.start
    && (time < line.end || (lineIndex === song.lyrics.length - 1 && time <= mediaDuration)))
  return index < 0 ? undefined : { index, ...song.lyrics[index] }
}

async function main() {
  await mkdir(outputRoot, { recursive: true })
  await cp(sourceProfile, profile, { recursive: true, force: true })
  await rm(path.join(profile, 'playlists.json'), { force: true })
  const library = JSON.parse(await readFile(libraryPath, 'utf8'))
  const processed = library.filter((song) =>
    song.sourcePath && song.enhancedPath && song.vocalPath && song.instrumentalPath && song.lyrics?.length > 1)
  if (processed.length !== 2) throw new Error(`Expected exactly two processed songs; found ${processed.length}.`)
  const sourcesBefore = await sourceManifest(library)
  logOffset = (await stat(logPath).catch(() => ({ size: 0 }))).size

  let initial = await startApp()
  record('two-processed-songs', initial.songs?.length === 2, `Private profile exposes ${initial.songs?.length ?? 0} songs.`)
  const ports = await listeningPorts(testedPid)
  record('zero-tcp-listeners', ports.length === 0, `App process tree has ${ports.length} listening TCP endpoints.`, ports)

  await attempt('navigation-and-ai-studio-absent', async () => {
    const body = await snapshot('body')
    const libraryNav = await snapshot('[data-testid="nav-library"]')
    const playlistsNav = await snapshot('[data-testid="nav-playlists"]')
    const passed = !body.text.includes('AI Studio') && !libraryNav.disabled && !playlistsNav.disabled
    record('navigation-and-ai-studio-absent', passed, `AI Studio text ${body.text.includes('AI Studio') ? 'is present' : 'is absent'}; Library and Playlists controls are enabled.`)
  })

  let primary = processed[0]
  const secondary = processed[1]
  await selectLibrarySong(primary.id)
  const initialLanguage = lyricLanguage(await status())
  if (!initialLanguage?.languageCode || initialLanguage.languageCode === 'und') {
    await clickTestId('refresh-lyrics-language')
    await waitFor(async () => {
      const value = await status()
      const language = lyricLanguage(value)
      return language?.songId === primary.id
        && language.languageCode
        && language.languageCode !== 'und'
        && playback(value).status !== 'error'
        ? value : undefined
    }, 'legacy song original-language retranscription', 1_200_000)
    const migratedLibrary = JSON.parse(await readFile(libraryPath, 'utf8'))
    primary = migratedLibrary.find((song) => song.id === primary.id) ?? primary
  }
  await screenshot('01-library-language')

  await attempt('language-persisted-displayed-unicode-intact', async () => {
    const value = await status()
    const language = lyricLanguage(value)
    const label = await snapshot('[data-testid="lyrics-language"]')
    const persisted = JSON.parse(await readFile(libraryPath, 'utf8')).find((song) => song.id === primary.id)
    const unicodeLyrics = persisted.lyrics.map((line) => line.text).join('')
    const nonAsciiIntact = /[^\u0000-\u007f]/u.test(unicodeLyrics)
      && primary.lyrics.map((line) => line.text).join('') === unicodeLyrics
    const passed = language?.songId === primary.id
      && language.languageCode && language.languageCode !== 'und'
      && language.languageName && language.languageName !== 'Unknown'
      && label.text.includes(language.languageName)
      && persisted.languageCode === language.languageCode
      && persisted.languageName === language.languageName
      && nonAsciiIntact
    record('language-persisted-displayed-unicode-intact', passed,
      `${language?.languageName ?? 'missing'} (${language?.languageCode ?? 'missing'}) is reported; rendered label is "${label.text}"; Unicode lyrics ${nonAsciiIntact ? 'match persisted text' : 'do not match'}.`,
      { language, rendered: label.text, persistedCode: persisted.languageCode, persistedName: persisted.languageName })
  })

  await attempt('seek-selects-timestamped-lyrics', async () => {
    await setPlaying(false)
    const total = await duration()
    const finalPlayableLine = [...primary.lyrics].reverse().find((line) => line.start < total - 0.1)
    const targets = [
      Math.max(0, primary.lyrics[0].start),
      primary.lyrics[1].start + 0.05,
      primary.lyrics[0].start + 0.05,
      finalPlayableLine.start + 0.05,
    ]
    const evidence = []
    for (const target of targets) {
      await seek(target)
      const value = await status()
      const expected = lyricAt(primary, target, total)
      evidence.push({
        target,
        expected: expected?.text,
        actual: playback(value).activeLyricText,
        index: playback(value).activeLyricIndex,
        passed: expected?.text === playback(value).activeLyricText,
      })
    }
    const passed = evidence.every((item) => item.passed)
    record('seek-selects-timestamped-lyrics', passed,
      evidence.map((item) => `${item.target.toFixed(2)}s→${item.index}:${item.actual ?? 'none'}`).join('; '), evidence)
    await screenshot('02-seeked-lyrics')
  })

  await attempt('song-change-resets-once-mode-change-preserves', async () => {
    await seek(Math.min(12, (await duration()) / 3))
    const beforeSongChange = await status()
    await selectLibrarySong(secondary.id)
    const afterSongChange = await status()
    const resetClock = (await snapshot('.timeline span:first-child')).text
    await delay(400)
    const settledSongChange = await status()
    await setMode('vocal')
    await seek(Math.min(8, (await duration()) / 4))
    const beforeMode = await position()
    await setMode('instrumental')
    const afterMode = await position()
    const changedOnce = currentTime(afterSongChange) <= 0.05
      && currentTime(settledSongChange) <= 0.05
      && resetClock === '0:00'
      && transitionReason(afterSongChange) === 'manual-library'
      && transitionCount(afterSongChange) === transitionCount(beforeSongChange) + 1
      && transitionCount(settledSongChange) === transitionCount(afterSongChange)
      && selectedSongId(afterSongChange) === secondary.id
      && lyricLanguage(afterSongChange)?.songId === secondary.id
    const modePreserved = Math.abs(afterMode - beforeMode) <= 0.2
    record('song-change-resets-once-mode-change-preserves', changedOnce && modePreserved,
      `Song changed from ${currentTime(beforeSongChange).toFixed(2)}s to ${currentTime(afterSongChange).toFixed(2)}s and settled ${currentTime(settledSongChange).toFixed(2)}s; same-song mode change ${beforeMode.toFixed(2)}→${afterMode.toFixed(2)}s.`,
      { beforeSongChange, afterSongChange, settledSongChange, resetClock, beforeMode, afterMode })
  })

  let namedPlaylistId
  await attempt('song-menu-add-create-select', async () => {
    await selectLibrarySong(primary.id)
    await seek(Math.min(5, (await duration()) / 4))
    const beforeMenu = await status()
    await openSongMenu(primary.id)
    await screenshot('03-song-menu')
    const openState = await status()
    await clickTestId('nav-library')
    const afterDismiss = await status()
    await addSongToPlaylist(primary.id, 'queue')
    const queueState = await status()
    const created = await createPlaylistForSong(secondary.id, 'Tank QA')
    namedPlaylistId = created.playlist.id
    await selectPlaylistView(namedPlaylistId)
    const passed = selectedSongId(openState) === selectedSongId(beforeMenu)
      && Math.abs(currentTime(openState) - currentTime(beforeMenu)) <= 0.05
      && songIds(getPlaylist(afterDismiss, 'queue')).length === 0
      && songIds(getPlaylist(queueState, 'queue')).join(',') === primary.id
      && songIds(created.playlist).join(',') === secondary.id
      && playlistState(await status()).selectedPlaylistId === namedPlaylistId
    record('song-menu-add-create-select', passed,
      `Menu did not change playback; Queue received the selected song; named playlist ${namedPlaylistId ?? 'missing'} was created, populated, and selected.`,
      { beforeMenu, openState, afterDismiss, queueState, created: created.value })
    await screenshot('04-created-playlist')
  })

  await attempt('fifo-order-and-duplicate-entries', async () => {
    await addSongToPlaylist(secondary.id, 'queue')
    await addSongToPlaylist(primary.id, 'queue')
    await addSongToPlaylist(primary.id, 'queue')
    const value = await selectPlaylistView('queue')
    const queue = getPlaylist(value, 'queue')
    const expected = [primary.id, secondary.id, primary.id, primary.id]
    const uniqueEntryIds = new Set(entryIds(queue))
    const passed = JSON.stringify(songIds(queue)) === JSON.stringify(expected)
      && uniqueEntryIds.size === expected.length
    record('fifo-order-and-duplicate-entries', passed,
      `Queue song order is ${songIds(queue).join(' → ')}; ${uniqueEntryIds.size}/${expected.length} entry identities are unique.`,
      { entries: queue.entries })
    await screenshot('05-fifo-duplicates')
  })

  await attempt('fifo-natural-end-advances-once', async () => {
    let value = await selectPlaylistView('queue')
    const queue = getPlaylist(value, 'queue')
    const first = queue.entries[0]
    const second = queue.entries[1]
    await selectPlaylistEntry(first.id, first.songId)
    await clickTestId('mode-original')
    await waitFor(async () => playback(await status()).mode === 'original', 'original mode before auto advance')
    await delay(700)
    const total = await duration()
    await seek(Math.max(0, total - 2.5))
    const before = await status()
    await setPlaying(true)
    let advanced
    try {
      advanced = await waitFor(async () => {
        const candidate = await status()
        return currentEntryId(candidate) === second.id
          && playback(candidate).status === 'playing'
          ? candidate : undefined
      }, 'one FIFO natural-end advance', 12_000)
    } finally {
      if (!advanced) {
        const failed = await status()
        await setPlaying(false).catch(() => undefined)
        await screenshot('06-auto-advance-failure').catch(() => undefined)
        throw new Error(`one FIFO natural-end advance not observed; final cursor=${currentEntryId(failed) ?? 'none'}, time=${currentTime(failed).toFixed(2)}, state=${playback(failed).status}, reason=${transitionReason(failed) ?? 'missing'}`)
      }
    }
    await delay(1_000)
    const settled = await status()
    const advancedExactlyOnce = currentEntryId(settled) === second.id
      && selectedSongId(settled) === second.songId
      && currentTime(advanced) <= 0.5
      && playback(advanced).status === 'playing'
      && transitionReason(advanced) === 'natural-end'
      && transitionCount(advanced) === transitionCount(before) + 1
      && transitionCount(settled) === transitionCount(advanced)
      && queueRevision(settled) === queueRevision(advanced)
    record('fifo-natural-end-advances-once', advancedExactlyOnce,
      `Cursor ${first.id}→${currentEntryId(advanced)} and remained there; reason=${transitionReason(advanced) ?? 'missing'}, time=${currentTime(advanced).toFixed(2)}s, state=${playback(advanced).status}.`,
      { before, advanced, settled })
    await setPlaying(false)
    await screenshot('06-auto-advanced')
  })

  await attempt('removal-preserves-order-and-cursor-contract', async () => {
    let value = await selectPlaylistView('queue')
    let queue = getPlaylist(value, 'queue')
    const originalIds = entryIds(queue)
    const target = queue.entries[1]
    const following = queue.entries[2]
    await selectPlaylistEntry(target.id, target.songId)
    await setPlaying(false)
    const removeBefore = queue.entries[0]
    await clickTestId(`playlist-remove-${removeBefore.id}`)
    value = await waitFor(async () => {
      const candidate = await status()
      return !entryIds(getPlaylist(candidate, 'queue')).includes(removeBefore.id) ? candidate : undefined
    }, 'entry before cursor removal')
    const cursorAfterBeforeRemoval = currentEntryId(value)
    queue = getPlaylist(value, 'queue')
    await clickTestId(`playlist-remove-${target.id}`)
    value = await waitFor(async () => {
      const candidate = await status()
      return !entryIds(getPlaylist(candidate, 'queue')).includes(target.id)
        && currentEntryId(candidate) === following.id ? candidate : undefined
    }, 'paused current entry removal')
    queue = getPlaylist(value, 'queue')
    const expected = originalIds.filter((id) => id !== removeBefore.id && id !== target.id)
    const passed = JSON.stringify(entryIds(queue)) === JSON.stringify(expected)
      && cursorAfterBeforeRemoval === target.id
      && currentEntryId(value) === following.id
      && currentTime(value) <= 0.05
      && transitionReason(value) === 'entry-removed'
    record('removal-preserves-order-and-cursor-contract', passed,
      `Removing ${removeBefore.id} before the cursor kept ${cursorAfterBeforeRemoval}; removing paused current ${target.id} selected following ${currentEntryId(value) ?? 'none'} at ${currentTime(value).toFixed(2)}s; surviving order is ${entryIds(queue).join(' → ')}.`)
  })

  await attempt('playlist-cursor-persists-restart-at-zero-paused', async () => {
    const before = await status()
    const selectedPlaylistId = playlistState(before).selectedPlaylistId
    const cursor = currentEntryId(before)
    await stopApp()
    initial = await startApp()
    const restored = await waitFor(async () => {
      const candidate = await status()
      return playlistState(candidate).selectedPlaylistId === selectedPlaylistId
        && currentEntryId(candidate) === cursor
        && selectedSongId(candidate)
        && playback(candidate).status === 'paused'
        ? candidate : undefined
    }, 'persisted playlist and cursor after restart', 12_000)
    const passed = currentTime(restored) <= 0.05
      && playback(restored).status === 'paused'
      && transitionReason(restored) === 'restore'
    record('playlist-cursor-persists-restart-at-zero-paused', passed,
      `Restored playlist=${selectedPlaylistId}, cursor=${cursor}, time=${currentTime(restored).toFixed(2)}s, state=${playback(restored).status}, reason=${transitionReason(restored) ?? 'missing'}.`,
      { before, restored })
    await screenshot('07-restored-playlist')
  })

  await attempt('last-entry-and-empty-playlist-stop', async () => {
    let value = await selectPlaylistView(namedPlaylistId)
    const named = getPlaylist(value, namedPlaylistId)
    const last = named.entries.at(-1)
    await selectPlaylistEntry(last.id, last.songId)
    await waitFor(async () => playback(await status()).mode === 'original', 'original mode for last entry')
    await delay(700)
    const total = await duration()
    await seek(Math.max(0, total - 2.5))
    await setPlaying(true)
    let ended
    try {
      ended = await waitFor(async () => {
        const candidate = await status()
        return playback(candidate).status === 'ended' ? candidate : undefined
      }, 'last entry ended state', 12_000)
    } catch (error) {
      await screenshot('08-last-entry-end-failure').catch(() => undefined)
      throw error
    }
    const endHeld = currentEntryId(ended) === last.id
    await clickTestId('playlist-clear')
    await waitFor(
      () => snapshot('[data-testid="playlist-clear-confirm"]'),
      'clear-playlist confirmation',
    )
    await clickTestId('playlist-clear-confirm')
    const empty = await waitFor(async () => {
      const candidate = await status()
      return getPlaylist(candidate, namedPlaylistId)?.entries.length === 0 ? candidate : undefined
    }, 'empty playlist')
    const play = await snapshot('[data-testid="playlist-play"]')
    const passed = endHeld && currentEntryId(empty) === undefined && play.disabled
    record('last-entry-and-empty-playlist-stop', passed,
      `Last entry ${endHeld ? 'remained selected at end' : 'did not remain selected'}; empty playlist cursor=${currentEntryId(empty) ?? 'none'}; playlist Play disabled=${play.disabled}.`)
    await screenshot('08-empty-playlist')
  })

  await attempt('empty-playlist-stops-and-disables-play', async () => {
    await setPlaying(false).catch(() => undefined)
    const selected = await selectPlaylistView(namedPlaylistId)
    if ((getPlaylist(selected, namedPlaylistId)?.entries.length ?? 0) > 0) {
      await clickTestId('playlist-clear')
      await waitFor(
        () => snapshot('[data-testid="playlist-clear-confirm"]'),
        'clear-playlist confirmation',
      )
      await clickTestId('playlist-clear-confirm')
    }
    const empty = await waitFor(async () => {
      const candidate = await status()
      return getPlaylist(candidate, namedPlaylistId)?.entries.length === 0 ? candidate : undefined
    }, 'explicitly cleared empty playlist')
    const play = await snapshot('[data-testid="playlist-play"]')
    const passed = currentEntryId(empty) === undefined
      && play.disabled
      && playback(empty).status !== 'playing'
    record('empty-playlist-stops-and-disables-play', passed,
      `Empty playlist cursor=${currentEntryId(empty) ?? 'none'}, state=${playback(empty).status}, playlist Play disabled=${play.disabled}.`)
    await screenshot('09-empty-playlist')
  })

  const sourcesAfter = await sourceManifest(library)
  const sourceFilesUnchanged = JSON.stringify(sourcesBefore) === JSON.stringify(sourcesAfter)
  record('source-files-unchanged', sourceFilesUnchanged,
    `${sourcesBefore.length} source files retained identical hashes, sizes, and modification times.`,
    { before: sourcesBefore, after: sourcesAfter })

  const finalPorts = await listeningPorts(testedPid)
  record('zero-tcp-listeners-final', finalPorts.length === 0,
    `Final app process tree has ${finalPorts.length} listening TCP endpoints.`, finalPorts)

  await stopApp()
  const log = await readFile(logPath).catch(() => Buffer.alloc(0))
  const runLog = log.subarray(Math.min(logOffset, log.length)).toString('utf8')
  await writeFile(path.join(outputRoot, 'app-run.log'), runLog)
  const rendererErrors = runLog.split(/\r?\n/).filter((line) =>
    /\bERROR\b/i.test(line) && /(renderer|preload|uncaught|unhandled)/i.test(line))
  record('no-renderer-errors', rendererErrors.length === 0,
    `Controlled run logged ${rendererErrors.length} renderer/preload/unhandled errors.`, rendererErrors)

  const report = {
    verdict: cases.every((item) => item.status === 'passed') ? 'APPROVE' : 'REJECT',
    generatedAt: new Date().toISOString(),
    executable,
    electronEntry: args.electronEntry ? path.resolve(args.electronEntry) : undefined,
    sourceProfile,
    isolatedProfile: profile,
    explicitPrivateAutomationFlag: true,
    namedPipe: '\\\\.\\pipe\\karaoke-studio-control',
    testedPid,
    songs: processed.map(({ id, title, sourcePath }) => ({ id, title, sourcePath })),
    cases,
    screenshots,
  }
  await writeFile(path.join(outputRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(`${report.verdict}: ${cases.filter((item) => item.status === 'passed').length}/${cases.length} gates passed.`)
  console.log(`Evidence: ${path.join(outputRoot, 'report.json')}`)
  process.exitCode = report.verdict === 'APPROVE' ? 0 : 1
}

try {
  await main()
} catch (error) {
  console.error(`REJECT: ${error instanceof Error ? error.stack : String(error)}`)
  process.exitCode = 1
} finally {
  await stopApp()
}
