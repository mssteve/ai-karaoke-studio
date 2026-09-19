import { access } from 'node:fs/promises'
import path from 'node:path'

const requiredSiblings = [
  'main.js',
  'preload.cjs',
  'transcribe.js',
  'transcription-timing.js',
  'demucs-runner.js',
  'demucs-inference.js',
]

export async function verifyLocalElectronEntry(executable, entry) {
  const missing = []
  for (const file of [executable, ...requiredSiblings.map((name) => path.join(path.dirname(entry), name))]) {
    try {
      await access(file)
    } catch {
      missing.push(file)
    }
  }
  if (missing.length) {
    throw new Error(
      `Local Electron output is incomplete. Run "npm start" for an interactive launch `
      + `or "npm run build" before QA.\nMissing:\n- ${missing.join('\n- ')}`,
    )
  }
}
