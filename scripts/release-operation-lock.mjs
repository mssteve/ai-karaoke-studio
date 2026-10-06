import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { open, readFile, realpath, rename, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import path from 'node:path'

export class ReleaseLockError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ReleaseLockError'
    this.exitCode = 4
  }
}

function captured(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.on('error', reject)
    child.on('close', (code) => code === 0 ? resolve(stdout.trim()) : resolve(''))
  })
}

export async function currentProcessStartTime(pid = process.pid) {
  if (process.platform === 'win32') {
    const result = await captured('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `$p=Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue;`
        + `if($p){$p.StartTime.ToUniversalTime().Ticks}`,
    ])
    return result || null
  }
  try {
    process.kill(pid, 0)
    return `pid:${pid}`
  } catch (error) {
    if (error.code === 'ESRCH') return null
    throw error
  }
}

export async function currentProcessIdentity(pid = process.pid) {
  if (process.platform !== 'win32') {
    const startTime = await currentProcessStartTime(pid)
    if (!startTime) return null
    let commandLine = ''
    let executablePath = ''
    try {
      commandLine = (await readFile(`/proc/${pid}/cmdline`))
        .toString('utf8').split('\0').filter(Boolean)
      executablePath = await realpath(`/proc/${pid}/exe`)
    } catch {}
    return {
      pid,
      parentPid: pid === process.pid ? process.ppid : null,
      startTime,
      commandLine,
      executablePath,
    }
  }
  const result = await captured('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}" -ErrorAction SilentlyContinue;`
      + `if($p){$g=Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue;`
      + `if($g){[pscustomobject]@{pid=[int]$p.ProcessId;parentPid=[int]$p.ParentProcessId;`
      + `startTime=$g.StartTime.ToUniversalTime().Ticks.ToString();`
      + `executablePath=[string]$p.ExecutablePath;commandLine=[string]$p.CommandLine}`
      + `|ConvertTo-Json -Compress}}`,
  ])
  return result ? JSON.parse(result) : null
}

function equalSecret(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string'
    || Buffer.byteLength(left) !== Buffer.byteLength(right)) return false
  return timingSafeEqual(Buffer.from(left), Buffer.from(right))
}

export function hashLockToken(token) {
  return createHash('sha256').update(token).digest('hex')
}

export function parseWindowsCommandLine(commandLine) {
  if (Array.isArray(commandLine)) return commandLine
  const args = []
  let current = ''
  let quoted = false
  let slashes = 0
  for (let index = 0; index <= String(commandLine).length; index += 1) {
    const char = String(commandLine)[index]
    if (char === '\\') {
      slashes += 1
      continue
    }
    if (char === '"') {
      current += '\\'.repeat(Math.floor(slashes / 2))
      if (slashes % 2) current += '"'
      else quoted = !quoted
      slashes = 0
      continue
    }
    current += '\\'.repeat(slashes)
    slashes = 0
    if (char === undefined || (!quoted && /\s/.test(char))) {
      if (current) {
        args.push(current)
        current = ''
      }
      continue
    }
    current += char
  }
  return args
}

async function canonicalPath(value) {
  try { return await realpath(value) } catch { return path.resolve(value) }
}

export async function assertCanonicalNodeProcess(identity, {
  expectedPid,
  expectedParentPid,
  expectedScript,
  root,
} = {}) {
  if (!identity || identity.pid !== expectedPid
    || (expectedParentPid !== undefined && identity.parentPid !== expectedParentPid)
    || !identity.startTime || !identity.executablePath || !identity.commandLine) {
    throw new ReleaseLockError('Release process identity is incomplete or mismatched.')
  }
  const args = parseWindowsCommandLine(identity.commandLine)
  if (args.length < 2) throw new ReleaseLockError('Release process command line is invalid.')
  const [actualImage, entryScript] = args
  const [imageReal, nodeReal, scriptReal, expectedReal] = await Promise.all([
    canonicalPath(identity.executablePath),
    canonicalPath(process.execPath),
    canonicalPath(path.isAbsolute(entryScript) ? entryScript : path.resolve(root, entryScript)),
    canonicalPath(expectedScript),
  ])
  const commandImageMatches = path.isAbsolute(actualImage)
    ? (await canonicalPath(actualImage)).toLowerCase() === imageReal.toLowerCase()
    : path.basename(actualImage).toLowerCase() === path.basename(imageReal).toLowerCase()
  if (imageReal.toLowerCase() !== nodeReal.toLowerCase()
    || !commandImageMatches
    || scriptReal.toLowerCase() !== expectedReal.toLowerCase()) {
    throw new ReleaseLockError('Release process was not launched with the canonical entry script.')
  }
  return identity
}

export async function assertActiveReleaseLock({
  lockPath,
  lockToken,
  ownerPid,
  ownerIdentity,
  processIdentity = currentProcessIdentity,
  command = 'deploy-release-coordinated',
}) {
  if (!/^[0-9a-f]{64}$/.test(lockToken ?? '')) {
    throw new ReleaseLockError('Release lock token is missing or invalid.')
  }
  const actualOwner = ownerIdentity ?? await processIdentity(ownerPid)
  let record
  try { record = JSON.parse(await readFile(lockPath, 'utf8')) } catch {}
  if (!record || record.schema !== 2 || record.pid !== ownerPid
    || record.command !== command || !equalSecret(record.token, lockToken)
    || !actualOwner || actualOwner.startTime !== record.processStartTime) {
    throw new ReleaseLockError('Active deploy lock ownership is invalid.')
  }
  return { record, owner: actualOwner }
}

export async function consumeReleaseCapability({
  capabilityPath, nonce, operation, expectedHead, expectedSourceSha256, expectedVersion,
  pid = process.pid, parentPid = process.ppid, now = () => new Date(),
  processIdentity = currentProcessIdentity, lockPath, lockToken, root,
  canonicalDeployPath, canonicalReleasePath,
}) {
  if (!/^[0-9a-f]{64}$/.test(nonce ?? '')) {
    throw new ReleaseLockError('Release capability nonce is invalid.')
  }
  const claimPath = `${capabilityPath}.claim`
  const consumedPath = `${capabilityPath}.consumed-${pid}-${randomBytes(8).toString('hex')}`
  let claim
  let claimOwned = false
  try {
    claim = await open(claimPath, 'wx', 0o600)
    claimOwned = true
    await claim.writeFile(`${pid}\n`)
    await claim.close()
    claim = null
    await rename(capabilityPath, consumedPath)
  } catch {
    if (claim) await claim.close()
    if (claimOwned) await rm(claimPath, { force: true })
    throw new ReleaseLockError('Release capability is unavailable or was already consumed.')
  }
  try {
    const record = JSON.parse(await readFile(consumedPath, 'utf8'))
    const actualChild = await processIdentity(pid)
    const actualParent = await processIdentity(parentPid)
    const nonceMatches = equalSecret(record.nonce, nonce)
    if (record.schema !== 2 || !nonceMatches || record.operation !== operation
      || record.head !== expectedHead || record.sourceSha256 !== expectedSourceSha256
      || record.version !== expectedVersion || record.child?.pid !== pid
      || record.parent?.pid !== parentPid || !actualChild || !actualParent
      || actualChild.parentPid !== parentPid
      || actualChild.startTime !== record.child.startTime
      || actualParent.startTime !== record.parent.startTime
      || Date.parse(record.expiresAt) <= now().getTime()
      || Date.parse(record.createdAt) > now().getTime() + 5_000) {
      throw new ReleaseLockError('Release capability identity, scope, or lifetime is invalid.')
    }
    await assertCanonicalNodeProcess(actualParent, {
      expectedPid: parentPid,
      expectedScript: canonicalDeployPath,
      root,
    })
    await assertCanonicalNodeProcess(actualChild, {
      expectedPid: pid,
      expectedParentPid: parentPid,
      expectedScript: canonicalReleasePath,
      root,
    })
    const activeLock = await assertActiveReleaseLock({
      lockPath,
      lockToken,
      ownerPid: parentPid,
      ownerIdentity: actualParent,
      processIdentity,
    })
    if (record.lock?.path !== lockPath
      || record.lock?.tokenSha256 !== hashLockToken(lockToken)
      || record.lock?.ownerPid !== activeLock.record.pid
      || record.lock?.ownerStartTime !== activeLock.record.processStartTime) {
      throw new ReleaseLockError('Release capability lock binding is invalid.')
    }
    return record
  } finally {
    await rm(consumedPath, { force: true })
    await rm(claimPath, { force: true })
  }
}

export async function readLockState(lockPath, processStartTime = currentProcessStartTime) {
  let record
  try {
    record = JSON.parse(await readFile(lockPath, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return { state: 'available' }
    return { state: 'invalid', reason: 'lock record is unreadable' }
  }
  if (!record || record.schema !== 2 || !/^[0-9a-f]{64}$/.test(record.token ?? '')
    || !Number.isInteger(record.pid)
    || typeof record.processStartTime !== 'string') {
    return { state: 'invalid', record, reason: 'lock record has an invalid schema' }
  }
  const actualStart = await processStartTime(record.pid)
  if (actualStart === null) return { state: 'stale', record, reason: 'owner PID is absent' }
  if (actualStart !== record.processStartTime) {
    return { state: 'stale', record, reason: 'owner PID was reused' }
  }
  return { state: 'live', record }
}

export async function acquireOperationLock({
  lockPath,
  command,
  token = randomBytes(32).toString('hex'),
  pid = process.pid,
  now = () => new Date(),
  processStartTime = currentProcessStartTime,
}) {
  if (!/^[0-9a-f]{64}$/.test(token)) {
    throw new ReleaseLockError('Operation lock token must be 256 bits.')
  }
  const ownerStart = await processStartTime(pid)
  if (!ownerStart) throw new ReleaseLockError('Cannot establish the operation owner start time.')
  let handle
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      handle = await open(lockPath, 'wx')
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const state = await readLockState(lockPath, processStartTime)
      if (state.state === 'live') {
        throw new ReleaseLockError(`Another release operation owns ${lockPath}.`)
      }
      if (state.state !== 'stale') {
        throw new ReleaseLockError(`Cannot safely recover ${lockPath}: ${state.reason}.`)
      }
      const confirmed = await readLockState(lockPath, processStartTime)
      if (confirmed.state !== 'stale' || confirmed.record?.token !== state.record?.token) {
        throw new ReleaseLockError(`Lock ownership changed while recovering ${lockPath}.`)
      }
      await rm(lockPath, { force: true })
    }
  }
  if (!handle) throw new ReleaseLockError(`Could not acquire ${lockPath}.`)
  const record = {
    schema: 2,
    token,
    pid,
    processStartTime: ownerStart,
    command,
    acquiredAt: now().toISOString(),
  }
  await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`)
  await handle.close()
  return {
    path: lockPath,
    token,
    record,
    async release() {
      let current
      try {
        current = JSON.parse(await readFile(lockPath, 'utf8'))
      } catch (error) {
        if (error.code === 'ENOENT') return
        throw error
      }
      if (current.token !== token) {
        throw new ReleaseLockError(`Refusing to remove a lock owned by another token: ${lockPath}.`)
      }
      await rm(lockPath, { force: true })
    },
  }
}
