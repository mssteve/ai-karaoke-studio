import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { ONNXHTDemucs } from 'demucs/dist/onnx-htdemucs.js'
import {
  createValidatedDemucsModel,
  resolveDemucsWeightsPath,
} from '../dist-electron/demucs-inference.js'

let checks = 0
const check = (condition, message) => {
  assert.ok(condition, message)
  checks += 1
}
const rejects = async (action, pattern, message) => {
  await assert.rejects(action, pattern, message)
  checks += 1
}

const inputNames = ['input', 'onnx::ReduceMean_1']
const outputNames = ['output', '5073']
const mix = { data: new Float32Array(16), shape: [1, 2, 8] }
const magspec = { data: new Float32Array(32), shape: [1, 4, 2, 4] }
const validResults = {
  output: { data: new Float32Array(1 * 4 * 4 * 2 * 2), dims: [1, 4, 4, 2, 2] },
  5073: { data: new Float32Array(1 * 4 * 2 * 8), dims: [1, 4, 2, 8] },
}
const session = (overrides = {}) => ({
  inputNames,
  outputNames,
  run: async () => validResults,
  ...overrides,
})

const brokenConstruction = Object.create(ONNXHTDemucs.prototype)
check(brokenConstruction.sources === undefined,
  'the former Object.create construction must reproduce the missing model.sources field')

const model = createValidatedDemucsModel(session())
check(model.sources.length === 4 && model.segment === 7.8,
  'validated construction must execute Demucs class field initialization')
const outputs = await model.forward(mix, magspec)
check(outputs.outX.shape.length === 5 && outputs.outXt.shape.length === 4,
  'valid inference outputs must cross the boundary')

await rejects(
  () => createValidatedDemucsModel(session({
    run: async () => ({ 5073: validResults['5073'] }),
  })).forward(mix, magspec),
  /frequency-mask.*missing.*name="output"/i,
  'undefined named output must fail explicitly',
)
assert.throws(
  () => createValidatedDemucsModel(session({ outputNames: ['output'] })),
  /output contract is incomplete.*output/i,
)
checks += 1
await rejects(
  () => createValidatedDemucsModel(session({
    run: async () => ({
      ...validResults,
      output: { data: new Float32Array(32), dims: [1, 4, 4, 2] },
    }),
  })).forward(mix, magspec),
  /frequency-mask.*invalid rank\/shape.*\[1,4,4,2\]/i,
  'wrong output rank must fail with safe shape context',
)
await rejects(
  () => createValidatedDemucsModel(session({
    run: async () => ({
      ...validResults,
      output: { data: new Float32Array(1) },
    }),
  })).forward(mix, magspec),
  /frequency-mask.*no valid shape metadata.*name="output"/i,
  'missing output shape metadata must fail without a TypeError',
)
await rejects(
  () => createValidatedDemucsModel(session({
    run: async () => ({
      ...validResults,
      5073: { data: new Float32Array(24), dims: [1, 4, 3, 2] },
    }),
  })).forward(mix, magspec),
  /time-branch.*incompatible shape.*\[1,4,3,2\]/i,
  'wrong output channel shape must fail explicitly',
)
await rejects(
  () => createValidatedDemucsModel(session({
    run: async () => { throw new Error('out of memory') },
  })).forward(mix, magspec),
  /failed during session\.run.*out of memory/i,
  'inference rejection and memory pressure must retain the inference stage',
)
await rejects(
  () => model.forward({ data: new Float32Array(8), shape: [1, 8] }, magspec),
  /waveform input has invalid rank/i,
  'bad input rank must fail before ONNX Runtime',
)
await rejects(
  () => model.forward(mix, { data: new Float32Array(3), shape: [1, 4, 2, 4] }),
  /spectrogram input data does not match shape/i,
  'bad input data shape must fail before ONNX Runtime',
)

const weightsPath = resolveDemucsWeightsPath()
await access(weightsPath)
check(/node_modules[\\/]demucs[\\/]htdemucs\.onnx$/i.test(weightsPath),
  'installed/package-backed model resolution must target the Demucs package')

const runnerSource = await readFile('electron/demucs-runner.ts', 'utf8')
check(
  runnerSource.indexOf('await separateTracks(') < runnerSource.indexOf('await mkdir(outputDir'),
  'runner must complete every inference split before publishing any stem directory',
)
const mainSource = await readFile('electron/main.ts', 'utf8')
check(
  mainSource.indexOf('await fingerprint(generatedPath, 44)')
    < mainSource.indexOf('await replaceFile(generated[name], paths.stems[name])'),
  'main process must validate all temporary stems before replacing durable stems',
)

console.log(`PASS Demucs inference boundary: ${checks} deterministic checks.`)
