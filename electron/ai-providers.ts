import path from 'node:path'
import { fileURLToPath } from 'node:url'

export type LocalAiKind = 'separation' | 'transcription'

export interface LocalAiCapabilities {
  forcedTextAlignment: false
  timedWords: boolean
  languageDetection: boolean
  cloud: false
}

export interface LocalAiProviderDescriptor {
  id: 'demucs-onnx' | 'whisper-small-timestamped'
  kind: LocalAiKind
  label: string
  local: true
  capabilities: LocalAiCapabilities
}

export interface LocalProcessRunOptions {
  env?: NodeJS.ProcessEnv
  onStdoutLine?: (line: string) => void
  onStderrLine?: (line: string) => void
  onHeartbeat?: () => void
}

export type LocalProcessRunner = (
  command: string,
  args: string[],
  options?: LocalProcessRunOptions,
) => Promise<void>

export interface SeparationRequest {
  inputPath: string
  outputRoot: string
  cpuThreads: number
  onStdoutLine?: (line: string) => void
  onHeartbeat?: () => void
}

export interface SeparationProvider {
  descriptor: LocalAiProviderDescriptor
  separate: (request: SeparationRequest) => Promise<void>
}

export interface TranscriptionRequest {
  audioPath: string
  cacheDir: string
  outputPath: string
  cpuThreads: number
  recognitionArgument?: string
  onStdoutLine?: (line: string) => void
  onHeartbeat?: () => void
}

export interface TranscriptionProvider {
  descriptor: LocalAiProviderDescriptor
  transcribe: (request: TranscriptionRequest) => Promise<void>
}

export type LocalAiProvider = SeparationProvider | TranscriptionProvider

const moduleDir = path.dirname(fileURLToPath(import.meta.url))

export const DEMUCS_ONNX_PROVIDER: LocalAiProviderDescriptor = {
  id: 'demucs-onnx',
  kind: 'separation',
  label: 'Demucs ONNX htdemucs',
  local: true,
  capabilities: {
    forcedTextAlignment: false,
    timedWords: false,
    languageDetection: false,
    cloud: false,
  },
}

export const WHISPER_TIMESTAMPED_PROVIDER: LocalAiProviderDescriptor = {
  id: 'whisper-small-timestamped',
  kind: 'transcription',
  label: 'Whisper small timestamped',
  local: true,
  capabilities: {
    forcedTextAlignment: false,
    timedWords: true,
    languageDetection: true,
    cloud: false,
  },
}

const descriptors = [DEMUCS_ONNX_PROVIDER, WHISPER_TIMESTAMPED_PROVIDER]

let processRunner: LocalProcessRunner | undefined
const overrides = new Map<LocalAiKind, LocalAiProvider>()

export function configureLocalAiProcessRunner(runner: LocalProcessRunner) {
  processRunner = runner
}

export function listLocalAiProviders(): LocalAiProviderDescriptor[] {
  return descriptors.map((descriptor) => ({
    ...descriptor,
    capabilities: { ...descriptor.capabilities },
  }))
}

function requireRunner() {
  if (!processRunner) throw new Error('Local AI process runner is not configured.')
  return processRunner
}

export function createDemucsOnnxProvider(runner?: LocalProcessRunner): SeparationProvider {
  return {
    descriptor: DEMUCS_ONNX_PROVIDER,
    separate: (request) => (runner ?? requireRunner())(process.execPath, [
      path.join(moduleDir, 'demucs-runner.js'),
      request.inputPath,
      request.outputRoot,
      String(request.cpuThreads),
    ], {
      env: { ELECTRON_RUN_AS_NODE: '1' },
      onStdoutLine: request.onStdoutLine,
      onHeartbeat: request.onHeartbeat,
    }),
  }
}

export function createWhisperTimestampedProvider(
  runner?: LocalProcessRunner,
): TranscriptionProvider {
  return {
    descriptor: WHISPER_TIMESTAMPED_PROVIDER,
    transcribe: (request) => (runner ?? requireRunner())(process.execPath, [
      path.join(moduleDir, 'transcribe.js'),
      request.audioPath,
      request.cacheDir,
      request.outputPath,
      String(request.cpuThreads),
      request.recognitionArgument ?? 'auto',
    ], {
      env: { ELECTRON_RUN_AS_NODE: '1' },
      onStdoutLine: request.onStdoutLine,
      onHeartbeat: request.onHeartbeat,
    }),
  }
}

export function getDefaultProvider(kind: 'separation'): SeparationProvider
export function getDefaultProvider(kind: 'transcription'): TranscriptionProvider
export function getDefaultProvider(kind: LocalAiKind): LocalAiProvider {
  if (kind === 'separation') return createDemucsOnnxProvider()
  if (kind === 'transcription') return createWhisperTimestampedProvider()
  throw new Error(`Unsupported local AI provider kind: ${String(kind)}`)
}

export function installLocalAiProviderForTests(provider: LocalAiProvider) {
  const previous = overrides.get(provider.descriptor.kind)
  overrides.set(provider.descriptor.kind, provider)
  return () => {
    if (previous) overrides.set(provider.descriptor.kind, previous)
    else overrides.delete(provider.descriptor.kind)
  }
}

export function resetLocalAiProvidersForTests() {
  overrides.clear()
}

export async function dispatchSeparation(request: SeparationRequest) {
  const provider = (overrides.get('separation') as SeparationProvider | undefined)
    ?? getDefaultProvider('separation')
  if (provider.descriptor.kind !== 'separation') {
    throw new Error('The separation provider kind does not match the dispatch.')
  }
  await provider.separate(request)
}

export async function dispatchTranscription(request: TranscriptionRequest) {
  const provider = (overrides.get('transcription') as TranscriptionProvider | undefined)
    ?? getDefaultProvider('transcription')
  if (provider.descriptor.kind !== 'transcription') {
    throw new Error('The transcription provider kind does not match the dispatch.')
  }
  await provider.transcribe(request)
}
