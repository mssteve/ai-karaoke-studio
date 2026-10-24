import type { LyricLine, TranscriptionTimingDiagnostics } from './types.js'

export const TIMESTAMP_EPSILON_SECONDS = 0.01
export const MINIMUM_FRAGMENT_DURATION_SECONDS = 0.04
export const DEFAULT_FALLBACK_DURATION_SECONDS = 2
const FLOAT_TOLERANCE_SECONDS = 1e-9

export interface TimedTextFragment {
  text: string
  timestamp: [number | null, number | null]
}

interface ClassifiedFragment {
  text: string
  index: number
  start?: number
  end?: number
  reason?: string
}

interface EmittedFragment extends LyricLine {
  fallback: boolean
}

export interface NormalizedTimingResult {
  lines: LyricLine[]
  diagnostics: TranscriptionTimingDiagnostics
}

function appendText(left: string, right: string) {
  if (!left) return right
  if (!right) return left
  return /\s$/u.test(left) || /^\s/u.test(right) ? `${left}${right}` : `${left} ${right}`
}

function timingReason(start: number | null, end: number | null, mediaDuration?: number) {
  if (start === null || end === null || !Number.isFinite(start) || !Number.isFinite(end)) {
    return 'timestamps were missing or non-finite'
  }
  if (start < 0 || end < 0) return 'timestamps were negative'
  if (end + TIMESTAMP_EPSILON_SECONDS < start) return 'the end preceded the start'
  if (mediaDuration !== undefined && start >= mediaDuration) {
    return 'the fragment started outside the media duration'
  }
  return undefined
}

function prepare(fragments: readonly TimedTextFragment[], mediaDuration?: number) {
  if (mediaDuration !== undefined && (!Number.isFinite(mediaDuration) || mediaDuration <= 0)) {
    throw new Error(`Whisper media duration is invalid (${String(mediaDuration)}).`)
  }
  const diagnostics: TranscriptionTimingDiagnostics = {
    fallbackUsed: false,
    fallbackLineCount: 0,
    repairedOverlapCount: 0,
    invalidDurationExpansionCount: 0,
    sortedFragmentCount: 0,
    mergedFragmentCount: 0,
    discardedFragmentCount: 0,
    messages: [],
  }
  const classified: ClassifiedFragment[] = []
  const seen = new Set<string>()
  for (const [index, fragment] of fragments.entries()) {
    if (!fragment.text.trim()) {
      diagnostics.discardedFragmentCount += 1
      diagnostics.messages.push(`Fragment ${index + 1}: empty text discarded.`)
      continue
    }
    const key = `${fragment.text}\u0000${String(fragment.timestamp[0])}\u0000${String(fragment.timestamp[1])}`
    if (seen.has(key)) {
      diagnostics.discardedFragmentCount += 1
      diagnostics.messages.push(`Fragment ${index + 1}: exact duplicate discarded.`)
      continue
    }
    seen.add(key)
    const reason = timingReason(fragment.timestamp[0], fragment.timestamp[1], mediaDuration)
    classified.push(reason
      ? { text: fragment.text, index, reason }
      : {
          text: fragment.text,
          index,
          start: fragment.timestamp[0]!,
          end: mediaDuration === undefined
            ? fragment.timestamp[1]!
            : Math.min(fragment.timestamp[1]!, mediaDuration),
        })
  }
  if (!classified.length) throw new Error('Whisper produced no nonempty lyric fragments.')

  const valid = classified.filter((fragment) => !fragment.reason)
  const originalValidOrder = valid.map((fragment) => fragment.index)
  valid.sort((left, right) => (
    left.start! - right.start! || left.end! - right.end! || left.index - right.index
  ))
  diagnostics.sortedFragmentCount = valid.reduce(
    (count, fragment, rank) => count + (fragment.index === originalValidOrder[rank] ? 0 : 1),
    0,
  )
  if (diagnostics.sortedFragmentCount) {
    diagnostics.messages.push(
      `${diagnostics.sortedFragmentCount} valid fragment(s) moved during stable chronological sorting.`,
    )
  }

  const rankByIndex = new Map(valid.map((fragment, rank) => [fragment.index, rank]))
  const fallbackBuckets = Array.from({ length: valid.length + 1 }, () => [] as ClassifiedFragment[])
  for (const malformed of classified.filter((fragment) => fragment.reason)) {
    let precedingRank = -1
    for (let index = malformed.index - 1; index >= 0; index -= 1) {
      const rank = rankByIndex.get(index)
      if (rank !== undefined) {
        precedingRank = rank
        break
      }
    }
    fallbackBuckets[precedingRank + 1].push(malformed)
  }
  return { valid, fallbackBuckets, diagnostics }
}

function mergeTexts(fragments: readonly ClassifiedFragment[]) {
  return fragments.reduce((text, fragment) => appendText(text, fragment.text), '')
}

export function normalizeTimedFragmentsWithDiagnostics(
  fragments: readonly TimedTextFragment[],
  mediaDuration?: number,
): { fragments: LyricLine[]; diagnostics: TranscriptionTimingDiagnostics; fallbackIndices: Set<number> } {
  const { valid, fallbackBuckets, diagnostics } = prepare(fragments, mediaDuration)
  const emitted: EmittedFragment[] = []
  let cursor = 0
  let pendingPrefix = ''

  const mergeIntoPreviousOrPrefix = (items: readonly ClassifiedFragment[], reason: string) => {
    const text = mergeTexts(items)
    diagnostics.fallbackUsed = true
    diagnostics.fallbackLineCount += items.length
    diagnostics.mergedFragmentCount += items.length
    if (emitted.length) {
      const previous = emitted.at(-1)!
      previous.text = appendText(previous.text, text)
      previous.fallback = true
    } else {
      pendingPrefix = appendText(pendingPrefix, text)
    }
    for (const item of items) {
      diagnostics.messages.push(
        `Fragment ${item.index + 1}: ${item.reason}; fallback text merged (${reason}).`,
      )
    }
  }

  const placeFallback = (items: readonly ClassifiedFragment[], boundary?: number) => {
    if (!items.length) return
    diagnostics.fallbackUsed = true
    diagnostics.fallbackLineCount += items.length
    const availableEnd = boundary ?? mediaDuration
      ?? (cursor + items.length * DEFAULT_FALLBACK_DURATION_SECONDS)
    const available = Math.max(0, availableEnd - cursor)
    const capacity = Math.floor((available + FLOAT_TOLERANCE_SECONDS)
      / MINIMUM_FRAGMENT_DURATION_SECONDS)
    const outputCount = Math.min(items.length, capacity)
    if (!outputCount) {
      diagnostics.fallbackLineCount -= items.length
      mergeIntoPreviousOrPrefix(items, 'no 40ms boundary was available')
      return
    }

    const duration = Math.min(DEFAULT_FALLBACK_DURATION_SECONDS, available / outputCount)
    for (let group = 0; group < outputCount; group += 1) {
      const from = Math.floor(group * items.length / outputCount)
      const to = Math.floor((group + 1) * items.length / outputCount)
      const grouped = items.slice(from, to)
      const start = cursor
      const end = group === outputCount - 1
        ? Math.min(availableEnd, start + duration)
        : start + duration
      emitted.push({ text: mergeTexts(grouped), start, end, fallback: true })
      cursor = end
      for (const item of grouped) {
        diagnostics.messages.push(
          `Fragment ${item.index + 1}: ${item.reason}; fallback timing used.`,
        )
      }
    }
    const merged = items.length - outputCount
    if (merged > 0) {
      diagnostics.mergedFragmentCount += merged
      diagnostics.messages.push(
        `${merged} fallback fragment(s) were text-merged to preserve the exact 40ms minimum.`,
      )
    }
  }

  for (let rank = 0; rank < valid.length; rank += 1) {
    const fragment = valid[rank]
    placeFallback(fallbackBuckets[rank], fragment.start)

    let start = fragment.start!
    let end = fragment.end!
    const nextStart = valid[rank + 1]?.start
    if (start < cursor - FLOAT_TOLERANCE_SECONDS) {
      start = cursor
      diagnostics.repairedOverlapCount += 1
      diagnostics.messages.push(`Fragment ${fragment.index + 1}: overlapping start clamped.`)
    }
    if (nextStart !== undefined && end > nextStart + FLOAT_TOLERANCE_SECONDS) {
      end = nextStart
      diagnostics.repairedOverlapCount += 1
      diagnostics.messages.push(`Fragment ${fragment.index + 1}: overlapping end clamped.`)
    }
    if (end < start) end = start

    if (end - start + FLOAT_TOLERANCE_SECONDS < MINIMUM_FRAGMENT_DURATION_SECONDS) {
      const limit = nextStart ?? mediaDuration
      const expandedEnd = start + MINIMUM_FRAGMENT_DURATION_SECONDS
      if (limit === undefined || expandedEnd <= limit + FLOAT_TOLERANCE_SECONDS) {
        end = expandedEnd
        diagnostics.invalidDurationExpansionCount += 1
        diagnostics.messages.push(
          `Fragment ${fragment.index + 1}: invalid duration expanded to 40ms.`,
        )
      } else {
        const text = appendText(pendingPrefix, fragment.text)
        pendingPrefix = ''
        diagnostics.mergedFragmentCount += 1
        if (emitted.length) {
          emitted.at(-1)!.text = appendText(emitted.at(-1)!.text, text)
        } else if (rank + 1 < valid.length) {
          pendingPrefix = appendText(pendingPrefix, text)
        } else {
          throw new Error('Whisper produced no timeline interval large enough for a 40ms lyric line.')
        }
        diagnostics.messages.push(
          `Fragment ${fragment.index + 1}: text merged because no 40ms interval was available.`,
        )
        continue
      }
    }

    emitted.push({
      text: appendText(pendingPrefix, fragment.text),
      start,
      end,
      fallback: Boolean(pendingPrefix),
    })
    pendingPrefix = ''
    cursor = end
  }

  placeFallback(fallbackBuckets[valid.length])
  if (pendingPrefix) {
    if (!emitted.length) {
      const end = mediaDuration === undefined
        ? MINIMUM_FRAGMENT_DURATION_SECONDS
        : Math.min(mediaDuration, MINIMUM_FRAGMENT_DURATION_SECONDS)
      if (end + FLOAT_TOLERANCE_SECONDS < MINIMUM_FRAGMENT_DURATION_SECONDS) {
        throw new Error('Whisper produced no timeline interval large enough for a 40ms lyric line.')
      }
      emitted.push({ text: pendingPrefix, start: 0, end, fallback: true })
    } else {
      emitted.at(-1)!.text = appendText(emitted.at(-1)!.text, pendingPrefix)
      emitted.at(-1)!.fallback = true
    }
  }
  if (!emitted.length) {
    throw new Error('Whisper produced globally unusable timing with no constructible timeline.')
  }

  const fallbackIndices = new Set<number>()
  const normalized = emitted.map((fragment, index) => {
    if (fragment.fallback) fallbackIndices.add(index)
    return { text: fragment.text, start: fragment.start, end: fragment.end }
  })
  return { fragments: normalized, diagnostics, fallbackIndices }
}

export function normalizeTimedFragments(
  fragments: readonly TimedTextFragment[],
  mediaDuration?: number,
) {
  return normalizeTimedFragmentsWithDiagnostics(fragments, mediaDuration).fragments
}

function groupTimedFragments(
  fragments: readonly LyricLine[],
  fallbackIndices: ReadonlySet<number>,
): LyricLine[] {
  const lines: LyricLine[] = []
  let current: LyricLine[] = []
  const flush = () => {
    if (!current.length) return
    lines.push({
      text: current.map((item) => item.text).join('').trim(),
      start: current[0].start,
      end: current.at(-1)!.end,
    })
    current = []
  }

  for (const [index, fragment] of fragments.entries()) {
    if (fallbackIndices.has(index)) flush()
    const currentEnd = current.at(-1)?.end ?? fragment.start
    if (current.length && fragment.start - currentEnd >= 1.5) flush()
    current.push(fragment)
    const text = current.map((item) => item.text).join('').trim()
    if (fallbackIndices.has(index)
      || text.length >= 48
      || fragment.end - current[0].start >= 5
      || /[.!?。！？]$/.test(text)) flush()
  }
  flush()
  return lines
}

export function normalizeWhisperChunksWithDiagnostics(
  chunks: readonly TimedTextFragment[],
  mediaDuration?: number,
): NormalizedTimingResult {
  const normalized = normalizeTimedFragmentsWithDiagnostics(chunks, mediaDuration)
  const lines = groupTimedFragments(normalized.fragments, normalized.fallbackIndices)
  validateLyricLines(lines, mediaDuration)
  return { lines, diagnostics: normalized.diagnostics }
}

export function normalizeWhisperChunks(
  chunks: readonly TimedTextFragment[],
  mediaDuration?: number,
) {
  return normalizeWhisperChunksWithDiagnostics(chunks, mediaDuration).lines
}

export function validateLyricLines(lines: readonly LyricLine[], mediaDuration?: number) {
  let previousEnd = 0
  for (const [index, line] of lines.entries()) {
    if (!line.text.trim()
      || !Number.isFinite(line.start)
      || !Number.isFinite(line.end)
      || line.start < 0
      || line.end - line.start + FLOAT_TOLERANCE_SECONDS < MINIMUM_FRAGMENT_DURATION_SECONDS
      || line.start + FLOAT_TOLERANCE_SECONDS < previousEnd
      || (mediaDuration !== undefined && line.end > mediaDuration + FLOAT_TOLERANCE_SECONDS)) {
      throw new Error(
        `Whisper produced invalid or unordered timestamps at lyric line ${index + 1}`
        + ` (${line.start}-${line.end}, previous end ${previousEnd}).`,
      )
    }
    previousEnd = line.end
  }
}

const LYRIC_TOKEN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]\p{M}*|(?:(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])[\p{L}\p{N}\p{M}])+(?:['’](?:(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])[\p{L}\p{N}\p{M}])+)*/gu

export interface AsrTimedWord {
  text: string
  start: number
  end: number
}

export interface TextRematchAlignment {
  lines: LyricLine[]
  matchedLineCount: number
  retainedLineCount: number
  message: string
}

export function lyricTokens(text: string) {
  return [...text.normalize('NFKC').matchAll(LYRIC_TOKEN)].map((match) => match[0].toLowerCase().replace(/’/g, "'"))
}

export function lyricLineWeight(text: string) {
  return Math.max(1, lyricTokens(text).length)
}

function roundSeconds(value: number) {
  return Math.round(value * 1000) / 1000
}

export function alignUserLinesToAsrWords(
  lines: readonly LyricLine[],
  words: readonly AsrTimedWord[],
  mediaDuration?: number,
): TextRematchAlignment {
  const retained = lines.map((line) => ({ text: line.text, start: line.start, end: line.end }))
  const honest = 'Whisper cannot force-align provided text.'
  if (!lines.length) {
    return {
      lines: [],
      matchedLineCount: 0,
      retainedLineCount: 0,
      message: `Text-to-Whisper-word rematch aligned 0 of 0 lines. Unmatched lines kept their previous timing. ${honest}`,
    }
  }
  const userTokens = lines.flatMap((line, lineIndex) => lyricTokens(line.text).map((token) => ({
    token,
    lineIndex,
  })))
  const asrTokens = words.flatMap((word, wordIndex) => lyricTokens(word.text).map((token) => ({
    token,
    wordIndex,
  })))
  const matchedWordsByLine = new Map<number, number[]>()
  if (userTokens.length && asrTokens.length) {
    const scores = Array.from({ length: userTokens.length + 1 }, () => new Int32Array(asrTokens.length + 1))
    const choice = Array.from({ length: userTokens.length + 1 }, () => new Int8Array(asrTokens.length + 1))
    for (let userIndex = 1; userIndex <= userTokens.length; userIndex += 1) {
      for (let asrIndex = 1; asrIndex <= asrTokens.length; asrIndex += 1) {
        let best = scores[userIndex - 1][asrIndex]
        let from = 1
        if (scores[userIndex][asrIndex - 1] > best) {
          best = scores[userIndex][asrIndex - 1]
          from = 2
        }
        if (userTokens[userIndex - 1].token === asrTokens[asrIndex - 1].token
          && scores[userIndex - 1][asrIndex - 1] + 2 >= best) {
          best = scores[userIndex - 1][asrIndex - 1] + 2
          from = 3
        }
        scores[userIndex][asrIndex] = best
        choice[userIndex][asrIndex] = from
      }
    }
    const matchedTokensByLine = new Map<number, number>()
    let userIndex = userTokens.length
    let asrIndex = asrTokens.length
    while (userIndex > 0 && asrIndex > 0) {
      const from = choice[userIndex][asrIndex]
      if (from === 3) {
        const lineIndex = userTokens[userIndex - 1].lineIndex
        const wordIndex = asrTokens[asrIndex - 1].wordIndex
        const current = matchedWordsByLine.get(lineIndex) ?? []
        if (!current.includes(wordIndex)) current.push(wordIndex)
        matchedWordsByLine.set(lineIndex, current)
        matchedTokensByLine.set(lineIndex, (matchedTokensByLine.get(lineIndex) ?? 0) + 1)
        userIndex -= 1
        asrIndex -= 1
      } else if (from === 1) userIndex -= 1
      else asrIndex -= 1
    }
    for (const [lineIndex, matchedTokens] of matchedTokensByLine) {
      const tokenCount = userTokens.filter((token) => token.lineIndex === lineIndex).length
      if (matchedTokens * 2 < tokenCount) matchedWordsByLine.delete(lineIndex)
    }
  }

  const candidate = retained.map((line) => ({ ...line }))
  const accepted = new Set<number>()
  let previousEnd = 0
  for (let index = 0; index < lines.length; index += 1) {
    const wordIndexes = matchedWordsByLine.get(index)
    if (!wordIndexes?.length) continue
    const matched = wordIndexes.map((wordIndex) => words[wordIndex])
      .filter((word) => Number.isFinite(word?.start) && Number.isFinite(word?.end) && word.end > word.start)
    if (!matched.length) continue
    let start = Math.min(...matched.map((word) => word.start))
    let end = Math.max(...matched.map((word) => word.end))
    if (start < previousEnd - FLOAT_TOLERANCE_SECONDS) start = previousEnd
    const nextMatchedStart = lines.slice(index + 1).reduce<number | undefined>((found, _line, offset) => {
      if (found !== undefined) return found
      const nextIndexes = matchedWordsByLine.get(index + 1 + offset)
      if (!nextIndexes?.length) return undefined
      return Math.min(...nextIndexes.map((wordIndex) => words[wordIndex].start))
    }, undefined)
    const limit = Math.min(
      mediaDuration ?? Number.POSITIVE_INFINITY,
      nextMatchedStart ?? Number.POSITIVE_INFINITY,
    )
    if (end - start + FLOAT_TOLERANCE_SECONDS < MINIMUM_FRAGMENT_DURATION_SECONDS) {
      if (start + MINIMUM_FRAGMENT_DURATION_SECONDS <= limit + FLOAT_TOLERANCE_SECONDS) {
        end = start + MINIMUM_FRAGMENT_DURATION_SECONDS
      } else {
        continue
      }
    }
    if (end > limit + FLOAT_TOLERANCE_SECONDS) end = limit
    if (end - start + FLOAT_TOLERANCE_SECONDS < MINIMUM_FRAGMENT_DURATION_SECONDS
      || start + FLOAT_TOLERANCE_SECONDS < previousEnd
      || (mediaDuration !== undefined && end > mediaDuration + FLOAT_TOLERANCE_SECONDS)) {
      continue
    }
    candidate[index] = { text: lines[index].text, start: roundSeconds(start), end: roundSeconds(end) }
    accepted.add(index)
    previousEnd = candidate[index].end
  }

  let output = candidate
  try {
    validateLyricLines(output, mediaDuration)
  } catch {
    output = retained
    accepted.clear()
  }
  const matchedLineCount = accepted.size
  const retainedLineCount = lines.length - matchedLineCount
  return {
    lines: output.map((line) => ({ text: line.text, start: line.start, end: line.end })),
    matchedLineCount,
    retainedLineCount,
    message: `Text-to-Whisper-word rematch aligned ${matchedLineCount} of ${lines.length} lines. `
      + `Unmatched lines kept their previous timing. ${honest}`,
  }
}
