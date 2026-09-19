import { readFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { separateTracks } from 'demucs/dist/apply.js'
import { samplesToWav, wavToSamples } from 'demucs/dist/wav-utils.js'
import * as ort from 'onnxruntime-node'
import { createValidatedDemucsModel, resolveDemucsWeightsPath } from './demucs-inference.js'
import { onnxSessionOptions } from './processing-resources.js'

async function main() {
  const [inputPath, outputRoot, rawThreads] = process.argv.slice(2)
  if (!inputPath || !outputRoot) throw new Error('Missing Demucs worker arguments.')
  const cpuThreads = Math.max(1, Math.floor(Number(rawThreads) || 1))
  const weightsPath = resolveDemucsWeightsPath()
  const weights = new Uint8Array(await readFile(weightsPath))
  const session = await ort.InferenceSession.create(weights, onnxSessionOptions({
    logicalCores: cpuThreads * 2,
    cpuThreads,
    executionProvider: 'cpu',
    gpuLimitEnforced: false,
    gpuLimitation: '',
  }))
  try {
    const model = createValidatedDemucsModel(session)
    const rawAudio = wavToSamples(new Uint8Array(await readFile(inputPath)))
    const tracks = await separateTracks(model, rawAudio, (step, total) => {
      process.stdout.write(`${step}/${total}\n`)
    })
    const outputDir = path.join(outputRoot, path.basename(inputPath, path.extname(inputPath)))
    await mkdir(outputDir, { recursive: true })
    for (const [name, samples] of Object.entries(tracks)) {
      const outputPath = path.join(outputDir, `${name}.wav`)
      await writeFile(outputPath, samplesToWav(samples.channelData, samples.sampleRate))
      process.stdout.write(`Wrote: ${outputPath}\n`)
    }
  } finally {
    await session.release()
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
})
