import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg'
import {
  createDeliverableStore,
  normalizeDeliverableStore,
  reconcileArtifactOutcome,
} from '../dist-electron/processing-domain.js'
import {
  createProcessingResourcePolicy,
  ffmpegValidationArguments,
} from '../dist-electron/processing-resources.js'

const workspace = path.resolve('scripts', 'qa-artifacts', 'processing-artifact-unit')
const validAudio = path.join(workspace, 'vocal.wav')
const invalidAudio = path.join(workspace, 'enhanced.m4a')
const statePath = path.join(workspace, 'deliverables.json')
const policy = createProcessingResourcePolicy(4)

await rm(workspace, { recursive: true, force: true })
await mkdir(workspace, { recursive: true })
try {
  const generated = spawnSync(ffmpegInstaller.path, [
    '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.2',
    '-threads', String(policy.cpuThreads),
    '-c:a', 'pcm_s16le', validAudio,
  ], { windowsHide: true, encoding: 'utf8' })
  assert.equal(generated.status, 0, generated.stderr)

  const playable = spawnSync(
    ffmpegInstaller.path,
    ffmpegValidationArguments(validAudio, policy),
    { windowsHide: true, encoding: 'utf8' },
  )
  assert.equal(playable.status, 0, 'validated partial vocal output must be decodable')

  await writeFile(invalidAudio, 'not audio', 'utf8')
  const invalid = spawnSync(
    ffmpegInstaller.path,
    ffmpegValidationArguments(invalidAudio, policy),
    { windowsHide: true, encoding: 'utf8' },
  )
  assert.notEqual(invalid.status, 0, 'non-media artifacts must fail playability validation')

  const file = await stat(validAudio)
  const store = createDeliverableStore(1_000)
  store.outcomes.vocal = reconcileArtifactOutcome(store.outcomes.vocal, [{
    path: validAudio,
    size: file.size,
    modifiedAt: file.mtimeMs,
    validatedAt: new Date(1_100).toISOString(),
  }], 1_100)
  store.outcomes.enhanced = reconcileArtifactOutcome(store.outcomes.enhanced, undefined, 1_200)
  await writeFile(statePath, JSON.stringify(store), 'utf8')

  const restarted = normalizeDeliverableStore(JSON.parse(await readFile(statePath, 'utf8')), 2_000)
  assert.equal(restarted.outcomes.vocal.state, 'ready')
  assert.equal(restarted.outcomes.vocal.artifacts[0].path, validAudio)
  assert.equal(restarted.outcomes.enhanced.state, 'missing')

  await rm(validAudio)
  const missing = spawnSync(
    ffmpegInstaller.path,
    ffmpegValidationArguments(validAudio, policy),
    { windowsHide: true, encoding: 'utf8' },
  )
  assert.notEqual(missing.status, 0, 'deleted persisted artifacts must fail restart validation')
  const invalidated = reconcileArtifactOutcome(restarted.outcomes.vocal, undefined, 2_100)
  assert.equal(invalidated.state, 'failed')
  assert.equal(invalidated.failure?.code, 'invalid-artifact')
} finally {
  await rm(workspace, { recursive: true, force: true })
}

console.log('PASS processing artifacts: 9 checks for playability, persistence, restart, and invalidation.')
