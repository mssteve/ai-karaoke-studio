import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdir,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const musicRoot = path.resolve(process.argv[2] ?? '')
const appPath = path.resolve(process.argv[3] ?? '')
const outputRoot = path.resolve(process.argv[4] ?? '')
if (!process.argv[2] || !process.argv[3] || !process.argv[4]) {
  throw new Error('Usage: node scripts\\qa-demucs-music-acceptance.mjs <music-root> <packaged-app> <output-root>')
}

const supported = new Set(['.mp3', '.mp4', '.wav'])
const stemNames = ['drums', 'bass', 'other', 'vocals']
const logicalCores = os.availableParallelism()
const cpuThreads = Math.max(1, Math.floor(logicalCores / 2))
const packageRoot = path.dirname(appPath)
const runnerPath = path.join(packageRoot, 'resources', 'app.asar', 'dist-electron', 'demucs-runner.js')
const ffmpegPath = path.join(
  packageRoot,
  'resources',
  'app.asar.unpacked',
  'node_modules',
  '@ffmpeg-installer',
  'win32-x64',
  'ffmpeg.exe',
)
const reportPath = path.join(outputRoot, 'report.json')
const startedAt = new Date().toISOString()

async function inventory(root) {
  const files = []
  const visit = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const itemPath = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(itemPath)
      else if (entry.isFile() && supported.has(path.extname(entry.name).toLowerCase())) files.push(itemPath)
    }
  }
  await visit(root)
  return files.sort((left, right) => left.localeCompare(right))
}

async function sha256(filePath) {
  const handle = await open(filePath, 'r')
  const hash = createHash('sha256')
  try {
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk)
  } finally {
    await handle.close()
  }
  return hash.digest('hex')
}

async function sourceSnapshot(filePath) {
  const info = await stat(filePath)
  return {
    bytes: info.size,
    modifiedAtMs: info.mtimeMs,
    createdAtMs: info.birthtimeMs,
    sha256: await sha256(filePath),
  }
}

function sanitize(value, sourcePath, id) {
  return value
    .replaceAll(sourcePath, `<source:${id}>`)
    .replaceAll(sourcePath.replaceAll('\\', '/'), `<source:${id}>`)
    .replaceAll(musicRoot, '<music-root>')
    .replaceAll(musicRoot.replaceAll('\\', '/'), '<music-root>')
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: options.env ?? process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    let timedOut = false
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          child.kill()
        }, options.timeoutMs)
      : undefined
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))
    child.on('error', reject)
    child.on('close', (exitCode, signal) => {
      if (timer) clearTimeout(timer)
      resolve({
        exitCode,
        signal,
        timedOut,
        stdout: Buffer.concat(stdout).toString(),
        stderr: Buffer.concat(stderr).toString(),
      })
    })
  })
}

function freeMemoryKiB() {
  const result = spawnSync('powershell.exe', [
    '-NoProfile',
    '-Command',
    '(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory',
  ], { encoding: 'utf8', windowsHide: true })
  const value = Number(result.stdout.trim())
  return Number.isFinite(value) ? value : null
}

function parseWav(buffer) {
  if (buffer.length < 12 || buffer.subarray(0, 4).toString() !== 'RIFF'
    || buffer.subarray(8, 12).toString() !== 'WAVE') {
    throw new Error('Invalid RIFF/WAVE header.')
  }
  let offset = 12
  let format
  let dataBytes
  while (offset + 8 <= buffer.length) {
    const chunk = buffer.subarray(offset, offset + 4).toString()
    const size = buffer.readUInt32LE(offset + 4)
    const start = offset + 8
    if (chunk === 'fmt ' && size >= 16 && start + size <= buffer.length) {
      format = {
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        blockAlign: buffer.readUInt16LE(start + 12),
        bitsPerSample: buffer.readUInt16LE(start + 14),
      }
    } else if (chunk === 'data') {
      dataBytes = Math.min(size, buffer.length - start)
      break
    }
    offset = start + size + (size % 2)
  }
  if (!format || !dataBytes || !format.blockAlign || !format.sampleRate) {
    throw new Error('WAV format or audio data chunk is missing.')
  }
  const frames = Math.floor(dataBytes / format.blockAlign)
  return { ...format, frames, durationSeconds: frames / format.sampleRate }
}

async function inspectWav(filePath) {
  const info = await stat(filePath)
  const wav = parseWav(await readFile(filePath))
  return { bytes: info.size, ...wav }
}

async function collectPublishedStems(directory) {
  const published = []
  for (const name of stemNames) {
    try {
      const info = await stat(path.join(directory, `${name}.wav`))
      if (info.isFile()) published.push(name)
    } catch {
      // Absence is the expected failure behavior.
    }
  }
  return published
}

await rm(outputRoot, { recursive: true, force: true })
await mkdir(outputRoot, { recursive: true })
const sources = await inventory(musicRoot)
const initial = []
for (let index = 0; index < sources.length; index += 1) {
  const snapshot = await sourceSnapshot(sources[index])
  initial.push({
    id: `media-${String(index + 1).padStart(3, '0')}-${snapshot.sha256.slice(0, 12)}`,
    path: sources[index],
    ...snapshot,
  })
}

const packageDiagnostics = {
  executableSha256: await sha256(appPath),
  appAsarSha256: await sha256(path.join(packageRoot, 'resources', 'app.asar')),
  runner: 'resources/app.asar/dist-electron/demucs-runner.js',
  ffmpeg: 'resources/app.asar.unpacked/node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe',
}
const resourcePolicy = {
  logicalCores,
  cpuThreads,
  executionProvider: 'cpu',
  executionMode: 'sequential',
  interOpThreads: 1,
  workerEnvironment: {
    OMP_NUM_THREADS: String(cpuThreads),
    OMP_THREAD_LIMIT: String(cpuThreads),
    MKL_NUM_THREADS: String(cpuThreads),
    OPENBLAS_NUM_THREADS: String(cpuThreads),
    NUMEXPR_NUM_THREADS: String(cpuThreads),
    VECLIB_MAXIMUM_THREADS: String(cpuThreads),
  },
}
const results = []

for (let index = 0; index < initial.length; index += 1) {
  const source = initial[index]
  const caseRoot = path.join(outputRoot, 'processed', source.id)
  const preparedPath = path.join(caseRoot, 'source.wav')
  const separatedRoot = path.join(caseRoot, 'separated')
  await mkdir(caseRoot, { recursive: true })
  const caseStarted = Date.now()
  const memoryBeforeKiB = freeMemoryKiB()
  const conversion = await run(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', source.path,
    '-vn', '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le',
    '-threads', String(cpuThreads),
    preparedPath,
  ], { timeoutMs: 30 * 60 * 1000 })
  const record = {
    id: source.id,
    ordinal: index + 1,
    source: {
      sha256: source.sha256,
      bytes: source.bytes,
      modifiedAtMs: source.modifiedAtMs,
      createdAtMs: source.createdAtMs,
    },
    queue: {
      concurrency: 1,
      priorTerminal: index === 0 || results[index - 1]?.terminal === true,
    },
    conversion: {
      exitCode: conversion.exitCode,
      timedOut: conversion.timedOut,
    },
    attempts: [],
    outputs: [],
    resourceDiagnostics: {
      memoryBeforeKiB,
      memoryAfterKiB: null,
      cpuThreads,
    },
    terminal: false,
  }

  if (conversion.exitCode !== 0 || conversion.timedOut) {
    record.failure = {
      stage: 'source-preparation',
      detail: sanitize(conversion.stderr || conversion.stdout, source.path, source.id).trim(),
    }
  } else {
    const prepared = await inspectWav(preparedPath)
    record.prepared = prepared
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const attemptRoot = path.join(separatedRoot, `attempt-${attempt}`)
      await rm(attemptRoot, { recursive: true, force: true })
      const attemptStarted = Date.now()
      const execution = await run(appPath, [
        runnerPath,
        preparedPath,
        attemptRoot,
        String(cpuThreads),
      ], {
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          ...resourcePolicy.workerEnvironment,
        },
        timeoutMs: 30 * 60 * 1000,
      })
      const stemDirectory = path.join(attemptRoot, 'source')
      const published = await collectPublishedStems(stemDirectory)
      const attemptRecord = {
        attempt,
        exitCode: execution.exitCode,
        signal: execution.signal,
        timedOut: execution.timedOut,
        elapsedMs: Date.now() - attemptStarted,
        progress: execution.stdout.split(/\r?\n/).filter((line) => /^\d+\/\d+$/.test(line)),
        publishedStemCount: published.length,
      }
      if (execution.exitCode !== 0 || execution.timedOut) {
        attemptRecord.failure = sanitize(execution.stderr || execution.stdout, source.path, source.id)
          .trim().split(/\r?\n/).slice(-20)
        record.attempts.push(attemptRecord)
        if (published.length !== 0) {
          record.failure = {
            stage: 'partial-publication',
            detail: `${published.length} stems were visible after failed inference.`,
          }
          break
        }
        if (attempt === 2) {
          record.failure = {
            stage: 'demucs',
            detail: attemptRecord.failure,
          }
        }
        continue
      }

      let valid = true
      for (const name of stemNames) {
        const stemPath = path.join(stemDirectory, `${name}.wav`)
        try {
          const stem = await inspectWav(stemPath)
          const durationDeltaSeconds = Math.abs(stem.durationSeconds - prepared.durationSeconds)
          const decode = await run(ffmpegPath, [
            '-hide_banner', '-loglevel', 'error',
            '-threads', String(cpuThreads),
            '-i', stemPath,
            '-t', '0.1',
            '-f', 'null', '-',
          ], { timeoutMs: 2 * 60 * 1000 })
          const output = {
            component: `stem-${name}`,
            relativePath: path.relative(outputRoot, stemPath),
            bytes: stem.bytes,
            durationSeconds: stem.durationSeconds,
            durationDeltaSeconds,
            decodable: decode.exitCode === 0 && !decode.timedOut,
          }
          record.outputs.push(output)
          if (stem.frames <= 0 || durationDeltaSeconds > 1 / prepared.sampleRate || !output.decodable) {
            valid = false
          }
        } catch (error) {
          valid = false
          record.outputs.push({
            component: `stem-${name}`,
            relativePath: path.relative(outputRoot, stemPath),
            valid: false,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
      attemptRecord.validStemCount = record.outputs.filter((output) => (
        output.bytes > 44 && output.decodable && output.durationDeltaSeconds <= 1 / prepared.sampleRate
      )).length
      record.attempts.push(attemptRecord)
      if (valid && attemptRecord.validStemCount === 4) {
        record.terminal = true
        break
      }
      record.failure = {
        stage: 'stem-validation',
        detail: 'One or more stems failed duration or decodability validation.',
      }
      break
    }
  }
  record.elapsedMs = Date.now() - caseStarted
  record.resourceDiagnostics.memoryAfterKiB = freeMemoryKiB()
  await rm(preparedPath, { force: true })
  results.push(record)
  await writeFile(reportPath, `${JSON.stringify({
    verdict: 'running',
    startedAt,
    updatedAt: new Date().toISOString(),
    inventoryCount: initial.length,
    completedCount: results.length,
    packageDiagnostics,
    resourcePolicy,
    results,
  }, null, 2)}\n`)
  console.log(`${record.terminal ? 'PASS' : 'FAIL'} ${source.id} (${index + 1}/${initial.length})`)
}

const finalSources = []
for (const source of initial) {
  const final = await sourceSnapshot(source.path)
  finalSources.push({
    id: source.id,
    hashUnchanged: final.sha256 === source.sha256,
    bytesUnchanged: final.bytes === source.bytes,
    modifiedAtUnchanged: final.modifiedAtMs === source.modifiedAtMs,
    createdAtUnchanged: final.createdAtMs === source.createdAtMs,
  })
}
const allSourcesUnchanged = finalSources.every((source) => (
  source.hashUnchanged && source.bytesUnchanged && source.modifiedAtUnchanged && source.createdAtUnchanged
))
const allPassed = results.length > 0
  && results.every((result) => result.terminal && result.outputs.length === 4)
  && allSourcesUnchanged
  && results.every((result, index) => index === 0 || result.queue.priorTerminal)
const report = {
  verdict: allPassed ? 'APPROVE' : 'REJECT',
  startedAt,
  completedAt: new Date().toISOString(),
  inventoryCount: initial.length,
  packageDiagnostics,
  resourcePolicy,
  sourceIntegrity: {
    allUnchanged: allSourcesUnchanged,
    files: finalSources,
  },
  queue: {
    concurrency: 1,
    sequentialTerminalContinuation: results.every((result, index) => index === 0 || result.queue.priorTerminal),
  },
  results,
}
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(`${report.verdict}: ${results.filter((result) => result.terminal).length}/${results.length} anonymized media files passed.`)
if (!allPassed) process.exitCode = 1
