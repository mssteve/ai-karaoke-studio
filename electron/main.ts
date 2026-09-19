import { app, BrowserWindow, dialog, ipcMain, net, protocol, shell } from 'electron'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { access, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import {
  isPrivateAutomationEnabled,
  startAutomationServer,
  type AutomationCommand,
} from './automation.js'
import { getDiagnosticsPath, logDiagnostic } from './logger.js'
import { ProcessingProgress } from './processing-progress.js'
import {
  PendingProcessingPlans,
  ProcessingScheduler,
  recoverInterruptedProcessing,
} from './processing-scheduler.js'
import {
  createProcessingResourcePolicy,
  ffmpegThreadArguments,
  ffmpegValidationArguments,
  processingWorkerEnvironment,
} from './processing-resources.js'
import {
  chooseEnhancementPlan,
  createMasterFilter,
  enhancementSummary,
  loudnessAnalysisArguments,
  parseLoudnormMetrics,
} from './enhancement.js'
import {
  componentFailure,
  blockedByFailure,
  computeMergedRetryPlan,
  deliverableIds,
  isProcessingComponentId,
  normalizeComponentFailure,
  normalizeDeliverableStore,
  reconcileArtifactOutcome,
} from './processing-domain.js'
import {
  normalizeWhisperChunksWithDiagnostics,
  validateLyricLines,
} from './transcription-timing.js'
import type {
  ArtifactFingerprint,
  ComponentFailure,
  DeliverableId,
  DeliverableState,
  ProcessingDiagnostics,
  ProcessingComponentId,
  PlaybackAutomationStatus,
  Playlist,
  PlaylistMutationRequest,
  PlaylistStore,
  ProcessingItemId,
  ProcessUpdate,
  RetryDeliverableRequest,
  Song,
  TranscriptionResult,
} from './types.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
let mainWindow: BrowserWindow | null = null
let library: Song[] = []
let playlistStore: PlaylistStore = { schemaVersion: 1, selectedPlaylistId: 'queue', playlists: [] }
let playlistRevision = 0
let playlistLoadDiagnostic: string | undefined
let playlistMutationChain: Promise<unknown> = Promise.resolve()
let rendererPlaybackStatus: PlaybackAutomationStatus | null = null
let rendererErrorSequence = 0
const rendererErrors: Array<{
  sequence: number
  at: string
  source: string
  message: string
  detail?: string
}> = []

function recordRendererError(source: string, message: string, detail?: unknown) {
  rendererErrors.push({
    sequence: ++rendererErrorSequence,
    at: new Date().toISOString(),
    source,
    message,
    detail: detail === undefined ? undefined : String(detail),
  })
  logDiagnostic('ERROR', message, detail)
}
const processingScheduler = new ProcessingScheduler(1)
const processingResources = createProcessingResourcePolicy()
const pendingProcessingTargets = new PendingProcessingPlans<DeliverableId>()
const songProcessingPromises = new Map<string, Promise<Song>>()
let librarySaveChain: Promise<void> = Promise.resolve()
const privateAutomationEnabled = isPrivateAutomationEnabled(app.isPackaged, process.argv)
const privateQaHooksEnabled = privateAutomationEnabled
  && process.argv.includes('--enable-private-qa-hooks')
type QaFailurePoint =
  | 'source-preparation'
  | 'demucs'
  | 'stem-other'
  | 'whisper-transcription'
  | 'enhanced'
  | 'save-library'
let qaFailure: { songId: string; point: QaFailurePoint; message?: string } | undefined
let qaFixtureAiEnabled = false
let qaTranscriptFixture: 'invalid' | 'fallback' | 'corrected' | undefined

function triggerQaFailure(songId: string, point: QaFailurePoint) {
  if (!privateQaHooksEnabled || qaFailure?.songId !== songId || qaFailure.point !== point) return
  throw new Error(qaFailure.message ?? `QA injected ${point} failure.`)
}

protocol.registerSchemesAsPrivileged([{
  scheme: 'karaoke',
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    stream: true,
  },
}])

function getLibraryPath() {
  return path.join(app.getPath('userData'), 'library.json')
}

function getPlaylistsPath() {
  return path.join(app.getPath('userData'), 'playlists.json')
}

function defaultLyricLanguage(): Song['lyricLanguage'] {
  return { languageCode: 'und', languageName: 'Unknown', languageSource: 'legacy' }
}

function createQueue(now = new Date().toISOString()): Playlist {
  return {
    id: 'queue',
    name: 'Queue',
    kind: 'queue',
    entries: [],
    createdAt: now,
    updatedAt: now,
  }
}

function createHistory(now = new Date().toISOString()): Playlist {
  return {
    id: 'history',
    name: 'History',
    kind: 'history',
    entries: [],
    createdAt: now,
    updatedAt: now,
  }
}

function createEmptyPlaylistStore(): PlaylistStore {
  const now = new Date().toISOString()
  return { schemaVersion: 1, selectedPlaylistId: 'queue', playlists: [createQueue(now), createHistory(now)] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}

function normalizeLanguageCode(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return 'und'
  try {
    return Intl.getCanonicalLocales(value.trim())[0] ?? 'und'
  } catch {
    return 'und'
  }
}

function normalizeSong(song: Song): Song {
  const legacy = song as Song & { language?: string; languageCode?: string; languageName?: string }
  const candidate = isRecord(song.lyricLanguage) ? song.lyricLanguage : undefined
  const code = normalizeLanguageCode(candidate?.languageCode ?? legacy.languageCode)
  const name = typeof candidate?.languageName === 'string' && candidate.languageName.trim()
    ? candidate.languageName.trim()
    : typeof legacy.languageName === 'string' && legacy.languageName.trim()
      ? legacy.languageName.trim()
      : typeof legacy.language === 'string' && legacy.language.trim()
        ? legacy.language.trim()
        : 'Unknown'
  const source = candidate?.languageSource === 'detected' || candidate?.languageSource === 'user'
    || candidate?.languageSource === 'legacy' ? candidate.languageSource : 'legacy'
  return {
    ...song,
    lyrics: Array.isArray(song.lyrics) ? song.lyrics : [],
    lyricLanguage: { languageCode: code, languageName: name, languageSource: source },
    languageCode: code,
    languageName: name,
    languageSource: source,
    deliverables: normalizeDeliverableStore(song.deliverables),
    processingFailure: normalizeComponentFailure(song.processingFailure),
  }
}

function validatePlaylistStore(value: unknown): PlaylistStore {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.playlists)) {
    throw new Error('Unsupported or malformed playlist schema.')
  }
  const songIds = new Set(library.map((song) => song.id))
  const ids = new Set<string>()
  const entryIds = new Set<string>()
  const playlists: Playlist[] = []
  let queueFound = false
  let historyFound = false
  for (const raw of value.playlists) {
    if (!isRecord(raw)
      || typeof raw.id !== 'string'
      || typeof raw.name !== 'string'
      || (raw.kind !== 'queue' && raw.kind !== 'history' && raw.kind !== 'playlist')
      || !Array.isArray(raw.entries)
      || typeof raw.createdAt !== 'string'
      || typeof raw.updatedAt !== 'string'
      || ids.has(raw.id)) throw new Error('Malformed playlist record.')
    if (raw.kind === 'queue') {
      if (raw.id !== 'queue' || queueFound) throw new Error('Malformed system Queue.')
      queueFound = true
    } else if (raw.kind === 'history') {
      if (raw.id !== 'history' || historyFound) throw new Error('Malformed system History.')
      historyFound = true
    } else if (raw.id === 'queue' || raw.id === 'history') throw new Error('Malformed system playlist.')
    ids.add(raw.id)
    const entries = raw.entries.flatMap((entry): Playlist['entries'] => {
      if (!isRecord(entry)
        || typeof entry.id !== 'string'
        || typeof entry.songId !== 'string'
        || typeof entry.addedAt !== 'string'
        || entryIds.has(entry.id)) throw new Error('Malformed playlist entry.')
      entryIds.add(entry.id)
      if (!songIds.has(entry.songId)) {
        playlistLoadDiagnostic = `Pruned orphan playlist entry ${entry.id}.`
        return []
      }
      return [{ id: entry.id, songId: entry.songId, addedAt: entry.addedAt }]
    })
    const currentEntryId = typeof raw.currentEntryId === 'string'
      && entries.some((entry) => entry.id === raw.currentEntryId)
      ? raw.currentEntryId : undefined
    playlists.push({
      id: raw.id,
      name: raw.kind === 'queue' ? 'Queue' : raw.kind === 'history' ? 'History' : raw.name.trim(),
      kind: raw.kind,
      entries,
      currentEntryId,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
    })
  }
  if (!queueFound) playlists.unshift(createQueue())
  if (!historyFound) playlists.splice(1, 0, createHistory())
  const selectedPlaylistId = typeof value.selectedPlaylistId === 'string'
    && playlists.some((playlist) => playlist.id === value.selectedPlaylistId)
    ? value.selectedPlaylistId : 'queue'
  return { schemaVersion: 1, selectedPlaylistId, playlists }
}

async function loadPlaylists() {
  playlistLoadDiagnostic = undefined
  try {
    playlistStore = validatePlaylistStore(JSON.parse(await readFile(getPlaylistsPath(), 'utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      playlistLoadDiagnostic = error instanceof Error ? error.message : String(error)
      logDiagnostic('ERROR', 'Unable to load playlists; using a safe empty Queue', error)
    }
    playlistStore = createEmptyPlaylistStore()
  }
}

async function savePlaylists() {
  await mkdir(app.getPath('userData'), { recursive: true })
  const target = getPlaylistsPath()
  const temporary = `${target}.${process.pid}.new`
  await writeFile(temporary, JSON.stringify(playlistStore, null, 2), 'utf8')
  await rename(temporary, target)
  playlistRevision += 1
  playlistLoadDiagnostic = undefined
}

function getPlaylist(id: unknown) {
  if (typeof id !== 'string' || !id) throw new Error('A valid playlist ID is required.')
  const playlist = playlistStore.playlists.find((item) => item.id === id)
  if (!playlist) throw new Error('The playlist no longer exists.')
  return playlist
}

function assertFresh(playlist: Playlist, expectedUpdatedAt?: unknown) {
  if (expectedUpdatedAt !== undefined
    && (typeof expectedUpdatedAt !== 'string' || expectedUpdatedAt !== playlist.updatedAt)) {
    throw new Error('The playlist changed. Refresh and try again.')
  }
}

function playlistName(value: unknown, excludingId?: string) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Playlist name cannot be empty.')
  const name = value.trim()
  if (['queue', 'history'].includes(name.toLocaleLowerCase())) {
    throw new Error('Queue and History are reserved playlist names.')
  }
  if (playlistStore.playlists.some((item) => item.id !== excludingId
    && item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
    throw new Error('A playlist with that name already exists.')
  }
  return name
}

function touch(playlist: Playlist) {
  playlist.updatedAt = new Date().toISOString()
}

function queuePlaylistMutation<T>(operation: () => Promise<T>) {
  const result = playlistMutationChain.then(operation, operation)
  playlistMutationChain = result.then(() => undefined, () => undefined)
  return result
}

async function createPlaylist(nameValue: unknown) {
  const name = playlistName(nameValue)
  const now = new Date().toISOString()
  playlistStore.playlists.push({
    id: randomUUID(),
    name,
    kind: 'playlist',
    entries: [],
    createdAt: now,
    updatedAt: now,
  })
  await savePlaylists()
  return playlistStore
}

async function renamePlaylist(request: { playlistId?: unknown; expectedUpdatedAt?: unknown; name?: unknown }) {
  const playlist = getPlaylist(request.playlistId)
  if (playlist.kind !== 'playlist') throw new Error('System playlists cannot be renamed.')
  assertFresh(playlist, request.expectedUpdatedAt)
  playlist.name = playlistName(request.name, playlist.id)
  touch(playlist)
  await savePlaylists()
  return playlistStore
}

async function deletePlaylist(request: { playlistId?: unknown; expectedUpdatedAt?: unknown }) {
  const playlist = getPlaylist(request.playlistId)
  if (playlist.kind !== 'playlist') throw new Error('System playlists cannot be deleted.')
  assertFresh(playlist, request.expectedUpdatedAt)
  playlistStore.playlists = playlistStore.playlists.filter((item) => item.id !== playlist.id)
  if (playlistStore.selectedPlaylistId === playlist.id) playlistStore.selectedPlaylistId = 'queue'
  await savePlaylists()
  return playlistStore
}

async function addSongToPlaylist(request: {
  playlistId?: unknown
  expectedUpdatedAt?: unknown
  songId?: unknown
}) {
  const playlist = getPlaylist(request.playlistId)
  if (playlist.kind === 'history') throw new Error('Songs cannot be added directly to History.')
  assertFresh(playlist, request.expectedUpdatedAt)
  if (typeof request.songId !== 'string' || !library.some((song) => song.id === request.songId)) {
    throw new Error('The song no longer exists in the library.')
  }
  playlist.entries.push({ id: randomUUID(), songId: request.songId, addedAt: new Date().toISOString() })
  touch(playlist)
  await savePlaylists()
  return playlistStore
}

async function removePlaylistEntry(request: {
  playlistId?: unknown
  expectedUpdatedAt?: unknown
  entryId?: unknown
}) {
  const playlist = getPlaylist(request.playlistId)
  assertFresh(playlist, request.expectedUpdatedAt)
  if (typeof request.entryId !== 'string') throw new Error('A valid playlist entry ID is required.')
  const index = playlist.entries.findIndex((entry) => entry.id === request.entryId)
  if (index < 0) throw new Error('The playlist entry no longer exists.')
  playlist.entries.splice(index, 1)
  if (playlist.currentEntryId === request.entryId) {
    playlist.currentEntryId = playlist.entries[index]?.id ?? playlist.entries[index - 1]?.id
  }
  touch(playlist)
  await savePlaylists()
  return playlistStore
}

async function archiveQueueEntry(request: {
  playlistId?: unknown
  expectedUpdatedAt?: unknown
  entryId?: unknown
}) {
  const queue = getPlaylist(request.playlistId)
  if (queue.kind !== 'queue') throw new Error('Only Queue entries can be archived.')
  assertFresh(queue, request.expectedUpdatedAt)
  if (typeof request.entryId !== 'string') throw new Error('A valid queue entry ID is required.')
  const index = queue.entries.findIndex((entry) => entry.id === request.entryId)
  if (index < 0) throw new Error('The queue entry no longer exists.')
  const [entry] = queue.entries.splice(index, 1)
  const history = getPlaylist('history')
  history.entries.unshift({ ...entry, addedAt: new Date().toISOString() })
  queue.currentEntryId = queue.entries[index]?.id ?? queue.entries[index - 1]?.id
  touch(queue)
  touch(history)
  await savePlaylists()
  return playlistStore
}

async function clearPlaylist(request: { playlistId?: unknown; expectedUpdatedAt?: unknown }) {
  const playlist = getPlaylist(request.playlistId)
  assertFresh(playlist, request.expectedUpdatedAt)
  playlist.entries = []
  playlist.currentEntryId = undefined
  touch(playlist)
  await savePlaylists()
  return playlistStore
}

async function selectPlaylist(playlistId: unknown) {
  const playlist = getPlaylist(playlistId)
  playlistStore.selectedPlaylistId = playlist.id
  await savePlaylists()
  return playlistStore
}

async function setPlaylistCursor(request: {
  playlistId?: unknown
  expectedUpdatedAt?: unknown
  entryId?: unknown
}) {
  const playlist = getPlaylist(request.playlistId)
  assertFresh(playlist, request.expectedUpdatedAt)
  if (request.entryId !== undefined
    && (typeof request.entryId !== 'string'
      || !playlist.entries.some((entry) => entry.id === request.entryId))) {
    throw new Error('The playlist entry no longer exists.')
  }
  playlist.currentEntryId = request.entryId as string | undefined
  touch(playlist)
  await savePlaylists()
  return playlistStore
}

function toPlayableUrl(filePath?: string) {
  return filePath ? pathToFileURL(filePath).href : undefined
}

function mediaUrl(songId: string, mode: string, available?: string) {
  return available ? `karaoke://media/${encodeURIComponent(songId)}/${mode}` : undefined
}

function hydrate(song: Song): Song {
  return {
    ...normalizeSong(song),
    sourceUrl: mediaUrl(song.id, 'original', song.sourcePath) ?? '',
    instrumentalUrl: mediaUrl(song.id, 'instrumental', song.instrumentalPath),
    vocalUrl: mediaUrl(song.id, 'vocal', song.vocalPath),
    enhancedUrl: mediaUrl(song.id, 'enhanced', song.enhancedPath),
  }
}

async function hydrateTranscriptMetadata(song: Song) {
  const normalized = normalizeSong(song)
  if (normalized.languageSource !== 'legacy') return normalized
  const transcriptPath = path.join(app.getPath('userData'), 'processed', song.id, 'lyrics.json')
  try {
    const transcript: unknown = JSON.parse(await readFile(transcriptPath, 'utf8'))
    if (!isTranscriptionResult(transcript)) return normalized
    const languageCode = normalizeLanguageCode(transcript.languageCode)
    const languageName = transcript.languageName?.trim() || transcript.language?.trim()
    if (languageCode === 'und' || !languageName) return normalized
    return normalizeSong({
      ...normalized,
      lyrics: transcript.lines,
      languageCode,
      languageName,
      languageSource: transcript.languageSource === 'user' ? 'user' : 'detected',
      lyricLanguage: {
        languageCode,
        languageName,
        languageSource: transcript.languageSource === 'user' ? 'user' : 'detected',
      },
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logDiagnostic('ERROR', `Unable to hydrate transcript metadata for ${song.id}`, error)
    }
    return normalized
  }
}

async function loadLibrary() {
  let stored: Song[]
  try {
    stored = JSON.parse(await readFile(getLibraryPath(), 'utf8')) as Song[]
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    library = []
    return false
  }
  library = await Promise.all(stored.map(hydrateTranscriptMetadata))
  let recovered = stored.some((song) => !song.deliverables)
  for (const song of library) {
    recovered = recoverInterruptedProcessing(song) || recovered
    song.deliverables = normalizeDeliverableStore(song.deliverables)
    for (const id of deliverableIds) {
      const current = outcome(song, id)
      if (current.state !== 'queued' && current.state !== 'active') continue
      const failure = componentFailure(id, 'Processing was interrupted by app shutdown.', {
        code: 'interrupted',
      })
      setOutcome(song, id, 'failed', { failure })
      song.processingFailure = failure
      song.processingStage = 'error'
      song.processingMessage = failure.message
      recovered = true
    }
    await inspectDeliverables(song)
  }
  return recovered || library.length > 0
}

function saveLibrary(songOverride?: Song, finalSongId?: string) {
  const save = async () => {
    if (finalSongId) triggerQaFailure(finalSongId, 'save-library')
    await mkdir(app.getPath('userData'), { recursive: true })
    const target = getLibraryPath()
    const temporary = `${target}.${process.pid}.new`
    const persistedLibrary = songOverride
      ? library.map((song) => song.id === songOverride.id ? songOverride : song)
      : library
    await writeFile(
      temporary,
      JSON.stringify(persistedLibrary.map(({
        sourceUrl: _sourceUrl,
        instrumentalUrl: _instrumentalUrl,
        vocalUrl: _vocalUrl,
        enhancedUrl: _enhancedUrl,
        ...song
      }) => song), null, 2),
      'utf8',
    )
    await replaceFile(temporary, target)
  }
  const result = librarySaveChain.then(save, save)
  librarySaveChain = result.catch(() => undefined)
  return result
}

function publish(update: ProcessUpdate) {
  mainWindow?.webContents.send('ai:progress', update)
}

function applyProgress(update: ProcessUpdate, shouldPublish = true) {
  const { songId, stage, progress, message, details } = update
  const song = library.find((item) => item.id === songId)
  if (!song) return
  song.processingStage = stage
  song.processingProgress = progress
  song.processingMessage = message
  song.processingDetails = details
  if (update.failure !== undefined) song.processingFailure = update.failure
  if (shouldPublish) publish({ ...update, song: hydrate(song) })
}

function resolveUnpacked(modulePath: string) {
  return app.isPackaged ? modulePath.replace('app.asar', 'app.asar.unpacked') : modulePath
}

interface ProcessOptions {
  env?: NodeJS.ProcessEnv
  onStdoutLine?: (line: string) => void
  onStderrLine?: (line: string) => void
  onHeartbeat?: () => void
}

function runProcess(command: string, args: string[], options: ProcessOptions = {}) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      env: processingWorkerEnvironment(processingResources, { ...process.env, ...options.env }),
    })
    let stderr = ''
    let stdoutPending = ''
    let stderrPending = ''
    const heartbeat = options.onHeartbeat
      ? setInterval(options.onHeartbeat, 5_000)
      : undefined
    heartbeat?.unref()
    const consumeLines = (pending: string, callback?: (line: string) => void) => {
      const lines = pending.split(/\r?\n/)
      const remainder = lines.pop() ?? ''
      for (const line of lines) callback?.(line)
      return remainder
    }
    child.stdout.on('data', (chunk) => {
      stdoutPending = consumeLines(stdoutPending + chunk.toString(), options.onStdoutLine)
    })
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString()
      stderr += text
      stderrPending = consumeLines(stderrPending + text, options.onStderrLine)
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (heartbeat) clearInterval(heartbeat)
      if (stdoutPending) options.onStdoutLine?.(stdoutPending)
      if (stderrPending) options.onStderrLine?.(stderrPending)
      if (code === 0) resolve()
      else {
        const error = new Error(stderr.trim() || `Local AI process exited with code ${code}.`)
        logDiagnostic('ERROR', `Subprocess failed: ${path.basename(command)} (${code})`, error)
        reject(error)
      }
    })
  })
}

function parseTimestamp(value: string) {
  const match = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(value.trim())
  if (!match) return undefined
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3])
}

async function runFfmpeg(
  ffmpegPath: string,
  args: string[],
  onProgress: (progress: number | undefined, message: string) => void,
) {
  let duration: number | undefined
  let lastProgress = -1
  const report = (seconds?: number) => {
    if (!duration || seconds === undefined) {
      if (lastProgress < 0) {
        lastProgress = 0
        onProgress(undefined, 'FFmpeg is processing audio')
      }
      return
    }
    const progress = Math.min(99, Math.max(0, Math.floor(seconds / duration * 100)))
    if (progress > lastProgress) {
      lastProgress = progress
      onProgress(progress, `FFmpeg processed ${seconds.toFixed(1)}s of ${duration.toFixed(1)}s`)
    }
  }
  const outputPath = args.at(-1)
  if (!outputPath) throw new Error('FFmpeg output path is missing.')
  await runProcess(ffmpegPath, [
    ...ffmpegThreadArguments(processingResources),
    ...args.slice(0, -1),
    '-threads', String(processingResources.cpuThreads),
    outputPath,
    '-progress', 'pipe:1', '-nostats',
  ], {
    onStdoutLine: (line) => {
      const [key, value] = line.split('=', 2)
      if (key === 'out_time') report(parseTimestamp(value ?? ''))
      else if (key === 'out_time_us') report(Number(value) / 1_000_000)
    },
    onStderrLine: (line) => {
      const match = /Duration:\s*(\d+:\d+:\d+(?:\.\d+)?)/.exec(line)
      if (match) duration = parseTimestamp(match[1])
    },
  })
  onProgress(100, duration ? `FFmpeg processed ${duration.toFixed(1)}s` : 'FFmpeg output is complete')
}

async function measureLoudness(filePath: string) {
  const lines: string[] = []
  await runProcess(
    resolveUnpacked(ffmpegInstaller.path),
    loudnessAnalysisArguments(filePath, processingResources),
    { onStderrLine: (line) => lines.push(line) },
  )
  return parseLoudnormMetrics(lines.join('\n'))
}

async function validateOutput(filePath: string, minimumBytes = 1) {
  const output = await stat(filePath)
  if (!output.isFile() || output.size < minimumBytes) {
    throw new Error(`Generated output is empty or invalid: ${path.basename(filePath)}`)
  }
}

async function fingerprint(
  filePath: string,
  minimumBytes = 1,
  validateMedia = true,
): Promise<ArtifactFingerprint> {
  await validateOutput(filePath, minimumBytes)
  if (validateMedia) {
    await runProcess(
      resolveUnpacked(ffmpegInstaller.path),
      ffmpegValidationArguments(filePath, processingResources),
    )
  }
  const output = await stat(filePath)
  return {
    path: filePath,
    size: output.size,
    modifiedAt: output.mtimeMs,
    validatedAt: new Date().toISOString(),
  }
}

async function replaceFile(temporaryPath: string, targetPath: string) {
  const backupPath = `${targetPath}.${process.pid}.old`
  await rm(backupPath, { force: true })
  let hadTarget = false
  try {
    await rename(targetPath, backupPath)
    hadTarget = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  try {
    await rename(temporaryPath, targetPath)
    await rm(backupPath, { force: true }).catch((error) => {
      logDiagnostic('WARN', `Unable to remove replaced artifact backup: ${backupPath}`, error)
    })
  } catch (error) {
    if (hadTarget) await rename(backupPath, targetPath).catch(() => undefined)
    throw error
  }
}

async function runFfmpegAtomic(
  ffmpegPath: string,
  args: string[],
  targetPath: string,
  onProgress: (progress: number | undefined, message: string) => void,
) {
  const extension = path.extname(targetPath)
  const temporaryPath = `${targetPath}.${process.pid}.new${extension}`
  await rm(temporaryPath, { force: true })
  try {
    const targetIndex = args.lastIndexOf(targetPath)
    const temporaryArgs = [...args]
    if (targetIndex < 0) throw new Error('FFmpeg output target is missing.')
    temporaryArgs[targetIndex] = temporaryPath
    await runFfmpeg(ffmpegPath, temporaryArgs, onProgress)
    await fingerprint(temporaryPath, 44)
    await replaceFile(temporaryPath, targetPath)
  } catch (error) {
    await rm(temporaryPath, { force: true })
    throw error
  }
}

function outcome(song: Song, id: DeliverableId) {
  song.deliverables = normalizeDeliverableStore(song.deliverables)
  return song.deliverables.outcomes[id]
}

function setOutcome(
  song: Song,
  id: DeliverableId,
  state: DeliverableState,
  options: {
    artifacts?: ArtifactFingerprint[]
    failure?: ComponentFailure
    blockedBy?: DeliverableId[]
    diagnostics?: ProcessingDiagnostics
  } = {},
) {
  const current = outcome(song, id)
  song.deliverables!.outcomes[id] = {
    id,
    state,
    artifacts: options.artifacts ?? current.artifacts,
    updatedAt: new Date().toISOString(),
    failure: options.failure,
    blockedBy: options.blockedBy,
    diagnostics: options.diagnostics ?? current.diagnostics,
  }
}

function outputPaths(song: Song) {
  const root = path.join(app.getPath('userData'), 'processed', song.id)
  return {
    root,
    source: path.join(root, 'source.wav'),
    speech: path.join(root, 'speech.wav'),
    transcript: path.join(root, 'lyrics.json'),
    stems: {
      vocals: path.join(root, 'stems', 'vocals.wav'),
      drums: path.join(root, 'stems', 'drums.wav'),
      bass: path.join(root, 'stems', 'bass.wav'),
      other: path.join(root, 'stems', 'other.wav'),
    },
    instrumental: song.instrumentalPath ?? path.join(root, 'instrumental.m4a'),
    vocal: song.vocalPath ?? path.join(root, 'vocal.m4a'),
    enhanced: song.enhancedPath ?? path.join(root, 'enhanced.m4a'),
  }
}

async function resolveStemPaths(song: Song) {
  const paths = outputPaths(song)
  const result = { ...paths.stems }
  for (const name of ['vocals', 'drums', 'bass', 'other'] as const) {
    try {
      await validateOutput(result[name], 44)
    } catch {
      result[name] = await findFile(paths.root, `${name}.wav`) ?? result[name]
    }
  }
  return result
}

async function inspectDeliverables(song: Song) {
  song.deliverables = normalizeDeliverableStore(song.deliverables)
  const paths = outputPaths(song)
  const stems = await resolveStemPaths(song)
  const artifacts = new Map<DeliverableId, ArtifactFingerprint[]>()
  const inspect = async (id: DeliverableId, candidates: Array<[string, number]>) => {
    try {
      const validated = await Promise.all(candidates.map(([filePath, minimum]) => fingerprint(filePath, minimum)))
      artifacts.set(id, validated)
      const current = outcome(song, id)
      song.deliverables!.outcomes[id] = reconcileArtifactOutcome(current, validated)
    } catch (error) {
      if ((await Promise.all(candidates.map(([filePath]) => stat(filePath).then(
        () => true,
        () => false,
      )))).every(Boolean)) {
        logDiagnostic('WARN', `Existing ${id} artifacts failed validation`, error)
      }
      const current = outcome(song, id)
      song.deliverables!.outcomes[id] = reconcileArtifactOutcome(current, undefined)
    }
  }

  await inspect('original', [[song.sourcePath, 1]])
  await inspect('source-preparation', [[paths.source, 44], [paths.speech, 44]])
  await inspect('stem-vocals', [[stems.vocals, 44]])
  await inspect('stem-drums', [[stems.drums, 44]])
  await inspect('stem-bass', [[stems.bass, 44]])
  await inspect('stem-other', [[stems.other, 44]])
  const stemsReady = (['stem-vocals', 'stem-drums', 'stem-bass', 'stem-other'] as DeliverableId[])
    .every((id) => outcome(song, id).state === 'ready')
  setOutcome(song, 'demucs', stemsReady ? 'ready' : 'missing', {
    artifacts: stemsReady ? [...artifacts.values()].flat().filter((item) => Object.values(stems).includes(item.path)) : [],
  })
  await inspect('instrumental', [[paths.instrumental, 44]])
  await inspect('vocal', [[paths.vocal, 44]])
  await inspect('enhanced', [[paths.enhanced, 44]])
  try {
    const transcript: unknown = JSON.parse(await readFile(paths.transcript, 'utf8'))
    if (!isTranscriptionResult(transcript)) throw new Error('Invalid transcript')
    const transcriptArtifact = await fingerprint(paths.transcript, 2, false)
    setOutcome(song, 'whisper-transcription', 'ready', {
      artifacts: [transcriptArtifact],
      diagnostics: transcript.timingDiagnostics,
    })
    try {
      applyTranscript(song, transcript)
      setOutcome(song, 'lyrics', 'ready', {
        artifacts: [transcriptArtifact],
        diagnostics: transcript.timingDiagnostics,
      })
    } catch {
      if (outcome(song, 'lyrics').state !== 'failed') {
        setOutcome(song, 'lyrics', 'missing', { artifacts: [] })
      }
    }
  } catch {
    if (outcome(song, 'whisper-transcription').state !== 'failed') {
      setOutcome(song, 'whisper-transcription', 'missing', { artifacts: [] })
    }
    if (outcome(song, 'lyrics').state !== 'failed') {
      setOutcome(song, 'lyrics', 'missing', { artifacts: [] })
    }
  }

  if (outcome(song, 'instrumental').state === 'ready') song.instrumentalPath = paths.instrumental
  else {
    song.instrumentalPath = undefined
    song.instrumentalUrl = undefined
  }
  if (outcome(song, 'vocal').state === 'ready') song.vocalPath = paths.vocal
  else {
    song.vocalPath = undefined
    song.vocalUrl = undefined
  }
  if (outcome(song, 'enhanced').state === 'ready') song.enhancedPath = paths.enhanced
  else {
    song.enhancedPath = undefined
    song.enhancedUrl = undefined
  }
  return {
    valid: new Set(deliverableIds.filter((id) => outcome(song, id).state === 'ready')),
    paths,
    stems,
  }
}

function isTranscriptionResult(value: unknown): value is TranscriptionResult {
  if (!value || typeof value !== 'object') return false
  const transcript = value as Partial<TranscriptionResult>
  return typeof transcript.text === 'string'
    && (transcript.language === undefined || typeof transcript.language === 'string')
    && (transcript.languageName === undefined || typeof transcript.languageName === 'string')
    && (transcript.languageCode === undefined || typeof transcript.languageCode === 'string')
    && (transcript.timingDiagnostics === undefined || (
      typeof transcript.timingDiagnostics.fallbackUsed === 'boolean'
      && Number.isInteger(transcript.timingDiagnostics.fallbackLineCount)
      && Number.isInteger(transcript.timingDiagnostics.repairedOverlapCount)
      && (transcript.timingDiagnostics.invalidDurationExpansionCount === undefined
        || Number.isInteger(transcript.timingDiagnostics.invalidDurationExpansionCount))
      && (transcript.timingDiagnostics.sortedFragmentCount === undefined
        || Number.isInteger(transcript.timingDiagnostics.sortedFragmentCount))
      && (transcript.timingDiagnostics.mergedFragmentCount === undefined
        || Number.isInteger(transcript.timingDiagnostics.mergedFragmentCount))
      && Number.isInteger(transcript.timingDiagnostics.discardedFragmentCount)
      && Array.isArray(transcript.timingDiagnostics.messages)
      && transcript.timingDiagnostics.messages.every((message) => typeof message === 'string')
    ))
    && Array.isArray(transcript.lines)
    && transcript.lines.every((line) => (
      line
      && typeof line.text === 'string'
      && Number.isFinite(line.start)
      && Number.isFinite(line.end)
      && line.start >= 0
      && line.end > line.start
    ))
    && (() => {
      try {
        validateLyricLines(transcript.lines)
        return true
      } catch {
        return false
      }
    })()
}

async function findFile(root: string, fileName: string): Promise<string | undefined> {
  const { readdir } = await import('node:fs/promises')
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  for (const entry of entries) {
    const candidate = path.join(root, entry.name)
    if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) return candidate
    if (entry.isDirectory()) {
      const found = await findFile(candidate, fileName)
      if (found) return found
    }
  }
  return undefined
}

function applyTranscript(song: Song, transcript: TranscriptionResult) {
  const languageCode = normalizeLanguageCode(transcript.languageCode)
  const languageName = transcript.languageName?.trim() || transcript.language?.trim()
  if (languageCode === 'und' || !languageName) {
    throw new Error('Local Whisper AI could not identify the original lyric language.')
  }
  if (!transcript.lines.length) {
    throw new Error('Local Whisper AI did not find any timed lyrics.')
  }
  song.lyrics = transcript.lines
  song.lyricLanguage = {
    languageCode,
    languageName,
    languageSource: transcript.languageSource === 'user' ? 'user' : 'detected',
  }
  song.languageCode = song.lyricLanguage.languageCode
  song.languageName = song.lyricLanguage.languageName
  song.languageSource = song.lyricLanguage.languageSource
}

interface TranscriptionProgressEvent {
  phase?: 'model' | 'language' | 'transcription' | 'lyrics'
  status?: string
  progress?: number
  completed?: number
  total?: number
  duration?: number
  chunks?: number
  lines?: number
  fallbackLines?: number
  file?: string
}

async function runTranscription(
  inputPath: string,
  outputPath: string,
  onProgress?: (event: TranscriptionProgressEvent) => void,
  onHeartbeat?: () => void,
) {
  const temporaryOutput = `${outputPath}.${process.pid}.new`
  const transcriptionScript = path.join(__dirname, 'transcribe.js')
  try {
    await runProcess(process.execPath, [
      transcriptionScript,
      inputPath,
      path.join(app.getPath('userData'), 'ai-models'),
      temporaryOutput,
      String(processingResources.cpuThreads),
    ], {
      env: { ELECTRON_RUN_AS_NODE: '1' },
      onStdoutLine: (line) => {
        if (!line.startsWith('KARAOKE_PROGRESS ')) return
        try {
          onProgress?.(JSON.parse(line.slice('KARAOKE_PROGRESS '.length)) as TranscriptionProgressEvent)
        } catch {
          logDiagnostic('WARN', `Ignored malformed transcription progress: ${line}`)
        }
      },
      onHeartbeat,
    })
    const transcript: unknown = JSON.parse(await readFile(temporaryOutput, 'utf8'))
    if (!isTranscriptionResult(transcript)) {
      throw new Error('Local Whisper AI produced an invalid lyrics file.')
    }
    await replaceFile(temporaryOutput, outputPath)
    return transcript
  } catch (error) {
    await rm(temporaryOutput, { force: true })
    throw error
  }
}

function reportTranscriptionProgress(
  tracker: ProcessingProgress,
  event: TranscriptionProgressEvent,
) {
  if (event.phase === 'model') {
    if (event.status === 'ready') {
      applyProgress(tracker.update('whisper-model', 'complete', {
        message: 'Whisper model is ready',
      }))
      return
    }
    const rawProgress = Number(event.progress)
    const progress = Number.isFinite(rawProgress)
      ? rawProgress <= 1 ? rawProgress * 100 : rawProgress
      : undefined
    applyProgress(tracker.update('whisper-model', progress === undefined ? 'indeterminate' : 'active', {
      progress,
      message: event.file
        ? `Loading Whisper model: ${path.basename(event.file)}`
        : 'Loading the local Whisper model',
    }))
    return
  }
  if (event.phase === 'language') {
    const progress = event.total ? Math.min(15, event.completed! / event.total * 15) : undefined
    applyProgress(tracker.update('whisper-transcription', 'active', {
      progress,
      message: event.total
        ? `Detecting lyric language sample ${event.completed} of ${event.total}`
        : 'Detecting the lyric language',
    }))
    return
  }
  if (event.phase === 'transcription' && event.status === 'running') {
    applyProgress(tracker.update('whisper-transcription', 'indeterminate', {
      message: event.duration
        ? `Transcribing ${event.duration.toFixed(1)}s of audio; Whisper does not expose chunk completion`
        : 'Transcribing audio; Whisper does not expose chunk completion',
    }))
    return
  }
  if (event.phase === 'transcription' && event.status === 'complete') {
    applyProgress(tracker.update('whisper-transcription', 'active', {
      progress: 99,
      message: `Whisper completed ${event.chunks ?? 0} timed word segments`,
    }))
  }
}

async function executeRetranscription(songId: string, tracker: ProcessingProgress) {
  const song = library.find((item) => item.id === songId)
  if (!song) throw new Error('Song was not found in the local library.')

  const outputRoot = path.join(app.getPath('userData'), 'processed', song.id)
  const transcriptionInput = path.join(outputRoot, 'speech-retranscribe.wav')
  const transcriptOutput = path.join(outputRoot, 'lyrics.json')
  try {
    applyProgress(tracker.update('source-preparation', 'active', {
      progress: 0,
      message: 'Preparing the existing vocal stem for Whisper',
    }))
    const rawVocals = await findFile(outputRoot, 'vocals.wav')
    const vocalSource = rawVocals ?? song.vocalPath
    if (!vocalSource) throw new Error('The existing vocal output is unavailable.')
    await access(vocalSource)
    await runFfmpeg(resolveUnpacked(ffmpegInstaller.path), [
      '-y', '-i', vocalSource, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', transcriptionInput,
    ], (progress, message) => {
      applyProgress(tracker.update('source-preparation', progress === undefined ? 'indeterminate' : 'active', {
        progress,
        message,
      }))
    })
    await validateOutput(transcriptionInput, 44)
    applyProgress(tracker.update('source-preparation', 'complete', {
      message: 'Whisper-ready audio is validated',
    }))
    const transcript = await runTranscription(
      transcriptionInput,
      transcriptOutput,
      (event) => reportTranscriptionProgress(tracker, event),
      () => applyProgress(tracker.heartbeat()),
    )
    applyTranscript(song, transcript)
    applyProgress(tracker.update('lyrics', 'active', {
      message: 'Committing timed lyrics and language metadata',
    }))
    await validateOutput(transcriptOutput)
    applyProgress(tracker.update('lyrics', 'complete', {
      message: `${transcript.lines.length} timed lyric lines are committed`,
    }))
    const completed = tracker.complete(`${song.languageName} lyrics and timing refreshed`)
    applyProgress(completed, false)
    await saveLibrary()
    publish({ ...completed, song: hydrate(song) })
    return hydrate(song)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Lyrics and language refresh failed.'
    applyProgress(tracker.failCurrent(message))
    await saveLibrary()
    throw error
  }
}

async function executeFullProcessing(songId: string, tracker: ProcessingProgress) {
  const song = library.find((item) => item.id === songId)
  if (!song) throw new Error('Song was not found in the local library.')

  const outputRoot = path.join(app.getPath('userData'), 'processed', song.id)
  const separationInput = path.join(outputRoot, 'source.wav')
  const transcriptionInput = path.join(outputRoot, 'speech.wav')
  const transcriptOutput = path.join(outputRoot, 'lyrics.json')

  try {
    await mkdir(outputRoot, { recursive: true })
    await access(song.sourcePath)
    applyProgress(tracker.update('original', 'complete', {
      message: 'Original source is ready',
    }))
    applyProgress(tracker.update('source-preparation', 'active', {
      progress: 0,
      message: 'Preparing studio-quality separation audio',
    }))

    const ffmpegPath = resolveUnpacked(ffmpegInstaller.path)
    await runFfmpeg(ffmpegPath, [
      '-y', '-i', song.sourcePath, '-vn', '-ar', '44100', '-ac', '2', separationInput,
    ], (progress, message) => {
      applyProgress(tracker.update('source-preparation', progress === undefined ? 'indeterminate' : 'active', {
        progress: progress === undefined ? undefined : progress * 0.7,
        message: `Separation audio: ${message}`,
      }))
    })
    await runFfmpeg(ffmpegPath, [
      '-y', '-i', song.sourcePath, '-vn', '-ar', '16000', '-ac', '1', transcriptionInput,
    ], (progress, message) => {
      applyProgress(tracker.update('source-preparation', progress === undefined ? 'indeterminate' : 'active', {
        progress: progress === undefined ? undefined : 70 + progress * 0.3,
        message: `Transcription audio: ${message}`,
      }))
    })
    await Promise.all([validateOutput(separationInput, 44), validateOutput(transcriptionInput, 44)])
    applyProgress(tracker.update('source-preparation', 'complete', {
      message: 'Source conversion outputs are validated',
    }))

    applyProgress(tracker.update('demucs', 'indeterminate', {
      message: 'Loading the local Demucs model',
    }))
    const demucsCli = path.join(__dirname, 'demucs-runner.js')
    await runProcess(process.execPath, [
      demucsCli, separationInput, outputRoot, String(processingResources.cpuThreads),
    ], {
      env: { ELECTRON_RUN_AS_NODE: '1' },
      onStdoutLine: (line) => {
        const chunk = /^(\d+)\/(\d+)$/.exec(line.trim())
        if (chunk) {
          applyProgress(tracker.update('demucs', 'active', {
            progress: Number(chunk[1]) / Number(chunk[2]) * 100,
            message: `Demucs processed chunk ${chunk[1]} of ${chunk[2]}`,
          }))
          return
        }
        const stem = /Wrote:\s+.*[\\/](vocals|drums|bass|other)\.wav$/i.exec(line)
        if (stem) {
          const item = `stem-${stem[1].toLowerCase()}` as ProcessingItemId
          applyProgress(tracker.update(item, 'complete', {
            message: `${stem[1]} stem was written`,
          }))
        }
      },
      onHeartbeat: () => applyProgress(tracker.heartbeat()),
    })
    applyProgress(tracker.update('demucs', 'complete', {
      message: 'Demucs separation completed',
    }))

    const vocalsPath = await findFile(outputRoot, 'vocals.wav')
    if (!vocalsPath) throw new Error('The vocal stem was not produced by the local separation model.')
    const instrumentalPath = path.join(outputRoot, 'instrumental.m4a')
    const vocalPath = path.join(outputRoot, 'vocal.m4a')
    const enhancedPath = path.join(outputRoot, 'enhanced.m4a')
    const stemNames = ['drums.wav', 'bass.wav', 'other.wav']
    const discoveredStems = await Promise.all(stemNames.map((name) => findFile(outputRoot, name)))
    const missingStems = stemNames.filter((_name, index) => !discoveredStems[index])
    if (missingStems.length) {
      throw new Error(`The local separation model did not produce: ${missingStems.join(', ')}.`)
    }
    const stems = discoveredStems as string[]
    await Promise.all([
      validateOutput(vocalsPath, 44),
      ...stems.map((stem) => validateOutput(stem, 44)),
    ])
    for (const name of ['vocals', 'drums', 'bass', 'other'] as const) {
      applyProgress(tracker.update(`stem-${name}`, 'complete', {
        message: `${name} stem is validated`,
      }))
    }

    const mixInputs = stems.flatMap((stem) => ['-i', stem])
    applyProgress(tracker.update('instrumental', 'active', {
      progress: 0,
      message: 'Mixing instrumental output',
    }))
    await runFfmpeg(ffmpegPath, [
      '-y', ...mixInputs,
      '-filter_complex', `amix=inputs=${stems.length}:duration=longest,volume=${stems.length}`,
      '-c:a', 'aac', '-b:a', '256k', instrumentalPath,
    ], (progress, message) => applyProgress(tracker.update(
      'instrumental',
      progress === undefined ? 'indeterminate' : 'active',
      { progress, message },
    )))
    await validateOutput(instrumentalPath)
    applyProgress(tracker.update('instrumental', 'complete', {
      message: 'Instrumental output is validated',
    }))

    applyProgress(tracker.update('vocal', 'active', {
      progress: 0,
      message: 'Improving vocal presence and clarity',
    }))
    await runFfmpeg(ffmpegPath, [
      '-y', '-i', vocalsPath,
      '-af',
      'highpass=f=80,lowpass=f=14500,equalizer=f=3000:t=q:w=1.2:g=2.5,acompressor=threshold=-18dB:ratio=2.5:attack=15:release=180:makeup=2,loudnorm=I=-16:TP=-1.5:LRA=9',
      '-ar', '44100', '-c:a', 'aac', '-b:a', '256k', vocalPath,
    ], (progress, message) => applyProgress(tracker.update(
      'vocal',
      progress === undefined ? 'indeterminate' : 'active',
      { progress, message },
    )))
    await validateOutput(vocalPath)
    applyProgress(tracker.update('vocal', 'complete', {
      message: 'Vocal output is validated',
    }))
    applyProgress(tracker.update('enhanced', 'active', {
      progress: 0,
      message: 'Mixing enhanced output',
    }))
    await runFfmpeg(ffmpegPath, [
      '-y', '-i', instrumentalPath, '-i', vocalPath,
      '-filter_complex',
      "amix=inputs=2:duration=longest:weights='0.9 1.15',volume=1.8,alimiter=limit=0.95",
      '-c:a', 'aac', '-b:a', '256k', enhancedPath,
    ], (progress, message) => applyProgress(tracker.update(
      'enhanced',
      progress === undefined ? 'indeterminate' : 'active',
      { progress, message },
    )))
    await validateOutput(enhancedPath)
    applyProgress(tracker.update('enhanced', 'complete', {
      message: 'Enhanced output is validated',
    }))

    const transcript = await runTranscription(
      transcriptionInput,
      transcriptOutput,
      (event) => reportTranscriptionProgress(tracker, event),
      () => applyProgress(tracker.heartbeat()),
    )
    await Promise.all([
      access(song.sourcePath),
      access(instrumentalPath),
      access(vocalPath),
      access(enhancedPath),
    ])

    song.instrumentalPath = instrumentalPath
    song.instrumentalUrl = toPlayableUrl(instrumentalPath)
    song.vocalPath = vocalPath
    song.vocalUrl = toPlayableUrl(vocalPath)
    song.enhancedPath = enhancedPath
    song.enhancedUrl = toPlayableUrl(enhancedPath)
    applyTranscript(song, transcript)
    applyProgress(tracker.update('lyrics', 'active', {
      message: 'Committing timed lyrics and output metadata',
    }))
    await validateOutput(transcriptOutput)
    applyProgress(tracker.update('lyrics', 'complete', {
      message: `${transcript.lines.length} timed lyric lines are committed`,
    }))
    const completed = tracker.complete('All four audio versions and timed lyrics are ready')
    applyProgress(completed, false)
    await saveLibrary()
    publish({ ...completed, song: hydrate(song) })
    return hydrate(song)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Local AI processing failed.'
    applyProgress(tracker.failCurrent(message))
    await saveLibrary()
    throw error
  }
}

async function executeResumableProcessing(
  songId: string,
  requested: readonly DeliverableId[],
  tracker: ProcessingProgress,
) {
  const song = library.find((item) => item.id === songId)
  if (!song) throw new Error('Song was not found in the local library.')

  const inspected = await inspectDeliverables(song)
  const plan = computeMergedRetryPlan(requested, inspected.valid)
  const planned = new Set(plan)
  const ffmpegPath = resolveUnpacked(ffmpegInstaller.path)
  let paths = outputPaths(song)
  let stems = inspected.stems
  let current: DeliverableId = requested[0] ?? 'original'

  let initialized: ProcessUpdate | undefined
  for (const id of deliverableIds) {
    if (!planned.has(id) && inspected.valid.has(id)) {
      const progressId = id as ProcessingItemId
      try {
        initialized = tracker.update(progressId, 'complete', { message: 'Validated existing artifact for reuse' })
        applyProgress(initialized, false)
      } catch {
        // Some durable deliverables are represented by another progress item.
      }
    } else if (planned.has(id) && outcome(song, id).state !== 'ready') {
      setOutcome(song, id, 'queued')
    }
  }
  await saveLibrary()
  if (initialized) publish({ ...initialized, song: hydrate(song) })

  const activate = (id: DeliverableId, message: string) => {
    current = id
    setOutcome(song, id, 'active')
    applyProgress(tracker.update(id as ProcessingItemId, 'active', { progress: 0, message }))
  }
  const ready = async (
    id: DeliverableId,
    artifacts: ArtifactFingerprint[],
    message: string,
    diagnostics?: ProcessingDiagnostics,
  ) => {
    setOutcome(song, id, 'ready', { artifacts, diagnostics })
    const completed = tracker.update(id as ProcessingItemId, 'complete', { message, diagnostics })
    applyProgress(completed, false)
    try {
      await saveLibrary()
    } catch (error) {
      setOutcome(song, id, 'failed', {
        failure: componentFailure(id, `Could not persist ${id}: ${
          error instanceof Error ? error.message : String(error)
        }`),
      })
      throw error
    }
    publish({ ...completed, song: hydrate(song) })
  }

  try {
    await mkdir(paths.root, { recursive: true })
    for (const id of plan) {
      if (id.startsWith('stem-') && outcome(song, id).state === 'ready') continue
      if (id === 'original') {
        activate(id, 'Validating original source')
        await ready(id, [await fingerprint(song.sourcePath)], 'Original source is ready')
        continue
      }
      if (id === 'source-preparation') {
        activate(id, 'Preparing separation and transcription audio')
        triggerQaFailure(song.id, 'source-preparation')
        await runFfmpegAtomic(ffmpegPath, [
          '-y', '-i', song.sourcePath, '-vn', '-ar', '44100', '-ac', '2', paths.source,
        ], paths.source, (progress, message) => applyProgress(tracker.update(id,
          progress === undefined ? 'indeterminate' : 'active',
          { progress: progress === undefined ? undefined : progress * 0.7, message: `Separation audio: ${message}` },
        )))
        await runFfmpegAtomic(ffmpegPath, [
          '-y', '-i', song.sourcePath, '-vn', '-ar', '16000', '-ac', '1', paths.speech,
        ], paths.speech, (progress, message) => applyProgress(tracker.update(id,
          progress === undefined ? 'indeterminate' : 'active',
          { progress: progress === undefined ? undefined : 70 + progress * 0.3, message: `Transcription audio: ${message}` },
        )))
        await ready(id, [
          await fingerprint(paths.source, 44),
          await fingerprint(paths.speech, 44),
        ], 'Source preparation outputs are validated')
        continue
      }
      if (id === 'demucs') {
        activate(id, 'Loading the local Demucs model')
        triggerQaFailure(song.id, 'demucs')
        if (qaFailure?.songId === song.id && qaFailure.point === 'stem-other') {
          current = 'stem-other'
          triggerQaFailure(song.id, 'stem-other')
        }
        const temporaryRoot = path.join(paths.root, `.demucs-${process.pid}-${Date.now()}`)
        await mkdir(temporaryRoot, { recursive: true })
        try {
          if (privateQaHooksEnabled && qaFixtureAiEnabled) {
            for (const name of ['vocals', 'drums', 'bass', 'other'] as const) {
              await copyFile(paths.source, path.join(temporaryRoot, `${name}.wav`))
            }
          } else {
            const demucsCli = path.join(__dirname, 'demucs-runner.js')
            await runProcess(process.execPath, [
              demucsCli, paths.source, temporaryRoot, String(processingResources.cpuThreads),
            ], {
              env: { ELECTRON_RUN_AS_NODE: '1' },
              onStdoutLine: (line) => {
                const chunk = /^(\d+)\/(\d+)$/.exec(line.trim())
                if (chunk) {
                  applyProgress(tracker.update('demucs', 'active', {
                    progress: Number(chunk[1]) / Number(chunk[2]) * 100,
                    message: `Demucs processed chunk ${chunk[1]} of ${chunk[2]}`,
                  }))
                }
              },
              onHeartbeat: () => applyProgress(tracker.heartbeat()),
            })
          }
          const generated = {} as Record<'vocals' | 'drums' | 'bass' | 'other', string>
          for (const name of ['vocals', 'drums', 'bass', 'other'] as const) {
            current = `stem-${name}`
            const generatedPath = await findFile(temporaryRoot, `${name}.wav`)
            if (!generatedPath) {
              throw new Error(`Demucs did not produce the ${name} stem.`)
            }
            await fingerprint(generatedPath, 44)
            generated[name] = generatedPath
          }
          await mkdir(path.dirname(paths.stems.vocals), { recursive: true })
          for (const name of ['vocals', 'drums', 'bass', 'other'] as const) {
            await replaceFile(generated[name], paths.stems[name])
          }
          stems = paths.stems
          const stemArtifacts: ArtifactFingerprint[] = []
          for (const name of ['vocals', 'drums', 'bass', 'other'] as const) {
            current = `stem-${name}`
            const artifact = await fingerprint(stems[name], 44)
            stemArtifacts.push(artifact)
            await ready(`stem-${name}`, [artifact], `${name} stem is validated`)
          }
          current = 'demucs'
          await ready('demucs', stemArtifacts, 'Demucs separation completed')
        } finally {
          await rm(temporaryRoot, { recursive: true, force: true })
        }
        continue
      }
      if (id === 'instrumental') {
        activate(id, 'Mixing instrumental output')
        const inputs = [stems.drums, stems.bass, stems.other].flatMap((stem) => ['-i', stem])
        await runFfmpegAtomic(ffmpegPath, [
          '-y', ...inputs,
          '-filter_complex', "amix=inputs=3:duration=longest,volume=3",
          '-c:a', 'aac', '-b:a', '256k', paths.instrumental,
        ], paths.instrumental, (progress, message) => applyProgress(tracker.update(id,
          progress === undefined ? 'indeterminate' : 'active', { progress, message },
        )))
        song.instrumentalPath = paths.instrumental
        await ready(id, [await fingerprint(paths.instrumental, 44)], 'Instrumental output is validated')
        continue
      }
      if (id === 'vocal') {
        activate(id, 'Improving vocal presence and clarity')
        await runFfmpegAtomic(ffmpegPath, [
          '-y', '-i', stems.vocals,
          '-af', 'highpass=f=80,lowpass=f=14500,equalizer=f=3000:t=q:w=1.2:g=2.5,acompressor=threshold=-18dB:ratio=2.5:attack=15:release=180:makeup=2,loudnorm=I=-16:TP=-1.5:LRA=9',
          '-ar', '44100', '-c:a', 'aac', '-b:a', '256k', paths.vocal,
        ], paths.vocal, (progress, message) => applyProgress(tracker.update(id,
          progress === undefined ? 'indeterminate' : 'active', { progress, message },
        )))
        song.vocalPath = paths.vocal
        await ready(id, [await fingerprint(paths.vocal, 44)], 'Vocal output is validated')
        continue
      }
      if (id === 'enhanced') {
        activate(id, 'Measuring Vocal with EBU R128')
        triggerQaFailure(song.id, 'enhanced')
        const vocalMetrics = await measureLoudness(paths.vocal)
        applyProgress(tracker.update(id, 'active', {
          progress: 10,
          message: `Vocal measured ${vocalMetrics.integratedLufs?.toFixed(1) ?? 'silent'} LUFS, `
            + `${vocalMetrics.truePeakDbtp?.toFixed(1) ?? 'no finite'} dBTP`,
        }))
        const instrumentalMetrics = await measureLoudness(paths.instrumental)
        const balance = chooseEnhancementPlan(vocalMetrics, instrumentalMetrics)
        applyProgress(tracker.update(id, 'active', {
          progress: 20,
          message: `Balance selected: Vocal ${balance.vocalGainDb.toFixed(1)} dB, `
            + `Instrumental ${balance.instrumentalGainDb.toFixed(1)} dB`
            + `${balance.cleanupApplied ? '; mild measured-noise cleanup enabled' : ''}`,
        }))
        const premixPath = path.join(paths.root, `.enhanced-premix-${process.pid}.m4a`)
        const enhancedCandidate = path.join(paths.root, `.enhanced-candidate-${process.pid}.m4a`)
        try {
          await runFfmpegAtomic(ffmpegPath, [
            '-y', '-i', paths.vocal, '-i', paths.instrumental,
            '-filter_complex', balance.mixFilter,
            '-map', '[enhanced]',
            '-c:a', 'aac', '-b:a', '256k', premixPath,
          ], premixPath, (progress, message) => applyProgress(tracker.update(id,
            progress === undefined ? 'indeterminate' : 'active',
            { progress: progress === undefined ? undefined : 20 + progress * 0.45, message },
          )))
          const premixMetrics = await measureLoudness(premixPath)
          const master = createMasterFilter(premixMetrics)
          applyProgress(tracker.update(id, 'active', {
            progress: 70,
            message: master.caveat ?? `Applying two-pass ${-16} LUFS / ${-1.5} dBTP master`,
          }))
          await runFfmpegAtomic(ffmpegPath, [
            '-y', '-i', premixPath,
            '-af', master.filter,
            '-ar', '44100', '-c:a', 'aac', '-b:a', '256k', enhancedCandidate,
          ], enhancedCandidate, (progress, message) => applyProgress(tracker.update(id,
            progress === undefined ? 'indeterminate' : 'active',
            { progress: progress === undefined ? undefined : 70 + progress * 0.25, message },
          )))
          const outputMetrics = await measureLoudness(enhancedCandidate)
          if (outputMetrics.truePeakDbtp !== null && outputMetrics.truePeakDbtp > -1.35) {
            throw new Error(`Enhanced true peak ${outputMetrics.truePeakDbtp.toFixed(2)} dBTP exceeds the -1.5 dBTP ceiling tolerance.`)
          }
          if (!master.caveat && (outputMetrics.integratedLufs === null
            || Math.abs(outputMetrics.integratedLufs - -16) > 1.5)) {
            throw new Error('Enhanced output did not reach the measured -16 LUFS target tolerance.')
          }
          const diagnostics = enhancementSummary({
            vocal: vocalMetrics,
            instrumental: instrumentalMetrics,
            premix: premixMetrics,
            output: outputMetrics,
            vocalGainDb: balance.vocalGainDb,
            instrumentalGainDb: balance.instrumentalGainDb,
            vocalFilters: balance.vocalFilters,
            instrumentalFilters: balance.instrumentalFilters,
            masterFilter: master.filter,
            cleanupApplied: balance.cleanupApplied,
            caveat: master.caveat,
          })
          await replaceFile(enhancedCandidate, paths.enhanced)
          song.enhancedPath = paths.enhanced
          await ready(
            id,
            [await fingerprint(paths.enhanced, 44)],
            `Enhanced ready: ${outputMetrics.integratedLufs?.toFixed(1) ?? 'silent'} LUFS, `
              + `${outputMetrics.truePeakDbtp?.toFixed(1) ?? 'no finite'} dBTP`,
            diagnostics,
          )
        } finally {
          await rm(premixPath, { force: true })
          await rm(enhancedCandidate, { force: true })
        }
        continue
      }
      if (id === 'whisper-transcription') {
        activate(id, 'Preparing the valid vocal output for Whisper')
        const retrySpeech = path.join(paths.root, 'speech-retry.wav')
        const input = planned.has('source-preparation') ? paths.speech : retrySpeech
        if (input === retrySpeech) {
          await runFfmpegAtomic(ffmpegPath, [
            '-y', '-i', paths.vocal, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', retrySpeech,
          ], retrySpeech, (progress, message) => applyProgress(tracker.update(id,
            progress === undefined ? 'indeterminate' : 'active',
            { progress: progress === undefined ? undefined : progress * 0.1, message },
          )))
        }
        applyProgress(tracker.update('whisper-model', 'indeterminate', {
          message: 'Loading the local Whisper model',
        }))
        triggerQaFailure(song.id, 'whisper-transcription')
        if (privateQaHooksEnabled && qaFixtureAiEnabled) {
          reportTranscriptionProgress(tracker, { phase: 'model', status: 'ready' })
          reportTranscriptionProgress(tracker, { phase: 'transcription', status: 'running' })
          const temporaryTranscript = `${paths.transcript}.${process.pid}.new`
          const fixtureChunks = qaTranscriptFixture === 'invalid'
            ? []
            : qaTranscriptFixture === 'fallback'
              ? [{ text: 'fallback lyric', timestamp: [-1, 1] as [number, number] }]
            : qaTranscriptFixture === 'corrected'
              ? [
                  { text: 'QA ', timestamp: [0, 1] as [number, number] },
                  { text: 'lyric', timestamp: [0.7, 1.5] as [number, number] },
                ]
              : [{ text: 'QA lyric', timestamp: [0, 1] as [number, number] }]
          const fixtureTiming = normalizeWhisperChunksWithDiagnostics(fixtureChunks, 2)
          await writeFile(temporaryTranscript, JSON.stringify({
            text: 'QA lyric',
            languageCode: 'en',
            languageName: 'English',
            languageSource: 'detected',
            lines: fixtureTiming.lines,
            timingDiagnostics: fixtureTiming.diagnostics,
          }), 'utf8')
          await replaceFile(temporaryTranscript, paths.transcript)
        } else {
          await runTranscription(
            input,
            paths.transcript,
            (event) => reportTranscriptionProgress(tracker, event),
            () => applyProgress(tracker.heartbeat()),
          )
        }
        const transcript: TranscriptionResult = JSON.parse(await readFile(paths.transcript, 'utf8'))
        const timingMessage = transcript.timingDiagnostics?.fallbackUsed
          ? `Whisper transcription is usable with fallback timing on ${transcript.timingDiagnostics.fallbackLineCount} line(s)`
          : 'Whisper transcription is validated'
        await ready(
          id,
          [await fingerprint(paths.transcript, 2, false)],
          timingMessage,
          transcript.timingDiagnostics,
        )
        continue
      }
      if (id === 'lyrics') {
        activate(id, 'Committing timed lyrics and language metadata')
        const transcript: unknown = JSON.parse(await readFile(paths.transcript, 'utf8'))
        if (!isTranscriptionResult(transcript)) throw new Error('Local Whisper AI produced invalid timed lyrics.')
        applyTranscript(song, transcript)
        await ready(id, [await fingerprint(paths.transcript, 2, false)],
          `${transcript.lines.length} timed lyric lines are committed`,
          transcript.timingDiagnostics)
      }
    }

    const finalInspection = await inspectDeliverables(song)
    song.processingFailure = undefined
    const allReady = deliverableIds.every((id) => finalInspection.valid.has(id))
    await saveLibrary()
    const completed = tracker.complete(allReady
      ? 'All four audio versions and timed lyrics are ready'
      : 'Requested component is ready; other components remain available or missing')
    if (!allReady) completed.stage = 'partial'
    const committedSong: Song = {
      ...song,
      processingStage: completed.stage,
      processingProgress: completed.progress,
      processingMessage: completed.message,
      processingDetails: completed.details,
      processingFailure: undefined,
    }
    try {
      await saveLibrary(committedSong, song.id)
    } catch (error) {
      const failure = componentFailure('library-save', `Final library commit failed: ${
        error instanceof Error ? error.message : String(error)
      }`)
      song.processingFailure = failure
      const failed = tracker.fail(current as ProcessingItemId, failure.message)
      failed.failure = failure
      applyProgress(failed)
      throw error
    }
    applyProgress(completed, false)
    publish({ ...completed, song: hydrate(song) })
    return hydrate(song)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Local AI processing failed.'
    const persistedFailure = song.processingFailure?.component === 'library-save'
      ? song.processingFailure
      : undefined
    const failure = persistedFailure ?? componentFailure(current, message)
    if (!persistedFailure) {
      setOutcome(song, current, 'failed', { failure })
      if (current.startsWith('stem-')) setOutcome(song, 'demucs', 'failed', { failure })
      const blocked = blockedByFailure(plan, current)
      for (const id of plan) {
        if (id === current || outcome(song, id).state === 'ready') continue
        const blockedBy = blocked[id]
        if (blockedBy?.length) {
          setOutcome(song, id, 'blocked', {
            blockedBy,
            failure: componentFailure(id, `Blocked because ${blockedBy.join(', ')} failed.`, {
              code: 'missing-dependency',
              dependency: blockedBy[0],
            }),
          })
        }
      }
    }
    song.processingFailure = failure
    const failed = tracker.fail(current as ProcessingItemId, message)
    if (['original', 'instrumental', 'vocal', 'enhanced']
      .some((id) => outcome(song, id as DeliverableId).state === 'ready')) {
      failed.stage = 'partial'
    }
    if (current.startsWith('stem-') && failed.details) {
      const demucs = failed.details.items.find((item) => item.id === 'demucs')
      if (demucs?.status === 'active' || demucs?.status === 'indeterminate') {
        demucs.status = 'error'
        demucs.error = message
      }
    }
    failed.failure = failure
    applyProgress(failed)
    await saveLibrary()
    throw error
  }
}

function scheduleProcessing(
  songId: string,
  operation: 'full' | 'lyrics' | 'retry',
  component: DeliverableId,
) {
  const song = library.find((item) => item.id === songId)
  if (!song) throw new Error('Song was not found in the local library.')
  const key = songId
  const existing = songProcessingPromises.get(songId)
  if (existing) {
    pendingProcessingTargets.add(songId, component)
    return existing
  }
  pendingProcessingTargets.add(songId, component)
  const tracker = new ProcessingProgress(songId, operation)
  let queuedSave: Promise<void> = Promise.resolve()
  const promise = processingScheduler.enqueue({
    key,
    onQueuePosition: (position) => {
      applyProgress(tracker.queued(position))
      queuedSave = saveLibrary()
    },
    run: async () => {
      await queuedSave
      let result: Song | undefined
      let currentTracker = tracker
      while (pendingProcessingTargets.hasPending(songId)) {
        const batch = pendingProcessingTargets.take(songId)
        result = await executeResumableProcessing(songId, batch, currentTracker)
        currentTracker = new ProcessingProgress(songId, 'retry')
      }
      return result ?? hydrate(song)
    },
  })
  songProcessingPromises.set(songId, promise)
  const cleanup = () => {
    pendingProcessingTargets.finish(songId)
    songProcessingPromises.delete(songId)
  }
  void promise.then(cleanup, cleanup)
  return promise
}

function processSong(songId: string) {
  const song = library.find((item) => item.id === songId)
  if (!song) throw new Error('Song was not found in the local library.')
  const component = song.processingFailure?.retryable ? song.processingFailure.component : 'original'
  if (component === 'library-save') return retryLibrarySave(song)
  return scheduleProcessing(songId, 'full', component)
}

function retranscribeSong(songId: string) {
  return scheduleProcessing(songId, 'lyrics', 'lyrics')
}

function retryLibrarySave(song: Song) {
  const existing = songProcessingPromises.get(song.id)
  if (existing) return existing
  const promise = processingScheduler.enqueue({
    key: song.id,
    onQueuePosition: (position) => {
      song.processingStage = 'queued'
      song.processingMessage = `Queued for local AI processing (position ${position})`
      void saveLibrary()
    },
    run: async () => {
      const inspection = await inspectDeliverables(song)
      const allReady = deliverableIds.every((id) => inspection.valid.has(id))
      const committed: Song = {
        ...song,
        processingStage: allReady ? 'complete' : 'partial',
        processingProgress: 100,
        processingMessage: allReady
          ? 'All four audio versions and timed lyrics are ready'
          : 'Available outputs are durably saved',
        processingFailure: undefined,
      }
      try {
        await saveLibrary(committed, song.id)
        Object.assign(song, committed)
        publish({
          songId: song.id,
          stage: committed.processingStage,
          progress: 100,
          message: committed.processingMessage!,
          details: committed.processingDetails,
          song: hydrate(song),
        })
        return hydrate(song)
      } catch (error) {
        const failure = componentFailure('library-save', `Final library commit failed: ${
          error instanceof Error ? error.message : String(error)
        }`)
        song.processingStage = 'error'
        song.processingProgress = Math.min(song.processingProgress, 99)
        song.processingMessage = failure.message
        song.processingFailure = failure
        await saveLibrary()
        throw error
      }
    },
  })
  songProcessingPromises.set(song.id, promise)
  const cleanup = () => songProcessingPromises.delete(song.id)
  void promise.then(cleanup, cleanup)
  return promise
}

async function retryDeliverable(request: RetryDeliverableRequest) {
  if (!request || typeof request.songId !== 'string' || !isProcessingComponentId(request.component)) {
    throw new Error('A valid song and deliverable component are required.')
  }
  const song = library.find((item) => item.id === request.songId)
  if (!song) throw new Error('Song was not found in the local library.')
  if (request.component === 'library-save') return retryLibrarySave(song)
  await inspectDeliverables(song)
  const target = request.component
  const current = outcome(song, target)
  if (current.state === 'active' || current.state === 'queued') {
    const existing = songProcessingPromises.get(song.id)
    if (existing) return existing
    throw new Error('That component is already processing.')
  }
  if (current.state === 'ready') {
    throw new Error('That component is already ready and does not need retrying.')
  }
  if (current.failure && !current.failure.retryable) {
    throw new Error(`This component cannot be retried safely: ${current.failure.message}`)
  }
  return scheduleProcessing(song.id, 'retry', target)
}

async function importSongs() {
  const options: Electron.OpenDialogOptions = {
    title: 'Add songs to Karaoke Studio',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Songs and videos', extensions: ['mp3', 'mp4'] }],
  }
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options)
  if (result.canceled) return library.map(hydrate)
  return addSongPaths(result.filePaths)
}

async function addSongPaths(filePaths: string[]) {
  const knownPaths = new Set(library.map((song) => song.sourcePath.toLowerCase()))
  for (const sourcePath of filePaths) {
    await access(sourcePath)
    const extension = path.extname(sourcePath).slice(1).toLowerCase()
    if (extension !== 'mp3' && extension !== 'mp4') {
      throw new Error(`Unsupported song format: ${path.basename(sourcePath)}`)
    }
    if (knownPaths.has(sourcePath.toLowerCase())) continue
    const id = randomUUID()
    library.unshift({
      id,
      title: path.basename(sourcePath, path.extname(sourcePath)),
      artist: 'Unknown artist',
      sourcePath,
      sourceUrl: mediaUrl(id, 'original', sourcePath) ?? '',
      format: extension as 'mp3' | 'mp4',
      addedAt: new Date().toISOString(),
      lyrics: [],
      lyricLanguage: defaultLyricLanguage(),
      languageCode: 'und',
      languageName: 'Unknown',
      languageSource: 'legacy',
      processingStage: 'idle',
      processingProgress: 0,
    })
  }
  await saveLibrary()
  return library.map(hydrate)
}

async function removeSong(id: string) {
  if (typeof id !== 'string' || !library.some((song) => song.id === id)) {
    throw new Error('The song no longer exists in the library.')
  }
  library = library.filter((song) => song.id !== id)
  for (const playlist of playlistStore.playlists) {
    const originalEntries = playlist.entries
    const currentIndex = originalEntries.findIndex((entry) => entry.id === playlist.currentEntryId)
    const removedCurrent = currentIndex >= 0 && originalEntries[currentIndex].songId === id
    const replacement = removedCurrent
      ? originalEntries.slice(currentIndex + 1).find((entry) => entry.songId !== id)
        ?? originalEntries.slice(0, currentIndex).reverse().find((entry) => entry.songId !== id)
      : undefined
    playlist.entries = playlist.entries.filter((entry) => entry.songId !== id)
    if (removedCurrent) {
      playlist.currentEntryId = replacement?.id
    }
    if (!playlist.entries.some((entry) => entry.id === playlist.currentEntryId)) {
      playlist.currentEntryId = undefined
    }
    touch(playlist)
  }
  await saveLibrary()
  await savePlaylists()
  return library.map(hydrate)
}

function registerPrivateProtocol() {
  protocol.handle('karaoke', async (request) => {
    const url = new URL(request.url)
    if (url.hostname === 'app') {
      const staticRoot = path.resolve(__dirname, '..', 'dist')
      const requestedPath = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1))
      const filePath = path.resolve(staticRoot, requestedPath)
      if (filePath !== staticRoot && !filePath.startsWith(`${staticRoot}${path.sep}`)) {
        return new Response('Forbidden', { status: 403 })
      }
      return net.fetch(pathToFileURL(filePath).href)
    }

    if (url.hostname === 'media') {
      const [, encodedId, mode] = url.pathname.split('/')
      const song = library.find((item) => item.id === decodeURIComponent(encodedId ?? ''))
      const mediaPath = mode === 'original'
        ? song?.sourcePath
        : mode === 'enhanced'
          ? song?.enhancedPath
          : mode === 'vocal'
            ? song?.vocalPath
            : mode === 'instrumental'
              ? song?.instrumentalPath
              : undefined
      if (!mediaPath) return new Response('Audio version not found.', { status: 404 })
      const file = await stat(mediaPath)
      const range = request.headers.get('range')
      const extension = path.extname(mediaPath).toLowerCase()
      const contentType = extension === '.mp3'
        ? 'audio/mpeg'
        : extension === '.wav'
          ? 'audio/wav'
          : extension === '.mp4'
            ? 'video/mp4'
            : 'audio/mp4'
      const headers = new Headers({
        'Accept-Ranges': 'bytes',
        'Content-Type': contentType,
      })

      let start = 0
      let end = file.size - 1
      let status = 200
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
        if (!match) return new Response('Invalid byte range.', { status: 416 })
        if (match[1]) start = Number(match[1])
        if (match[2]) end = Number(match[2])
        if (!match[1] && match[2]) start = Math.max(0, file.size - Number(match[2]))
        end = Math.min(end, file.size - 1)
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end) {
          return new Response('Unsatisfiable byte range.', {
            status: 416,
            headers: { 'Content-Range': `bytes */${file.size}` },
          })
        }
        status = 206
        headers.set('Content-Range', `bytes ${start}-${end}/${file.size}`)
      }
      headers.set('Content-Length', String(end - start + 1))
      if (request.method === 'HEAD') return new Response(null, { status, headers })
      const stream = Readable.toWeb(createReadStream(mediaPath, { start, end }))
      return new Response(stream as ReadableStream, { status, headers })
    }

    return new Response('Not found', { status: 404 })
  })
}

async function automateRenderedUi(command: AutomationCommand) {
  if (!mainWindow) throw new Error('The desktop window is not available.')
  if (!command.selector || !command.uiAction) throw new Error('A UI action and selector are required.')
  const selector = JSON.stringify(command.selector)
  const action = JSON.stringify(command.uiAction)
  const value = JSON.stringify(command.uiValue ?? '')
  return mainWindow.webContents.executeJavaScript(`
    (() => {
      const element = document.querySelector(${selector});
      if (${action} === 'exists') return { exists: element instanceof HTMLElement };
      if (!(element instanceof HTMLElement)) {
        throw new Error('Rendered UI element not found: ' + ${selector});
      }
      if (${action} === 'click') {
        element.click();
      } else if (${action} === 'double-click') {
        element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
        element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 2 }));
        element.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, detail: 2 }));
      } else if (${action} === 'set-value') {
        if (!(element instanceof HTMLInputElement)) {
          throw new Error('Rendered UI element is not an input: ' + ${selector});
        }
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        setter?.call(element, ${value});
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return {
        text: element.textContent?.trim() ?? '',
        ariaLabel: element.getAttribute('aria-label'),
        ariaSelected: element.getAttribute('aria-selected'),
        value: element instanceof HTMLInputElement ? element.value : undefined,
        media: element instanceof HTMLMediaElement ? {
          currentTime: element.currentTime,
          duration: element.duration,
          readyState: element.readyState,
          networkState: element.networkState,
          paused: element.paused,
          ended: element.ended,
          currentSrc: element.currentSrc,
          playingIntent: element.dataset.playbackIntent === 'true',
          pendingSeek: element.dataset.playbackPendingSeek
            ? JSON.parse(element.dataset.playbackPendingSeek)
            : undefined,
          sourceGeneration: Number(element.dataset.playbackGeneration || 0),
          mode: element.dataset.playbackMode,
          status: element.dataset.playbackStatus,
          eventSequence: element.dataset.playbackTrace
            ? JSON.parse(element.dataset.playbackTrace)
            : [],
        } : undefined,
        disabled: 'disabled' in element ? Boolean(element.disabled) : false,
        className: element.className,
      };
    })()
  `, true)
}

async function handleAutomation(command: AutomationCommand) {
  switch (command.action) {
    case 'status':
      {
        const playback = rendererPlaybackStatus
          && rendererPlaybackStatus.playlist?.transitionReason === 'restore'
          && rendererPlaybackStatus.songId
          && (rendererPlaybackStatus.status === 'idle' || rendererPlaybackStatus.status === 'loading')
          ? { ...rendererPlaybackStatus, status: 'paused' as const }
          : rendererPlaybackStatus
      return {
        version: app.getVersion(),
        window: mainWindow ? {
          visible: mainWindow.isVisible(),
          focused: mainWindow.isFocused(),
          title: mainWindow.getTitle(),
          url: mainWindow.webContents.getURL(),
        } : null,
        bridgeExpected: Boolean(mainWindow),
        activeJobs: processingScheduler.keys(),
        processingResources,
        playback,
        playlists: {
          selectedPlaylistId: playlistStore.selectedPlaylistId,
          activePlaylistId: rendererPlaybackStatus?.playlist?.activePlaylistId,
          currentEntryId: rendererPlaybackStatus?.playlist?.currentEntryId,
          nextEntryId: rendererPlaybackStatus?.playlist?.nextEntryId,
          transitionReason: rendererPlaybackStatus?.playlist?.transitionReason,
          transitionCount: rendererPlaybackStatus?.playlist?.transitionCount ?? 0,
          queueRevision: playlistRevision,
          revision: playlistRevision,
          diagnostic: playlistLoadDiagnostic,
          playlists: playlistStore.playlists.map((playlist) => ({
            id: playlist.id,
            name: playlist.name,
            kind: playlist.kind,
            currentEntryId: playlist.currentEntryId,
            entries: playlist.entries.map((entry) => ({ id: entry.id, songId: entry.songId })),
          })),
        },
        songs: library.map((song) => ({
          id: song.id,
          title: song.title,
          sourcePath: song.sourcePath,
          stage: song.processingStage,
          progress: song.processingProgress,
          message: song.processingMessage,
          details: song.processingDetails,
          deliverables: song.deliverables,
          failure: song.processingFailure,
          versions: {
            original: Boolean(song.sourcePath),
            enhanced: Boolean(song.enhancedPath),
            vocal: Boolean(song.vocalPath),
            instrumental: Boolean(song.instrumentalPath),
          },
        })),
      }
      }
    case 'add':
      if (!command.paths?.length) throw new Error('At least one MP3 or MP4 path is required.')
      return addSongPaths(command.paths)
    case 'inject-library':
      if (!Array.isArray(command.songs)) throw new Error('Fixture songs are required.')
      library = command.songs.map((song) => normalizeSong(song as Song))
      await saveLibrary()
      await mainWindow?.webContents.reload()
      return { injected: library.length }
    case 'qa-configure':
      if (!privateQaHooksEnabled) throw new Error('Private QA hooks are not enabled.')
      if (command.failurePoint === undefined) {
        qaFailure = undefined
      } else {
        if (!command.songId || ![
          'source-preparation',
          'demucs',
          'stem-other',
          'whisper-transcription',
          'enhanced',
          'save-library',
        ].includes(command.failurePoint)) throw new Error('A valid QA failure point and song are required.')
        qaFailure = {
          songId: command.songId,
          point: command.failurePoint as QaFailurePoint,
          message: typeof command.failureMessage === 'string' ? command.failureMessage : undefined,
        }
      }
      qaFixtureAiEnabled = command.enabled === true
      qaTranscriptFixture = command.transcriptFixture === 'invalid'
        || command.transcriptFixture === 'fallback'
        || command.transcriptFixture === 'corrected'
        ? command.transcriptFixture
        : undefined
      return {
        failure: qaFailure,
        fixtureAi: qaFixtureAiEnabled,
        transcriptFixture: qaTranscriptFixture,
      }
    case 'process':
      if (!command.songId) throw new Error('A song ID is required.')
      return processSong(command.songId)
    case 'retranscribe':
      if (!command.songId) throw new Error('A song ID is required.')
      return retranscribeSong(command.songId)
    case 'retry':
      if (!command.songId || !isProcessingComponentId(command.component)) {
        throw new Error('A song ID and valid component are required.')
      }
      return retryDeliverable({ songId: command.songId, component: command.component })
    case 'remove':
      if (!command.songId) throw new Error('A song ID is required.')
      return removeSong(command.songId)
    case 'control':
      if (!mainWindow) throw new Error('The desktop window is not available.')
      mainWindow.webContents.send('automation:control', command.value)
      return { accepted: true }
    case 'ui':
      return automateRenderedUi(command)
    case 'screenshot': {
      if (!mainWindow) throw new Error('The desktop window is not available.')
      if (mainWindow.isMinimized()) mainWindow.restore()
      if (!mainWindow.isVisible()) mainWindow.showInactive()
      const renderedState = await mainWindow.webContents.executeJavaScript(`new Promise((resolve) => {
        const finish = () => requestAnimationFrame(() => requestAnimationFrame(() => {
          const body = document.body
          const root = document.getElementById('root')
          resolve({
            readyState: document.readyState,
            bodyWidth: body?.scrollWidth ?? 0,
            bodyHeight: body?.scrollHeight ?? 0,
            rootChildren: root?.childElementCount ?? 0,
            visible: document.visibilityState === 'visible',
          })
        }))
        if (document.readyState === 'complete') finish()
        else window.addEventListener('load', finish, { once: true })
      })`, true) as {
        readyState: string
        bodyWidth: number
        bodyHeight: number
        rootChildren: number
        visible: boolean
      }
      if (renderedState.readyState !== 'complete'
        || renderedState.bodyWidth <= 0
        || renderedState.bodyHeight <= 0
        || renderedState.rootChildren <= 0
        || !renderedState.visible) {
        throw new Error(`Rendered UI was not capture-ready: ${JSON.stringify(renderedState)}`)
      }
      const screenshot = await mainWindow.webContents.capturePage()
      const png = screenshot.toPNG()
      if (screenshot.isEmpty() || png.byteLength === 0) {
        throw new Error(`Rendered UI capture was empty after readiness proof: ${JSON.stringify(renderedState)}`)
      }
      const outputPath = path.join(getDiagnosticsPath(), `screenshot-${Date.now()}.png`)
      await mkdir(getDiagnosticsPath(), { recursive: true })
      await writeFile(outputPath, png)
      return { path: outputPath, size: screenshot.getSize(), bytes: png.byteLength, renderedState }
    }
    case 'diagnostics':
      return {
        path: getDiagnosticsPath(),
        rendererErrors: [...rendererErrors],
        rendererErrorCount: rendererErrors.length,
      }
    default:
      throw new Error(`Unsupported automation action: ${command.action}`)
  }
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1060,
    minHeight: 700,
    backgroundColor: '#09090b',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#09090b',
      symbolColor: '#d4d4d8',
      height: 44,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.webContents.on('did-fail-load', (_event, code, description, validatedUrl) => {
    recordRendererError('did-fail-load', `Renderer failed to load ${validatedUrl} (${code})`, description)
  })
  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    recordRendererError('preload-error', `Preload failed: ${preloadPath}`, error)
  })
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    recordRendererError('render-process-gone', `Renderer process ended: ${details.reason}`, details)
  })
  mainWindow.webContents.on('console-message', (_event, level, message, lineNumber, sourceId) => {
    if (level >= 3) {
      recordRendererError('console', `Renderer console: ${message}`, `${sourceId}:${lineNumber}`)
    }
  })

  await mainWindow.loadURL('karaoke://app/index.html')
  logDiagnostic('INFO', 'Desktop UI loaded', mainWindow.webContents.getURL())
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()

app.on('second-instance', () => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
})

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return
  logDiagnostic('INFO', `Karaoke Studio ${app.getVersion()} starting`)
  logDiagnostic(
    'INFO',
    `Local AI is serial and capped at ${processingResources.cpuThreads} of `
      + `${processingResources.logicalCores} available logical CPU cores. `
      + processingResources.gpuLimitation,
  )
  const recoveredInterruptedProcessing = await loadLibrary()
  logDiagnostic('INFO', `Loaded ${library.length} library songs from ${getLibraryPath()}`)
  if (recoveredInterruptedProcessing) await saveLibrary()
  await loadPlaylists()
  registerPrivateProtocol()

  ipcMain.handle('library:get', () => library.map(hydrate))
  ipcMain.handle('library:import', () => importSongs())
  ipcMain.handle('library:remove', (_event, id: string) => queuePlaylistMutation(() => removeSong(id)))
  ipcMain.handle('ai:process', (_event, id: string) => processSong(id))
  ipcMain.handle('ai:retranscribe', (_event, id: string) => retranscribeSong(id))
  ipcMain.handle('ai:retry-deliverable', (_event, request: RetryDeliverableRequest) =>
    retryDeliverable(request))
  ipcMain.handle('playlists:get', () => playlistStore)
  ipcMain.handle('playlists:create', (_event, request: { name?: unknown }) =>
    queuePlaylistMutation(() => createPlaylist(request?.name)))
  ipcMain.handle('playlists:rename', (_event, request) =>
    queuePlaylistMutation(() => renamePlaylist(request ?? {})))
  ipcMain.handle('playlists:delete', (_event, request) =>
    queuePlaylistMutation(() => deletePlaylist(request ?? {})))
  ipcMain.handle('playlists:add-song', (_event, request) =>
    queuePlaylistMutation(() => addSongToPlaylist(request ?? {})))
  ipcMain.handle('playlists:remove-entry', (_event, request) =>
    queuePlaylistMutation(() => removePlaylistEntry(request ?? {})))
  ipcMain.handle('playlists:archive-queue-entry', (_event, request) =>
    queuePlaylistMutation(() => archiveQueueEntry(request ?? {})))
  ipcMain.handle('playlists:clear', (_event, request: PlaylistMutationRequest) =>
    queuePlaylistMutation(() => clearPlaylist(request ?? {})))
  ipcMain.handle('playlists:select', (_event, request: { playlistId?: unknown }) =>
    queuePlaylistMutation(() => selectPlaylist(request?.playlistId)))
  ipcMain.handle('playlists:set-cursor', (_event, request) =>
    queuePlaylistMutation(() => setPlaylistCursor(request ?? {})))
  ipcMain.handle('file:reveal', async (_event, filePath: string) => {
    shell.showItemInFolder(filePath)
  })
  ipcMain.handle('diagnostics:open', async () => {
    await mkdir(getDiagnosticsPath(), { recursive: true })
    await shell.openPath(getDiagnosticsPath())
  })
  ipcMain.handle('diagnostics:renderer-error', (_event, message: string, detail?: string) => {
    recordRendererError('renderer-exception', `Renderer exception: ${message}`, detail)
  })
  ipcMain.on('automation:renderer-status', (_event, status: PlaybackAutomationStatus) => {
    rendererPlaybackStatus = status
  })

  await createWindow()
  if (privateAutomationEnabled) {
    startAutomationServer(handleAutomation)
    logDiagnostic('INFO', 'Private automation enabled')
  }
  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

process.on('uncaughtException', (error) => {
  logDiagnostic('ERROR', 'Uncaught main-process exception', error)
})

process.on('unhandledRejection', (reason) => {
  logDiagnostic('ERROR', 'Unhandled main-process rejection', reason)
})

app.on('child-process-gone', (_event, details) => {
  logDiagnostic('ERROR', `Child process ended: ${details.type} / ${details.reason}`, details)
})
