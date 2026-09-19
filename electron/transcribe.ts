import { readFile, writeFile } from 'node:fs/promises'
import type { TranscriptionResult } from './types.js'
import { onnxSessionOptions } from './processing-resources.js'
import {
  normalizeWhisperChunksWithDiagnostics,
  type TimedTextFragment,
} from './transcription-timing.js'

type WordChunk = TimedTextFragment

interface WhisperModel {
  (inputs: {
    input_features: unknown
    decoder_input_ids: unknown
  }): Promise<{ logits: { data: ArrayLike<number> } }>
  generation_config: {
    decoder_start_token_id: number
    lang_to_id: Record<string, number>
  }
}

interface WhisperTranscriber {
  (audio: Float32Array, options: {
    return_timestamps: 'word'
    chunk_length_s: number
    stride_length_s: number
    language: string
    task: 'transcribe'
  }): Promise<{ text: string; chunks?: WordChunk[] }>
  processor: (audio: Float32Array) => Promise<{ input_features: unknown }>
  model: WhisperModel
  dispose: () => Promise<void>
}

function report(event: Record<string, unknown>) {
  process.stdout.write(`KARAOKE_PROGRESS ${JSON.stringify(event)}\n`)
}

function readMonoPcm16Wav(buffer: Buffer) {
  if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'RIFF'
    || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Whisper input is not a valid WAV file.')
  }

  let format: { encoding: number; channels: number; sampleRate: number; bitsPerSample: number } | undefined
  let audioData: Buffer | undefined
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const chunkId = buffer.toString('ascii', offset, offset + 4)
    const chunkSize = buffer.readUInt32LE(offset + 4)
    const dataStart = offset + 8
    const dataEnd = dataStart + chunkSize
    if (dataEnd > buffer.length) throw new Error('Whisper input WAV is truncated.')

    if (chunkId === 'fmt ' && chunkSize >= 16) {
      format = {
        encoding: buffer.readUInt16LE(dataStart),
        channels: buffer.readUInt16LE(dataStart + 2),
        sampleRate: buffer.readUInt32LE(dataStart + 4),
        bitsPerSample: buffer.readUInt16LE(dataStart + 14),
      }
    } else if (chunkId === 'data') {
      audioData = buffer.subarray(dataStart, dataEnd)
    }
    offset = dataEnd + (chunkSize % 2)
  }

  if (!format || !audioData) throw new Error('Whisper input WAV is missing audio data.')
  if (format.encoding !== 1 || format.channels !== 1 || format.sampleRate !== 16000
    || format.bitsPerSample !== 16) {
    throw new Error('Whisper input must be 16 kHz mono 16-bit PCM WAV audio.')
  }
  if (audioData.length % 2 !== 0) throw new Error('Whisper input PCM data is truncated.')

  const audio = new Float32Array(audioData.length / 2)
  for (let index = 0; index < audio.length; index += 1) {
    audio[index] = audioData.readInt16LE(index * 2) / 32768
  }
  return audio
}

async function detectLanguage(
  transcriber: WhisperTranscriber,
  audio: Float32Array,
  Tensor: typeof import('@huggingface/transformers').Tensor,
) {
  const startToken = transcriber.model.generation_config.decoder_start_token_id
  const sampleLength = 16000 * 30
  const candidates: Array<{ sample: Float32Array; energy: number }> = []
  for (let offset = 0; offset < audio.length; offset += sampleLength) {
    const sample = audio.subarray(offset, Math.min(audio.length, offset + sampleLength))
    let energy = 0
    for (let index = 0; index < sample.length; index += 160) {
      energy += sample[index] * sample[index]
    }
    candidates.push({ sample, energy: energy / Math.max(1, Math.ceil(sample.length / 160)) })
  }
  const samples = candidates.sort((left, right) => right.energy - left.energy).slice(0, 4)
  const languageScores = new Map<string, number>()
  for (const [index, { sample }] of samples.entries()) {
    const { input_features } = await transcriber.processor(sample)
    const decoderInputIds = new Tensor('int64', [BigInt(startToken)], [1, 1])
    const { logits } = await transcriber.model({ input_features, decoder_input_ids: decoderInputIds })
    for (const [token, tokenId] of Object.entries(transcriber.model.generation_config.lang_to_id)) {
      languageScores.set(token, (languageScores.get(token) ?? 0) + Number(logits.data[tokenId]))
    }
    report({ phase: 'language', completed: index + 1, total: samples.length })
  }
  const detected = [...languageScores].sort((left, right) => right[1] - left[1])[0]
  const languageCode = detected?.[0].slice(2, -2) ?? ''
  if (!languageCode) throw new Error('Whisper could not detect the source language.')

  let language = languageCode
  try {
    language = new Intl.DisplayNames(['en'], { type: 'language' }).of(languageCode) ?? languageCode
  } catch {
    // Keep the stable Whisper language code when the runtime has no display-name data.
  }
  return { language, languageCode }
}

async function main() {
  const [audioPath, cacheDir, outputPath, rawThreads] = process.argv.slice(2)
  if (!audioPath || !cacheDir || !outputPath) {
    throw new Error('Missing transcription arguments.')
  }

  process.env.HF_HOME = cacheDir
  process.env.TRANSFORMERS_CACHE = cacheDir
  const cpuThreads = Math.max(1, Math.floor(Number(rawThreads) || 1))

  const { pipeline, Tensor } = await import('@huggingface/transformers')
  report({ phase: 'model', status: 'loading' })
  const transcriber = await pipeline(
    'automatic-speech-recognition',
    'onnx-community/whisper-small_timestamped',
    {
      dtype: 'q8',
      device: 'cpu',
      session_options: onnxSessionOptions({
        logicalCores: cpuThreads * 2,
        cpuThreads,
        executionProvider: 'cpu',
        gpuLimitEnforced: false,
        gpuLimitation: '',
      }),
      cache_dir: cacheDir,
      progress_callback: (event: { progress?: number; status?: string; file?: string }) => {
        report({
          phase: 'model',
          status: event.status,
          progress: event.progress,
          file: event.file,
        })
      },
    },
  ) as unknown as WhisperTranscriber
  report({ phase: 'model', status: 'ready', progress: 100 })
  const audio = readMonoPcm16Wav(await readFile(audioPath))
  try {
    const { language, languageCode } = await detectLanguage(transcriber, audio, Tensor)
    report({ phase: 'transcription', status: 'running', duration: audio.length / 16000 })
    const result = await transcriber(audio, {
      return_timestamps: 'word',
      chunk_length_s: 30,
      stride_length_s: 5,
      language: languageCode,
      task: 'transcribe',
    })
    report({ phase: 'transcription', status: 'complete', chunks: result.chunks?.length ?? 0 })

    const normalizedTiming = normalizeWhisperChunksWithDiagnostics(
      result.chunks ?? [],
      audio.length / 16000,
    )
    const transcript: TranscriptionResult = {
      text: result.text.trim(),
      language,
      languageCode,
      languageName: language,
      languageSource: 'detected',
      lines: normalizedTiming.lines,
      timingDiagnostics: normalizedTiming.diagnostics,
    }
    await writeFile(outputPath, JSON.stringify(transcript, null, 2), 'utf8')
    report({
      phase: 'lyrics',
      status: 'written',
      lines: normalizedTiming.lines.length,
      fallbackLines: normalizedTiming.diagnostics.fallbackLineCount,
    })
  } finally {
    await transcriber.dispose()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exit(1)
})
