import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import {
  chooseEnhancementPlan,
  createMasterFilter,
  loudnessAnalysisArguments,
  parseLoudnormMetrics,
  STEM_GAIN_LIMIT_DB,
} from '../dist-electron/enhancement.js'
import {
  createProcessingResourcePolicy,
  ffmpegThreadArguments,
} from '../dist-electron/processing-resources.js'

const metrics = (integratedLufs, truePeakDbtp, loudnessRangeLu = 5, thresholdLufs = -40) => ({
  integratedLufs,
  truePeakDbtp,
  loudnessRangeLu,
  thresholdLufs,
})

const quietVocal = chooseEnhancementPlan(metrics(-32, -8), metrics(-23, -5))
assert.equal(quietVocal.vocalGainDb, 5, 'quiet Vocal boost must respect peak headroom')
assert.equal(quietVocal.instrumentalGainDb, 0)

const quietInstrumental = chooseEnhancementPlan(metrics(-20, -4), metrics(-35, -12))
assert.equal(quietInstrumental.vocalGainDb, 0)
assert.equal(quietInstrumental.instrumentalGainDb, STEM_GAIN_LIMIT_DB)

const balanced = chooseEnhancementPlan(metrics(-20, -5), metrics(-23, -6))
assert.equal(balanced.vocalGainDb, 0)
assert.equal(balanced.instrumentalGainDb, 0)
assert.equal(balanced.cleanupApplied, false)

const nearSilent = chooseEnhancementPlan(metrics(-60, -50, 0), metrics(-55, -45, 0))
assert.equal(nearSilent.vocalGainDb, 0)
assert.equal(nearSilent.instrumentalGainDb, 0)
assert.equal(nearSilent.cleanupApplied, false, 'near-silence must not trigger noise amplification/cleanup')

const noisy = chooseEnhancementPlan(metrics(-20, -5), metrics(-18, -12, 1))
assert.equal(noisy.cleanupApplied, true)
assert.ok(noisy.instrumentalFilters.some((filter) => filter.startsWith('afftdn=nr=3')))

const clippingRisk = chooseEnhancementPlan(metrics(-25, -0.5), metrics(-23, -1))
assert.equal(clippingRisk.vocalGainDb, -2.5, 'peak risk must override loudness boost')
assert.equal(clippingRisk.instrumentalGainDb, -2)
assert.ok(Number.isFinite(clippingRisk.vocalGainDb))
assert.ok(Number.isFinite(clippingRisk.instrumentalGainDb))

assert.throws(() => parseLoudnormMetrics('not a loudnorm report'), /did not return/)
const silentMaster = createMasterFilter(metrics(null, null, null, null))
assert.match(silentMaster.caveat, /too quiet/)
assert.doesNotMatch(silentMaster.filter, /NaN|Infinity/)
const normalMaster = createMasterFilter(metrics(-19, -3, 4, -29))
assert.match(normalMaster.filter, /loudnorm=I=-16:TP=-1.5/)

const workspace = path.resolve('scripts', 'qa-artifacts', 'enhancement-metric-unit')
const vocalPath = path.join(workspace, 'vocal.wav')
const instrumentalPath = path.join(workspace, 'instrumental.wav')
const premixPath = path.join(workspace, 'premix.wav')
const enhancedPath = path.join(workspace, 'enhanced.wav')
const policy = createProcessingResourcePolicy(4)
const run = (args) => {
  const result = spawnSync(ffmpegInstaller.path, args, { windowsHide: true, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result
}
const analyze = (filePath) => {
  const result = run(loudnessAnalysisArguments(filePath, policy))
  return parseLoudnormMetrics(result.stderr)
}
const hash = async (filePath) => createHash('sha256').update(await readFile(filePath)).digest('hex')

await rm(workspace, { recursive: true, force: true })
await mkdir(workspace, { recursive: true })
try {
  run(['-y', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=3', '-af', 'volume=0.08', vocalPath])
  run(['-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=3', '-af', 'volume=0.20', instrumentalPath])
  const beforeVocal = await hash(vocalPath)
  const beforeInstrumental = await hash(instrumentalPath)
  const vocalMeasured = analyze(vocalPath)
  const instrumentalMeasured = analyze(instrumentalPath)
  assert.ok(Number.isFinite(vocalMeasured.integratedLufs))
  assert.ok(Number.isFinite(instrumentalMeasured.integratedLufs))

  const plan = chooseEnhancementPlan(vocalMeasured, instrumentalMeasured)
  run([
    '-y', ...ffmpegThreadArguments(policy),
    '-i', vocalPath, '-i', instrumentalPath,
    '-filter_complex', plan.mixFilter,
    '-map', '[enhanced]',
    '-c:a', 'pcm_s16le', premixPath,
  ])
  const premixMeasured = analyze(premixPath)
  const master = createMasterFilter(premixMeasured)
  run([
    '-y', ...ffmpegThreadArguments(policy),
    '-i', premixPath, '-af', master.filter,
    '-c:a', 'pcm_s16le', enhancedPath,
  ])
  const outputMeasured = analyze(enhancedPath)
  assert.ok(outputMeasured.integratedLufs !== null)
  assert.ok(Math.abs(outputMeasured.integratedLufs + 16) <= 1.5)
  assert.ok(outputMeasured.truePeakDbtp !== null && outputMeasured.truePeakDbtp <= -1.35)
  assert.equal(await hash(vocalPath), beforeVocal, 'Enhanced processing must not alter Vocal')
  assert.equal(await hash(instrumentalPath), beforeInstrumental, 'Enhanced processing must not alter Instrumental')
} finally {
  await rm(workspace, { recursive: true, force: true })
}

console.log('PASS enhanced balance: deterministic edge cases and real FFmpeg EBU R128 fixture.')
