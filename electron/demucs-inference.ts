import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ONNXHTDemucs } from 'demucs/dist/onnx-htdemucs.js'
import * as ort from 'onnxruntime-node'

interface TensorData {
  data: Float32Array
  shape: number[]
}

interface SessionLike {
  inputNames: readonly string[]
  outputNames: readonly string[]
  run: (feeds: Record<string, ort.Tensor>) => Promise<Record<string, {
    data: ort.Tensor['data']
    dims: readonly number[]
  }>>
}

function shapeText(shape: readonly number[] | undefined) {
  return shape ? `[${shape.join(',')}]` : 'missing'
}

function tensorSize(shape: readonly number[]) {
  return shape.reduce((size, dimension) => size * dimension, 1)
}

function validateInput(label: string, tensor: TensorData, rank: number) {
  if (!tensor || !Array.isArray(tensor.shape) || tensor.shape.length !== rank) {
    throw new Error(`Demucs ${label} input has invalid rank; expected ${rank}, received ${shapeText(tensor?.shape)}.`)
  }
  if (tensor.shape.some((dimension) => !Number.isInteger(dimension) || dimension <= 0)) {
    throw new Error(`Demucs ${label} input has invalid shape ${shapeText(tensor.shape)}.`)
  }
  if (!(tensor.data instanceof Float32Array) || tensor.data.length !== tensorSize(tensor.shape)) {
    throw new Error(`Demucs ${label} input data does not match shape ${shapeText(tensor.shape)}.`)
  }
}

function validateOutput(
  results: Awaited<ReturnType<SessionLike['run']>>,
  name: string,
  label: string,
  rank: number,
  expectedPrefix: readonly number[],
) {
  const tensor = results[name]
  if (!tensor) {
    throw new Error(`Demucs inference output "${label}" is missing (name="${name}", available=${
      Object.keys(results).join(',') || 'none'
    }).`)
  }
  if (!Array.isArray(tensor.dims)) {
    throw new Error(`Demucs inference output "${label}" has no valid shape metadata (name="${name}").`)
  }
  const shape = [...tensor.dims]
  if (shape.length !== rank) {
    throw new Error(`Demucs inference output "${label}" has invalid rank/shape ${shapeText(shape)}; expected rank ${rank}.`)
  }
  if (shape.some((dimension) => !Number.isInteger(dimension) || dimension <= 0)
    || expectedPrefix.some((dimension, index) => shape[index] !== dimension)) {
    throw new Error(`Demucs inference output "${label}" has incompatible shape ${shapeText(shape)}; expected prefix [${
      expectedPrefix.join(',')
    }].`)
  }
  if (!(tensor.data instanceof Float32Array) || tensor.data.length !== tensorSize(shape)) {
    throw new Error(`Demucs inference output "${label}" data does not match shape ${shapeText(shape)}.`)
  }
  return { data: tensor.data, shape }
}

export function resolveDemucsWeightsPath() {
  const packagePath = fileURLToPath(import.meta.resolve('demucs/package.json'))
  return path.join(path.dirname(packagePath), 'htdemucs.onnx')
}

export function createValidatedDemucsModel(session: SessionLike) {
  const model = Reflect.construct(ONNXHTDemucs, []) as ONNXHTDemucs
  if (!Array.isArray(model.sources) || model.sources.length !== 4
    || model.audioChannels !== 2 || model.samplerate !== 44_100 || model.segment <= 0) {
    throw new Error('Demucs model metadata is incomplete or incompatible.')
  }
  if (session.inputNames.length < 2 || session.inputNames.some((name) => !name)) {
    throw new Error(`Demucs session input contract is incomplete (names=${session.inputNames.join(',') || 'none'}).`)
  }
  if (session.outputNames.length < 2 || session.outputNames.some((name) => !name)) {
    throw new Error(`Demucs session output contract is incomplete (names=${session.outputNames.join(',') || 'none'}).`)
  }

  Object.assign(model, {
    session,
    inputNames: [...session.inputNames],
    outputNames: [...session.outputNames],
  })
  model.forward = async (mix: TensorData, magspec: TensorData) => {
    validateInput('waveform', mix, 3)
    validateInput('spectrogram', magspec, 4)
    const feeds: Record<string, ort.Tensor> = {
      [session.inputNames[0]]: new ort.Tensor('float32', mix.data, mix.shape),
      [session.inputNames[1]]: new ort.Tensor('float32', magspec.data, magspec.shape),
    }
    let results: Awaited<ReturnType<SessionLike['run']>>
    try {
      results = await session.run(feeds)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`Demucs inference failed during session.run (inputs=${
        session.inputNames.join(',')
      }; outputs=${session.outputNames.join(',')}): ${detail}`, { cause: error })
    }
    if (!results || typeof results !== 'object') {
      throw new Error(`Demucs inference returned no output map (expected=${session.outputNames.join(',')}).`)
    }
    const prefix = [mix.shape[0], model.sources.length]
    return {
      outX: validateOutput(
        results,
        session.outputNames[0],
        'frequency-mask',
        5,
        [...prefix, model.audioChannels * 2],
      ),
      outXt: validateOutput(
        results,
        session.outputNames[1],
        'time-branch',
        4,
        [...prefix, model.audioChannels],
      ),
    }
  }
  return model
}
