import { spawn } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import {
  ArtifactVerificationError,
  compareSnapshots,
  hashFile,
  readPackageMetadata,
  releaseVersionDirectory,
  snapshotProtectedSources,
  snapshotTree,
  validateApproval,
  verifyApprovedRelease,
} from './release-artifact-verification.mjs'
import {
  acquireOperationLock,
  assertActiveReleaseLock,
  assertCanonicalNodeProcess,
  currentProcessIdentity,
  hashLockToken,
  readLockState,
  ReleaseLockError,
} from './release-operation-lock.mjs'
import { removeCanonicalStage } from './release-source-staging.mjs'

const require = createRequire(import.meta.url)
const asar = require('@electron/asar')
const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const EXIT = Object.freeze({
  OK: 0,
  USAGE: 2,
  SOURCE: 3,
  LOCK: 4,
  ARTIFACT: 5,
  ZIP: 6,
  INSTALL: 7,
  PROMOTION: 8,
})

export class DeployError extends Error {
  constructor(message, exitCode) {
    super(message)
    this.name = 'DeployError'
    this.exitCode = exitCode
  }
}

function fail(message, exitCode) {
  throw new DeployError(message, exitCode)
}

export function parseArguments(argv) {
  const options = { dryRun: false, build: false, zip: false, install: false }
  for (const argument of argv) {
    if (argument === '--dry-run') options.dryRun = true
    else if (argument === '--build') options.build = true
    else if (argument === '--zip') options.zip = true
    else if (argument === '--install') options.install = true
    else if (argument.startsWith('--approval=')) {
      if (!argument.slice(11)) fail('--approval requires a path.', EXIT.USAGE)
      if (options.approval) fail('--approval may be supplied only once.', EXIT.USAGE)
      options.approval = argument.slice(11)
    } else {
      fail(`Unknown option: ${argument}.`, EXIT.USAGE)
    }
  }
  if (!argv.length) options.dryRun = true
  if (options.dryRun && (options.build || options.zip || options.install)) {
    fail('--dry-run cannot be combined with mutating modes.', EXIT.USAGE)
  }
  if (options.approval && !options.build && !options.dryRun) {
    fail('--approval is accepted only with --build or --dry-run.', EXIT.USAGE)
  }
  if (options.build && !options.approval) fail('--build requires --approval=<path>.', EXIT.USAGE)
  if (!options.dryRun && !options.build && !options.zip && !options.install) options.dryRun = true
  return options
}

export function redact(root, value) {
  let output = String(value)
  const home = process.env.USERPROFILE
  for (const sensitive of [root, home].filter(Boolean)) {
    const escaped = sensitive.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    output = output.replace(new RegExp(escaped, 'gi'), '<redacted-root>')
  }
  output = output.replace(
    /(--?[^\s=]*(?:token|secret|password|key)[^\s=]*=)([^\s]+)/gi,
    '$1<redacted>',
  )
  output = output.replace(/\b(?:[A-Za-z]:\\|\\\\)[^\r\n"']+/g, '<redacted-path>')
  output = output.replace(/\b(?:bearer|token|secret|password|api[_-]?key)\s+[\w+/=.-]+/gi, '<redacted-secret>')
  return output
}

function logLine(context, phase, message) {
  context.logs.push({ phase, message: redact(context.root, message) })
  context.writeLog(`[${phase}] ${redact(context.root, message)}`)
}

function runProcess(command, args, {
  cwd,
  env,
  timeoutMs = 0,
  stdio = 'inherit',
  onSpawn,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio,
    })
    onSpawn?.(child)
    let timer
    child.on('error', reject)
    if (timeoutMs > 0) {
      timer = setTimeout(() => reject(Object.assign(new Error('Process timed out.'), {
        code: 'DEPLOY_TIMEOUT',
        pid: child.pid,
      })), timeoutMs)
    }
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, pid: child.pid })
    })
  })
}

async function gitCaptured(root, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: root,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => code === 0
      ? resolve(stdout.trim())
      : reject(new Error(stderr.trim() || `git exited with code ${code}`)))
  })
}

export async function inspectSource(root) {
  let worktree
  try {
    worktree = await gitCaptured(root, ['rev-parse', '--show-toplevel'])
  } catch {
    fail('A valid Git worktree is required.', EXIT.SOURCE)
  }
  if (path.resolve(worktree).toLowerCase() !== path.resolve(root).toLowerCase()) {
    fail('The deployment root is not the Git worktree root.', EXIT.SOURCE)
  }
  const [branch, head] = await Promise.all([
    gitCaptured(root, ['branch', '--show-current']),
    gitCaptured(root, ['rev-parse', 'HEAD']),
  ])
  if (!branch || !head) fail('Git branch and HEAD must be resolvable.', EXIT.SOURCE)
  return { branch, head }
}

function crcTable() {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let value = n
    for (let k = 0; k < 8; k += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1)
    }
    table[n] = value >>> 0
  }
  return table
}

const CRC_TABLE = crcTable()
function updateCrc(crc, buffer) {
  let value = crc
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)
  return value >>> 0
}

function dosTime(date = new Date('2000-01-01T00:00:00Z')) {
  const year = Math.max(1980, date.getUTCFullYear())
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5)
      | Math.floor(date.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  }
}

async function writeAll(handle, buffer) {
  let offset = 0
  while (offset < buffer.length) {
    const result = await handle.write(buffer, offset, buffer.length - offset)
    offset += result.bytesWritten
  }
}

export async function createStoredZip(zipPath, entries, timestamp) {
  const handle = await open(zipPath, 'wx')
  const central = []
  let position = 0
  try {
    for (const entry of entries) {
      const name = Buffer.from(entry.name, 'utf8')
      const localOffset = position
      const stamp = dosTime(timestamp)
      const header = Buffer.alloc(30)
      header.writeUInt32LE(0x04034b50, 0)
      header.writeUInt16LE(20, 4)
      header.writeUInt16LE(0x0808, 6)
      header.writeUInt16LE(0, 8)
      header.writeUInt16LE(stamp.time, 10)
      header.writeUInt16LE(stamp.date, 12)
      header.writeUInt16LE(name.length, 26)
      await writeAll(handle, header)
      await writeAll(handle, name)
      position += header.length + name.length
      let crc = 0xffffffff
      let size = 0
      const source = entry.buffer
        ? (async function * buffers() { yield entry.buffer })()
        : createReadStream(entry.path)
      for await (const chunk of source) {
        const data = Buffer.from(chunk)
        crc = updateCrc(crc, data)
        size += data.length
        await writeAll(handle, data)
        position += data.length
      }
      crc = (crc ^ 0xffffffff) >>> 0
      const descriptor = Buffer.alloc(16)
      descriptor.writeUInt32LE(0x08074b50, 0)
      descriptor.writeUInt32LE(crc, 4)
      descriptor.writeUInt32LE(size, 8)
      descriptor.writeUInt32LE(size, 12)
      await writeAll(handle, descriptor)
      position += descriptor.length
      central.push({ name, crc, size, localOffset, stamp })
    }
    const centralOffset = position
    for (const entry of central) {
      const header = Buffer.alloc(46)
      header.writeUInt32LE(0x02014b50, 0)
      header.writeUInt16LE(20, 4)
      header.writeUInt16LE(20, 6)
      header.writeUInt16LE(0x0808, 8)
      header.writeUInt16LE(0, 10)
      header.writeUInt16LE(entry.stamp.time, 12)
      header.writeUInt16LE(entry.stamp.date, 14)
      header.writeUInt32LE(entry.crc, 16)
      header.writeUInt32LE(entry.size, 20)
      header.writeUInt32LE(entry.size, 24)
      header.writeUInt16LE(entry.name.length, 28)
      header.writeUInt32LE(entry.localOffset, 42)
      await writeAll(handle, header)
      await writeAll(handle, entry.name)
      position += header.length + entry.name.length
    }
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(central.length, 8)
    end.writeUInt16LE(central.length, 10)
    end.writeUInt32LE(position - centralOffset, 12)
    end.writeUInt32LE(centralOffset, 16)
    await writeAll(handle, end)
  } finally {
    await handle.close()
  }
}

function unsafeZipName(name) {
  return !name || name.includes('\\') || name.includes('/')
    || name.includes('\0') || name.includes(':') || /^[a-z]:/i.test(name) || name.startsWith('\\\\')
    || name === '.' || name === '..'
}

export async function inspectZip(zipPath) {
  const handle = await open(zipPath, 'r')
  try {
    const info = await handle.stat()
    const tailLength = Math.min(info.size, 65_557)
    const tail = Buffer.alloc(tailLength)
    await handle.read(tail, 0, tailLength, info.size - tailLength)
    let endAt = -1
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === 0x06054b50) { endAt = i; break }
    }
    if (endAt < 0) fail('ZIP end record is missing.', EXIT.ZIP)
    const count = tail.readUInt16LE(endAt + 10)
    const centralSize = tail.readUInt32LE(endAt + 12)
    const centralOffset = tail.readUInt32LE(endAt + 16)
    if (count === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) {
      fail('ZIP64 is not permitted for friend archives.', EXIT.ZIP)
    }
    const central = Buffer.alloc(centralSize)
    await handle.read(central, 0, centralSize, centralOffset)
    const entries = []
    const names = new Set()
    let cursor = 0
    for (let index = 0; index < count; index += 1) {
      if (central.readUInt32LE(cursor) !== 0x02014b50) fail('ZIP central directory is invalid.', EXIT.ZIP)
      const flags = central.readUInt16LE(cursor + 8)
      const method = central.readUInt16LE(cursor + 10)
      const crc = central.readUInt32LE(cursor + 16)
      const compressedSize = central.readUInt32LE(cursor + 20)
      const size = central.readUInt32LE(cursor + 24)
      const nameLength = central.readUInt16LE(cursor + 28)
      const extraLength = central.readUInt16LE(cursor + 30)
      const commentLength = central.readUInt16LE(cursor + 32)
      const external = central.readUInt32LE(cursor + 38)
      const localOffset = central.readUInt32LE(cursor + 42)
      const name = central.subarray(cursor + 46, cursor + 46 + nameLength).toString(
        (flags & 0x800) ? 'utf8' : 'latin1',
      )
      if (unsafeZipName(name)) fail(`ZIP entry is not root-safe: ${name}.`, EXIT.ZIP)
      const folded = name.toLowerCase()
      if (names.has(folded)) fail(`ZIP contains duplicate entry ${name}.`, EXIT.ZIP)
      names.add(folded)
      if (method !== 0 || ((external >>> 16) & 0o170000) === 0o120000) {
        fail(`ZIP entry ${name} is compressed or linked unexpectedly.`, EXIT.ZIP)
      }
      const local = Buffer.alloc(30)
      await handle.read(local, 0, 30, localOffset)
      if (local.readUInt32LE(0) !== 0x04034b50) fail('ZIP local header is invalid.', EXIT.ZIP)
      const localNameLength = local.readUInt16LE(26)
      const localExtraLength = local.readUInt16LE(28)
      const localName = Buffer.alloc(localNameLength)
      await handle.read(localName, 0, localNameLength, localOffset + 30)
      if (localName.toString((flags & 0x800) ? 'utf8' : 'latin1') !== name) {
        fail('ZIP local and central entry names differ.', EXIT.ZIP)
      }
      entries.push({
        name,
        crc,
        size,
        compressedSize,
        dataOffset: localOffset + 30 + localNameLength + localExtraLength,
      })
      cursor += 46 + nameLength + extraLength + commentLength
    }
    if (cursor !== central.length) fail('ZIP central directory has trailing data.', EXIT.ZIP)
    return { handle, entries, close: () => handle.close() }
  } catch (error) {
    await handle.close()
    throw error
  }
}

async function readZipEntry(zip, entry) {
  const buffer = Buffer.alloc(entry.size)
  await zip.handle.read(buffer, 0, entry.size, entry.dataOffset)
  return buffer
}

async function hashZipEntry(zip, entry) {
  const hash = createHash('sha256')
  const chunk = Buffer.alloc(1024 * 1024)
  let offset = 0
  while (offset < entry.size) {
    const length = Math.min(chunk.length, entry.size - offset)
    const result = await zip.handle.read(chunk, 0, length, entry.dataOffset + offset)
    if (!result.bytesRead) fail('ZIP entry ended unexpectedly.', EXIT.ZIP)
    hash.update(chunk.subarray(0, result.bytesRead))
    offset += result.bytesRead
  }
  return hash.digest('hex')
}

async function verifyEntryCrc(zip, entry) {
  let crc = 0xffffffff
  const chunk = Buffer.alloc(1024 * 1024)
  let offset = 0
  while (offset < entry.size) {
    const length = Math.min(chunk.length, entry.size - offset)
    const result = await zip.handle.read(chunk, 0, length, entry.dataOffset + offset)
    if (!result.bytesRead) fail('ZIP entry ended unexpectedly.', EXIT.ZIP)
    crc = updateCrc(crc, chunk.subarray(0, result.bytesRead))
    offset += result.bytesRead
  }
  if (((crc ^ 0xffffffff) >>> 0) !== entry.crc) {
    fail(`ZIP entry CRC is invalid: ${entry.name}.`, EXIT.ZIP)
  }
}

export async function verifyFriendZip(zipPath, approved) {
  const expected = [
    approved.artifacts.exe.name,
    'README.txt',
    'SHA256SUMS.txt',
  ]
  const zip = await inspectZip(zipPath)
  try {
    if (zip.entries.length !== expected.length
      || expected.some((name) => !zip.entries.some((entry) => entry.name === name))) {
      fail(`ZIP must contain exactly: ${expected.join(', ')}.`, EXIT.ZIP)
    }
    for (const entry of zip.entries) await verifyEntryCrc(zip, entry)
    const installer = zip.entries.find((entry) => entry.name === approved.artifacts.exe.name)
    if (await hashZipEntry(zip, installer) !== approved.artifacts.exe.sha256) {
      fail('ZIP installer hash does not match approved release provenance.', EXIT.ZIP)
    }
    const readme = (await readZipEntry(
      zip,
      zip.entries.find((entry) => entry.name === 'README.txt'),
    )).toString('utf8')
    if (!readme.includes(`Karaoke Studio ${approved.version}`)
      || !readme.includes(approved.artifacts.exe.sha256)
      || readme.includes('\n/') || readme.includes('\n\\')) {
      fail('ZIP README version or installer hash is invalid.', EXIT.ZIP)
    }
    const sums = (await readZipEntry(
      zip,
      zip.entries.find((entry) => entry.name === 'SHA256SUMS.txt'),
    )).toString('utf8')
    if (sums !== `${approved.artifacts.exe.sha256}  ${approved.artifacts.exe.name}\r\n`) {
      fail('ZIP hash file is invalid.', EXIT.ZIP)
    }
    return { entries: expected, installerSha256: approved.artifacts.exe.sha256 }
  } finally {
    await zip.close()
  }
}

async function safeRemoveOwned(target, parent, token) {
  if (!target) return
  if (path.dirname(target) !== path.resolve(parent) || !path.basename(target).includes(token)) {
    fail('Refusing broad temporary-path cleanup.', EXIT.PROMOTION)
  }
  await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

export async function atomicPromote(staged, live, token, deps = {}) {
  const renameFn = deps.rename ?? rename
  const parent = path.dirname(live)
  const backup = path.join(parent, `.${path.basename(live)}-backup-${token}`)
  let backedUp = false
  let promoted = false
  try {
    try {
      await renameFn(live, backup)
      backedUp = true
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    await renameFn(staged, live)
    promoted = true
    if (backedUp) await safeRemoveOwned(backup, parent, token)
  } catch (error) {
    if (backedUp) {
      try {
        if (promoted) await renameFn(live, staged)
        await renameFn(backup, live)
      } catch (rollbackError) {
        fail(`Promotion and rollback failed: ${rollbackError.message}.`, EXIT.PROMOTION)
      }
    }
    throw new DeployError(`Atomic promotion failed: ${error.message}.`, EXIT.PROMOTION)
  }
}

async function assertReplaceableVersionFolder(live, version) {
  let info
  try {
    info = await lstat(live)
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    fail('Refusing to replace a non-directory release version path.', EXIT.PROMOTION)
  }
  let provenance
  try {
    provenance = JSON.parse(await readFile(path.join(live, 'provenance.json'), 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return
    fail('Refusing to replace a release version with unreadable provenance.', EXIT.PROMOTION)
  }
  if (provenance?.verdict === 'APPROVE') {
    fail(`Refusing to overwrite approved release ${version}.`, EXIT.PROMOTION)
  }
  if (provenance?.packageVersion && provenance.packageVersion !== version) {
    fail('Refusing to replace a release folder for a different package version.', EXIT.PROMOTION)
  }
}

export async function promoteOwnedRelease(staging, root, version, token, deps = {}) {
  const live = releaseVersionDirectory(root, version)
  const resolvedRoot = path.resolve(root)
  const resolvedStaging = path.resolve(staging)
  if (path.dirname(resolvedStaging) !== resolvedRoot
    || !path.basename(resolvedStaging).startsWith('.release-staging-')
    || !path.basename(resolvedStaging).includes(token)) {
    fail('Refusing to promote a path that is not an owned release stage.', EXIT.PROMOTION)
  }
  await mkdir(path.dirname(live), { recursive: true })
  await assertReplaceableVersionFolder(live, version)
  await atomicPromote(resolvedStaging, live, token, deps)
  return live
}

function friendReadme(version, installerName, sha256) {
  return [
    `Karaoke Studio ${version} Friend Test`,
    '',
    'Windows 10/11 x64',
    '',
    `Run ${installerName} and follow the installer prompts.`,
    'This private test build is unsigned; Windows may display a publisher warning.',
    'Audio and AI processing remain local to this PC.',
    '',
    `SHA-256: ${sha256}`,
    '',
  ].join('\r\n')
}

export async function createFriendZip({ root, approved, token, now = new Date() }) {
  const zipDir = path.join(root, 'zip')
  await mkdir(zipDir, { recursive: true })
  const name = `Karaoke-Studio-${approved.version}-Friend-Test.zip`
  const live = path.join(zipDir, name)
  const staged = path.join(zipDir, `.${name}.tmp-${token}`)
  const readme = Buffer.from(friendReadme(
    approved.version,
    approved.artifacts.exe.name,
    approved.artifacts.exe.sha256,
  ), 'utf8')
  const sums = Buffer.from(
    `${approved.artifacts.exe.sha256}  ${approved.artifacts.exe.name}\r\n`,
    'utf8',
  )
  try {
    await createStoredZip(staged, [
      { name: approved.artifacts.exe.name, path: approved.artifacts.exe.path },
      { name: 'README.txt', buffer: readme },
      { name: 'SHA256SUMS.txt', buffer: sums },
    ], now)
    const verification = await verifyFriendZip(staged, approved)
    await atomicPromote(staged, live, token)
    return { path: live, sha256: await hashFile(live), ...verification }
  } catch (error) {
    await safeRemoveOwned(staged, zipDir, token)
    if (error instanceof DeployError) throw error
    throw new DeployError(`Friend ZIP creation failed: ${error.message}.`, EXIT.ZIP)
  }
}

async function listExactProcesses(executablePath) {
  if (process.platform !== 'win32') return []
  const escaped = executablePath.replaceAll("'", "''")
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Get-CimInstance Win32_Process | Where-Object {$_.ExecutablePath -ieq '${escaped}'} | `
        + 'Select-Object ProcessId,ParentProcessId,ExecutablePath | ConvertTo-Json -Compress',
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error('Process enumeration failed.'))
      if (!stdout.trim()) return resolve([])
      const parsed = JSON.parse(stdout)
      resolve((Array.isArray(parsed) ? parsed : [parsed]).map((entry) => ({
        pid: entry.ProcessId,
        parentPid: entry.ParentProcessId,
        executablePath: entry.ExecutablePath,
      })))
    })
  })
}

async function gracefulStopExact(pids, timeoutMs) {
  for (const pid of pids) {
    await runProcess('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue;if($p){[void]$p.CloseMainWindow()}`,
    ], { stdio: 'ignore' })
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const live = pids.filter((pid) => {
      try { process.kill(pid, 0); return true } catch { return false }
    })
    if (!live.length) return
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  fail('The exact installed application PID did not exit before timeout.', EXIT.INSTALL)
}

export async function killExactTree(rootPid, {
  listProcesses,
  killProcess,
} = {}) {
  if (!rootPid) return
  let rows = listProcesses ? await listProcesses() : []
  if (!listProcesses && process.platform === 'win32') {
    const output = await new Promise((resolve) => {
      const child = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress',
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      let stdout = ''
      child.stdout.on('data', (chunk) => { stdout += chunk })
      child.on('close', () => resolve(stdout))
      child.on('error', () => resolve(''))
    })
    if (output.trim()) {
      const parsed = JSON.parse(output)
      rows = Array.isArray(parsed) ? parsed : [parsed]
    }
  }
  const targets = new Set([rootPid])
  let changed = true
  while (changed) {
    changed = false
    for (const row of rows) {
      if (targets.has(row.ParentProcessId) && !targets.has(row.ProcessId)) {
        targets.add(row.ProcessId)
        changed = true
      }
    }
  }
  for (const pid of [...targets].reverse()) {
    try {
      if (killProcess) await killProcess(pid)
      else process.kill(pid)
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
  }
}

function defaultInstallAdapter() {
  return {
    listExactProcesses,
    gracefulStopExact,
    runInstaller: async (installer, timeoutMs) => {
      let installerPid
      try {
        const result = await runProcess(installer, ['/S'], {
          timeoutMs,
          stdio: 'ignore',
          onSpawn: (child) => { installerPid = child.pid },
        })
        if (result.code !== 0) fail(`Installer exited with code ${result.code}.`, EXIT.INSTALL)
      } catch (error) {
        if (error.code === 'DEPLOY_TIMEOUT') await killExactTree(installerPid)
        if (error instanceof DeployError) throw error
        fail(error.code === 'DEPLOY_TIMEOUT' ? 'Installer timed out.' : 'Installer failed.', EXIT.INSTALL)
      }
    },
    relaunch: (executable) => {
      const child = spawn(executable, [], {
        detached: false,
        windowsHide: false,
        stdio: 'ignore',
      })
      child.unref()
      return child.pid
    },
  }
}

async function verifyInstalled(executable, approved) {
  await access(executable)
  const installedAsar = path.join(path.dirname(executable), 'resources', 'app.asar')
  const installedPackage = JSON.parse(asar.extractFile(
    installedAsar,
    process.platform === 'win32' ? 'package.json' : 'package.json',
  ).toString('utf8'))
  if (installedPackage.version !== approved.version) {
    fail('Installed application version does not match the approved installer.', EXIT.INSTALL)
  }
  if (await hashFile(installedAsar) !== approved.staging.sha256) {
    fail('Installed application ASAR does not match the approved release.', EXIT.INSTALL)
  }
}

async function snapshotUserData(userDataDir) {
  const local = await snapshotTree(userDataDir)
  const references = new Set()
  function collect(value) {
    if (typeof value === 'string' && path.isAbsolute(value)) references.add(path.resolve(value))
    else if (Array.isArray(value)) value.forEach(collect)
    else if (value && typeof value === 'object') Object.values(value).forEach(collect)
  }
  for (const name of ['library.json', 'playlists.json']) {
    try {
      collect(JSON.parse(await readFile(path.join(userDataDir, name), 'utf8')))
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    }
  }
  const external = []
  for (const reference of [...references].sort()) {
    let info
    try {
      info = await lstat(reference)
    } catch (error) {
      if (error.code === 'ENOENT') {
        external.push({
          id: createHash('sha256').update(reference.toLowerCase()).digest('hex'),
          missing: true,
        })
        continue
      }
      throw error
    }
    if (info.isSymbolicLink()) fail('Referenced user data contains a reparse point.', EXIT.INSTALL)
    const id = createHash('sha256').update(reference.toLowerCase()).digest('hex')
    if (info.isDirectory()) {
      external.push({ id, tree: await snapshotTree(reference) })
    } else {
      external.push({
        id,
        bytes: info.size,
        mtimeMs: Math.trunc(info.mtimeMs),
        sha256: await hashFile(reference),
      })
    }
  }
  return { local, external }
}

export async function installApprovedRelease({
  approved,
  installExe,
  userDataDir,
  adapter = defaultInstallAdapter(),
  timeoutMs = 120_000,
}) {
  const running = await adapter.listExactProcesses(installExe)
  const exact = running.filter((entry) =>
    path.resolve(entry.executablePath).toLowerCase() === path.resolve(installExe).toLowerCase())
  const wasRunning = exact.length > 0
  if (wasRunning) await adapter.gracefulStopExact(exact.map((entry) => entry.pid), 15_000)
  const before = await snapshotUserData(userDataDir)
  let installed = false
  try {
    await adapter.runInstaller(approved.artifacts.exe.path, timeoutMs)
    installed = true
    await verifyInstalled(installExe, approved)
    const after = await snapshotUserData(userDataDir)
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      fail('User data changed during installation.', EXIT.INSTALL)
    }
    const relaunchedPid = wasRunning ? await adapter.relaunch(installExe) : undefined
    return {
      wasRunning,
      relaunchedPid,
      userDataFiles: before.local.length,
      referencedPaths: before.external.length,
    }
  } catch (error) {
    if (wasRunning && !installed) {
      try { await adapter.relaunch(installExe) } catch {}
    }
    if (error instanceof DeployError) throw error
    throw new DeployError(`Installation failed: ${error.message}.`, EXIT.INSTALL)
  }
}

async function buildRelease(context, approvalPath) {
  const staging = path.join(context.root, `.release-staging-${context.token}`)
  const sourceStaging = path.join(context.root, `.release-source-${context.token}`)
  const capabilityPath = path.join(context.root, '.release-capability')
  const capabilityNonce = randomBytes(32).toString('hex')
  const relativeApproval = path.relative(context.root, approvalPath)
  const deployPath = path.join(context.root, 'scripts', 'deploy-release.mjs')
  const releasePath = path.join(context.root, 'scripts', 'release.mjs')

  async function issueCapability(childPid) {
    const processIdentity = currentProcessIdentity
    const [parent, child] = await Promise.all([
      processIdentity(process.pid),
      processIdentity(childPid),
    ])
    await assertCanonicalNodeProcess(parent, {
      expectedPid: process.pid,
      expectedScript: deployPath,
      root: context.root,
    })
    await assertCanonicalNodeProcess(child, {
      expectedPid: childPid,
      expectedParentPid: process.pid,
      expectedScript: releasePath,
      root: context.root,
    })
    const activeLock = await assertActiveReleaseLock({
      lockPath: context.releaseLock.path,
      lockToken: context.releaseLock.token,
      ownerPid: process.pid,
      ownerIdentity: parent,
      processIdentity,
    })
    const createdAt = new Date()
    const record = {
      schema: 2,
      nonce: capabilityNonce,
      operation: 'package-release',
      parent,
      child,
      lock: {
        path: context.releaseLock.path,
        tokenSha256: hashLockToken(context.releaseLock.token),
        ownerPid: activeLock.record.pid,
        ownerStartTime: activeLock.record.processStartTime,
      },
      head: context.source.head,
      sourceSha256: context.sourceSnapshot.sha256,
      version: context.version,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + 30_000).toISOString(),
    }
    const handle = await open(capabilityPath, 'wx', 0o600)
    try { await handle.writeFile(`${JSON.stringify(record)}\n`) } finally { await handle.close() }
    await chmod(capabilityPath, 0o600)
    if (process.platform === 'win32') {
      const acl = await runProcess('icacls.exe', [
        capabilityPath, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:(R,W,D)`,
      ], { cwd: context.root, stdio: 'ignore' })
      if (acl.code !== 0) throw new ReleaseLockError('Could not restrict release capability ACL.')
    }
    return record
  }

  try {
    await safeRemoveOwned(staging, context.root, context.token)
    await rm(capabilityPath, { force: true })
    await rm(`${capabilityPath}.claim`, { force: true })
    let capabilityPromise
    const result = await context.run(process.execPath, [
      path.join(context.root, 'scripts', 'release.mjs'),
      `--approval=${relativeApproval}`,
    ], {
      cwd: context.root,
      env: {
        KARAOKE_RELEASE_DIR: staging,
        KARAOKE_RELEASE_SOURCE_DIR: sourceStaging,
        KARAOKE_RELEASE_LOCK_TOKEN: context.releaseLock.token,
        KARAOKE_RELEASE_CAPABILITY_PATH: capabilityPath,
        KARAOKE_RELEASE_CAPABILITY_NONCE: capabilityNonce,
      },
      onSpawn: (child) => {
        capabilityPromise = issueCapability(child.pid)
        capabilityPromise.catch(() => {})
        return capabilityPromise
      },
    })
    if (!capabilityPromise) fail('Release child did not expose a capability binding.', EXIT.LOCK)
    await capabilityPromise
    try {
      await access(capabilityPath)
      fail('Release child did not consume its one-time capability.', EXIT.LOCK)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    if (result.code !== 0) fail('Canonical release workflow rejected the build.', EXIT.ARTIFACT)
    const approved = await verifyApprovedRelease({
      root: context.root,
      releaseDir: staging,
      requireCurrentSource: true,
    })
    compareSnapshots(context.sourceSnapshot, await snapshotProtectedSources(context.root))
    await promoteOwnedRelease(staging, context.root, context.version, context.token)
    return verifyApprovedRelease({ root: context.root })
  } catch (error) {
    await rm(capabilityPath, { force: true })
    await rm(`${capabilityPath}.claim`, { force: true })
    await safeRemoveOwned(staging, context.root, context.token)
    throw error
  } finally {
    await removeCanonicalStage(sourceStaging)
  }
}

async function inspectPrerequisites(root) {
  const checks = [
    ['git', ['--version']],
    [process.execPath, ['--version']],
  ]
  if (process.platform === 'win32') checks.push(['powershell.exe', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']])
  for (const [command, args] of checks) {
    let result
    try {
      result = await runProcess(command, args, { cwd: root, stdio: 'ignore' })
    } catch {
      fail(`Required tool is unavailable: ${command}.`, EXIT.SOURCE)
    }
    if (result.code !== 0) fail(`Required tool is unavailable: ${command}.`, EXIT.SOURCE)
  }
}

export async function runDeploy(options, dependencies = {}) {
  const root = path.resolve(dependencies.root ?? moduleRoot)
  const context = {
    root,
    token: dependencies.token ?? randomBytes(12).toString('hex'),
    logs: [],
    writeLog: dependencies.writeLog ?? console.log,
    run: dependencies.run ?? runProcess,
  }
  let version
  try {
    ({ version } = await readPackageMetadata(root))
  } catch (error) {
    fail(error.message, EXIT.SOURCE)
  }
  await inspectPrerequisites(root)
  const source = await inspectSource(root)
  let sourceSnapshot
  try {
    sourceSnapshot = await snapshotProtectedSources(root)
  } catch (error) {
    fail(error.message, EXIT.SOURCE)
  }
  context.sourceSnapshot = sourceSnapshot
  context.source = source
  context.version = version
  let releaseDir
  try {
    releaseDir = releaseVersionDirectory(root, version)
  } catch (error) {
    fail(error.message, EXIT.SOURCE)
  }
  const zipPath = path.join(root, 'zip', `Karaoke-Studio-${version}-Friend-Test.zip`)
  const installExe = dependencies.installExe
    ?? path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Karaoke Studio', 'Karaoke Studio.exe')
  const userDataDir = dependencies.userDataDir
    ?? path.join(process.env.APPDATA ?? '', 'karaoke-studio')
  const deployLockPath = path.join(root, '.deploy-release.lock')
  const releaseLockPath = path.join(root, '.release.lock')
  const lockStates = await Promise.all([
    readLockState(deployLockPath, dependencies.processStartTime),
    readLockState(releaseLockPath, dependencies.processStartTime),
  ])
  logLine(context, 'inspect', `version=${version} branch=${source.branch} head=${source.head}`)
  logLine(context, 'plan', `release=${path.relative(root, releaseDir)} zip=${path.relative(root, zipPath)}`)
  logLine(
    context,
    'plan',
    `install=${path.dirname(installExe).toLowerCase().startsWith(root.toLowerCase())
      ? path.relative(root, installExe)
      : '<normal-per-user-install>'}`,
  )
  logLine(context, 'locks', `deploy=${lockStates[0].state} release=${lockStates[1].state}`)

  if (options.dryRun) {
    try {
      await access(path.join(releaseDir, 'provenance.json'))
      const approved = await verifyApprovedRelease({ root })
      logLine(context, 'artifact', `approved NSIS=${approved.artifacts.exe.sha256}`)
    } catch (error) {
      if (error.code === 'ENOENT') {
        logLine(context, 'artifact', 'existing release absent')
      } else {
        throw error
      }
    }
    if (options.approval) {
      await validateApproval(root, options.approval, {
        expectedSource: sourceSnapshot,
        expectedBranch: source.branch,
        expectedHead: source.head,
        now: dependencies.now?.() ?? new Date(),
      })
    }
    let installed = false
    try { await access(installExe); installed = true } catch {}
    logLine(context, 'install', `current-install=${installed ? 'present' : 'absent'}`)
    compareSnapshots(sourceSnapshot, await snapshotProtectedSources(root))
    logLine(context, 'verdict', 'APPROVE dry-run: no mutations performed.')
    return { exitCode: EXIT.OK, mode: 'dry-run', version, logs: context.logs }
  }

  if (lockStates.some((state) => state.state === 'live' || state.state === 'invalid')) {
    fail('A release/deploy lock is live or cannot be safely recovered.', EXIT.LOCK)
  }
  let deployLock
  let releaseLock
  try {
    deployLock = await acquireOperationLock({
      lockPath: deployLockPath,
      command: 'deploy-release',
      processStartTime: dependencies.processStartTime,
    })
    releaseLock = await acquireOperationLock({
      lockPath: releaseLockPath,
      command: 'deploy-release-coordinated',
      processStartTime: dependencies.processStartTime,
    })
    context.releaseLock = releaseLock
    let approved
    if (options.build) {
      const approval = await validateApproval(root, options.approval, {
        expectedSource: sourceSnapshot,
        expectedBranch: source.branch,
        expectedHead: source.head,
        now: dependencies.now?.() ?? new Date(),
      })
      logLine(context, 'build', `approval=${path.relative(root, approval.absolute)}`)
      approved = await buildRelease(context, approval.absolute)
    } else {
      approved = await verifyApprovedRelease({ root })
    }
    compareSnapshots(sourceSnapshot, await snapshotProtectedSources(root))
    let zipResult
    if (options.zip) {
      logLine(context, 'zip', 'creating verified friend archive')
      zipResult = await createFriendZip({
        root,
        approved,
        token: context.token,
        now: dependencies.now?.() ?? new Date(),
      })
      compareSnapshots(sourceSnapshot, await snapshotProtectedSources(root))
    }
    let installResult
    if (options.install) {
      logLine(context, 'install', 'updating exact normal per-user installation')
      installResult = await installApprovedRelease({
        approved,
        installExe,
        userDataDir,
        adapter: dependencies.installAdapter,
        timeoutMs: dependencies.installerTimeoutMs,
      })
    }
    logLine(context, 'verdict', 'APPROVE deployment operation completed.')
    return { exitCode: EXIT.OK, version, approved, zipResult, installResult, logs: context.logs }
  } finally {
    if (releaseLock) await releaseLock.release()
    if (deployLock) await deployLock.release()
  }
}

export function normalizeError(error) {
  if (error instanceof DeployError || error instanceof ArtifactVerificationError
    || error instanceof ReleaseLockError) {
    return {
      exitCode: error.exitCode ?? EXIT.ARTIFACT,
      message: error.message,
    }
  }
  return { exitCode: EXIT.ARTIFACT, message: error instanceof Error ? error.message : String(error) }
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArguments(argv)
    await runDeploy(options)
    return EXIT.OK
  } catch (error) {
    const normalized = normalizeError(error)
    console.error(`REJECT: ${redact(moduleRoot, normalized.message)}`)
    return normalized.exitCode
  }
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  process.exitCode = await main()
}
