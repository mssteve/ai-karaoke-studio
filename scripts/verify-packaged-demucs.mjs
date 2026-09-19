import { spawn } from 'node:child_process'
import { access, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const appDir = path.resolve(process.argv[2] ?? '')
const evidenceDir = path.resolve(process.argv[3] ?? '')
if (!process.argv[2] || !process.argv[3]) {
  throw new Error('Usage: node scripts\\verify-packaged-demucs.mjs <packaged-app-dir> <evidence-dir>')
}

const executable = path.join(appDir, 'Karaoke Studio.exe')
const resources = path.join(appDir, 'resources')
const unpackedModules = path.join(resources, 'app.asar.unpacked', 'node_modules')
const demucsCli = path.join(unpackedModules, 'demucs', 'dist', 'cli.js')
const fixturePath = path.join(evidenceDir, 'short-fixture.wav')
const outputDir = path.join(evidenceDir, 'output')
const sampleRate = 44_100
const seconds = 0.35
const frames = Math.round(sampleRate * seconds)

function createFixture() {
  const channels = 2
  const bitsPerSample = 16
  const dataBytes = frames * channels * bitsPerSample / 8
  const buffer = Buffer.alloc(44 + dataBytes)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataBytes, 4)
  buffer.write('WAVEfmt ', 8)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(channels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, 28)
  buffer.writeUInt16LE(channels * bitsPerSample / 8, 32)
  buffer.writeUInt16LE(bitsPerSample, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataBytes, 40)
  for (let frame = 0; frame < frames; frame += 1) {
    const sample = Math.round(Math.sin(2 * Math.PI * 440 * frame / sampleRate) * 8_000)
    buffer.writeInt16LE(sample, 44 + frame * 4)
    buffer.writeInt16LE(sample, 46 + frame * 4)
  }
  return buffer
}

function runDemucs() {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [demucsCli, fixturePath, '--output', outputDir], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (exitCode) => resolve({ exitCode, stdout, stderr }))
  })
}

await rm(evidenceDir, { recursive: true, force: true })
await mkdir(evidenceDir, { recursive: true })
for (const relative of [
  ['demucs', 'package.json'],
  ['mediabunny', 'package.json'],
  ['@mediabunny', 'mp3-encoder', 'package.json'],
]) {
  await access(path.join(unpackedModules, ...relative))
}
await writeFile(fixturePath, createFixture())
const result = await runDemucs()
if (result.exitCode !== 0) {
  throw new Error(`Packaged Demucs exited with ${result.exitCode}.\n${result.stderr || result.stdout}`)
}

const stemDir = path.join(outputDir, 'short-fixture')
const stems = []
for (const name of ['drums.wav', 'bass.wav', 'other.wav', 'vocals.wav']) {
  const stemPath = path.join(stemDir, name)
  const info = await stat(stemPath)
  const header = await readFile(stemPath)
  if (info.size <= 44 || header.subarray(0, 4).toString() !== 'RIFF') {
    throw new Error(`Packaged Demucs produced an invalid ${name}.`)
  }
  stems.push({ name, bytes: info.size })
}

const evidence = {
  verdict: 'PASS',
  executable,
  command: `"${executable}" "${demucsCli}" "${fixturePath}" --output "${outputDir}"`,
  environment: { ELECTRON_RUN_AS_NODE: '1' },
  exitCode: result.exitCode,
  stdout: result.stdout.trim().split(/\r?\n/),
  stderr: result.stderr.trim().split(/\r?\n/).filter(Boolean),
  fixture: { path: fixturePath, sampleRate, channels: 2, seconds },
  unpackedRuntimePackages: ['demucs', 'mediabunny', '@mediabunny/mp3-encoder'],
  stems,
}
await writeFile(path.join(evidenceDir, 'report.json'), `${JSON.stringify(evidence, null, 2)}\n`)
process.stdout.write(`${JSON.stringify(evidence)}\n`)
