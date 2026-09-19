import { spawn } from 'node:child_process'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const options = parseArgs(process.argv.slice(2))
const executable = path.resolve(options.app ?? path.join(projectRoot, 'release', 'win-unpacked', 'Karaoke Studio.exe'))
const outputRoot = path.resolve(options.output ?? path.join(
  projectRoot,
  'scripts',
  'qa-artifacts',
  `packaged-demucs-${new Date().toISOString().replaceAll(':', '-')}`,
))
const fixturePath = path.join(outputRoot, 'short-stereo.wav')
const stemRoot = path.join(outputRoot, 'separated', 'short-stereo')
const reportPath = path.join(outputRoot, 'report.json')
const logPath = path.join(outputRoot, 'demucs.log')
const expectedStems = ['vocals.wav', 'drums.wav', 'bass.wav', 'other.wav']

function parseArgs(args) {
  const parsed = {}
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (value === '--app') parsed.app = args[++index]
    else if (value === '--output') parsed.output = args[++index]
    else if (value === '--timeout-ms') parsed.timeoutMs = Number(args[++index])
    else throw new Error(`Unknown argument: ${value}`)
  }
  if (parsed.timeoutMs !== undefined && (!Number.isFinite(parsed.timeoutMs) || parsed.timeoutMs <= 0)) {
    throw new Error('--timeout-ms must be a positive number.')
  }
  return parsed
}

function createWav(durationSeconds = 0.5, sampleRate = 44_100) {
  const channels = 2
  const bytesPerSample = 2
  const sampleCount = Math.round(durationSeconds * sampleRate)
  const dataSize = sampleCount * channels * bytesPerSample
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(channels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * channels * bytesPerSample, 28)
  buffer.writeUInt16LE(channels * bytesPerSample, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)

  for (let sample = 0; sample < sampleCount; sample += 1) {
    const envelope = Math.sin(Math.PI * sample / sampleCount)
    const left = Math.sin(2 * Math.PI * 220 * sample / sampleRate) * envelope
    const right = Math.sin(2 * Math.PI * 330 * sample / sampleRate) * envelope
    const offset = 44 + sample * channels * bytesPerSample
    buffer.writeInt16LE(Math.round(left * 12_000), offset)
    buffer.writeInt16LE(Math.round(right * 12_000), offset + bytesPerSample)
  }
  return buffer
}

async function runDemucs(cliPath) {
  const child = spawn(executable, [
    cliPath,
    fixturePath,
    '--output',
    path.join(outputRoot, 'separated'),
  ], {
    cwd: path.dirname(executable),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    windowsHide: true,
  })
  const stdout = []
  const stderr = []
  child.stdout.on('data', (chunk) => stdout.push(chunk))
  child.stderr.on('data', (chunk) => stderr.push(chunk))

  const timeoutMs = options.timeoutMs ?? 12 * 60 * 1000
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill()
  }, timeoutMs)
  const result = await new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code, signal }))
  })
  clearTimeout(timer)

  const output = `${Buffer.concat(stdout).toString()}${Buffer.concat(stderr).toString()}`
  await writeFile(logPath, output)
  return { ...result, timedOut, output }
}

async function inspectStem(fileName) {
  const filePath = path.join(stemRoot, fileName)
  try {
    const fileStat = await stat(filePath)
    const header = await readFile(filePath)
    return {
      fileName,
      path: filePath,
      bytes: fileStat.size,
      valid: fileStat.size > 44
        && header.subarray(0, 4).toString() === 'RIFF'
        && header.subarray(8, 12).toString() === 'WAVE',
    }
  } catch (error) {
    return { fileName, path: filePath, bytes: 0, valid: false, error: error.message }
  }
}

async function main() {
  await rm(outputRoot, { recursive: true, force: true })
  await mkdir(outputRoot, { recursive: true })
  await writeFile(fixturePath, createWav())

  const resourcesRoot = path.join(path.dirname(executable), 'resources')
  const cliPath = path.join(resourcesRoot, 'app.asar.unpacked', 'node_modules', 'demucs', 'dist', 'cli.js')
  const result = await runDemucs(cliPath)
  const stems = await Promise.all(expectedStems.map(inspectStem))
  const passed = result.code === 0 && !result.timedOut && stems.every((stem) => stem.valid)
  const report = {
    status: passed ? 'passed' : 'failed',
    mechanism: `${path.basename(executable)} with ELECTRON_RUN_AS_NODE=1`,
    executable,
    demucsCli: cliPath,
    fixture: fixturePath,
    output: stemRoot,
    exitCode: result.code,
    signal: result.signal,
    timedOut: result.timedOut,
    stems,
    log: logPath,
  }
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)

  console.log(`${passed ? 'PASS' : 'FAIL'} packaged Demucs: ${stems.filter((stem) => stem.valid).length}/4 valid WAV stems.`)
  console.log(`Electron-as-Node: ${executable}`)
  console.log(`Demucs CLI: ${cliPath}`)
  console.log(`Fixture: ${fixturePath}`)
  console.log(`Stem output: ${stemRoot}`)
  console.log(`Report: ${reportPath}`)
  if (!passed) {
    const failure = result.output.trim().split(/\r?\n/).slice(-12).join('\n')
    if (failure) console.error(failure)
    process.exitCode = 1
  }
}

main().catch(async (error) => {
  await mkdir(outputRoot, { recursive: true })
  await writeFile(reportPath, `${JSON.stringify({
    status: 'failed',
    executable,
    error: error.stack ?? error.message,
  }, null, 2)}\n`)
  console.error(error.stack ?? error.message)
  process.exitCode = 1
})
