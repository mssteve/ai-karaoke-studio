export { replaceTextFile } from './atomic-file.js'
import type {
  LyricLine,
  LyricRematchStatus,
  LyricTextSource,
  LyricTimingMethod,
  LyricsDocument,
  Song,
  TranscriptWord,
  TranscriptionResult,
  UpdateLyricsRequest,
  UpdateLyricsResult,
} from './types.js'
import {
  alignUserLinesToAsrWords,
  lyricLineWeight,
  MINIMUM_FRAGMENT_DURATION_SECONDS,
  validateLyricLines,
} from './transcription-timing.js'

const FIT_ERROR = 'Edited lyrics cannot fit a 40ms timeline.'
const LRC_ERROR = 'LRC timestamps are incomplete or invalid.'

export interface LyricUpdateDependencies {
  isBusy: (songId: string) => boolean
  readSong: (songId: string) => Song | undefined
  writeSong: (song: Song) => Promise<void>
  readLyrics: (songId: string) => Promise<string | null>
  writeLyrics: (songId: string, contents: string) => Promise<void>
  deleteLyrics: (songId: string) => Promise<void>
  hasVocals: (song: Song) => Promise<boolean>
}

export interface LyricRematchDependencies {
  readSong: (songId: string) => Song | undefined
  writeSong: (song: Song) => Promise<void>
  readLyrics: (songId: string) => Promise<string | null>
  writeLyrics: (songId: string, contents: string) => Promise<void>
  recognizeWords: (song: Song) => Promise<TranscriptWord[]>
  mediaDuration?: (song: Song) => number | undefined
  publishFailure?: (song: Song) => void
}

interface ParsedLyricEdit {
  text: string
  lines: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function normalizeLyricOwnership(song: {
  lyricTextSource?: unknown
  lyricsRevision?: unknown
  lyricTimingMethod?: unknown
  lyricRematchStatus?: unknown
  lyricRematchMessage?: unknown
}): Pick<Song, 'lyricTextSource' | 'lyricsRevision' | 'lyricTimingMethod' | 'lyricRematchStatus' | 'lyricRematchMessage'> {
  const lyricTextSource: LyricTextSource = song.lyricTextSource === 'user' || song.lyricTextSource === 'engine'
    ? song.lyricTextSource
    : 'engine'
  const lyricsRevision = typeof song.lyricsRevision === 'number'
    && Number.isInteger(song.lyricsRevision)
    && song.lyricsRevision >= 0
    ? song.lyricsRevision
    : 0
  const lyricTimingMethod: LyricTimingMethod = song.lyricTimingMethod === 'whisper-grouped'
    || song.lyricTimingMethod === 'preserved-line-times'
    || song.lyricTimingMethod === 'text-to-whisper-word-rematch'
    ? song.lyricTimingMethod
    : 'whisper-grouped'
  const lyricRematchStatus: LyricRematchStatus = song.lyricRematchStatus === 'none'
    || song.lyricRematchStatus === 'pending'
    || song.lyricRematchStatus === 'complete'
    || song.lyricRematchStatus === 'failed'
    || song.lyricRematchStatus === 'skipped'
    ? song.lyricRematchStatus
    : 'none'
  const lyricRematchMessage = typeof song.lyricRematchMessage === 'string' && song.lyricRematchMessage.trim()
    ? song.lyricRematchMessage
    : undefined
  return { lyricTextSource, lyricsRevision, lyricTimingMethod, lyricRematchStatus, lyricRematchMessage }
}

export function shouldResumePendingRematch(song: Pick<Song, 'lyricTextSource' | 'lyricRematchStatus'>) {
  return song.lyricTextSource === 'user' && song.lyricRematchStatus === 'pending'
}

function finiteTime(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function copyLines(lines: readonly LyricLine[]): LyricLine[] {
  return lines.map((line) => ({ text: line.text, start: line.start, end: line.end }))
}

function mediaDurationOf(song: Song) {
  return typeof song.duration === 'number' && Number.isFinite(song.duration) && song.duration > 0
    ? song.duration
    : undefined
}

function priorLines(song: Song) {
  return Array.isArray(song.lyrics)
    ? song.lyrics.filter((line) => line
      && typeof line.text === 'string'
      && Number.isFinite(line.start)
      && Number.isFinite(line.end))
    : []
}

export function parseEditedLyrics(text: unknown): ParsedLyricEdit {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('Edited lyrics are empty.')
  }
  const physical = text.split(/\r?\n/)
  let sawLrc = false
  let sawPlain = false
  const lines: string[] = []
  for (const physicalLine of physical) {
    if (physicalLine.trim().length === 0) continue
    const classified = classifyLyricLine(physicalLine)
    if (classified.kind === 'metadata') continue
    if (classified.kind === 'invalid') throw new Error(LRC_ERROR)
    if (classified.kind === 'lrc') {
      sawLrc = true
      if (classified.text.trim().length === 0) continue
      lines.push(classified.text)
      continue
    }
    sawPlain = true
    lines.push(classified.text)
  }
  if (sawLrc && sawPlain) throw new Error(LRC_ERROR)
  if (!lines.length) throw new Error('Edited lyrics contain no usable lines.')
  return { text, lines }
}

function classifyLyricLine(line: string):
  | { kind: 'metadata' }
  | { kind: 'plain'; text: string }
  | { kind: 'lrc'; text: string }
  | { kind: 'invalid' } {
  const metadata = /^\[([A-Za-z][A-Za-z0-9]*):(.*)\]$/.exec(line.trim())
  if (metadata && metadata[1].toLowerCase() === 'offset') {
    return /^[+-]?\d+$/.test(metadata[2].trim()) ? { kind: 'metadata' } : { kind: 'invalid' }
  }
  if (metadata && !hasTimestampAttempt(line)) return { kind: 'metadata' }
  if (!hasTimestampAttempt(line)) return { kind: 'plain', text: line }
  const parsed = parseLrcBody(line)
  if (parsed === undefined) return { kind: 'invalid' }
  return { kind: 'lrc', text: parsed }
}

function hasTimestampAttempt(line: string) {
  return /[\[<]\s*[+-]?\d*\s*:/.test(line)
}

function parseLrcBody(line: string) {
  let rest = line
  let timestamps = 0
  while (true) {
    const match = /^\[(\d+):(\d{2})(?:\.(\d{1,3}))?\]/.exec(rest)
    if (!match) break
    if (!validClock(match[1], match[2], match[3])) return undefined
    timestamps += 1
    rest = rest.slice(match[0].length)
  }
  if (timestamps !== 1) return undefined
  return stripCompleteWordTags(rest)
}

function validClock(minutes: string, seconds: string, fraction?: string) {
  if (!/^\d{1,3}$/.test(minutes) || Number(seconds) >= 60) return false
  if (fraction !== undefined && !/^\d{1,3}$/.test(fraction)) return false
  return true
}

function stripCompleteWordTags(value: string) {
  let invalid = false
  const stripped = value.replace(/<(\d+):(\d{2})(?:\.(\d{1,3}))?>/g, (_tag, minutes, seconds, fraction) => {
    if (!validClock(minutes, seconds, fraction)) invalid = true
    return ''
  })
  return invalid || hasTimestampAttempt(stripped) ? undefined : stripped
}

function assertFits(lines: readonly LyricLine[], mediaDuration?: number) {
  try {
    validateLyricLines(lines, mediaDuration)
  } catch {
    throw new Error(FIT_ERROR)
  }
}

export function preserveLyricTiming(
  texts: readonly string[],
  prior: readonly LyricLine[],
  mediaDuration?: number,
): LyricLine[] {
  if (!texts.length) throw new Error('Edited lyrics contain no usable lines.')
  const usablePrior = prior.filter((line) => Number.isFinite(line.start) && Number.isFinite(line.end))
  if (usablePrior.length === texts.length) {
    const copied = texts.map((text, index) => ({
      text,
      start: usablePrior[index].start,
      end: usablePrior[index].end,
    }))
    try {
      validateLyricLines(copied, mediaDuration)
      return copied
    } catch {
      // Prior timing is not a valid bounded timeline; fall through to redistribution.
    }
  }
  if (usablePrior.length) {
    const start = usablePrior[0].start
    const end = usablePrior[usablePrior.length - 1].end
    return distributeTiming(texts, start, end, mediaDuration)
  }
  if (mediaDuration === undefined) {
    const lines = texts.map((text, index) => ({
      text,
      start: index * MINIMUM_FRAGMENT_DURATION_SECONDS,
      end: (index + 1) * MINIMUM_FRAGMENT_DURATION_SECONDS,
    }))
    assertFits(lines)
    return lines
  }
  return distributeTiming(texts, 0, mediaDuration, mediaDuration)
}

function distributeTiming(
  texts: readonly string[],
  start: number,
  end: number,
  mediaDuration?: number,
) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    throw new Error(FIT_ERROR)
  }
  const startMs = Math.round(start * 1000)
  const endMs = Math.round(end * 1000)
  const boundedEndMs = mediaDuration === undefined
    ? endMs
    : Math.min(endMs, Math.round(mediaDuration * 1000))
  const span = boundedEndMs - startMs
  const minimum = Math.round(MINIMUM_FRAGMENT_DURATION_SECONDS * 1000)
  if (span < texts.length * minimum) throw new Error(FIT_ERROR)
  const weights = texts.map((text) => lyricLineWeight(text))
  let cursor = startMs
  let remaining = span
  let remainingWeight = weights.reduce((total, weight) => total + weight, 0)
  const lines = texts.map((text, index) => {
    const last = index === texts.length - 1
    const slotsAfter = texts.length - index - 1
    const fair = remaining * weights[index] / remainingWeight
    const duration = last
      ? remaining
      : Math.min(remaining - slotsAfter * minimum, Math.max(minimum, Math.round(fair)))
    const line = {
      text,
      start: cursor / 1000,
      end: (cursor + duration) / 1000,
    }
    cursor += duration
    remaining -= duration
    remainingWeight -= weights[index]
    return line
  })
  assertFits(lines, mediaDuration)
  return lines
}

export function lyricsDocumentFromSong(song: Song, extras: Partial<LyricsDocument> = {}): LyricsDocument {
  const ownership = normalizeLyricOwnership(song)
  return {
    text: song.lyricEditorText ?? song.lyrics.map((line) => line.text).join('\n'),
    lines: copyLines(song.lyrics),
    language: song.languageName,
    languageCode: song.languageCode,
    languageName: song.languageName,
    languageSource: song.languageSource,
    timingMethod: extras.timingMethod ?? ownership.lyricTimingMethod,
    rematch: extras.rematch ?? {
      status: ownership.lyricRematchStatus,
      message: ownership.lyricRematchMessage,
    },
    ...extras,
    source: extras.source ?? ownership.lyricTextSource,
    revision: extras.revision ?? ownership.lyricsRevision,
  }
}

export function parseLyricsDocument(value: unknown): LyricsDocument | undefined {
  if (!isRecord(value) || typeof value.text !== 'string' || !Array.isArray(value.lines)) return undefined
  if (!value.lines.every((line) => isRecord(line)
    && typeof line.text === 'string'
    && typeof line.start === 'number'
    && typeof line.end === 'number'
    && Number.isFinite(line.start)
    && Number.isFinite(line.end))) return undefined
  return value as unknown as LyricsDocument
}

export function reapplyLyricsDocument(song: Song, document: LyricsDocument) {
  const fileSource = document.source === 'user' || document.source === 'engine' ? document.source : undefined
  const source = fileSource ?? (song.lyricTextSource === 'user' ? 'user' : 'engine')
  const lines = copyLines(document.lines)
  if (source !== 'user') {
    const languageCode = typeof document.languageCode === 'string' ? document.languageCode.trim() : ''
    const languageName = document.languageName?.trim() || document.language?.trim() || ''
    if (!languageCode || languageCode === 'und' || !languageName || !lines.length) {
      throw new Error('Local Whisper AI could not identify the original lyric language.')
    }
    song.languageCode = languageCode
    song.languageName = languageName
    song.languageSource = document.languageSource === 'user' ? 'user' : 'detected'
    song.lyricLanguage = {
      languageCode,
      languageName,
      languageSource: song.languageSource,
    }
  }
  song.lyrics = lines
  song.lyricEditorText = document.text
  song.lyricTextSource = source
  const revision = finiteTime(document.revision)
  song.lyricsRevision = revision !== undefined && Number.isInteger(revision) && revision >= 0
    ? revision
    : normalizeLyricOwnership(song).lyricsRevision
  song.lyricTimingMethod = document.timingMethod === 'preserved-line-times'
    || document.timingMethod === 'text-to-whisper-word-rematch'
    || document.timingMethod === 'whisper-grouped'
    ? document.timingMethod
    : (source === 'user' ? 'preserved-line-times' : 'whisper-grouped')
  const status = document.rematch?.status
  song.lyricRematchStatus = status === 'pending' || status === 'complete' || status === 'failed'
    || status === 'skipped' || status === 'none'
    ? status
    : 'none'
  song.lyricRematchMessage = typeof document.rematch?.message === 'string' && document.rematch.message.trim()
    ? document.rematch.message
    : undefined
  return song
}

export function protectUserLyrics(song: Song) {
  return normalizeLyricOwnership(song).lyricTextSource === 'user'
}

function skippedMessage() {
  return 'Rematch skipped because no vocal stem is available.'
}

function pendingMessage() {
  return 'Lyric timing rematch is queued. Whisper cannot force-align provided text.'
}

export async function updateSavedLyrics(
  deps: LyricUpdateDependencies,
  request: UpdateLyricsRequest | unknown,
): Promise<UpdateLyricsResult> {
  if (!isRecord(request) || typeof request.songId !== 'string' || !request.songId) {
    throw new Error('The song no longer exists in the library.')
  }
  const songId = request.songId
  if (deps.isBusy(songId)) throw new Error('Lyrics are busy with local processing.')
  const existing = deps.readSong(songId)
  if (!existing) throw new Error('The song no longer exists in the library.')
  const song = structuredClone(existing)
  Object.assign(song, normalizeLyricOwnership(song))
  if (request.expectedRevision !== undefined && request.expectedRevision !== song.lyricsRevision) {
    throw new Error('Lyric revision conflict.')
  }
  const parsed = parseEditedLyrics(request.text)
  const previousRaw = await deps.readLyrics(songId)
  let previousDocument: LyricsDocument | undefined
  if (previousRaw !== null) {
    try {
      previousDocument = parseLyricsDocument(JSON.parse(previousRaw))
    } catch {
      previousDocument = undefined
    }
  }
  const reference = previousDocument?.lines?.length ? copyLines(previousDocument.lines) : priorLines(song)
  const lines = preserveLyricTiming(parsed.lines, reference, mediaDurationOf(song))
  const hasVocals = await deps.hasVocals(song)
  const revision = song.lyricsRevision + 1
  const rematchStatus: LyricRematchStatus = hasVocals ? 'pending' : 'skipped'
  const rematchMessage = hasVocals ? pendingMessage() : skippedMessage()
  const document: LyricsDocument = {
    text: parsed.text,
    lines,
    language: song.languageName,
    languageCode: song.languageCode,
    languageName: song.languageName,
    languageSource: song.languageSource,
    words: previousDocument?.words,
    referenceLines: reference,
    source: 'user',
    revision,
    timingMethod: 'preserved-line-times',
    rematch: { status: rematchStatus, message: rematchMessage },
  }
  song.lyrics = copyLines(lines)
  song.lyricEditorText = parsed.text
  song.lyricTextSource = 'user'
  song.lyricsRevision = revision
  song.lyricTimingMethod = 'preserved-line-times'
  song.lyricRematchStatus = rematchStatus
  song.lyricRematchMessage = rematchMessage
  const serialized = `${JSON.stringify(document, null, 2)}\n`
  await deps.writeLyrics(songId, serialized)
  try {
    await deps.writeSong(song)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    try {
      if (previousRaw === null) await deps.deleteLyrics(songId)
      else await deps.writeLyrics(songId, previousRaw)
    } catch (restoreError) {
      const restoreMessage = restoreError instanceof Error ? restoreError.message : String(restoreError)
      throw new Error(
        `Lyric library save failed: ${message}. Restoring lyrics.json also failed: ${restoreMessage}. `
        + 'lyrics.json remains the source of truth and will be reapplied on reload.',
      )
    }
    throw new Error(`Lyric library save failed: ${message}. lyrics.json was restored.`)
  }
  return { song, rematch: hasVocals ? 'queued' : 'skipped' }
}

export async function commitTimingRematch(
  deps: LyricRematchDependencies,
  songId: string,
  revision: number,
) {
  const initial = deps.readSong(songId)
  if (!initial) return 'missing' as const
  if (initial.lyricsRevision !== revision || initial.lyricTextSource !== 'user') return 'stale' as const
  let previousDocument: LyricsDocument | undefined
  try {
    const words = await deps.recognizeWords(initial)
    const fresh = deps.readSong(songId)
    if (!fresh) return 'missing' as const
    if (fresh.lyricsRevision !== revision || fresh.lyricTextSource !== 'user') return 'stale' as const
    const raw = await deps.readLyrics(songId)
    const document = raw === null ? undefined : parseLyricsDocument(safeJson(raw))
    if (!document || document.revision !== revision || document.source !== 'user') return 'stale' as const
    if (document.lines.length !== fresh.lyrics.length
      || document.lines.some((line, index) => line.text !== fresh.lyrics[index]?.text)) {
      return 'stale' as const
    }
    previousDocument = document
    const aligned = alignUserLinesToAsrWords(document.lines, words, mediaDurationOf(fresh))
    const committed: LyricsDocument = {
      ...document,
      text: document.text,
      lines: aligned.lines,
      words,
      source: 'user',
      revision,
      timingMethod: aligned.matchedLineCount > 0 ? 'text-to-whisper-word-rematch' : 'preserved-line-times',
      rematch: { status: 'complete', message: aligned.message },
    }
    const latest = deps.readSong(songId)
    if (!latest || latest.lyricsRevision !== revision || latest.lyricTextSource !== 'user') return 'stale' as const
    const nextSong = structuredClone(latest)
    nextSong.lyrics = copyLines(aligned.lines)
    nextSong.lyricEditorText = committed.text
    nextSong.lyricTextSource = 'user'
    nextSong.lyricsRevision = revision
    nextSong.lyricTimingMethod = committed.timingMethod ?? 'preserved-line-times'
    nextSong.lyricRematchStatus = 'complete'
    nextSong.lyricRematchMessage = aligned.message
    await deps.writeLyrics(songId, `${JSON.stringify(committed, null, 2)}\n`)
    await deps.writeSong(nextSong)
    return 'committed' as const
  } catch (error) {
    await persistRematchFailure(deps, songId, revision, error, previousDocument)
    return 'failed' as const
  }
}

async function persistRematchFailure(
  deps: LyricRematchDependencies,
  songId: string,
  revision: number,
  error: unknown,
  previousDocument?: LyricsDocument,
) {
  const song = deps.readSong(songId)
  if (!song || song.lyricsRevision !== revision || song.lyricTextSource !== 'user') return
  const message = error instanceof Error ? error.message : String(error)
  const failure = `Lyric timing rematch failed: ${message}. Saved lyric text and timing were retained. Whisper cannot force-align provided text.`
  const failedSong = structuredClone(song)
  failedSong.lyricRematchStatus = 'failed'
  failedSong.lyricRematchMessage = failure
  const persistenceErrors: unknown[] = []
  try {
    const raw = previousDocument ? null : await deps.readLyrics(songId)
    const document = previousDocument ?? (raw === null ? undefined : parseLyricsDocument(safeJson(raw)))
    if (document && document.revision === revision && document.source === 'user') {
      failedSong.lyricEditorText = document.text
      document.rematch = { status: 'failed', message: failure }
      document.timingMethod = document.timingMethod ?? 'preserved-line-times'
      await deps.writeLyrics(songId, `${JSON.stringify(document, null, 2)}\n`)
    }
  } catch (writeError) {
    persistenceErrors.push(writeError)
  }
  try {
    await deps.writeSong(failedSong)
  } catch (writeError) {
    persistenceErrors.push(writeError)
  } finally {
    deps.publishFailure?.(failedSong)
  }
  if (persistenceErrors.length) {
    throw new AggregateError([error, ...persistenceErrors],
      `${failure} Failure status could not be fully persisted: ${persistenceErrors.map(String).join('; ')}`)
  }
}

function safeJson(raw: string) {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}

export function stampEngineTranscript(song: Song, transcript: TranscriptionResult): LyricsDocument {
  const ownership = normalizeLyricOwnership(song)
  return {
    ...transcript,
    source: 'engine',
    revision: ownership.lyricTextSource === 'user' ? ownership.lyricsRevision : ownership.lyricsRevision + 1,
    timingMethod: 'whisper-grouped',
    rematch: { status: 'none' },
  }
}
