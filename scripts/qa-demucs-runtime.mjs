import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

const workspace = path.resolve('scripts', 'qa-artifacts', 'demucs-runtime')
const runner = path.resolve('dist-electron', 'demucs-runner.js')
const sampleRate = 44_100
const cases = [
  { name: 'short-padding', seconds: 0.2 },
  { name: 'trailing-split', seconds: 6.0 },
]

function createWav(seconds) {
  const channels = 2
  const frames = Math.round(seconds * sampleRate)
  const dataBytes = frames * channels * 2
  const buffer = Buffer.alloc(44 + dataBytes)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataBytes, 4)
  buffer.write('WAVEfmt ', 8)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(channels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * channels * 2, 28)
  buffer.writeUInt16LE(channels * 2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataBytes, 40)
  for (let frame = 0; frame < frames; frame += 1) {
    const envelope = Math.sin(Math.PI * frame / frames)
    const left = Math.round(Math.sin(2 * Math.PI * 220 * frame / sampleRate) * envelope * 8_000)
    const right = Math.round(Math.sin(2 * Math.PI * 330 * frame / sampleRate) * envelope * 8_000)
    buffer.writeInt16LE(left, 44 + frame * 4)
    buffer.writeInt16LE(right, 46 + frame * 4)
  }
  return buffer
}

function run(input, output) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [runner, input, output, '1'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

function wavFrames(buffer) {
  assert.equal(buffer.subarray(0, 4).toString(), 'RIFF')
  assert.equal(buffer.subarray(8, 12).toString(), 'WAVE')
  const channels = buffer.readUInt16LE(22)
  const bitsPerSample = buffer.readUInt16LE(34)
  return buffer.readUInt32LE(40) / (channels * bitsPerSample / 8)
}

await rm(workspace, { recursive: true, force: true })
await mkdir(workspace, { recursive: true })
let checks = 0
for (const testCase of cases) {
  const input = path.join(workspace, `${testCase.name}.wav`)
  const output = path.join(workspace, 'output')
  await writeFile(input, createWav(testCase.seconds))
  const result = await run(input, output)
  assert.equal(result.code, 0, result.stderr || result.stdout)
  checks += 1
  const expectedFrames = Math.round(testCase.seconds * sampleRate)
  for (const stem of ['drums', 'bass', 'other', 'vocals']) {
    const stemPath = path.join(output, testCase.name, `${stem}.wav`)
    assert.ok((await stat(stemPath)).size > 44, `${testCase.name} ${stem} must be nonempty`)
    assert.equal(wavFrames(await readFile(stemPath)), expectedFrames,
      `${testCase.name} ${stem} duration must match the input`)
    checks += 2
  }
}

console.log(`PASS real Demucs runtime: ${checks} checks for short padding, trailing split, four stems, and exact duration.`)
