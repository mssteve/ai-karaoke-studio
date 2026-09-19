import assert from 'node:assert/strict'
import {
  MINIMUM_FRAGMENT_DURATION_SECONDS,
  normalizeTimedFragments,
  normalizeWhisperChunks,
  normalizeWhisperChunksWithDiagnostics,
} from '../dist-electron/transcription-timing.js'

let checks = 0
const equal = (actual, expected, message) => {
  assert.deepEqual(actual, expected, message)
  checks += 1
}
const check = (value, message) => {
  assert.ok(value, message)
  checks += 1
}
const rejects = (action, pattern, message) => {
  assert.throws(action, pattern, message)
  checks += 1
}

const containmentFragments = normalizeTimedFragments([
  { text: 'long segment', timestamp: [76.76, 101.72] },
  { text: ' valid next', timestamp: [80.38, 85.78] },
], 120)
equal(containmentFragments[0], { text: 'long segment', start: 76.76, end: 80.38 },
  'the real containment shape must clamp the long fragment to the next word boundary')
check(containmentFragments.at(-1).start >= containmentFragments[0].end,
  'the real containment shape must be non-overlapping')

const partial = normalizeWhisperChunks([
  { text: 'one.', timestamp: [1, 3] },
  { text: 'two.', timestamp: [2.5, 4] },
], 10)
equal(partial[0].end, 2.5, 'partial overlap must clamp at the next boundary')

const duplicate = normalizeWhisperChunks([
  { text: '重複。', timestamp: [1, 2] },
  { text: '重複。', timestamp: [1, 2] },
], 5)
equal(duplicate.length, 1, 'identical duplicate fragments must be discarded')
equal(duplicate[0].text, '重複。', 'multilingual Unicode text must remain unchanged')

const sorted = normalizeWhisperChunks([
  { text: 'world.', timestamp: [2, 3] },
  { text: 'Hello ', timestamp: [1, 1.8] },
], 5)
equal(sorted.map((line) => line.text), ['Hello world.'],
  'valid out-of-order words must be sorted before grouping')

const mixedUnsorted = normalizeWhisperChunksWithDiagnostics([
  { text: 'later.', timestamp: [4, 5] },
  { text: '损坏', timestamp: [Number.NaN, null] },
  { text: 'early.', timestamp: [0, 1] },
  { text: 'middle.', timestamp: [2, 3] },
], 6)
equal(mixedUnsorted.lines[0], { text: 'early.', start: 0, end: 1 },
  'malformed input must not displace a valid early line during sorting')
equal(mixedUnsorted.lines.map((line) => line.text), ['early.', 'middle.', 'later.', '损坏'],
  'mixed malformed and unsorted input must keep stable text association')
check(mixedUnsorted.diagnostics.sortedFragmentCount > 0
  && mixedUnsorted.diagnostics.fallbackLineCount === 1,
'sorting and fallback placement must be diagnosed independently')

const firstFallback = normalizeWhisperChunksWithDiagnostics([
  { text: 'first malformed.', timestamp: [Number.NaN, 1] },
  { text: 'next valid.', timestamp: [3, 4] },
], 8)
equal(firstFallback.lines[0], { text: 'first malformed.', start: 0, end: 2 },
  'first malformed line must anchor at zero')
check(firstFallback.diagnostics.fallbackUsed && firstFallback.diagnostics.fallbackLineCount === 1,
  'first-line fallback must be diagnosed')

const middleFallback = normalizeWhisperChunksWithDiagnostics([
  { text: 'first.', timestamp: [0, 1] },
  { text: 'middle malformed.', timestamp: [-1, 2] },
  { text: 'last.', timestamp: [4, 5] },
], 8)
equal(middleFallback.lines[1], { text: 'middle malformed.', start: 1, end: 3 },
  'middle malformed line must anchor at the previous end and stay before the next boundary')

const finalFallback = normalizeWhisperChunksWithDiagnostics([
  { text: 'valid.', timestamp: [1, 2] },
  { text: 'final malformed.', timestamp: [null, null] },
], 3)
equal(finalFallback.lines[1], { text: 'final malformed.', start: 2, end: 3 },
  'final malformed line must use bounded duration clamped to media')

const consecutive = normalizeWhisperChunksWithDiagnostics([
  { text: 'valid.', timestamp: [0, 1] },
  { text: 'bad one.', timestamp: [Number.NaN, 2] },
  { text: 'bad two.', timestamp: [3, 2] },
  { text: 'next.', timestamp: [5, 6] },
], 8)
equal(consecutive.lines.slice(1, 3), [
  { text: 'bad one.', start: 1, end: 3 },
  { text: 'bad two.', start: 3, end: 5 },
], 'consecutive malformed lines must divide the available safe interval')
equal(consecutive.diagnostics.fallbackLineCount, 2,
  'all consecutive fallback lines must be diagnosed')

const noNaturalGap = normalizeWhisperChunksWithDiagnostics([
  { text: 'valid.', timestamp: [0, 1] },
  { text: '坏一', timestamp: [null, null] },
  { text: '坏二', timestamp: [-1, 0] },
  { text: 'next.', timestamp: [1, 2] },
], 2)
equal(noNaturalGap.lines.map((line) => line.text), ['valid. 坏一 坏二', 'next.'],
  'malformed text must merge deterministically when no natural gap exists')
equal(noNaturalGap.diagnostics.mergedFragmentCount, 2,
  'no-gap fallback association must use the merge counter')

const constrained = normalizeWhisperChunksWithDiagnostics([
  { text: '甲', timestamp: [null, null] },
  { text: '乙', timestamp: [null, null] },
  { text: '丙', timestamp: [null, null] },
], 0.08)
equal(constrained.lines.length, 2,
  'constrained media must merge excess malformed text instead of emitting short lines')
check(constrained.lines.every((line) => line.end - line.start >= 0.04),
  'constrained fallback lines must retain the exact 40ms minimum')
equal(constrained.diagnostics.mergedFragmentCount, 1,
  'constrained fallback merging must be diagnosed')

const boundaries = [
  { duration: 0.03, expansions: 1 },
  { duration: 0.039, expansions: 1 },
  { duration: 0.04, expansions: 0 },
].map(({ duration, expansions }) => {
  const result = normalizeWhisperChunksWithDiagnostics([
    { text: `${duration}`, timestamp: [0, duration] },
  ], 1)
  equal(result.diagnostics.invalidDurationExpansionCount, expansions,
    `${duration * 1000}ms duration must have the correct expansion classification`)
  equal(result.lines[0].end, 0.04,
    `${duration * 1000}ms duration must normalize to at least exactly 40ms`)
  return result
})
check(boundaries.every((result) => result.diagnostics.repairedOverlapCount === 0),
  'zero-width and short-duration expansion must not increment overlap repairs')

const trueOverlap = normalizeWhisperChunksWithDiagnostics([
  { text: 'one ', timestamp: [0, 0.2] },
  { text: 'two.', timestamp: [0.1, 0.3] },
], 1)
check(trueOverlap.diagnostics.repairedOverlapCount > 0
  && trueOverlap.diagnostics.invalidDurationExpansionCount === 0,
'actual overlap repair must be classified separately from duration expansion')

const clamped = normalizeWhisperChunks([
  { text: 'ending.', timestamp: [4, 8] },
], 5)
equal(clamped[0].end, 5, 'fragment ends must clamp to known media duration')

const reconstructedFragments = normalizeTimedFragments([
  { text: 'unusually long segment', timestamp: [10, 40] },
  { text: ' useful ', timestamp: [14, 15] },
  { text: 'words.', timestamp: [15, 16] },
], 45)
equal(reconstructedFragments[0].end, 14,
  'an unusually long segment must not block valid subsequent word timing')
const reconstructed = normalizeWhisperChunks([
  { text: 'unusually long segment', timestamp: [10, 40] },
  { text: ' useful ', timestamp: [14, 15] },
  { text: 'words.', timestamp: [15, 16] },
], 45)
check(reconstructed.every((line) => line.end - line.start >= MINIMUM_FRAGMENT_DURATION_SECONDS),
  'all normalized lyric lines must retain a positive minimum duration')

rejects(() => normalizeWhisperChunks([], 5), /no nonempty lyric fragments/,
  'only globally empty transcription output must fail')

equal(normalizeWhisperChunks([
  { text: '   ', timestamp: [0, 1] },
  { text: 'kept.', timestamp: [1, 2] },
], 5).length, 1, 'empty fragments must be discarded safely')

console.log(`PASS transcription timing: ${checks} deterministic checks.`)
