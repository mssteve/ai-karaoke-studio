import assert from 'node:assert/strict'
import path from 'node:path'
import {
  configureLocalAiProcessRunner,
  dispatchSeparation,
  dispatchTranscription,
  getDefaultProvider,
  installLocalAiProviderForTests,
  listLocalAiProviders,
  resetLocalAiProvidersForTests,
} from '../dist-electron/ai-providers.js'
import { resolveRecognitionLanguage } from '../dist-electron/transcribe.js'

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

const providers = listLocalAiProviders()
equal(providers.map((provider) => provider.id), ['demucs-onnx', 'whisper-small-timestamped'],
  'the local registry exposes the current Demucs and Whisper engines')
check(providers.every((provider) => provider.local && provider.capabilities.forcedTextAlignment === false
  && provider.capabilities.cloud === false),
'default engines must not claim forced text alignment or cloud processing')
equal(getDefaultProvider('separation').descriptor, providers[0],
  'the default separation provider is demucs-onnx')
equal(getDefaultProvider('transcription').descriptor.capabilities.timedWords, true,
  'the default Whisper provider reports timed words without forced alignment')

const calls = []
configureLocalAiProcessRunner(async (command, args) => {
  calls.push({ command, args })
})
await getDefaultProvider('transcription').transcribe({
  audioPath: 'speech.wav',
  cacheDir: 'models',
  outputPath: 'lyrics.json',
  cpuThreads: 2,
  recognitionArgument: 'manual:fr',
})
equal(calls[0].args.slice(-1), ['manual:fr'],
  'the default Whisper provider dispatches the recognition mode as the fifth worker argument')
check(String(calls[0].args[0]).endsWith(`${path.sep}transcribe.js`),
  'transcription dispatch uses the Whisper worker')

let separated = 0
const restore = installLocalAiProviderForTests({
  descriptor: {
    ...providers[0],
    capabilities: { ...providers[0].capabilities },
  },
  separate: async () => {
    separated += 1
  },
})
await dispatchSeparation({ inputPath: 'in.wav', outputRoot: 'out', cpuThreads: 1 })
equal(separated, 1, 'separation call sites dispatch through the installed provider object')
restore()
resetLocalAiProvidersForTests()

let transcribed = 0
installLocalAiProviderForTests({
  descriptor: providers[1],
  transcribe: async (request) => {
    transcribed += 1
    equal(request.recognitionArgument, 'auto', 'injected transcription receives the requested mode')
  },
})
await dispatchTranscription({
  audioPath: 'speech.wav',
  cacheDir: 'models',
  outputPath: 'side.json',
  cpuThreads: 1,
  recognitionArgument: 'auto',
})
equal(transcribed, 1, 'transcription call sites dispatch through the installed provider object')
resetLocalAiProvidersForTests()

const languages = { '<|en|>': 50259, '<|fr|>': 50265, '<|zh|>': 50260 }
equal(resolveRecognitionLanguage(undefined, languages), { mode: 'auto', languageSource: 'detected' },
  'a missing recognition argument keeps automatic detection')
equal(resolveRecognitionLanguage('manual:fr', languages), {
  mode: 'manual',
  languageCode: 'fr',
  languageSource: 'user',
}, 'manual recognition skips detection and records a user language source')
rejects(() => resolveRecognitionLanguage('manual:xx', languages), /Unsupported recognition language\./,
  'manual recognition validates the loaded Whisper lang_to_id map')
rejects(() => resolveRecognitionLanguage('forced:en', languages), /Unsupported recognition language\./,
  'unsupported recognition arguments fail explicitly')

console.log(`PASS ai providers: ${checks} deterministic checks.`)
