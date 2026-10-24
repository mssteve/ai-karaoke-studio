import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  configureLocalAiProcessRunner,
  dispatchSeparation,
  dispatchTranscription,
} from '../dist-electron/ai-providers.js'
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
const calls = []
configureLocalAiProcessRunner(async (command, args, options) => {
  calls.push({ command, args, options })
})
await dispatchSeparation({ inputPath: 'input.wav', outputRoot: 'stems', cpuThreads: policy.cpuThreads })
await dispatchTranscription({
  audioPath: 'speech.wav', cacheDir: 'models', outputPath: 'lyrics.json',
  cpuThreads: policy.cpuThreads, recognitionArgument: 'manual:fr',
})
assert.equal(path.basename(calls[0].args[0]), 'demucs-runner.js')
assert.deepEqual(calls[0].args.slice(1), ['input.wav', 'stems', '5'],
  'real separation dispatch forwards the resource cap to the worker')
assert.equal(path.basename(calls[1].args[0]), 'transcribe.js')
assert.deepEqual(calls[1].args.slice(1), ['speech.wav', 'models', 'lyrics.json', '5', 'manual:fr'],
  'real transcription dispatch forwards the cap independently of recognition language')
assert.ok(calls.every((call) => call.command === process.execPath
  && call.options.env.ELECTRON_RUN_AS_NODE === '1'), 'providers launch local Node-mode workers')
assert.match(demucsSource, /InferenceSession\.create\(weights, onnxSessionOptions/,
  'Demucs ONNX session must enforce supported thread options')
assert.match(whisperSource, /device: 'cpu'[\s\S]*session_options: onnxSessionOptions/,
  'Whisper ONNX sessions must enforce the CPU provider and supported thread options')

console.log('PASS processing resources: CPU calculation, real provider dispatch, and worker propagation.')
