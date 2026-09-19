import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  calculateProcessingThreadLimit,
  createProcessingResourcePolicy,
  ffmpegThreadArguments,
  ffmpegValidationArguments,
  onnxSessionOptions,
  processingWorkerEnvironment,
} from '../dist-electron/processing-resources.js'

assert.equal(calculateProcessingThreadLimit(1), 1)
assert.equal(calculateProcessingThreadLimit(2), 1)
assert.equal(calculateProcessingThreadLimit(3), 1)
assert.equal(calculateProcessingThreadLimit(4), 2)
assert.equal(calculateProcessingThreadLimit(5), 2)
assert.equal(calculateProcessingThreadLimit(8), 4)

const policy = createProcessingResourcePolicy(10)
assert.equal(policy.cpuThreads, 5)
assert.equal(policy.executionProvider, 'cpu')
assert.equal(policy.gpuLimitEnforced, false)
assert.match(policy.gpuLimitation, /do not expose an enforceable percentage quota/i)

const environment = processingWorkerEnvironment(policy, {})
for (const name of [
  'OMP_NUM_THREADS',
  'OMP_THREAD_LIMIT',
  'MKL_NUM_THREADS',
  'OPENBLAS_NUM_THREADS',
  'NUMEXPR_NUM_THREADS',
  'VECLIB_MAXIMUM_THREADS',
]) {
  assert.equal(environment[name], '5', `${name} must receive the calculated cap`)
}

assert.deepEqual(ffmpegThreadArguments(policy), [
  '-threads', '5',
  '-filter_threads', '5',
  '-filter_complex_threads', '5',
])
assert.deepEqual(ffmpegValidationArguments('audio.wav', policy), [
  '-threads', '5',
  '-filter_threads', '5',
  '-filter_complex_threads', '5',
  '-v', 'error',
  '-i', 'audio.wav',
  '-t', '0.1',
  '-threads', '5',
  '-f', 'null',
  '-',
])
assert.deepEqual(onnxSessionOptions(policy), {
  executionProviders: ['cpu'],
  intraOpNumThreads: 5,
  interOpNumThreads: 1,
  executionMode: 'sequential',
})

const mainSource = await readFile('electron/main.ts', 'utf8')
const demucsSource = await readFile('electron/demucs-runner.ts', 'utf8')
const whisperSource = await readFile('electron/transcribe.ts', 'utf8')
assert.match(mainSource, /ffmpegThreadArguments\(processingResources\)/,
  'FFmpeg invocations must receive the shared thread policy')
assert.match(mainSource, /demucs-runner\.js[\s\S]*processingResources\.cpuThreads/,
  'Demucs worker must receive the shared thread cap')
assert.match(mainSource, /transcriptionScript[\s\S]*processingResources\.cpuThreads/,
  'Whisper worker must receive the shared thread cap')
assert.match(demucsSource, /InferenceSession\.create\(weights, onnxSessionOptions/,
  'Demucs ONNX session must enforce supported thread options')
assert.match(whisperSource, /device: 'cpu'[\s\S]*session_options: onnxSessionOptions/,
  'Whisper ONNX sessions must enforce the CPU provider and supported thread options')

console.log('PASS processing resources: 24 checks for CPU calculation and worker propagation.')
